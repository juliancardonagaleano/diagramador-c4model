import { slugify } from '../../model/factories';
import { formatIssues, validateDocument } from '../../model/schema';
import { DOCUMENT_VERSION, PARENT_TYPE, type C4Document, type C4Element, type C4Relationship, type ElementShape, type ElementType } from '../../model/types';
import { defaultViews } from '../defaultViews';
import {
  detectMermaidKind,
  looksLikeMermaid,
  MERMAID_DIAGRAM_KINDS,
  parseFlowchart,
  parseSequence,
  pickId,
  preprocessMermaid,
  splitLabel,
  truncate,
  Warnings,
  type FlowNodeRef,
  type MermaidLine,
} from '@iark/kernel';

export class MermaidImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MermaidImportError';
  }
}

export interface MermaidImportOptions {
  /** Nombre del documento: sustituye al título que declare el diagrama. */
  name?: string;
  /** Nombre a usar si el diagrama no declara título (p. ej. el del archivo). Por defecto "Diagrama Mermaid". */
  fallbackName?: string;
}

export interface MermaidImportResult {
  document: C4Document;
  /** Lo que no se pudo importar tal cual (construcciones no soportadas, referencias rotas…). Vacío si todo encajó. */
  warnings: string[];
}

export { looksLikeMermaid, MERMAID_DIAGRAM_KINDS };

type Line = MermaidLine;

/**
 * Importa un diagrama de Mermaid como documento del modelo. Se admiten:
 *  - los diagramas C4 nativos de Mermaid (`C4Context`, `C4Container`, `C4Component`, `C4Dynamic`);
 *  - `flowchart` / `graph` (los `subgraph` anidados pasan a ser sistema › contenedor › componente);
 *  - `sequenceDiagram` (participantes como sistemas, actores como personas, mensajes como relaciones);
 *  - `erDiagram` (entidades como sistemas con forma de base de datos).
 * Mermaid no guarda coordenadas ni vistas propias: se crean las vistas por defecto y el autolayout hace el resto.
 */
export function fromMermaid(source: string, options: MermaidImportOptions = {}): MermaidImportResult {
  const { lines, title } = preprocessMermaid(source);
  if (lines.length === 0) throw new MermaidImportError('El texto de Mermaid está vacío.');
  const header = lines[0];
  const kind = detectMermaidKind(header.text);
  if (!kind) {
    throw new MermaidImportError(
      `No se reconoce el tipo de diagrama de Mermaid («${header.text.split(/\s+/)[0]}»). Se admiten: ${MERMAID_DIAGRAM_KINDS.join(', ')}.`,
    );
  }
  const builder = new Builder();
  const body = lines.slice(1);
  let declaredTitle = title;
  if (kind === 'c4') declaredTitle = parseC4(body, builder) ?? declaredTitle;
  else if (kind === 'flowchart') parseFlowchartInto(body, builder);
  else if (kind === 'sequence') declaredTitle = parseSequenceInto(body, builder) ?? declaredTitle;
  else parseEr(body, builder);

  if (builder.elements.length === 0) throw new MermaidImportError('El diagrama de Mermaid no define ningún elemento que se pueda importar.');
  const name = options.name?.trim() || declaredTitle?.trim() || options.fallbackName?.trim() || 'Diagrama Mermaid';
  const document = {
    version: DOCUMENT_VERSION,
    workspace: { name },
    model: { elements: builder.elements, relationships: builder.relationships },
    views: defaultViews(builder.elements, builder.relationships),
  };
  const result = validateDocument(document);
  if (!result.ok) throw new MermaidImportError(`No se pudo construir un documento válido a partir de Mermaid:\n${formatIssues(result.issues)}`);
  return { document: result.document, warnings: builder.warnings.result() };
}

// ───────────────────────── Modelo en construcción ─────────────────────────

class Builder {
  elements: C4Element[] = [];
  relationships: C4Relationship[] = [];
  warnings = new Warnings();
  private elementIds = new Set<string>();
  private relIds = new Set<string>();
  /** Alias del origen (nodo, participante, entidad…) → id del elemento. */
  aliases = new Map<string, string>();
  private relKeys = new Set<string>();

  addElement(alias: string, type: ElementType, name: string, extra: Partial<C4Element> = {}): C4Element {
    const id = pickId(slugify(alias) || slugify(name) || type, this.elementIds);
    const element: C4Element = { id, type, name: name.trim() || alias, ...stripUndefined(extra) };
    this.elements.push(element);
    this.aliases.set(alias, id);
    return element;
  }

