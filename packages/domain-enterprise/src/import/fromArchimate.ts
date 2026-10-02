import { parseUrn, pickId, Warnings } from '@iark/kernel';
import { formatEnterpriseIssues, validateEnterpriseDocument } from '../schema';
import {
  ENTERPRISE_DOCUMENT_VERSION,
  KIND_LABELS,
  RELATION_LABELS,
  RELATION_RULES,
  type Application,
  type BusinessService,
  type Capability,
  type ElementKind,
  type Process,
  type Relation,
  type RelationKind,
  type Technology,
  type TechnologyKind,
  type Unit,
  type ValueStage,
  type ValueStream,
} from '../types';
import { readArchimate, looksLikeArchimate, type RawElement, type RawProperty, type RawRelationship } from './archimateXml';
import {
  normKey,
  parseAmount,
  parseBoolean,
  parseCount,
  parseCriticality,
  parseEndOfLife,
  parseImportance,
  parseLifecycle,
  parseMaturity,
  parseStrategy,
  parseTechnologyKind,
  propertyField,
  type PropField,
} from './archimateProps';
import { EnterpriseImportError, type EnterpriseImportResult } from './fromMermaid';

export { looksLikeArchimate };

/**
 * Importador de ArchiMate: lee un modelo del Open Group Exchange File Format (`.xml`, `<model>` en el espacio de nombres
 * `http://www.opengroup.org/xsd/archimate/3.x/`) o del formato nativo de Archi (`.archimate`, `<archimate:model>`) y lo
 * convierte en un documento empresarial. Lo que el módulo no puede representar no se descarta en silencio: se resume
 * en los avisos.
 *
 * ELEMENTOS
 * - BusinessActor, BusinessRole, BusinessCollaboration → unidades (`units`).
 * - Capability → capacidad (`capabilities`).
 * - BusinessProcess, BusinessFunction, BusinessInteraction → proceso (los dos últimos llevan su tipo como etiqueta).
 * - BusinessService → servicio de negocio.
 * - ApplicationComponent, ApplicationCollaboration, ApplicationService, DataObject → aplicación (salvo el componente, con
 *   su tipo como etiqueta).
 * - Node, Device, SystemSoftware, TechnologyCollaboration, TechnologyService, Artifact → tecnología. El tipo (`kind`) sale
 *   de la propiedad de tipo si la hay; si no: Node/Device/colaboración → infraestructura, servicio → servicio, artefacto →
 *   plataforma y software de sistema → base de datos, middleware o entorno de ejecución según su nombre (PostgreSQL,
 *   Kafka, JVM…) y, si no se reconoce, plataforma.
 * - ValueStream → flujo de valor. Un flujo que contiene a otros (composición o agregación entre flujos) es el flujo y los
 *   suyos son sus etapas, en el orden de sus relaciones de flujo/disparo; las que lo contienen a su vez se aplanan. Los flujos
 *   sueltos unidos entre sí por flujo/disparo forman las etapas de un flujo sintético; uno aislado es un flujo con una
 *   etapa del mismo nombre.
 * - AndJunction, OrJunction y los eventos (BusinessEvent, ApplicationEvent, TechnologyEvent) desaparecen: las relaciones que
 *   pasan por ellos se sustituyen por relaciones directas entre sus extremos (el evento queda como descripción).
 *
 * RELACIONES (origen → destino en ArchiMate; solo se emiten las que admite `RELATION_RULES`)
 * - Composition/Aggregation: capacidad → capacidad y actor o rol → unidad son la jerarquía (`parentId`; el primer padre
 *   manda, y un ciclo se omite; una BusinessCollaboration no es un nivel de la organización y sus miembros no se importan);
 *   proceso/aplicación/tecnología → igual: `composes`; flujo → flujo, la estructura de etapas.
 * - Assignment: unidad → proceso: `assigned-to` (y la unidad es su responsable si no lo fija una propiedad); unidad → capacidad, servicio, flujo, aplicación o tecnología: responsable
 *   (`ownerId`, si no lo fija una propiedad); tecnología → tecnología (nodo → software/artefacto): `depends-on` desde lo desplegado.
 * - Realization: proceso → capacidad: `realizes`; aplicación → capacidad o proceso: `supports`; tecnología → aplicación:
 *   `runs-on` (la aplicación sobre ese artefacto/software); proceso o capacidad → servicio: `exposes` (del servicio al proceso);
 *   capacidad → flujo: `enables` (a cada etapa); aplicación → aplicación y tecnología → tecnología: `depends-on` (lo realizado
 *   depende de quien lo realiza).
 * - Serving: aplicación → proceso o capacidad: `supports`; aplicación → aplicación y tecnología → tecnología: `depends-on`
 *   (el servido depende del que sirve); tecnología → aplicación: `runs-on`; proceso → proceso: `flows-to`; capacidad → flujo:
 *   `enables`; flujo → unidad (o Stakeholder): destinatario del flujo (`stakeholder`); servicio → unidad: audiencia del servicio.
 * - Flow: proceso → proceso y aplicación → aplicación: `flows-to`; entre flujos solo ordena las etapas.
 * - Triggering: proceso → proceso: `triggers`; aplicación → aplicación: `flows-to`; entre flujos solo ordena las etapas.
 * - Access: aplicación → aplicación (p. ej. a un DataObject): `depends-on`.
 * - Association: la relación que admiten los tipos de sus extremos (en cualquier sentido); entre dos del mismo tipo no se importa.
 * - Specialization, Influence y las que no tienen equivalente (p. ej. aplicación → unidad) se omiten y se cuentan. Una
 *   relación que apunta a otra relación, a un elemento que no se importa o a un identificador que no existe, también.
 *
 * PROPIEDADES (nombres y valores en español o inglés; ver `archimateProps.ts`)
 * - Aplicación: coste anual, usuarios, estrategia (conservar, migrar, reemplazar, retirar; también TIME), fin de soporte,
 *   ciclo de vida, criticidad, proveedor, tecnología, externo, referencia (`ref`, una URN) y responsable.
 * - Tecnología: ciclo de vida, fin de soporte, tipo, versión, referencia y responsable.
 * - Capacidad: madurez (1-5), importancia (diferenciadora, esencial, de apoyo) y responsable. Proceso: responsable.
 *   Flujo: destinatario y responsable; etapa: valor. Servicio: audiencia y responsable. Unidad: externa.
 * - El responsable es una unidad por su nombre; si no existe se crea una unidad con ese nombre (y se avisa).
 * - El resto de propiedades, y las que no se entienden en su valor, se enumeran en los avisos.
 *
 * NO SE IMPORTAN (se resumen en los avisos): motivación (Stakeholder, Goal, Requirement…), estrategia (Resource,
 * CourseOfAction), implementación y migración (WorkPackage, Plateau, Gap…), la estructura pasiva y las interfaces
 * (BusinessObject, Contract, Product, *Interface…), las funciones y procesos de aplicación y de tecnología, la capa
 * física, Location y Grouping, y las vistas (`views/diagrams`): el módulo deriva las suyas del modelo.
 *
 * Los ids salen del nombre (`Gestión de pedidos` → `gestion-de-pedidos`, con `-2`… si se repite) y no dependen de los
 * identificadores del archivo, así que importar dos veces lo mismo da el mismo documento.
 */

