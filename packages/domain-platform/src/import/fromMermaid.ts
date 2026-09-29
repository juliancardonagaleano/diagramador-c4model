import {
  detectMermaidKind,
  MERMAID_DIAGRAM_KINDS,
  ModuleError,
  parseFlowchart,
  pickId,
  preprocessMermaid,
  splitLabel,
  Warnings,
  type FlowLineStyle,
  type FlowNodeRef,
} from '@iark/kernel';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import {
  PLATFORM_DOCUMENT_VERSION,
  RESOURCE_KINDS,
  SERVICE_KINDS,
  type Criticality,
  type Dependency,
  type DependencyKind,
  type Deployment,
  type Environment,
  type EnvironmentKind,
  type Exposure,
  type Network,
  type PlatformDocument,
  type Resource,
  type ResourceKind,
  type ResourceStatus,
  type Service,
  type ServiceKind,
} from '../types';

export class PlatformImportError extends ModuleError {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformImportError';
  }
}

export interface PlatformImportOptions {
  name?: string;
  fallbackName?: string;
}

export interface PlatformImportResult {
  document: PlatformDocument;
  warnings: string[];
}

export const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const normalize = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Clases (sin acentos ni separadores) con las que se reconoce el tipo de un nodo, en inglés y en español. */
const CLASS_KINDS: Record<string, { service?: ServiceKind; external?: true; resource?: ResourceKind }> = {
  ...Object.fromEntries(SERVICE_KINDS.map((k) => [k, { service: k }])),
  servicio: { service: 'service' },
  external: { service: 'service', external: true },
  externo: { service: 'service', external: true },
  ...Object.fromEntries(RESOURCE_KINDS.map((k) => [normalize(k), { resource: k }])),
  basededatos: { resource: 'database' },
  bd: { resource: 'database' },
  db: { resource: 'database' },
  cola: { resource: 'queue' },
  broker: { resource: 'queue' },
  balanceador: { resource: 'load-balancer' },
  lb: { resource: 'load-balancer' },
  pasarela: { resource: 'gateway' },
  almacenamiento: { resource: 'storage' },
  maquinavirtual: { resource: 'vm' },
};
const STATUS_CLASSES: Record<string, ResourceStatus> = { planned: 'planned', previsto: 'planned', decommissioned: 'decommissioned', dadodebaja: 'decommissioned' };

type GroupInfo =
  | { type: 'environment'; name: string }
  | { type: 'network'; name: string; exposure?: Exposure; cidr?: string }
  | { type: 'host'; name: string; kind: 'cluster' | 'vm' }
  | { type: 'pipeline' }
  | { type: 'other' };

const EXPOSURE_WORDS: Record<string, Exposure> = { publica: 'public', privada: 'private', aislada: 'isolated', public: 'public', private: 'private', isolated: 'isolated' };

/** Tipo de un `subgraph` a partir del prefijo que le pone el exportador («Entorno: Producción», «Red pública: DMZ (10.0.0.0/24)», «Clúster: k8s»). */
function classifyGroup(label: string): GroupInfo {
  const text = splitLabel(label).name;
  let m = /^entorno:\s*(.+)$/i.exec(text);
  if (m) return { type: 'environment', name: m[1].trim() };
  m = /^red(?:\s+(\S+))?:\s*(.+)$/i.exec(text);
  if (m && (m[1] === undefined || normalize(m[1]) in EXPOSURE_WORDS)) {
    const cidr = /\s*\(([0-9a-fA-F:./]+)\)$/.exec(m[2]);
    return {
      type: 'network',
      name: (cidr ? m[2].slice(0, cidr.index) : m[2]).trim(),
      ...(m[1] ? { exposure: EXPOSURE_WORDS[normalize(m[1])] } : {}),
      ...(cidr ? { cidr: cidr[1] } : {}),
    };
  }
  m = /^(cl[uú]ster|m[aá]quina virtual|vm):\s*(.+)$/i.exec(text);
  if (m) return { type: 'host', name: m[2].trim(), kind: /^cl/i.test(m[1]) ? 'cluster' : 'vm' };
  if (/^(ci\/cd|ci|cd|infraestructura como c[oó]digo):\s*/i.test(text)) return { type: 'pipeline' };
  return { type: 'other' };
}