  addRelationship(sourceAlias: string, targetAlias: string, description: string | undefined, technology: string | undefined, where: string, dedupe = false): boolean {
    const sourceId = this.aliases.get(sourceAlias);
    const targetId = this.aliases.get(targetAlias);
    if (!sourceId || !targetId) {
      this.warnings.add(`${where}: la relación ${sourceAlias} → ${targetAlias} nombra un elemento que no está definido; se omite.`);
      return false;
    }
    if (sourceId === targetId) {
      this.warnings.add(`${where}: «${sourceAlias}» se relaciona consigo mismo; el modelo no admite relaciones a un mismo elemento, se omite.`);
      return false;
    }
    const key = `${sourceId}\u0000${targetId}\u0000${description ?? ''}\u0000${technology ?? ''}`;
    if (dedupe && this.relKeys.has(key)) return false;
    this.relKeys.add(key);
    const id = pickId(`${sourceId}--${targetId}`, this.relIds);
    const rel: C4Relationship = { id, sourceId, targetId };
    if (description) rel.description = description;
    if (technology) rel.technology = technology;
    this.relationships.push(rel);
    return true;
  }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as T;
}

// ───────────────────────── Diagramas C4 nativos ─────────────────────────

interface C4Call {
  fn: string;
  args: string[];
  named: Record<string, string>;
  opensBlock: boolean;
}

/** Descompone `Fn(a, "b", $k="v") {` en su nombre, argumentos posicionales y con nombre. */
function parseCall(text: string): C4Call | undefined {
  const m = /^([A-Za-z_][\w]*)\s*\(/.exec(text);
  if (!m) return undefined;
  const args: string[] = [];
  const named: Record<string, string> = {};
  let i = m[0].length;
  let current = '';
  let quoted = false;
  let wasQuoted = false;
  let closed = false;
  const push = (): void => {
    const value = current.trim();
    const nm = /^\$([\w]+)\s*=\s*([\s\S]*)$/.exec(value);
    if (nm) named[nm[1]] = unquote(nm[2].trim());
    else if (value !== '' || wasQuoted) args.push(wasQuoted ? unquote(value) : value);
    current = '';
    wasQuoted = false;
  };
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      current += ch;
      if (ch === '"') quoted = false;
    } else if (ch === '"') {
      quoted = true;
      current += ch;
      wasQuoted = true;
    } else if (ch === ',') push();
    else if (ch === ')') {
      push();
      closed = true;
      i += 1;
      break;
    } else current += ch;
  }
  if (!closed) return undefined;
  return { fn: m[1], args, named, opensBlock: text.slice(i).trim().startsWith('{') };
}

function unquote(s: string): string {
  return s.replace(/^"([\s\S]*)"$/, '$1');
}

const C4_ELEMENT = /^(Person|System|Container|Component)(Db|Queue)?(_Ext)?$/;
const C4_BOUNDARY = /^(Enterprise_Boundary|System_Boundary|Container_Boundary|Boundary|Deployment_Node|Node|Node_L|Node_R)$/;
const C4_REL = /^(Rel|BiRel)(_(U|D|L|R|Up|Down|Left|Right|Back|Neighbor))?$/;
const C4_SILENT = /^(UpdateElementStyle|UpdateRelStyle|UpdateLayoutConfig|AddElementTag|AddRelTag|LAYOUT_[A-Z_]+|SHOW_[A-Z_]+|title|accTitle|accDescr)\b/;

interface C4Frame {
  kind: 'system' | 'container' | 'group';
  elementId?: string;
}

