import {
  detectMermaidKind,
  MERMAID_DIAGRAM_KINDS,
  ModuleError,
  pickId,
  parseFlowchart,
  preprocessMermaid,
  splitLabel,
  Warnings,
  type FlowNodeRef,
} from '@iark/kernel';
import { formatEnterpriseIssues, validateEnterpriseDocument } from '../schema';
import { ENTERPRISE_DOCUMENT_VERSION, KIND_LABELS, relationBetween, type Application, type Capability, type DrawnKind, type EnterpriseDocument, type Process, type Relation, type Technology } from '../types';

export class EnterpriseImportError extends ModuleError {
  constructor(message: string) {
    super(message);
    this.name = 'EnterpriseImportError';
  }
}

export interface EnterpriseImportOptions {
  name?: string;
  fallbackName?: string;
}

export interface EnterpriseImportResult {
  document: EnterpriseDocument;
  warnings: string[];
}

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Nombres (sin acentos, en minúsculas) con los que se reconoce un tipo: en la clase de un nodo o en el título de una capa. */
const KIND_WORDS: Record<DrawnKind, string[]> = {
  capability: ['capability', 'capabilities', 'capacidad', 'capacidades'],
  process: ['process', 'processes', 'proceso', 'procesos'],
  application: ['application', 'applications', 'app', 'apps', 'aplicacion', 'aplicaciones'],
  technology: ['technology', 'technologies', 'tech', 'tecnologia', 'tecnologias'],
};
const normalize = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const kindFromWord = (word: string): DrawnKind | undefined => (Object.keys(KIND_WORDS) as DrawnKind[]).find((k) => KIND_WORDS[k].includes(normalize(word)));

interface Group {
  alias: string;
  label: string;
  /** Orden de aparición en el texto, para conservarlo en el documento. */
  seq: number;
  parent?: string;
  /** Un `subgraph` cuyo título es un tipo («Aplicaciones») es una capa, no una capacidad. */
  layer?: DrawnKind;
}

/**
 * Importa un `flowchart` de Mermaid como documento empresarial. El tipo de cada nodo sale, por este orden, de su clase
 * (`:::application`, `class A capability`; también en español), del título de la capa que lo contiene («Aplicaciones»),
 * de su forma (`([ ])` = proceso, `[( )]` = tecnología) y, por último, de que esté dentro de un grupo (capacidad) o no
 * (aplicación). Un `subgraph` que no es una capa es una capacidad que contiene a las suyas. Cada flecha se convierte en
 * la relación que admiten sus extremos (en cualquier sentido); la segunda línea del texto de una aplicación es su
 * tecnología y la de una tecnología, su versión.
 */