export interface ArchimateImportOptions {
  name?: string;
  fallbackName?: string;
  /** Idioma preferido para nombres y documentación (por defecto, `es`; después el sin idioma y el inglés). */
  lang?: string;
}

type MappedKind = 'unit' | 'capability' | 'process' | 'service' | 'application' | 'technology';

interface TypeInfo {
  kind: MappedKind;
  /** Etiqueta con el tipo de ArchiMate, cuando el módulo junta varios en un mismo tipo. */
  tag?: boolean;
  tech?: TechnologyKind;
}

const TYPE_LIST: Record<string, TypeInfo> = {
  BusinessActor: { kind: 'unit' },
  BusinessRole: { kind: 'unit' },
  BusinessCollaboration: { kind: 'unit' },
  Capability: { kind: 'capability' },
  BusinessProcess: { kind: 'process' },
  BusinessFunction: { kind: 'process', tag: true },
  BusinessInteraction: { kind: 'process', tag: true },
  BusinessService: { kind: 'service' },
  ApplicationComponent: { kind: 'application' },
  ApplicationCollaboration: { kind: 'application', tag: true },
  ApplicationService: { kind: 'application', tag: true },
  DataObject: { kind: 'application', tag: true },
  Node: { kind: 'technology', tech: 'infrastructure' },
  Device: { kind: 'technology', tech: 'infrastructure', tag: true },
  SystemSoftware: { kind: 'technology' },
  TechnologyCollaboration: { kind: 'technology', tech: 'infrastructure', tag: true },
  TechnologyService: { kind: 'technology', tech: 'service' },
  Artifact: { kind: 'technology', tech: 'platform', tag: true },
};

/** Mapa (y no un objeto) para que un tipo como `constructor` o `__proto__` en el XML no encuentre nada. */
const TYPES = new Map<string, TypeInfo>(Object.entries(TYPE_LIST));
const VALUE_STREAM = 'ValueStream';
const JUNCTIONS = new Set(['AndJunction', 'OrJunction']);
const EVENTS = new Set(['BusinessEvent', 'ApplicationEvent', 'TechnologyEvent']);
const isPassThrough = (type: string): boolean => JUNCTIONS.has(type) || EVENTS.has(type);

/** Tipos sin equivalente, por la capa o familia con la que se resumen. */
const UNMAPPED_GROUPS: Array<{ phrase: string; types: string[] }> = [
  { phrase: 'de motivación', types: ['Stakeholder', 'Driver', 'Assessment', 'Goal', 'Outcome', 'Principle', 'Requirement', 'Constraint', 'Meaning', 'Value'] },
  { phrase: 'de estrategia', types: ['Resource', 'CourseOfAction'] },
  { phrase: 'de implementación y migración', types: ['WorkPackage', 'Deliverable', 'ImplementationEvent', 'Plateau', 'Gap'] },
  { phrase: 'de negocio', types: ['BusinessInterface', 'BusinessObject', 'Contract', 'Representation', 'Product'] },
  { phrase: 'de aplicación', types: ['ApplicationInterface', 'ApplicationFunction', 'ApplicationInteraction', 'ApplicationProcess'] },
  { phrase: 'de tecnología', types: ['TechnologyInterface', 'Path', 'CommunicationNetwork', 'TechnologyFunction', 'TechnologyProcess', 'TechnologyInteraction'] },
  { phrase: 'de la capa física', types: ['Equipment', 'Facility', 'DistributionNetwork', 'Material'] },
  { phrase: 'de otro tipo', types: ['Location', 'Grouping'] },
];
const GROUP_OF_TYPE = new Map(UNMAPPED_GROUPS.flatMap((g) => g.types.map((t) => [t, g.phrase] as const)));
const UNKNOWN_GROUP = 'de un tipo desconocido';

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const quoted = (names: string[], max = 4): string => `${names.slice(0, max).map((n) => `«${n}»`).join(', ')}${names.length > max ? ` y ${names.length - max} más` : ''}`;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const kindWord = (k: ElementKind): string => KIND_LABELS[k].toLowerCase();

/** Tipo de tecnología de un software de sistema a partir de su nombre. */
function softwareKind(name: string): TechnologyKind {
  const n = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/postgres|mysql|mariadb|oracle ?(database|db)|sql ?server|mongo|redis|cassandra|\bdb2\b|\bhana\b|sqlite|dynamo|bigquery|snowflake|elasticsearch|base de datos|database/.test(n)) return 'database';
  if (/kafka|rabbit|activemq|\bmq\b|\besb\b|mulesoft|\bnats\b|pulsar|api gateway|middleware|mensajeria|broker/.test(n)) return 'middleware';
  if (/\bjvm\b|\bjava\b|openjdk|node\.?js|\.net\b|python|\bphp\b|tomcat|jboss|wildfly|runtime|\bjre\b/.test(n)) return 'runtime';
  return 'platform';
}

interface Rule {
  kind: RelationKind;
  reversed?: boolean;
  /** Si la conversión no es literal: cómo se cuenta en los avisos. */
  note?: string;
}

const STRUCTURAL: Record<string, Rule> = {
  'process>process': { kind: 'composes' },
  'application>application': { kind: 'composes' },
  'technology>technology': { kind: 'composes' },
};