function parseC4(lines: Line[], b: Builder): string | undefined {
  let title: string | undefined;
  const stack: C4Frame[] = [];
  const nearest = (kind: C4Frame['kind']): string | undefined => [...stack].reverse().find((f) => f.kind === kind)?.elementId;

  for (const { no, text } of lines) {
    const where = `línea ${no}`;
    if (text === '}') {
      stack.pop();
      continue;
    }
    const t = /^title\s+(.+)$/i.exec(text);
    if (t) {
      title = t[1].trim();
      continue;
    }
    if (C4_SILENT.test(text)) continue;
    const call = parseCall(text);
    if (!call) {
      b.warnings.add(`${where}: no se entiende «${truncate(text)}»; se omite.`);
      continue;
    }
    const { fn, args } = call;

    if (C4_BOUNDARY.test(fn)) {
      const [alias = '', label = alias] = args;
      if (fn === 'System_Boundary') {
        const system = b.addElement(alias, 'softwareSystem', label, { description: undefined });
        if (call.opensBlock) stack.push({ kind: 'system', elementId: system.id });
      } else if (fn === 'Container_Boundary') {
        const parentId = nearest('system');
        const container = b.addElement(alias, 'container', label, { parentId });
        if (call.opensBlock) stack.push({ kind: 'container', elementId: container.id });
      } else if (call.opensBlock) {
        // Empresa, nodos de despliegue y límites genéricos: solo agrupan, no son elementos del modelo.
        stack.push({ kind: 'group' });
        if (/Node/.test(fn)) b.warnings.add(`${where}: los nodos de despliegue («${fn}») no forman parte del modelo C4; sus elementos se importan sin ellos.`);
      }
      continue;
    }

    const el = C4_ELEMENT.exec(fn);
    if (el) {
      const [, base, variant, ext] = el;
      const type: ElementType = base === 'Person' ? 'person' : base === 'System' ? 'softwareSystem' : base === 'Container' ? 'container' : 'component';
      const [alias = '', label = alias, ...rest] = args;
      const withTech = type === 'container' || type === 'component';
      const technology = withTech ? rest[0] : undefined;
      const description = (withTech ? rest[1] : rest[0]) ?? undefined;
      const shape: ElementShape | undefined = variant === 'Db' ? 'database' : variant === 'Queue' ? 'queue' : undefined;
      const parentType = PARENT_TYPE[type];
      const parentId = parentType === 'softwareSystem' ? nearest('system') : parentType === 'container' ? nearest('container') : undefined;
      b.addElement(alias, type, label, { description, technology, external: ext ? true : undefined, shape, parentId, tags: call.named.tags ? call.named.tags.split('+') : undefined });
      continue;
    }

    const rel = C4_REL.exec(fn);
    if (rel || fn === 'RelIndex') {
      // RelIndex(indice, origen, destino, …): el índice solo ordena diagramas dinámicos.
      const offset = fn === 'RelIndex' ? 1 : 0;
      let [from = '', to = ''] = [args[offset], args[offset + 1]];
      const label = args[offset + 2];
      const technology = args[offset + 3];
      if (rel?.[3] === 'Back') [from, to] = [to, from];
      b.addRelationship(from, to, label, technology, where);
      if (rel?.[1] === 'BiRel') b.addRelationship(to, from, label, technology, where);
      continue;
    }

    b.warnings.add(`${where}: «${fn}» no está soportado; se omite.`);
  }
  return title;
}

// ───────────────────────── flowchart / graph ─────────────────────────

const LEVEL_TYPES: ElementType[] = ['softwareSystem', 'container', 'component'];

function parseFlowchartInto(lines: Line[], b: Builder): void {
  // Pila de subgraph que son elementos del modelo (los más profundos que un componente se aplanan).
  const stack: Array<{ alias: string; elementId?: string }> = [];
  let flattened = false;

  const parentFor = (type: ElementType): string | undefined => {
    const want = PARENT_TYPE[type];
    if (!want) return undefined;
    const level = LEVEL_TYPES.indexOf(want);
    return stack.filter((f) => f.elementId).map((f) => f.elementId as string)[level];
  };

  const ensureNode = (node: FlowNodeRef): void => {
    const shape: ElementShape | undefined = node.shape === 'cylinder' ? 'database' : node.shape === 'stadium' ? 'queue' : undefined;
    const known = b.aliases.get(node.alias);
    if (known) {
      // Definición posterior con texto: actualiza el nombre si el elemento se creó solo con su id.
      if (node.label !== undefined) {
        const el = b.elements.find((e) => e.id === known);
        if (el && el.name === node.alias) {
          const l = splitLabel(node.label);
          el.name = l.name;
          if (l.description) el.description = l.description;
        }
        if (el && shape && !el.shape) el.shape = shape;
      }
      return;
    }
    const depth = stack.filter((f) => f.elementId).length;
    const type = LEVEL_TYPES[Math.min(depth, 2)];
    const label = splitLabel(node.label ?? node.alias);
    b.addElement(node.alias, type, label.name || node.alias, { description: label.description, shape, parentId: parentFor(type) });
  };

  for (const ev of parseFlowchart(lines)) {
    if (ev.type === 'warning') b.warnings.add(ev.message);
    else if (ev.type === 'subgraph-end') stack.pop();
    else if (ev.type === 'subgraph-start') {
      const depth = stack.filter((f) => f.elementId).length;
      if (depth >= 3) {
        if (!flattened) b.warnings.add(`${ev.where}: los subgraph anidados a más de tres niveles se aplanan (el modelo llega hasta sistema › contenedor › componente).`);
        flattened = true;
        stack.push({ alias: ev.alias });
      } else {
        const type = LEVEL_TYPES[depth];
        const el = b.addElement(ev.alias, type, splitLabel(ev.label).name || ev.alias, { parentId: parentFor(type) });
        stack.push({ alias: ev.alias, elementId: el.id });
      }
    } else if (ev.type === 'node') ensureNode(ev.node);
    else {
      const label = ev.label ? splitLabel(ev.label).name : undefined;
      for (const from of ev.from) {
        for (const to of ev.to) {
          b.addRelationship(from.alias, to.alias, label, undefined, ev.where);
          if (ev.bidirectional) b.addRelationship(to.alias, from.alias, label, undefined, ev.where);
        }
      }
    }
  }
}