const ENVIRONMENT_WORDS: Array<[EnvironmentKind, RegExp]> = [
  ['dr', /^dr$|desastre|recuperacion|disaster/],
  ['staging', /stag|preprod|uat/],
  ['test', /test|prueba|^qa|integracion/],
  ['dev', /^dev|desarrollo/],
  ['prod', /prod/],
];
const environmentKind = (name: string): EnvironmentKind | undefined => ENVIRONMENT_WORDS.find(([, re]) => re.test(normalize(name)))?.[0];

/** Descripción de una instancia: la tecnología y, al final, `3 réplicas` y/o `v1.4.2` (así las escribe el exportador). */
function instanceDetails(description: string | undefined): { technology?: string; replicas?: number; version?: string } {
  const m = /^(.*?)\s*(?:(\d+) réplicas?)?\s*(?:·\s*)?(?:v(\d[\w.+-]*))?$/.exec(description ?? '');
  if (!m || (!m[2] && !m[3])) return description ? { technology: description } : {};
  return { ...(m[1] ? { technology: m[1] } : {}), ...(m[2] ? { replicas: Number(m[2]) } : {}), ...(m[3] ? { version: m[3] } : {}) };
}

const CRITICALITY_WORDS: Record<string, Criticality> = { baja: 'low', media: 'medium', alta: 'high', critica: 'critical' };

/** Quita del final de un texto lo que añade el exportador a un servicio (`criticidad alta`) o a un recurso (`entorno Producción`). */
function stripExtras(description: string | undefined): { text?: string; criticality?: Criticality; environment?: string } {
  let text = description;
  let criticality: Criticality | undefined;
  let environment: string | undefined;
  const c = text ? /\s*criticidad (baja|media|alta|cr[ií]tica)$/i.exec(text) : null;
  if (c) {
    criticality = CRITICALITY_WORDS[normalize(c[1])];
    text = text!.slice(0, c.index);
  }
  const e = text ? /(?:^|\s+)entorno (.+)$/i.exec(text) : null;
  if (e) {
    environment = e[1].trim();
    text = text!.slice(0, e.index);
  }
  return { text: text?.trim() || undefined, criticality, environment };
}

interface Group {
  alias: string;
  label: string;
  seq: number;
  parent?: string;
  info: GroupInfo;
}

/**
 * Importa un `flowchart` de Mermaid como documento de plataforma. Los `subgraph` con el prefijo que pone el exportador se
 * reconocen como `Entorno: …`, `Red pública|privada|aislada: …` (con su CIDR entre paréntesis) y `Clúster: …` / `Máquina
 * virtual: …`; un servicio dentro de un clúster queda desplegado en él (con `3 réplicas · v1.4.2` al final del texto), y
 * los servicios con el mismo nombre en varios entornos son un solo servicio con varios despliegues. El tipo de cada nodo
 * sale de su clase (`:::database`, `:::worker`, `:::external`, en inglés o en español) y, si no, de su forma (`[( )]` =
 * base de datos, `([ ])` = cola); `class X planned|decommissioned` da el estado del recurso. Las flechas son
 * dependencias: continua = llama, punteada = mensajes, gruesa = datos (la etiqueta `protocolo · descripción`).
 */