/** Relación del módulo por tipo de ArchiMate y tipos de sus extremos (`origen>destino`). */
const RULES: Record<string, Record<string, Rule>> = {
  Composition: STRUCTURAL,
  Aggregation: STRUCTURAL,
  Assignment: {
    'unit>process': { kind: 'assigned-to' },
    'technology>technology': { kind: 'depends-on', reversed: true, note: 'lo desplegado depende de su nodo' },
  },
  Realization: {
    'process>capability': { kind: 'realizes' },
    'application>capability': { kind: 'supports' },
    'application>process': { kind: 'supports' },
    'technology>application': { kind: 'runs-on', reversed: true },
    'process>service': { kind: 'exposes', reversed: true },
    'capability>service': { kind: 'exposes', reversed: true, note: 'el servicio expone la capacidad que lo realiza' },
    'application>application': { kind: 'depends-on', reversed: true, note: 'lo realizado depende de quien lo realiza' },
    'technology>technology': { kind: 'depends-on', reversed: true, note: 'lo realizado depende de quien lo realiza' },
  },
  Serving: {
    'application>process': { kind: 'supports' },
    'application>capability': { kind: 'supports' },
    'application>application': { kind: 'depends-on', reversed: true },
    'technology>technology': { kind: 'depends-on', reversed: true },
    'technology>application': { kind: 'runs-on', reversed: true },
    'process>process': { kind: 'flows-to', note: 'el destinatario depende del origen' },
  },
  Flow: {
    'process>process': { kind: 'flows-to' },
    'application>application': { kind: 'flows-to' },
  },
  Triggering: {
    'process>process': { kind: 'triggers' },
    'application>application': { kind: 'flows-to', note: 'el módulo solo dispara entre procesos' },
  },
  Access: {
    'application>application': { kind: 'depends-on', note: 'la aplicación depende de los datos a los que accede' },
  },
};

const ASSOCIATION_KINDS: RelationKind[] = ['supports', 'realizes', 'runs-on', 'assigned-to', 'exposes'];

/** Relación que une dos tipos de elemento distintos, en el sentido en que los dibuja el módulo. */
function associationRule(source: ElementKind, target: ElementKind): Rule | undefined {
  if (source === target) return undefined;
  for (const kind of ASSOCIATION_KINDS) {
    for (const [from, to] of RELATION_RULES[kind]) {
      if (from === source && to === target) return { kind };
      if (from === target && to === source) return { kind, reversed: true };
    }
  }
  return undefined;
}

const compact = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

type Link = RawRelationship;

type Fields = Partial<{
  annualCost: number;
  users: number;
  strategy: Application['strategy'];
  endOfLife: string;
  lifecycle: Application['lifecycle'];
  maturity: number;
  importance: Capability['importance'];
  criticality: Application['criticality'];
  owner: string;
  vendor: string;
  technology: string;
  version: string;
  external: boolean;
  kind: TechnologyKind;
  audience: string;
  stakeholder: string;
  value: string;
  ref: string;
}>;

/** Valor de una propiedad ya interpretado para su campo, o `undefined` si no se entiende. */
function parseProperty(field: PropField, value: string): string | number | boolean | undefined {
  switch (field) {
    case 'annualCost': return parseAmount(value);
    case 'users': return parseCount(value);
    case 'strategy': return parseStrategy(value);
    case 'endOfLife': return parseEndOfLife(value);
    case 'lifecycle': return parseLifecycle(value);
    case 'maturity': return parseMaturity(value);
    case 'importance': return parseImportance(value);
    case 'criticality': return parseCriticality(value);
    case 'external': return parseBoolean(value);
    case 'kind': return parseTechnologyKind(value);
    case 'ref': return parseUrn(value) ? value : undefined;
    default: return value.replace(/\s+/g, ' ');
  }
}

/** Cuenta casos por categoría, guardando unos pocos ejemplos para el aviso. */
class Tally {
  private map = new Map<string, { count: number; examples: string[] }>();
  add(key: string, example?: string): void {
    const c = this.map.get(key) ?? { count: 0, examples: [] };
    c.count += 1;
    if (example && c.examples.length < 3 && !c.examples.includes(example)) c.examples.push(example);
    this.map.set(key, c);
  }
  entries(): Array<[string, { count: number; examples: string[] }]> {
    return [...this.map.entries()];
  }
}

interface Node {
  raw: RawElement;
  kind: MappedKind;
  id: string;
}

const FLOW_LIKE = new Set(['Triggering', 'Flow']);

/**
 * Sustituye las relaciones que pasan por una unión (And/Or) o por un evento por relaciones directas entre los extremos
 * (A → unión → B es A → B). Por una unión solo se sigue con relaciones del mismo tipo; por un evento, con disparos o flujos.
 * Los eventos dan su nombre a la relación resultante si esta no tiene uno propio.
 */
function collapsePassThrough(links: Link[], elements: Map<string, RawElement>): { effective: Link[]; used: Set<string>; lost: number } {
  const passThrough = new Set([...elements.values()].filter((e) => isPassThrough(e.type)).map((e) => e.id));
  const leaving = new Map<string, Link[]>();
  for (const l of links) if (passThrough.has(l.source)) leaving.set(l.source, [...(leaving.get(l.source) ?? []), l]);
  const used = new Set<string>();
  const followed = new Set<Link>();
  const effective: Link[] = [];
  let lost = 0;
  for (const l of links) {
    if (passThrough.has(l.source)) continue;
    if (!passThrough.has(l.target)) {
      effective.push(l);
      continue;
    }
    let reached = false;
    const walk = (node: string, via: string[]): void => {
      if (via.includes(node)) return;
      const path = [...via, node];
      const events = path.filter((id) => EVENTS.has(elements.get(id)?.type ?? ''));
      for (const out of leaving.get(node) ?? []) {
        if (out.type !== l.type && !(events.length > 0 && FLOW_LIKE.has(l.type) && FLOW_LIKE.has(out.type))) continue;
        if (passThrough.has(out.target)) {
          const before = effective.length;
          walk(out.target, path);
          if (effective.length > before) followed.add(out);
          continue;
        }
        reached = true;
        followed.add(out);
        for (const id of path) used.add(id);
        const name = l.name ?? out.name ?? (events[0] ? elements.get(events[0])!.name.trim() || undefined : undefined);
        effective.push({ ...l, target: out.target, directed: l.directed || out.directed, ...(name ? { name } : {}) });
      }
    };
    walk(l.target, []);
    if (!reached) lost += 1;
  }
  // Las que salen de una unión o un evento y nadie sigue (tipo incompatible, o sin nada que entre).
  lost += links.filter((l) => passThrough.has(l.source) && !followed.has(l)).length;
  return { effective, used, lost };
}

