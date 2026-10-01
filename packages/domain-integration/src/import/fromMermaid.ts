import {
  detectMermaidKind,
  ModuleError,
  parseFlowchart,
  parseSequence,
  pickId,
  preprocessMermaid,
  splitLabel,
  Warnings,
  MERMAID_DIAGRAM_KINDS,
  type FlowLineStyle,
  type FlowNodeRef,
} from '@iark/kernel';
import { formatIntegrationIssues, validateIntegrationDocument } from '../schema';
import { PATTERN_INFO } from '../patterns';
import {
  INTEGRATION_DOCUMENT_VERSION,
  KIND_LABELS,
  PARENT_KINDS,
  PATTERNS,
  type Flow,
  type IntegrationDocument,
  type IntegrationNode,
  type IntegrationPattern,
  type Interaction,
  type InteractionStyle,
  type NodeKind,
} from '../types';

export class IntegrationImportError extends ModuleError {
  constructor(message: string) {
    super(message);
    this.name = 'IntegrationImportError';
  }
}

export interface IntegrationImportOptions {
  name?: string;
  fallbackName?: string;
}

export interface IntegrationImportResult {
  document: IntegrationDocument;
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

const ZONE_TITLE = /^Dominio:\s+(.+)$/;
const KIND_BY_LABEL = new Map<string, NodeKind>(Object.entries(KIND_LABELS).map(([kind, label]) => [label, kind as NodeKind]));
const PATTERN_BY_LABEL = new Map<string, IntegrationPattern>(PATTERNS.map((p) => [PATTERN_INFO[p].label, p]));
const CONTAINER_KINDS: readonly NodeKind[] = [...new Set(Object.values(PARENT_KINDS).flat())];

/** Quita del texto las marcas «…» que son un tipo de nodo o un patrón; las demás se quedan. */
function takeMarks(text: string | undefined): { text?: string; kind?: NodeKind; pattern?: IntegrationPattern } {
  let kind: NodeKind | undefined;
  let pattern: IntegrationPattern | undefined;
  const rest = (text ?? '')
    .replace(/\s*«([^»]*)»/g, (whole, label: string) => {
      const name = label.trim();
      if (PATTERN_BY_LABEL.has(name)) pattern = PATTERN_BY_LABEL.get(name);
      else if (KIND_BY_LABEL.has(name) && KIND_BY_LABEL.get(name) !== 'pattern') kind = KIND_BY_LABEL.get(name);
      else return whole;
      return '';
    })
    .trim();
  return { ...(rest ? { text: rest } : {}), ...(kind ? { kind } : {}), ...(pattern ? { pattern } : {}) };
}

/** Descripción, número de paso («2. Crea el pedido») y patrón («Reintento») de la etiqueta de una línea. */
function readEdgeLabel(raw: string | undefined): { description?: string; step?: number; pattern?: IntegrationPattern } {
  const marks = takeMarks(raw ? splitLabel(raw).name : undefined);
  const numbered = /^(\d+)\.(?:\s+|$)/.exec(marks.text ?? '');
  const description = (numbered ? marks.text!.slice(numbered[0].length) : marks.text)?.trim();
  return { ...(description ? { description } : {}), ...(numbered ? { step: Number(numbered[1]) } : {}), ...(marks.pattern ? { pattern: marks.pattern } : {}) };
}

function styleOf(line: FlowLineStyle): InteractionStyle {
  return line === 'dotted' ? 'async-message' : line === 'thick' ? 'event' : 'request-response';
}

/**
 * Importa un diagrama de Mermaid como documento de integración.
 * - `flowchart`: flecha continua = petición-respuesta, punteada = mensaje asíncrono, gruesa = evento; `[( )]` = almacén y
 *   `([ ])` = cola. Un `subgraph` con colas es un broker; con otros nodos, un sistema que expone sus APIs; si su título
 *   empieza por el tipo («Pasarela: Kong») manda el tipo, y «Dominio: X» es una zona que da `domain` a sus miembros. Una
 *   marca «Tipo» en el texto de un nodo («Conector») fija su tipo, y una de patrón («Reintento») lo hace nodo de patrón.
 * - `sequenceDiagram`: los participantes son sistemas (usuarios si son `actor`) y los mensajes, los pasos de un flujo.
 */
export function fromMermaid(source: string, options: IntegrationImportOptions = {}): IntegrationImportResult {
  const { lines, title } = preprocessMermaid(source);
  if (lines.length === 0) throw new IntegrationImportError('El texto de Mermaid está vacío.');
  const kind = detectMermaidKind(lines[0].text);
  if (kind !== 'flowchart' && kind !== 'sequence') {
    throw new IntegrationImportError(
      kind
        ? `Un diagrama de Mermaid «${lines[0].text.split(/\s+/)[0]}» no se puede importar como integración. Se admiten flowchart/graph y sequenceDiagram.`
        : `No se reconoce el tipo de diagrama de Mermaid («${lines[0].text.split(/\s+/)[0]}»). Se admiten: ${MERMAID_DIAGRAM_KINDS.join(', ')}.`,
    );
  }
  const warnings = new Warnings();
  const body = lines.slice(1);
  const built = kind === 'flowchart' ? fromFlowchart(body, warnings) : fromSequence(body, warnings);
  if (built.nodes.length === 0) throw new IntegrationImportError('El diagrama de Mermaid no define ningún nodo que se pueda importar.');
  const name = options.name?.trim() || built.title?.trim() || title?.trim() || options.fallbackName?.trim() || 'Mapa de integración';
  const result = validateIntegrationDocument({
    version: INTEGRATION_DOCUMENT_VERSION,
    workspace: { name },
    nodes: built.nodes,
    contracts: [],
    interactions: built.interactions,
    flows: built.flows,
  });
  if (!result.ok) throw new IntegrationImportError(`No se pudo construir un documento válido a partir de Mermaid:\n${formatIntegrationIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}

interface Built {
  nodes: IntegrationNode[];
  interactions: Interaction[];
  flows: Flow[];
  title?: string;
}

function fromFlowchart(lines: Parameters<typeof parseFlowchart>[0], warnings: Warnings): Built {
  interface Group {
    alias: string;
    label: string;
    parent?: string;
    zone?: string;
  }
  const groups = new Map<string, Group>();
  const zones = new Map<string, string>();
  const nodeInfo = new Map<string, { ref: FlowNodeRef; group?: string; zone?: string }>();
  const edges: Array<{ from: string; to: string; label?: string; line: FlowLineStyle; where: string }> = [];
  const stack: string[] = [];
  const enclosing = <T>(known: Map<string, T>): string | undefined => [...stack].reverse().find((alias) => known.has(alias));

  for (const ev of parseFlowchart(lines)) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'subgraph-start') {
      const zone = ZONE_TITLE.exec(splitLabel(ev.label).name)?.[1].trim();
      if (zone) zones.set(ev.alias, zone);
      else groups.set(ev.alias, { alias: ev.alias, label: ev.label, parent: enclosing(groups), zone: zones.get(enclosing(zones) ?? '') });
      stack.push(ev.alias);
    } else if (ev.type === 'subgraph-end') stack.pop();
    else if (ev.type === 'node') {
      if (zones.has(ev.node.alias)) continue;
      const known = nodeInfo.get(ev.node.alias);
      if (!known) nodeInfo.set(ev.node.alias, { ref: { ...ev.node }, group: enclosing(groups), zone: zones.get(enclosing(zones) ?? '') });
      else if (ev.node.label !== undefined) known.ref = { ...known.ref, label: ev.node.label, shape: ev.node.shape ?? known.ref.shape };
    } else {
      for (const from of ev.from) {
        for (const to of ev.to) {
          edges.push({ from: from.alias, to: to.alias, label: ev.label, line: ev.line, where: ev.where });
          if (ev.bidirectional) edges.push({ from: to.alias, to: from.alias, label: ev.label, line: ev.line, where: ev.where });
        }
      }
    }
  }

  // El exportador antepone el tipo al título del subgraph («Sistema: Pedidos»): manda sobre lo que se deduzca del contenido y se quita del nombre.
  const titleOf = (g: Group): { kind?: NodeKind; name: string } => {
    const name = splitLabel(g.label).name;
    const m = /^([^:]+):\s+(.*)$/.exec(name);
    const kind = m ? KIND_BY_LABEL.get(m[1]) : undefined;
    return kind ? { kind: CONTAINER_KINDS.includes(kind) ? kind : undefined, name: m![2] } : { name };
  };
  // Sin tipo en el título, un subgraph con colas (nodos en forma de estadio) es un broker; cualquier otro es un sistema que agrupa sus APIs.
  const groupKind = (g: Group): NodeKind =>
    titleOf(g).kind ?? ([...nodeInfo.values()].some((n) => n.group === g.alias && n.ref.shape === 'stadium') ? 'broker' : 'system');
  const ids = new Set<string>();
  const idOf = new Map<string, string>();
  const nodes: IntegrationNode[] = [];
  const take = (alias: string, label: string): string => {
    const id = pickId(slug(alias) || slug(label) || 'nodo', ids);
    idOf.set(alias, id);
    return id;
  };
  for (const g of groups.values()) {
    const kind = groupKind(g);
    if (g.parent) warnings.add(`El subgraph «${g.label}» está anidado: en integración se aplana y no tendrá padre.`);
    const title = titleOf(g).name.replace(new RegExp(`^(?:${Object.values(KIND_LABELS).join('|')}):\\s+`), '');
    nodes.push({ id: take(g.alias, g.label), kind, name: title || g.alias, ...(g.zone ? { domain: g.zone } : {}) });
  }
  for (const { ref, group, zone } of nodeInfo.values()) {
    if (groups.has(ref.alias)) continue; // una arista a un subgraph ya es el nodo de ese grupo
    const label = splitLabel(ref.label ?? ref.alias);
    const marks = takeMarks(label.description);
    const parentGroup = group ? groups.get(group) : undefined;
    const parentKind = parentGroup ? groupKind(parentGroup) : undefined;
    const kind: NodeKind = marks.pattern ? 'pattern' : (marks.kind ?? (ref.shape === 'cylinder' ? 'store' : ref.shape === 'stadium' ? 'queue' : parentKind === 'system' ? 'api' : 'system'));
    let parentId = parentGroup ? idOf.get(parentGroup.alias) : undefined;
    if (parentId && !(parentKind && PARENT_KINDS[kind]?.includes(parentKind))) {
      warnings.add(`«${label.name || ref.alias}» no encaja como hijo de «${parentGroup!.label}»; se importa sin padre.`);
      parentId = undefined;
    }
    nodes.push({
      id: take(ref.alias, label.name),
      kind,
      name: label.name || ref.alias,
      ...(marks.text ? { description: marks.text } : {}),
      ...(marks.pattern ? { pattern: marks.pattern } : {}),
      ...(parentId ? { parentId } : zone ? { domain: zone } : {}),
    });
  }

  const interactionIds = new Set<string>();
  const interactions: Interaction[] = [];
  for (const e of edges) {
    const sourceId = idOf.get(e.from);
    const targetId = idOf.get(e.to);
    if (!sourceId || !targetId || sourceId === targetId) {
      warnings.add(`${e.where}: la arista ${e.from} → ${e.to} no se puede importar; se omite.`);
      continue;
    }
    const { description, step, pattern } = readEdgeLabel(e.label);
    interactions.push({
      id: pickId(`${sourceId}--${targetId}`, interactionIds),
      sourceId,
      targetId,
      style: styleOf(e.line),
      ...(description ? { description } : {}),
      ...(pattern ? { pattern } : {}),
      ...(step !== undefined ? { order: step } : {}),
    });
  }
  return { nodes, interactions, flows: [] };
}

function fromSequence(lines: Parameters<typeof parseSequence>[0], warnings: Warnings): Built {
  const ids = new Set<string>();
  const idOf = new Map<string, string>();
  const nodes: IntegrationNode[] = [];
  const declare = (alias: string, label?: string, actor?: boolean): string => {
    const known = idOf.get(alias);
    if (known) {
      const node = nodes.find((n) => n.id === known)!;
      if (label) node.name = label;
      if (actor) node.kind = 'user';
      return known;
    }
    const id = pickId(slug(alias) || 'nodo', ids);
    idOf.set(alias, id);
    nodes.push({ id, kind: actor ? 'user' : 'system', name: label || alias });
    return id;
  };
  const interactionIds = new Set<string>();
  const interactions: Interaction[] = [];
  const steps: Flow['steps'] = [];
  let title: string | undefined;

  for (const ev of parseSequence(lines)) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'title') title = ev.text;
    else if (ev.type === 'participant') declare(ev.alias, ev.label, ev.actor);
    else {
      const sourceId = declare(ev.from);
      const targetId = declare(ev.to);
      if (sourceId === targetId) {
        warnings.add(`${ev.where}: «${ev.from}» se llama a sí mismo; se omite.`);
        continue;
      }
      // La respuesta de una petición ya recogida es la misma interacción de petición-respuesta.
      if (ev.arrow === 'reply' && interactions.some((i) => i.sourceId === targetId && i.targetId === sourceId && i.style === 'request-response')) continue;
      const { description, pattern } = readEdgeLabel(ev.text);
      const interaction: Interaction = {
        id: pickId(`${sourceId}--${targetId}`, interactionIds),
        sourceId,
        targetId,
        style: ev.arrow === 'async' || ev.arrow === 'lost' ? 'async-message' : 'request-response',
        ...(description ? { description } : {}),
        ...(pattern ? { pattern } : {}),
      };
      interactions.push(interaction);
      steps.push({ interactionId: interaction.id });
    }
  }
  const flows: Flow[] = steps.length > 0 ? [{ id: 'flujo', name: title ?? 'Flujo importado', steps }] : [];
  return { nodes, interactions, flows, title };
}