export function fromMermaid(source: string, options: PlatformImportOptions = {}): PlatformImportResult {
  const { lines, title } = preprocessMermaid(source);
  if (lines.length === 0) throw new PlatformImportError('El texto de Mermaid está vacío.');
  const kind = detectMermaidKind(lines[0].text);
  if (kind !== 'flowchart') {
    throw new PlatformImportError(
      kind
        ? `Un diagrama de Mermaid «${lines[0].text.split(/\s+/)[0]}» no se puede importar como plataforma. Se admite flowchart/graph.`
        : `No se reconoce el tipo de diagrama de Mermaid («${lines[0].text.split(/\s+/)[0]}»). Se admiten: ${MERMAID_DIAGRAM_KINDS.join(', ')}.`,
    );
  }
  const warnings = new Warnings();
  const groups = new Map<string, Group>();
  const nodes = new Map<string, { ref: FlowNodeRef; classes: Set<string>; group?: string; seq: number }>();
  const edges: Array<{ from: string[]; to: string[]; label?: string; line: FlowLineStyle; where: string }> = [];
  const stack: string[] = [];
  let seq = 0;

  for (const ev of parseFlowchart(lines.slice(1))) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'subgraph-start') {
      groups.set(ev.alias, { alias: ev.alias, label: ev.label, seq: seq++, parent: stack[stack.length - 1], info: classifyGroup(ev.label) });
      stack.push(ev.alias);
    } else if (ev.type === 'subgraph-end') stack.pop();
    else if (ev.type === 'node') {
      const known = nodes.get(ev.node.alias);
      if (!known) nodes.set(ev.node.alias, { ref: { ...ev.node }, classes: new Set(ev.node.classes), group: stack[stack.length - 1], seq: seq++ });
      else {
        for (const c of ev.node.classes ?? []) known.classes.add(c);
        if (ev.node.label !== undefined) known.ref = { ...known.ref, label: ev.node.label, shape: ev.node.shape ?? known.ref.shape };
        if (known.group === undefined && stack.length > 0) known.group = stack[stack.length - 1];
      }
    } else {
      const from = ev.from.map((n) => n.alias);
      const to = ev.to.map((n) => n.alias);
      edges.push({ from, to, label: ev.label, line: ev.line, where: ev.where });
      if (ev.bidirectional) edges.push({ from: to, to: from, label: ev.label, line: ev.line, where: ev.where });
    }
  }

  const ancestors = (start: string | undefined): Group[] => {
    const list: Group[] = [];
    for (let a = start; a !== undefined && !list.some((g) => g.alias === a); a = groups.get(a)?.parent) {
      const g = groups.get(a);
      if (g) list.push(g);
    }
    return list;
  };
  const inPipeline = (start: string | undefined): boolean => ancestors(start).some((g) => g.info.type === 'pipeline');
  /** Un paso de un pipeline (vista de entrega continua): no se importa. */
  const isStep = (alias: string): boolean => {
    const n = nodes.get(alias);
    return n !== undefined && (inPipeline(n.group) || n.classes.has('step'));
  };

  const ids = new Set<string>();
  const environments: Environment[] = [];
  const networks: Network[] = [];
  const resources: Resource[] = [];
  const services: Service[] = [];
  const deployments: Deployment[] = [];
  const environmentOf = new Map<string, string>(); // alias del grupo → id del entorno
  const entityOf = new Map<string, { id: string; kind: 'service' | 'resource' }>(); // alias de nodo o de anfitrión → elemento
  const networkOf = new Map<string, string>();
  const serviceByName = new Map<string, Service>();
  let fallbackEnvironment: string | undefined;

  const newEnvironment = (alias: string, name: string): string => {
    const id = pickId(slug(alias.replace(/^env[_-]?/i, '')) || slug(name) || 'entorno', ids);
    const k = environmentKind(name);
    environments.push({ id, name, ...(k ? { kind: k } : {}) });
    return id;
  };
  /** Entorno con ese nombre (el que nombra un recurso de la topología), creándolo si no existe. */
  const environmentNamed = (name: string): string => environments.find((e) => e.name.toLowerCase() === name.toLowerCase())?.id ?? newEnvironment(name, name);
  /** Entorno de un nodo o grupo: el del `subgraph` que lo contiene o, si no hay, uno por defecto. */
  const environmentFor = (start: string | undefined, what: string): string => {
    const g = ancestors(start).find((x) => x.info.type === 'environment');
    if (g) return environmentOf.get(g.alias)!;
    if (!fallbackEnvironment) {
      fallbackEnvironment = newEnvironment('produccion', 'Producción');
      warnings.add(`El diagrama no declara ningún entorno («Entorno: …») para ${what}: se crea el entorno «Producción».`);
    }
    return fallbackEnvironment;
  };

  // Todo se crea en el orden en que aparece en el texto.
  const entries = [
    ...[...groups.values()].map((g) => ({ seq: g.seq, group: g })),
    ...[...nodes.values()].filter((n) => !(groups.has(n.ref.alias) && groups.get(n.ref.alias)!.info.type !== 'other')).map((n) => ({ seq: n.seq, node: n })),
  ].sort((a, b) => a.seq - b.seq);
  let ignored = 0;

  for (const entry of entries) {
    if ('group' in entry) {
      const { alias, info, parent } = entry.group;
      if (info.type === 'environment') environmentOf.set(alias, newEnvironment(alias, info.name));
      else if (info.type === 'network') {
        const id = pickId(slug(alias) || slug(info.name) || 'red', ids);
        const parentNetwork = ancestors(parent).find((g) => g.info.type === 'network');
        networkOf.set(alias, id);
        networks.push({
          id,
          name: info.name,
          environmentId: environmentFor(parent, `la red «${info.name}»`),
          ...(parentNetwork ? { parentId: networkOf.get(parentNetwork.alias)! } : {}),
          ...(info.exposure ? { exposure: info.exposure } : {}),
          ...(info.cidr ? { cidr: info.cidr } : {}),
        });
      } else if (info.type === 'host') {
        const id = pickId(slug(alias) || slug(info.name) || info.kind, ids);
        const network = ancestors(parent).find((g) => g.info.type === 'network');
        entityOf.set(alias, { id, kind: 'resource' });
        resources.push({ id, name: info.name, kind: info.kind, environmentId: environmentFor(parent, `«${info.name}»`), ...(network ? { networkId: networkOf.get(network.alias)! } : {}) });
      } else if (info.type === 'other') warnings.add(`El subgraph «${splitLabel(entry.group.label).name}» no es un entorno, una red ni un clúster: se ignora y sus nodos se importan sin agrupar.`);
      continue;
    }

    const { ref, classes, group } = entry.node;
    if (isStep(entry.node.ref.alias)) {
      ignored += 1;
      continue;
    }
    const label = splitLabel(ref.label ?? ref.alias);
    const name = label.name || ref.alias;
    const extras = stripExtras(label.description);
    const found = [...classes].map((c) => CLASS_KINDS[normalize(c)]).find((k) => k !== undefined);
    const byShape = ref.shape === 'cylinder' ? { resource: 'database' as const } : ref.shape === 'stadium' ? { resource: 'queue' as const } : undefined;
    const chosen: { service?: ServiceKind; external?: boolean; resource?: ResourceKind } = found ?? byShape ?? { service: 'service' };
    const host = ancestors(group).find((g) => g.info.type === 'host');
    const network = ancestors(group).find((g) => g.info.type === 'network');

    if (chosen.resource) {
      const status = [...classes].map((c) => STATUS_CLASSES[normalize(c)]).find((s) => s !== undefined);
      const id = pickId(slug(ref.alias) || slug(name) || chosen.resource, ids);
      // El exportador escribe «tecnología · versión».
      const [technology, ...versionParts] = (extras.text ?? '').split(' · ');
      const version = versionParts.join(' · ');
      entityOf.set(ref.alias, { id, kind: 'resource' });
      if (host) warnings.add(`«${name}» está dentro del clúster «${host.info.type === 'host' ? host.info.name : host.label}», pero es un recurso y no un servicio: se importa sin anfitrión.`);
      resources.push({
        id,
        name,
        kind: chosen.resource,
        environmentId: extras.environment && !ancestors(group).some((g) => g.info.type === 'environment') ? environmentNamed(extras.environment) : environmentFor(group, `«${name}»`),
        ...(network ? { networkId: networkOf.get(network.alias)! } : {}),
        ...(technology ? { technology } : {}),
        ...(version ? { version } : {}),
        ...(status ? { status } : {}),
      });
      continue;
    }

    const details = host ? instanceDetails(extras.text) : { technology: extras.text };
    let service = serviceByName.get(name.toLowerCase());
    if (!service) {
      service = {
        id: pickId(slug(ref.alias) || slug(name) || 'servicio', ids),
        name,
        ...(chosen.service && chosen.service !== 'service' ? { kind: chosen.service } : {}),
        ...(details.technology ? { technology: details.technology } : {}),
        ...(chosen.external ? { external: true } : {}),
        ...(extras.criticality ? { criticality: extras.criticality } : {}),
      };
      serviceByName.set(name.toLowerCase(), service);
      services.push(service);
    }
    entityOf.set(ref.alias, { id: service.id, kind: 'service' });
    if (host && host.info.type === 'host' && !service.external) {
      const hostId = entityOf.get(host.alias)!.id;
      const environmentId = resources.find((r) => r.id === hostId)!.environmentId;
      if (!deployments.some((d) => d.serviceId === service!.id && d.hostId === hostId)) {
        deployments.push({
          id: pickId(`${service.id}-${environmentId}`, new Set(deployments.map((d) => d.id))),
          serviceId: service.id,
          environmentId,
          hostId,
          ...(details.replicas ? { replicas: details.replicas } : {}),
          ...(details.version ? { version: details.version } : {}),
        });
      }
    } else if (!service.external && ancestors(group).some((g) => g.info.type === 'environment' || g.info.type === 'network')) {
      warnings.add(`«${name}» está en un entorno o una red pero no dentro de un clúster o una máquina virtual: se importa sin despliegue.`);
    }
  }
  if (ignored > 0) warnings.add(`Se ignoraron ${ignored} paso(s) de pipeline: los pipelines se describen en el JSON, no en Mermaid.`);

  const dependencies: Dependency[] = [];
  const dependencyIds = new Set<string>();
  const signatures = new Set<string>();
  for (const e of edges) {
    const kindOfEdge: DependencyKind = e.line === 'dotted' ? 'messages' : e.line === 'thick' ? 'data' : 'calls';
    const [protocol, ...rest] = e.label ? splitLabel(e.label).name.split(' · ') : [];
    const description = rest.join(' · ');
    for (const a of e.from) {
      for (const b of e.to) {
        const [source, target] = [entityOf.get(a), entityOf.get(b)];
        if (!source || !target) {
          if (!isStep(a) && !isStep(b)) warnings.add(`${e.where}: la arista ${a} → ${b} no se puede importar; se omite.`);
          continue;
        }
        if (source.id === target.id) {
          if (a === b) warnings.add(`${e.where}: «${a}» depende de sí mismo; se omite.`);
          continue;
        }
        const signature = `${kindOfEdge}|${source.id}|${target.id}`;
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        dependencies.push({
          id: pickId(`${source.id}--${target.id}`, dependencyIds),
          sourceId: source.id,
          targetId: target.id,
          kind: kindOfEdge,
          ...(protocol && rest.length > 0 ? { protocol } : {}),
          ...(rest.length > 0 ? (description ? { description } : {}) : protocol ? { description: protocol } : {}),
        });
      }
    }
  }

  if (services.length + resources.length === 0) throw new PlatformImportError('El diagrama de Mermaid no define ningún servicio ni recurso que se pueda importar.');
  const name = options.name?.trim() || title?.trim() || options.fallbackName?.trim() || 'Arquitectura de plataforma';
  const result = validatePlatformDocument({
    version: PLATFORM_DOCUMENT_VERSION,
    workspace: { name },
    environments,
    networks,
    resources,
    services,
    deployments,
    dependencies,
    pipelines: [],
  });
  if (!result.ok) throw new PlatformImportError(`No se pudo construir un documento válido a partir de Mermaid:\n${formatPlatformIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