export function fromMermaid(source: string, options: EnterpriseImportOptions = {}): EnterpriseImportResult {
  const { lines, title } = preprocessMermaid(source);
  if (lines.length === 0) throw new EnterpriseImportError('El texto de Mermaid está vacío.');
  const kind = detectMermaidKind(lines[0].text);
  if (kind !== 'flowchart') {
    throw new EnterpriseImportError(
      kind
        ? `Un diagrama de Mermaid «${lines[0].text.split(/\s+/)[0]}» no se puede importar como arquitectura empresarial. Se admite flowchart/graph.`
        : `No se reconoce el tipo de diagrama de Mermaid («${lines[0].text.split(/\s+/)[0]}»). Se admiten: ${MERMAID_DIAGRAM_KINDS.join(', ')}.`,
    );
  }
  const warnings = new Warnings();
  const groups = new Map<string, Group>();
  const nodes = new Map<string, { ref: FlowNodeRef; classes: Set<string>; group?: string; seq: number }>();
  let seq = 0;
  const edges: Array<{ from: string[]; to: string[]; label?: string; where: string }> = [];
  const stack: string[] = [];

  for (const ev of parseFlowchart(lines.slice(1))) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'subgraph-start') {
      groups.set(ev.alias, { alias: ev.alias, label: ev.label, seq: seq++, parent: stack[stack.length - 1], layer: kindFromWord(splitLabel(ev.label).name) });
      stack.push(ev.alias);
    } else if (ev.type === 'subgraph-end') stack.pop();
    else if (ev.type === 'node') {
      const known = nodes.get(ev.node.alias);
      if (!known) nodes.set(ev.node.alias, { ref: { ...ev.node }, classes: new Set(ev.node.classes), group: stack[stack.length - 1], seq: seq++ });
      else {
        for (const c of ev.node.classes ?? []) known.classes.add(c);
        if (ev.node.label !== undefined) known.ref = { ...known.ref, label: ev.node.label, shape: ev.node.shape ?? known.ref.shape };
      }
    } else {
      const from = ev.from.map((n) => n.alias);
      const to = ev.to.map((n) => n.alias);
      edges.push({ from, to, label: ev.label, where: ev.where });
      if (ev.bidirectional) edges.push({ from: to, to: from, label: ev.label, where: ev.where });
    }
  }

  // El grupo «real» de un nodo o de un grupo: el ancestro más cercano que no es una capa, y la capa más cercana.
  const climb = (start: string | undefined, want: (g: Group) => boolean): Group | undefined => {
    for (let a = start; a !== undefined; a = groups.get(a)?.parent) {
      const g = groups.get(a);
      if (g && want(g)) return g;
    }
    return undefined;
  };

  const ids = new Set<string>();
  const idOf = new Map<string, string>();
  const kindOf = new Map<string, DrawnKind>();
  const capabilities: Capability[] = [];
  const processes: Process[] = [];
  const applications: Application[] = [];
  const technologies: Technology[] = [];
  const take = (alias: string, name: string, fallback: string): string => {
    const id = pickId(slug(alias) || slug(name) || fallback, ids);
    idOf.set(alias, id);
    return id;
  };

  // Los elementos se crean en el orden en que aparecen en el texto.
  const entries = [
    ...[...groups.values()].filter((g) => !g.layer).map((g) => ({ seq: g.seq, group: g })),
    ...[...nodes.values()].filter((n) => !(groups.has(n.ref.alias) && !groups.get(n.ref.alias)!.layer)).map((n) => ({ seq: n.seq, node: n })),
  ].sort((a, b) => a.seq - b.seq);
  // (una arista a un subgraph ya es la capacidad de ese grupo, no un nodo aparte)

  for (const entry of entries) {
    if ('group' in entry) {
      const g = entry.group;
      const name = splitLabel(g.label).name || g.alias;
      const id = take(g.alias, name, 'capacidad');
      kindOf.set(g.alias, 'capability');
      const parent = climb(g.parent, (x) => !x.layer);
      capabilities.push({ id, name, ...(parent ? { parentId: idOf.get(parent.alias) } : {}) });
      continue;
    }
    const { ref, classes, group } = entry.node;
    const label = splitLabel(ref.label ?? ref.alias);
    const name = label.name || ref.alias;
    const container = climb(group, (g) => !g.layer);
    const layer = climb(group, (g) => g.layer !== undefined)?.layer;
    const byClass = [...classes].map(kindFromWord).find((k) => k !== undefined);
    const byShape: DrawnKind | undefined = ref.shape === 'stadium' ? 'process' : ref.shape === 'cylinder' ? 'technology' : undefined;
    const k: DrawnKind = byClass ?? layer ?? byShape ?? (container ? 'capability' : 'application');
    kindOf.set(ref.alias, k);
    const id = take(ref.alias, name, k);
    if (k === 'capability') {
      const parent = container && !layer ? idOf.get(container.alias) : undefined;
      capabilities.push({ id, name, ...(parent ? { parentId: parent } : {}) });
      if (container && layer) warnings.add(`«${name}» está dentro del grupo «${container.label}» y de una capa: se importa sin capacidad padre.`);
    } else {
      if (container && !layer) warnings.add(`«${name}» está dentro del grupo «${container.label}» pero es ${KIND_LABELS[k].toLowerCase()}, no una capacidad: se importa sin padre.`);
      if (k === 'process') processes.push({ id, name });
      else if (k === 'application') applications.push({ id, name, ...(label.description ? { technology: label.description } : {}) });
      else technologies.push({ id, name, ...(label.description ? { version: label.description } : {}) });
    }
  }

  const relationIds = new Set<string>();
  const signatures = new Set<string>();
  const relations: Relation[] = [];
  const nameOf = (alias: string): string => {
    const id = idOf.get(alias);
    return [...capabilities, ...processes, ...applications, ...technologies].find((x) => x.id === id)?.name ?? alias;
  };
  for (const e of edges) {
    const description = e.label ? splitLabel(e.label).name : '';
    for (const a of e.from) {
      for (const b of e.to) {
        if (!idOf.has(a) || !idOf.has(b) || a === b) {
          if (a !== b) warnings.add(`${e.where}: la arista ${a} → ${b} no se puede importar; se omite.`);
          continue;
        }
        const [ka, kb] = [kindOf.get(a)!, kindOf.get(b)!];
        const rule = relationBetween(ka, kb);
        if (!rule) {
          warnings.add(`${e.where}: «${nameOf(a)}» → «${nameOf(b)}» une ${KIND_LABELS[ka].toLowerCase()} con ${KIND_LABELS[kb].toLowerCase()}, que no se relacionan; se omite${ka === 'capability' && kb === 'capability' ? ' (usa grupos para la jerarquía de capacidades)' : ''}.`);
          continue;
        }
        const [sourceId, targetId] = rule.reversed ? [idOf.get(b)!, idOf.get(a)!] : [idOf.get(a)!, idOf.get(b)!];
        const signature = `${rule.kind}|${sourceId}|${targetId}`;
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        relations.push({ id: pickId(`${sourceId}--${rule.kind}--${targetId}`, relationIds), kind: rule.kind, sourceId, targetId, ...(description ? { description } : {}) });
      }
    }
  }

  if (capabilities.length + processes.length + applications.length + technologies.length === 0) {
    throw new EnterpriseImportError('El diagrama de Mermaid no define ningún elemento que se pueda importar.');
  }
  const name = options.name?.trim() || title?.trim() || options.fallbackName?.trim() || 'Arquitectura empresarial';
  const result = validateEnterpriseDocument({ version: ENTERPRISE_DOCUMENT_VERSION, workspace: { name }, capabilities, processes, applications, technologies, relations });
  if (!result.ok) throw new EnterpriseImportError(`No se pudo construir un documento válido a partir de Mermaid:\n${formatEnterpriseIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
