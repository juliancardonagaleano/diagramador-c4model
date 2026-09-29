import { slugify } from '../../model/factories';
import { formatIssues, validateDocument } from '../../model/schema';
import { DOCUMENT_VERSION, PARENT_TYPE, type C4Document, type C4Element, type C4Relationship, type ElementShape, type ElementType } from '../../model/types';
import { defaultViews } from '../defaultViews';
import { pickId } from '../ids';
import { Warnings } from '../warnings';

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

/** Tipos de diagrama de Mermaid que se saben importar. */
export const MERMAID_DIAGRAM_KINDS = ['C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'flowchart / graph', 'sequenceDiagram', 'erDiagram'] as const;

type Kind = 'c4' | 'flowchart' | 'sequence' | 'er';

interface Line {
  no: number;
  text: string;
}

/**
 * Importa un diagrama de Mermaid como documento del modelo. Se admiten:
 *  - los diagramas C4 nativos de Mermaid (`C4Context`, `C4Container`, `C4Component`, `C4Dynamic`);
 *  - `flowchart` / `graph` (los `subgraph` anidados pasan a ser sistema › contenedor › componente);
 *  - `sequenceDiagram` (participantes como sistemas, actores como personas, mensajes como relaciones);
 *  - `erDiagram` (entidades como sistemas con forma de base de datos).
 * Mermaid no guarda coordenadas ni vistas propias: se crean las vistas por defecto y el autolayout hace el resto.
 */
export function fromMermaid(source: string, options: MermaidImportOptions = {}): MermaidImportResult {
  const { lines, title } = preprocess(source);
  if (lines.length === 0) throw new MermaidImportError('El texto de Mermaid está vacío.');
  const header = lines[0];
  const kind = detectKind(header.text);
  if (!kind) {
    throw new MermaidImportError(
      `No se reconoce el tipo de diagrama de Mermaid («${header.text.split(/\s+/)[0]}»). Se admiten: ${MERMAID_DIAGRAM_KINDS.join(', ')}.`,
    );
  }
  const builder = new Builder();
  const body = lines.slice(1);
  let declaredTitle = title;
  if (kind === 'c4') declaredTitle = parseC4(body, builder) ?? declaredTitle;
  else if (kind === 'flowchart') parseFlowchart(body, builder);
  else if (kind === 'sequence') declaredTitle = parseSequence(body, builder) ?? declaredTitle;
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

/** ¿Parece texto de Mermaid? (para autodetectar el formato de un archivo sin extensión conocida). */
export function looksLikeMermaid(source: string): boolean {
  try {
    const { lines } = preprocess(source);
    return lines.length > 0 && detectKind(lines[0].text) !== undefined;
  } catch {
    return false;
  }
}

// ───────────────────────── Preprocesado ─────────────────────────

function preprocess(source: string): { lines: Line[]; title?: string } {
  let text = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  // Bloque de código Markdown (```mermaid … ```).
  const fence = /```\s*mermaid[^\n]*\n([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1];
  let title: string | undefined;
  // Frontmatter YAML (`--- title: X ---`).
  const fm = /^\s*---\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(text);
  if (fm) {
    const t = /^\s*title:\s*(.+?)\s*$/m.exec(fm[1]);
    if (t) title = t[1].replace(/^["']|["']$/g, '');
    text = text.slice(fm[0].length);
  }
  const lines: Line[] = [];
  text.split('\n').forEach((raw, i) => {
    let t = raw.trim();
    if (!t || t.startsWith('%%')) return; // comentarios y directivas %%{init: …}%%
    t = t.replace(/\s%%[^"']*$/, '').trim();
    if (t) lines.push({ no: i + 1, text: t });
  });
  return { lines, title };
}

function detectKind(header: string): Kind | undefined {
  const word = header.split(/\s+/)[0];
  if (/^C4(Context|Container|Component|Dynamic|Deployment)$/.test(word)) return 'c4';
  if (word === 'flowchart' || word === 'flowchart-elk' || word === 'graph') return 'flowchart';
  if (word === 'sequenceDiagram') return 'sequence';
  if (word === 'erDiagram') return 'er';
  return undefined;
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

/** Texto de un nodo de Mermaid: sin comillas/backticks y con `<br/>` como salto (primer tramo = nombre, resto = descripción). */
function splitLabel(raw: string): { name: string; description?: string } {
  const text = raw.replace(/^"|"$/g, '').replace(/^`|`$/g, '').trim();
  const parts = text.split(/<br\s*\/?>|\\n/i).map((p) => p.replace(/<[^>]+>/g, '').trim()).filter(Boolean);
  const [name = '', ...rest] = parts;
  return { name, description: rest.length > 0 ? rest.join(' ') : undefined };
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

const FLOW_SILENT = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr|%%)\b/;

interface Opener {
  open: string;
  close: string[];
  shape?: ElementShape;
}

// De la apertura más larga a la más corta, para que `(((` gane a `((` y `(`.
const OPENERS: Opener[] = [
  { open: '(((', close: [')))'] },
  { open: '((', close: ['))'] },
  { open: '([', close: ['])'], shape: 'queue' },
  { open: '[(', close: [')]'], shape: 'database' },
  { open: '[[', close: [']]'] },
  { open: '[/', close: ['/]', '\\]'] },
  { open: '[\\', close: ['\\]', '/]'] },
  { open: '{{', close: ['}}'] },
  { open: '(', close: [')'] },
  { open: '[', close: [']'] },
  { open: '{', close: ['}'] },
  { open: '>', close: [']'] },
];

interface NodeRef {
  alias: string;
  label?: string;
  shape?: ElementShape;
}

const NODE_ID = /^[^\s\-=.&|"'()[\]{}<>;:,]+/u;
const LABELED_EDGE = /^(--|==|-\.)\s+(.+?)\s+(-{2,}|={2,}|\.-)(>|[xo](?=\s|$))?/;
const SIMPLE_EDGE = /^(<|[xo](?=-|=))?(-\.+-|={2,}|-{2,})(>|[xo](?=\s|$))?/;

/** Lee un nodo (`A`, `A[Texto]`, `A(("Texto"))`…) al inicio de `s`; devuelve el nodo y lo que sobra. */
function readNode(s: string): { node: NodeRef; rest: string } | undefined {
  const idm = NODE_ID.exec(s);
  if (!idm) return undefined;
  const alias = idm[0];
  let rest = s.slice(alias.length);
  let label: string | undefined;
  let shape: ElementShape | undefined;
  const opener = OPENERS.find((o) => rest.startsWith(o.open));
  if (opener) {
    const inner = rest.slice(opener.open.length);
    let body: string;
    let after: string;
    if (inner.startsWith('"')) {
      const end = inner.indexOf('"', 1);
      if (end < 0) return undefined;
      body = inner.slice(1, end);
      const closer = opener.close.find((c) => inner.slice(end + 1).trimStart().startsWith(c));
      if (!closer) return undefined;
      after = inner.slice(end + 1).trimStart().slice(closer.length);
    } else {
      const found = opener.close.map((c) => ({ c, i: inner.indexOf(c) })).filter((x) => x.i >= 0).sort((a, z) => a.i - z.i)[0];
      if (!found) return undefined;
      body = inner.slice(0, found.i);
      after = inner.slice(found.i + found.c.length);
    }
    label = body;
    shape = opener.shape;
    rest = after;
  }
  rest = rest.replace(/^:::[\w-]+/, '');
  return { node: { alias, label, shape }, rest };
}

/** Lee `A & B & C` y devuelve los nodos y lo que sobra. */
function readNodeGroup(s: string): { nodes: NodeRef[]; rest: string } | undefined {
  const nodes: NodeRef[] = [];
  let rest = s.trimStart();
  for (;;) {
    const r = readNode(rest);
    if (!r) return nodes.length > 0 ? { nodes, rest } : undefined;
    nodes.push(r.node);
    rest = r.rest.trimStart();
    if (rest.startsWith('&')) rest = rest.slice(1).trimStart();
    else return { nodes, rest };
  }
}

interface EdgeOp {
  label?: string;
  bidirectional: boolean;
  rest: string;
}

function readEdge(s: string): EdgeOp | undefined {
  const rest = s.trimStart();
  const labeled = LABELED_EDGE.exec(rest);
  if (labeled) return { label: labeled[2].trim(), bidirectional: false, rest: rest.slice(labeled[0].length) };
  const m = SIMPLE_EDGE.exec(rest);
  if (!m) return undefined;
  let after = rest.slice(m[0].length);
  let label: string | undefined;
  const lm = /^\|([^|]*)\|/.exec(after);
  if (lm) {
    label = lm[1].trim();
    after = after.slice(lm[0].length);
  }
  return { label, bidirectional: m[1] === '<' && m[3] === '>', rest: after };
}

const LEVEL_TYPES: ElementType[] = ['softwareSystem', 'container', 'component'];

function parseFlowchart(lines: Line[], b: Builder): void {
  // Pila de subgraph que son elementos del modelo (los más profundos que un componente se aplanan).
  const stack: Array<{ alias: string; elementId?: string }> = [];
  let flattened = false;

  const parentFor = (type: ElementType): string | undefined => {
    const want = PARENT_TYPE[type];
    if (!want) return undefined;
    const level = LEVEL_TYPES.indexOf(want);
    return stack.filter((f) => f.elementId).map((f) => f.elementId as string)[level];
  };

  const ensureNode = (node: NodeRef): void => {
    const known = b.aliases.get(node.alias);
    if (known) {
      // Definición posterior con texto: actualiza el nombre si el elemento se creó solo con su id.
      if (node.label !== undefined) {
        const el = b.elements.find((e) => e.id === known);
        if (el && el.name === node.alias) Object.assign(el, splitFor(node.label));
        if (el && node.shape && !el.shape) el.shape = node.shape;
      }
      return;
    }
    const depth = stack.filter((f) => f.elementId).length;
    const type = LEVEL_TYPES[Math.min(depth, 2)];
    const label = splitLabel(node.label ?? node.alias);
    b.addElement(node.alias, type, label.name || node.alias, { description: label.description, shape: node.shape, parentId: parentFor(type) });
  };

  const splitFor = (raw: string): { name: string; description?: string } => {
    const l = splitLabel(raw);
    return l.description ? { name: l.name, description: l.description } : { name: l.name };
  };

  for (const { no, text } of lines) {
    const where = `línea ${no}`;
    for (const stmt of splitStatements(text)) {
      if (stmt === 'end') {
        stack.pop();
        continue;
      }
      const sg = /^subgraph\s+(.+)$/.exec(stmt);
      if (sg) {
        const m = /^([^\s[]+)\s*\[\s*"?([^\]"]*)"?\s*\]$/.exec(sg[1]) ?? /^"?(.+?)"?$/.exec(sg[1]);
        const alias = m?.[1] ?? sg[1];
        const label = m?.[2] ?? alias;
        const depth = stack.filter((f) => f.elementId).length;
        if (depth >= 3) {
          if (!flattened) b.warnings.add(`${where}: los subgraph anidados a más de tres niveles se aplanan (el modelo llega hasta sistema › contenedor › componente).`);
          flattened = true;
          stack.push({ alias });
        } else {
          const type = LEVEL_TYPES[depth];
          const el = b.addElement(alias, type, splitLabel(label).name || alias, { parentId: parentFor(type) });
          stack.push({ alias, elementId: el.id });
        }
        continue;
      }
      if (FLOW_SILENT.test(stmt)) continue;
      if (/^(flowchart|graph)\b/.test(stmt)) continue;

      // Sentencia de nodos y aristas: grupo (edge grupo)*.
      let group = readNodeGroup(stmt);
      if (!group) {
        b.warnings.add(`${where}: no se entiende «${truncate(stmt)}»; se omite.`);
        continue;
      }
      group.nodes.forEach(ensureNode);
      let rest = group.rest;
      while (rest.trim() !== '') {
        const edge = readEdge(rest);
        if (!edge) {
          b.warnings.add(`${where}: no se entiende «${truncate(rest.trim())}»; se omite.`);
          break;
        }
        const next = readNodeGroup(edge.rest);
        if (!next) {
          b.warnings.add(`${where}: falta el nodo de destino después de la flecha; se omite.`);
          break;
        }
        next.nodes.forEach(ensureNode);
        for (const from of group.nodes) {
          for (const to of next.nodes) {
            b.addRelationship(from.alias, to.alias, edge.label ? splitLabel(edge.label).name : undefined, undefined, where);
            if (edge.bidirectional) b.addRelationship(to.alias, from.alias, edge.label ? splitLabel(edge.label).name : undefined, undefined, where);
          }
        }
        group = next;
        rest = next.rest;
      }
    }
  }
}

// ───────────────────────── sequenceDiagram ─────────────────────────

const SEQ_SILENT = /^(autonumber|activate|deactivate|note|loop|alt|else|opt|par|and|end|rect|critical|option|break|box|link|links|properties|details|destroy)\b/i;
const SEQ_ARROW = /^(\S+?)\s*(--?>>|--?>|--?x|--?\)|<<--?>>)\s*([+-])?\s*([^:\s][^:]*?)\s*:\s*(.*)$/;

function parseSequence(lines: Line[], b: Builder): string | undefined {
  let title: string | undefined;
  const declare = (alias: string, type: ElementType, name?: string): void => {
    if (b.aliases.has(alias)) return;
    b.addElement(alias, type, name?.trim() || alias);
  };
  for (const { no, text } of lines) {
    const where = `línea ${no}`;
    const t = /^title:?\s+(.+)$/i.exec(text);
    if (t) {
      title = t[1].trim();
      continue;
    }
    const decl = /^(?:create\s+)?(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/i.exec(text);
    if (decl) {
      const type: ElementType = decl[1].toLowerCase() === 'actor' ? 'person' : 'softwareSystem';
      const existing = b.aliases.get(decl[2]);
      if (existing) {
        // Mensajes anteriores ya lo crearon como sistema: se corrige el tipo y el nombre.
        const el = b.elements.find((e) => e.id === existing);
        if (el) {
          el.type = type;
          if (decl[3]) el.name = decl[3].trim();
        }
      } else declare(decl[2], type, decl[3]);
      continue;
    }
    if (SEQ_SILENT.test(text) || /^sequenceDiagram/.test(text)) continue;
    const m = SEQ_ARROW.exec(text);
    if (!m) {
      b.warnings.add(`${where}: no se entiende «${truncate(text)}»; se omite.`);
      continue;
    }
    const from = m[1].trim();
    const to = m[4].trim();
    declare(from, 'softwareSystem');
    declare(to, 'softwareSystem');
    b.addRelationship(from, to, splitLabel(m[5]).name || undefined, undefined, where, true);
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

/** Separa las sentencias de una línea por `;`, sin cortar los `;` que estén entre comillas. */
function splitStatements(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out.map((x) => x.trim()).filter(Boolean);
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