/** Cómo quedan los flujos de valor de ArchiMate en el módulo: un flujo con sus etapas en orden. */
interface StreamPlan {
  name: string;
  description?: string;
  /** Flujos de ArchiMate que son sus etapas, en orden. */
  stages: string[];
  /** `single`: un flujo suelto, con una etapa del mismo nombre. `chain`: flujos sueltos unidos por flujo/disparo, que son etapas de uno nuevo. */
  synthetic?: 'single' | 'chain';
  /** Flujo de ArchiMate en cuya posición del archivo se crea. */
  anchor: string;
}

function planStreams(streams: RawElement[], effective: Link[], elements: Map<string, RawElement>, nameOf: (el: RawElement) => string) {
  const position = new Map(streams.map((e, i) => [e.id, i]));
  const inDocument = (a: string, b: string): number => (position.get(a) ?? 0) - (position.get(b) ?? 0);
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const flowEdges: Array<[string, string]> = [];
  const flowLinks: Link[] = [];
  const consumed = new Set<Link>();
  for (const l of effective) {
    if (!position.has(l.source) || !position.has(l.target) || l.source === l.target) continue;
    if (l.type === 'Composition' || l.type === 'Aggregation') {
      let cyclic = false;
      for (let p: string | undefined = l.source; p !== undefined; p = parentOf.get(p)) if (p === l.target) cyclic = true;
      if (!parentOf.has(l.target) && !cyclic) {
        parentOf.set(l.target, l.source);
        childrenOf.set(l.source, [...(childrenOf.get(l.source) ?? []), l.target]);
        consumed.add(l);
      }
    } else if (FLOW_LIKE.has(l.type)) {
      flowEdges.push([l.source, l.target]);
      flowLinks.push(l);
    }
  }
  const rootOf = (id: string): string => {
    let top = id;
    for (let p = parentOf.get(top); p !== undefined; p = parentOf.get(top)) top = p;
    return top;
  };
  const leavesUnder = (id: string): string[] => ((childrenOf.get(id) ?? []).length === 0 ? [id] : [...childrenOf.get(id)!].sort(inDocument).flatMap(leavesUnder));
  /** Orden de las etapas: el de las relaciones de flujo y disparo entre ellas; a igualdad, el del archivo. */
  const sequence = (members: string[]): string[] => {
    const set = new Set(members);
    const edges = flowEdges.filter(([a, b]) => set.has(a) && set.has(b));
    const remaining = [...members].sort(inDocument);
    const result: string[] = [];
    while (remaining.length > 0) {
      const next = remaining.find((m) => !edges.some(([a, b]) => b === m && remaining.includes(a))) ?? remaining[0];
      result.push(next);
      remaining.splice(remaining.indexOf(next), 1);
    }
    return result;
  };

  const roots = streams.filter((e) => !parentOf.has(e.id));
  const loose = new Set(roots.filter((e) => !childrenOf.has(e.id)).map((e) => e.id));
  const plans: StreamPlan[] = [];
  const planOfRoot = new Map<string, StreamPlan>();
  const flattened = new Set<string>();
  for (const root of roots) {
    if (planOfRoot.has(root.id)) continue;
    const el = root;
    if (!loose.has(root.id)) {
      const stages = sequence(leavesUnder(root.id));
      for (const stage of stages) for (let p = parentOf.get(stage); p !== undefined && p !== root.id; p = parentOf.get(p)) flattened.add(nameOf(elements.get(p)!));
      const plan: StreamPlan = { name: nameOf(el), description: el.documentation, stages, anchor: root.id };
      plans.push(plan);
      planOfRoot.set(root.id, plan);
      continue;
    }
    // Flujos sueltos unidos entre sí por flujo o disparo.
    const members = new Set([root.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [a, b] of flowEdges) {
        if (loose.has(a) && loose.has(b) && members.has(a) !== members.has(b)) {
          members.add(a).add(b);
          grew = true;
        }
      }
    }
    if (members.size === 1) {
      const plan: StreamPlan = { name: nameOf(el), description: el.documentation, stages: [root.id], synthetic: 'single', anchor: root.id };
      plans.push(plan);
      planOfRoot.set(root.id, plan);
    } else {
      const ordered = sequence([...members]);
      const plan: StreamPlan = { name: `Flujo de valor: ${nameOf(elements.get(ordered[0])!)} → ${nameOf(elements.get(ordered[ordered.length - 1])!)}`, stages: ordered, synthetic: 'chain', anchor: [...members].sort(inDocument)[0] };
      plans.push(plan);
      for (const m of members) planOfRoot.set(m, plan);
    }
  }
  plans.sort((a, b) => inDocument(a.anchor, b.anchor));
  // Un flujo o disparo entre etapas del mismo flujo solo ordena; entre flujos distintos no tiene equivalente.
  for (const l of flowLinks) if (planOfRoot.get(rootOf(l.source)) === planOfRoot.get(rootOf(l.target))) consumed.add(l);
  return { plans, planOfRoot, rootOf, leavesUnder, consumed, flattened: [...flattened] };
}