// ───────────────────────── sequenceDiagram ─────────────────────────

function parseSequenceInto(lines: Line[], b: Builder): string | undefined {
  let title: string | undefined;
  const declare = (alias: string, type: ElementType, name?: string): void => {
    if (b.aliases.has(alias)) return;
    b.addElement(alias, type, name?.trim() || alias);
  };
  for (const ev of parseSequence(lines)) {
    if (ev.type === 'warning') b.warnings.add(ev.message);
    else if (ev.type === 'title') title = ev.text;
    else if (ev.type === 'participant') {
      const type: ElementType = ev.actor ? 'person' : 'softwareSystem';
      const existing = b.aliases.get(ev.alias);
      if (existing) {
        // Mensajes anteriores ya lo crearon como sistema: se corrige el tipo y el nombre.
        const el = b.elements.find((e) => e.id === existing);
        if (el) {
          el.type = type;
          if (ev.label) el.name = ev.label;
        }
      } else declare(ev.alias, type, ev.label);
    } else {
      declare(ev.from, 'softwareSystem');
      declare(ev.to, 'softwareSystem');
      b.addRelationship(ev.from, ev.to, splitLabel(ev.text).name || undefined, undefined, ev.where, true);
    }
  }
  return title;
}

// ───────────────────────── erDiagram ─────────────────────────

const ER_REL = /^(\S+)\s+(\S+?)(--|\.\.)(\S+?)\s+(\S+)\s*(?::\s*(.*))?$/;

const ER_LEFT: Record<string, string> = { '||': '1', '|o': '0..1', '}o': '0..*', '}|': '1..*' };
const ER_RIGHT: Record<string, string> = { '||': '1', 'o|': '0..1', 'o{': '0..*', '|{': '1..*' };

function parseEr(lines: Line[], b: Builder): void {
  const attributes = new Map<string, string[]>();
  let current: string | undefined;
  const ensure = (alias: string): void => {
    if (!b.aliases.has(alias)) b.addElement(alias, 'softwareSystem', alias.replace(/^"|"$/g, ''), { shape: 'database' });
  };
  for (const { no, text } of lines) {
    const where = `línea ${no}`;
    if (current) {
      if (text === '}') {
        current = undefined;
        continue;
      }
      attributes.get(current)!.push(text.replace(/\s+/g, ' '));
      continue;
    }
    const block = /^(\S+)\s*\{$/.exec(text);
    if (block) {
      current = block[1];
      ensure(current);
      attributes.set(current, []);
      continue;
    }
    if (/^(title|accTitle|accDescr|direction)\b/i.test(text)) continue;
    const rel = ER_REL.exec(text);
    if (rel) {
      const [, left, lCard, , rCard, right, label] = rel;
      ensure(left);
      ensure(right);
      const cardinality = `${ER_LEFT[lCard] ?? '?'} → ${ER_RIGHT[rCard] ?? '?'}`;
      const verb = label?.replace(/^"|"$/g, '').trim();
      b.addRelationship(left, right, verb ? `${verb} (${cardinality})` : cardinality, undefined, where);
      continue;
    }
    const lone = /^(\S+)$/.exec(text);
    if (lone) {
      ensure(lone[1]);
      continue;
    }
    b.warnings.add(`${where}: no se entiende «${truncate(text)}»; se omite.`);
  }
  for (const [alias, attrs] of attributes) {
    if (attrs.length === 0) continue;
    const el = b.elements.find((e) => e.id === b.aliases.get(alias));
    if (el) el.description = attrs.length > 12 ? `${attrs.slice(0, 12).join('; ')}; … (+${attrs.length - 12})` : attrs.join('; ');
  }
}