export function fromArchimate(text: string, options: ArchimateImportOptions = {}): EnterpriseImportResult {
  const raw = readArchimate(text, { lang: options.lang });
  const warnings = new Warnings();

  // ───── elementos y relaciones, sin repetidos ─────
  const elements = new Map<string, RawElement>();
  const links: Link[] = [];
  const linkIds = new Set<string>();
  let repeatedIds = 0;
  for (const el of raw.elements) {
    if (elements.has(el.id)) repeatedIds += 1;
    else elements.set(el.id, el);
  }
  for (const r of raw.relationships) {
    if (linkIds.has(r.id)) repeatedIds += 1;
    else links.push(r);
    linkIds.add(r.id);
  }

  const nameOf = (el: RawElement): string => el.name.replace(/\s+/g, ' ').trim() || `Sin nombre (${el.id})`;
  const unnamed: string[] = [];
  const unmapped = new Map<string, Array<{ type: string; name: string }>>();
  const groupOf = new Map<string, string>();
  const streamElements: RawElement[] = [];
  for (const el of elements.values()) {
    const mapped = TYPES.has(el.type) || el.type === VALUE_STREAM;
    if (mapped && el.name.trim() === '') unnamed.push(el.id);
    if (el.type === VALUE_STREAM) streamElements.push(el);
    else if (!mapped && !isPassThrough(el.type)) {
      const group = GROUP_OF_TYPE.get(el.type) ?? UNKNOWN_GROUP;
      unmapped.set(group, [...(unmapped.get(group) ?? []), { type: el.type, name: nameOf(el) }]);
      groupOf.set(el.id, group);
    }
  }

  const { effective, used: usedPassThrough, lost: lostThrough } = collapsePassThrough(links, elements);
  const { plans, planOfRoot, rootOf, leavesUnder, consumed, flattened } = planStreams(streamElements, effective, elements, nameOf);

  // ───── identificadores: del nombre, en el orden del archivo ─────
  const ids = new Set<string>();
  const take = (name: string, fallback: string): string => pickId(slug(name) || fallback, ids);
  const nodes = new Map<string, Node>();
  const streamIdOf = new Map<StreamPlan, string>();
  const stageIdOf = new Map<string, string>();
  for (const el of raw.elements) {
    if (elements.get(el.id) !== el) continue;
    const type = TYPES.get(el.type);
    if (type) {
      nodes.set(el.id, { raw: el, kind: type.kind, id: take(nameOf(el), type.kind) });
    } else if (el.type === VALUE_STREAM) {
      const plan = planOfRoot.get(rootOf(el.id))!;
      if (plan.anchor === el.id) streamIdOf.set(plan, take(plan.name, 'flujo-de-valor'));
      if (plan.stages.includes(el.id)) stageIdOf.set(el.id, take(plan.synthetic === 'single' ? `${nameOf(el)} etapa` : nameOf(el), 'etapa'));
    }
  }
  /** Flujo de ArchiMate → flujo del módulo y etapas a las que llega (un flujo con etapas lleva a todas). */
  const streamOf = new Map<string, { streamId: string; stages: string[] }>();
  for (const el of streamElements) {
    const plan = planOfRoot.get(rootOf(el.id))!;
    const own = stageIdOf.get(el.id);
    const stages = own ? [own] : plan.stages.filter((s) => leavesUnder(el.id).includes(s)).map((s) => stageIdOf.get(s)!);
    streamOf.set(el.id, { streamId: streamIdOf.get(plan)!, stages });
  }

  // ───── propiedades ─────
  const unitByName = new Map<string, string>();
  for (const n of nodes.values()) if (n.kind === 'unit') unitByName.set(normKey(nameOf(n.raw)), n.id);
  const createdUnits: Unit[] = [];
  const unitFor = (value: string): string => {
    const key = normKey(value);
    let id = unitByName.get(key);
    if (!id) {
      const name = value.replace(/\s+/g, ' ').trim();
      id = take(name, 'unidad');
      unitByName.set(key, id);
      createdUnits.push({ id, name });
    }
    return id;
  };
  const unmappedProps = new Tally();
  const badValues = new Tally();
  const ALLOWED: Record<string, PropField[]> = {
    unit: ['external'],
    capability: ['owner', 'importance', 'maturity'],
    process: ['owner'],
    application: ['owner', 'annualCost', 'users', 'strategy', 'endOfLife', 'lifecycle', 'criticality', 'vendor', 'technology', 'external', 'ref'],
    technology: ['owner', 'lifecycle', 'endOfLife', 'kind', 'version', 'ref'],
    service: ['owner', 'audience'],
    stream: ['owner', 'stakeholder'],
    stage: ['value'],
    single: ['owner', 'stakeholder', 'value'],
  };
  const read = (owner: string, kind: keyof typeof ALLOWED, props: RawProperty[]): Fields => {
    const out: Record<string, string | number | boolean> = {};
    for (const p of props) {
      const value = p.value.trim();
      if (value === '') continue;
      const hit = propertyField(p.key);
      if (!hit || !ALLOWED[kind].includes(hit.field)) {
        unmappedProps.add(p.key.trim(), `«${owner}»`);
        continue;
      }
      if (out[hit.field] !== undefined) continue;
      const parsed = parseProperty(hit.field, value);
      if (parsed === undefined) {
        if (hit.loose) unmappedProps.add(p.key.trim(), `«${owner}»`);
        else badValues.add(`«${p.key.trim()}» = «${value.length > 30 ? `${value.slice(0, 30)}…` : value}»`, `«${owner}»`);
      } else out[hit.field] = parsed;
    }
    return out as Fields;
  };

  const ownerOf = new Map<string, string>();
  const fields = new Map<string, Fields>();
  for (const n of nodes.values()) {
    const f = read(nameOf(n.raw), n.kind, n.raw.properties);
    fields.set(n.id, f);
    if (f.owner) ownerOf.set(n.id, unitFor(f.owner));
  }
  const streamFields = new Map<StreamPlan, Fields>();
  for (const plan of plans) {
    const anchor = elements.get(plan.anchor)!;
    if (plan.synthetic === 'chain') continue;
    const f = read(plan.name, plan.synthetic === 'single' ? 'single' : 'stream', anchor.properties);
    streamFields.set(plan, f);
    if (f.owner) ownerOf.set(streamIdOf.get(plan)!, unitFor(f.owner));
  }
  const stageFields = new Map<string, Fields>();
  for (const el of streamElements) {
    const own = stageIdOf.get(el.id);
    const plan = planOfRoot.get(rootOf(el.id))!;
    if (own && plan.synthetic === 'single') stageFields.set(own, streamFields.get(plan) ?? {});
    else if (own) stageFields.set(own, read(nameOf(el), 'stage', el.properties));
    else if (plan.anchor !== el.id) {
      for (const p of el.properties) if (p.value.trim()) unmappedProps.add(p.key.trim(), `«${nameOf(el)}»`);
    }
  }

  // ───── relaciones ─────
  const relations: Relation[] = [];
  const relationIds = new Set<string>();
  const signatures = new Set<string>();
  const skipped = new Tally();
  const converted = new Tally();
  const lostEndpoints = new Tally();
  const parentOf = new Map<string, string>();
  const extraParents = new Map<string, string[]>();
  const cycles: string[] = [];
  const audiences = new Map<string, string[]>();
  const stakeholders = new Map<string, string[]>();
  let relationOnRelation = 0;
  let missingEndpoints = 0;
  let selfRelations = 0;
  let mergedRelations = 0;
  const nameById = new Map([...nodes.values()].map((n) => [n.id, nameOf(n.raw)]));
  const addName = (map: Map<string, string[]>, key: string, name: string): void => void map.set(key, [...new Set([...(map.get(key) ?? []), name])]);
  const whoIs = (id: string): string | undefined => {
    const el = elements.get(id);
    return el && (el.type === 'Stakeholder' || TYPES.get(el.type)?.kind === 'unit') ? nameOf(el) : undefined;
  };

  const setParent = (childId: string, parentId: string, noun: string): void => {
    const current = parentOf.get(childId);
    if (current !== undefined) {
      if (current !== parentId) extraParents.set(childId, [...new Set([...(extraParents.get(childId) ?? []), parentId])]);
      return;
    }
    for (let p: string | undefined = parentId; p !== undefined; p = parentOf.get(p)) {
      if (p === childId) {
        cycles.push(`«${nameById.get(childId)}» y «${nameById.get(parentId)}» (${noun})`);
        return;
      }
    }
    parentOf.set(childId, parentId);
  };

  type End = { id: string; kind: ElementKind };
  const emit = (rule: Rule, source: End, target: End, link: Link, display: string): void => {
    const [from, to] = rule.reversed ? [target, source] : [source, target];
    if (from.id === to.id) {
      selfRelations += 1;
      return;
    }
    if (!RELATION_RULES[rule.kind].some(([a, b]) => a === from.kind && b === to.kind)) {
      skipped.add(`${link.type}|${kindWord(source.kind)}|${kindWord(target.kind)}`, display);
      return;
    }
    const signature = `${rule.kind}|${from.id}|${to.id}`;
    if (signatures.has(signature)) {
      mergedRelations += 1;
      return;
    }
    signatures.add(signature);
    if (rule.note) converted.add(`${link.type}|${kindWord(source.kind)}|${kindWord(target.kind)}|${RELATION_LABELS[rule.kind]}|${rule.note}`, display);
    const description = link.name?.replace(/\s+/g, ' ').trim();
    relations.push(compact({ id: pickId(`${from.id}--${rule.kind}--${to.id}`, relationIds), kind: rule.kind, sourceId: from.id, targetId: to.id, description: description || undefined }));
  };

  for (const l of effective) {
    if (consumed.has(l)) continue;
    const sourceEl = elements.get(l.source);
    const targetEl = elements.get(l.target);
    if (!sourceEl || !targetEl) {
      if (linkIds.has(l.source) || linkIds.has(l.target)) relationOnRelation += 1;
      else missingEndpoints += 1;
      continue;
    }
    const sv = streamOf.get(l.source);
    const tv = streamOf.get(l.target);
    const sn = nodes.get(l.source);
    const tn = nodes.get(l.target);
    const display = `«${nameOf(sourceEl)}» → «${nameOf(targetEl)}»`;
    const skip = (): void => void skipped.add(`${l.type}|${sv ? 'flujo de valor' : sn ? kindWord(sn.kind) : 'otro'}|${tv ? 'flujo de valor' : tn ? kindWord(tn.kind) : 'otro'}`, display);

    // A quién sirve un flujo de valor (su destinatario) o un servicio de negocio (su audiencia): una unidad o un Stakeholder.
    const who = l.type === 'Serving' ? whoIs(l.target) : undefined;
    if (who !== undefined && sv) {
      addName(stakeholders, sv.streamId, who);
      continue;
    }
    if (who !== undefined && sn?.kind === 'service') {
      addName(audiences, sn.id, who);
      continue;
    }

    // Un extremo que no se importa (motivación, estrategia…): la relación se pierde con él.
    if ((!sn && !sv) || (!tn && !tv)) {
      const gone = !sn && !sv ? l.source : l.target;
      lostEndpoints.add(isPassThrough(elements.get(gone)!.type) ? 'eventos o uniones con relaciones que no son disparos ni flujos' : `elementos ${groupOf.get(gone) ?? UNKNOWN_GROUP}`, display);
      continue;
    }

    // Flujos de valor.
    if (sv || tv) {
      const cap = sn?.kind === 'capability' ? sn : tn?.kind === 'capability' ? tn : undefined;
      const stream = sv ?? tv;
      if (sv && tv) {
        skip();
      } else if (cap && stream && (l.type === 'Association' || (cap === sn && (l.type === 'Serving' || l.type === 'Realization')))) {
        for (const stage of stream.stages) emit({ kind: 'enables' }, { id: cap.id, kind: 'capability' }, { id: stage, kind: 'stage' }, l, display);
        if (stream.stages.length > 1) converted.add(`${l.type}|capacidad|flujo de valor|${RELATION_LABELS.enables}|la capacidad que sirve a un flujo habilita todas sus etapas`, display);
      } else if (tv && sn?.kind === 'unit' && l.type === 'Assignment') {
        if (!ownerOf.has(tv.streamId)) ownerOf.set(tv.streamId, sn.id);
        converted.add('Assignment|unidad|flujo de valor|responsable|la unidad pasa a ser su responsable', display);
      } else skip();
      continue;
    }

    const source: End = { id: sn!.id, kind: sn!.kind };
    const target: End = { id: tn!.id, kind: tn!.kind };

    // Jerarquías de capacidades y de unidades.
    if ((l.type === 'Composition' || l.type === 'Aggregation') && source.kind === target.kind && (source.kind === 'capability' || source.kind === 'unit')) {
      // Una colaboración de negocio agrupa a quienes participan en ella, no es un nivel de la organización.
      if (sn!.raw.type === 'BusinessCollaboration') skipped.add(`${l.type}|colaboración de negocio|unidad`, display);
      else setParent(target.id, source.id, source.kind === 'unit' ? 'unidades' : 'capacidades');
      continue;
    }
    // Responsable: una unidad asignada a algo que no es un proceso.
    if (l.type === 'Assignment' && source.kind === 'unit' && ['capability', 'service', 'application', 'technology'].includes(target.kind)) {
      if (!ownerOf.has(target.id)) ownerOf.set(target.id, source.id);
      converted.add(`Assignment|unidad|${kindWord(target.kind)}|responsable|la unidad pasa a ser su responsable`, display);
      continue;
    }
    const rule = l.type === 'Association' ? associationRule(source.kind, target.kind) : (Object.hasOwn(RULES, l.type) ? RULES[l.type][`${source.kind}>${target.kind}`] : undefined);
    // Quien tiene asignado un proceso es, mientras no se diga otra cosa, su responsable (las reglas de gobierno miran `ownerId`).
    if (l.type === 'Assignment' && rule?.kind === 'assigned-to' && !ownerOf.has(target.id)) ownerOf.set(target.id, source.id);
    if (!rule) skip();
    else emit(l.type === 'Association' ? { ...rule, note: 'la asociación toma la relación que admiten los tipos de sus extremos' } : rule, source, target, l, display);
  }

  // ───── elementos del documento ─────
  const withOwner = <T extends { id: string }>(item: T): T => {
    const owner = ownerOf.get(item.id);
    return owner ? { ...item, ownerId: owner } : item;
  };
  const tagOf = (el: RawElement): string[] | undefined => (TYPES.get(el.type)?.tag ? [el.type] : undefined);
  const units: Unit[] = [];
  const capabilities: Capability[] = [];
  const processes: Process[] = [];
  const applications: Application[] = [];
  const technologies: Technology[] = [];
  const businessServices: BusinessService[] = [];
  for (const n of nodes.values()) {
    const name = nameOf(n.raw);
    const f = fields.get(n.id)!;
    const description = n.raw.documentation;
    switch (n.kind) {
      case 'unit':
        units.push(compact({ id: n.id, name, description, parentId: parentOf.get(n.id), external: f.external }));
        break;
      case 'capability':
        capabilities.push(withOwner(compact({ id: n.id, name, description, parentId: parentOf.get(n.id), importance: f.importance, maturity: f.maturity })));
        break;
      case 'process':
        processes.push(withOwner(compact({ id: n.id, name, description, tags: tagOf(n.raw) })));
        break;
      case 'service':
        businessServices.push(withOwner(compact({ id: n.id, name, description, audience: f.audience ?? audiences.get(n.id)?.join(', ') })));
        break;
      case 'application':
        applications.push(withOwner(compact({ id: n.id, name, description, technology: f.technology, vendor: f.vendor, lifecycle: f.lifecycle, criticality: f.criticality, external: f.external, annualCost: f.annualCost, users: f.users, strategy: f.strategy, endOfLife: f.endOfLife, ref: f.ref, tags: tagOf(n.raw) })));
        break;
      case 'technology': {
        const kind = f.kind ?? (n.raw.type === 'SystemSoftware' ? softwareKind(name) : (TYPES.get(n.raw.type)!.tech ?? 'platform'));
        technologies.push(withOwner(compact({ id: n.id, name, description, kind, version: f.version, lifecycle: f.lifecycle, endOfLife: f.endOfLife, ref: f.ref, tags: tagOf(n.raw) })));
        break;
      }
    }
  }
  const valueStreams: ValueStream[] = [];
  const valueStages: ValueStage[] = [];
  for (const plan of plans) {
    const streamId = streamIdOf.get(plan)!;
    const f = streamFields.get(plan) ?? {};
    const stakeholder = f.stakeholder ?? stakeholders.get(streamId)?.join(', ');
    valueStreams.push(withOwner(compact({ id: streamId, name: plan.name, description: plan.description, stakeholder })));
    for (const stage of plan.stages) {
      const el = elements.get(stage)!;
      valueStages.push(compact({ id: stageIdOf.get(stage)!, name: nameOf(el), description: plan.synthetic === 'single' ? undefined : el.documentation, streamId, value: stageFields.get(stageIdOf.get(stage)!)?.value }));
    }
  }

  // Propiedades de las relaciones y del modelo: no se importan.
  for (const l of links) for (const p of l.properties) if (p.value.trim()) unmappedProps.add(p.key.trim(), `relación ${l.type}`);
  for (const p of raw.properties) if (p.value.trim()) unmappedProps.add(p.key.trim(), 'el modelo');

  // ───── avisos ─────
  for (const group of [...UNMAPPED_GROUPS.map((g) => g.phrase), UNKNOWN_GROUP]) {
    const list = unmapped.get(group);
    if (!list) continue;
    const types = [...new Set(list.map((e) => e.type))].sort();
    warnings.add(`${plural(list.length, 'elemento', 'elementos')} ${group} sin equivalente en el módulo, ${list.length === 1 ? 'no se importa' : 'no se importan'} (${types.join(', ')}): ${quoted(list.map((e) => e.name))}.`);
  }
  if (unnamed.length > 0) warnings.add(`${plural(unnamed.length, 'elemento sin nombre', 'elementos sin nombre')}: ${unnamed.length === 1 ? 'se importa' : 'se importan'} como «Sin nombre (identificador)».`);
  if (repeatedIds > 0) warnings.add(`${plural(repeatedIds, 'identificador repetido', 'identificadores repetidos')} en el archivo: se conserva la primera definición.`);
  if (usedPassThrough.size > 0) {
    const junctions = [...usedPassThrough].filter((id) => JUNCTIONS.has(elements.get(id)!.type)).length;
    const events = usedPassThrough.size - junctions;
    const parts = [junctions > 0 ? plural(junctions, 'unión (And/Or)', 'uniones (And/Or)') : '', events > 0 ? plural(events, 'evento', 'eventos') : ''].filter(Boolean);
    warnings.add(`${parts.join(' y ')} ${usedPassThrough.size === 1 ? 'no se importa' : 'no se importan'} como elemento: sus relaciones se sustituyen por relaciones directas entre sus extremos.`);
  }
  if (lostThrough > 0) warnings.add(`${plural(lostThrough, 'relación omitida', 'relaciones omitidas')} por entrar o salir de una unión o un evento sin continuación compatible (una unión exige relaciones del mismo tipo y un evento solo sigue disparos y flujos).`);
  const singles = plans.filter((p) => p.synthetic === 'single');
  if (singles.length > 0) warnings.add(`${plural(singles.length, 'flujo de valor sin etapas', 'flujos de valor sin etapas')} (${quoted(singles.map((p) => p.name))}): ${singles.length === 1 ? 'recibe' : 'reciben'} una etapa con su mismo nombre.`);
  const chains = plans.filter((p) => p.synthetic === 'chain');
  if (chains.length > 0) warnings.add(`${plural(chains.length, 'cadena de flujos de valor sueltos', 'cadenas de flujos de valor sueltos')} unidos por flujo o disparo: pasan a ser las etapas de un flujo nuevo (${quoted(chains.map((p) => p.name))}).`);
  if (flattened.length > 0) warnings.add(`Etapas con subetapas aplanadas (solo se conservan las subetapas): ${quoted(flattened)}.`);

  const examples = (c: { count: number; examples: string[] }): string => `${c.examples.join(', ')}${c.count > c.examples.length ? ` y ${c.count - c.examples.length} más` : ''}`;
  const rels = (n: number): string => `${n} ${n === 1 ? 'relación' : 'relaciones'}`;
  const omitted = (n: number): string => (n === 1 ? 'omitida' : 'omitidas');
  const lost = lostEndpoints.entries();
  if (lost.length > 0) {
    const count = lost.reduce((n, [, c]) => n + c.count, 0);
    const reasons = lost.map(([reason, c]) => `${reason} (${c.count})`).join(', ');
    warnings.add(`${rels(count)} ${omitted(count)} porque un extremo no se importa: ${reasons}. Por ejemplo, ${lost.flatMap(([, c]) => c.examples).slice(0, 3).join(', ')}.`);
  }
  if (relationOnRelation > 0) warnings.add(`${rels(relationOnRelation)} ${omitted(relationOnRelation)} por unir una relación con otro elemento, que el módulo no admite.`);
  if (missingEndpoints > 0) warnings.add(`${rels(missingEndpoints)} ${omitted(missingEndpoints)} por apuntar a un identificador que no existe en el modelo.`);
  for (const [key, c] of skipped.entries()) {
    const [type, from, to] = key.split('|');
    warnings.add(`${rels(c.count)} ${type} (${from} → ${to}) sin equivalente en el módulo, ${omitted(c.count)}: ${examples(c)}.`);
  }
  for (const [key, c] of converted.entries()) {
    const [type, from, to, result, note] = key.split('|');
    warnings.add(`${rels(c.count)} ${type} (${from} → ${to}) se ${c.count === 1 ? 'importa' : 'importan'} como ${result === 'responsable' ? 'responsable' : `«${result}»`} (${note}): ${examples(c)}.`);
  }
  if (mergedRelations > 0) warnings.add(`${rels(mergedRelations)} ${omitted(mergedRelations)} por repetir otra igual tras la conversión.`);
  if (selfRelations > 0) warnings.add(`${plural(selfRelations, 'relación omitida', 'relaciones omitidas')} por unir un elemento consigo mismo tras sustituir uniones o eventos.`);
  for (const [child, parents] of extraParents) {
    const all = [parentOf.get(child)!, ...parents].map((id) => nameById.get(id) ?? id);
    warnings.add(`«${nameById.get(child)}» tiene varios padres (${quoted(all)}): se conserva «${all[0]}».`);
  }
  if (cycles.length > 0) warnings.add(`${plural(cycles.length, 'jerarquía circular omitida', 'jerarquías circulares omitidas')}: ${cycles.join('; ')}.`);
  if (createdUnits.length > 0) warnings.add(`${plural(createdUnits.length, 'unidad creada', 'unidades creadas')} a partir de la propiedad de responsable (el modelo no tiene un actor con ese nombre): ${quoted(createdUnits.map((u) => u.name))}.`);
  if (unmappedProps.entries().length > 0) {
    const entries = unmappedProps.entries().sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    warnings.add(`Propiedades sin equivalente en el módulo, no se importan: ${entries.slice(0, 10).map(([k, c]) => `«${k}» (${c.count})`).join(', ')}${entries.length > 10 ? ` y ${entries.length - 10} más` : ''}.`);
  }
  if (badValues.entries().length > 0) {
    const entries = badValues.entries();
    warnings.add(`${plural(entries.length, 'valor de propiedad no se entiende y se omite', 'valores de propiedad no se entienden y se omiten')}: ${entries.slice(0, 5).map(([v, c]) => `${v} en ${c.examples.join(', ')}`).join('; ')}${entries.length > 5 ? '…' : ''}.`);
  }
  if (raw.views.length > 0) warnings.add(`${plural(raw.views.length, 'vista (diagrama) no se importa', 'vistas (diagramas) no se importan')}: el módulo deriva las suyas del modelo (${quoted(raw.views, 3)}).`);

  // ───── el documento ─────
  const all = [...units, ...createdUnits, ...capabilities, ...processes, ...applications, ...technologies, ...businessServices, ...valueStreams];
  if (all.length === 0) {
    throw new EnterpriseImportError(
      raw.elements.length === 0 ? 'El modelo de ArchiMate no contiene elementos.' : `Ningún elemento del modelo de ArchiMate se puede importar: los ${raw.elements.length} que tiene no tienen equivalente en el módulo empresarial.`,
    );
  }
  const name = options.name?.trim() || raw.name?.trim() || options.fallbackName?.replace(/\.(archimate|xml)$/i, '').trim() || 'Arquitectura empresarial';
  const result = validateEnterpriseDocument({
    version: ENTERPRISE_DOCUMENT_VERSION,
    workspace: { name, ...(raw.documentation ? { description: raw.documentation } : {}) },
    units: [...units, ...createdUnits],
    capabilities,
    processes,
    applications,
    technologies,
    valueStreams,
    valueStages,
    businessServices,
    relations,
  });
  if (!result.ok) throw new EnterpriseImportError(`No se pudo construir un documento válido a partir del modelo de ArchiMate:\n${formatEnterpriseIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
