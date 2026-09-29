import { splitStatements, truncate, type MermaidLine } from './preprocess';

export type FlowShape = 'default' | 'cylinder' | 'stadium';

export interface FlowNodeRef {
  alias: string;
  /** Texto entre los delimitadores del nodo (`A[Texto]`); sin definir si el nodo solo se menciona. */
  label?: string;
  shape?: FlowShape;
}

export type FlowLineStyle = 'solid' | 'dotted' | 'thick';

/** Lo que se lee de un `flowchart` / `graph`, en el orden del texto. */
export type FlowchartEvent =
  | { type: 'subgraph-start'; alias: string; label: string; where: string }
  | { type: 'subgraph-end' }
  | { type: 'node'; node: FlowNodeRef; where: string }
  | { type: 'edge'; from: FlowNodeRef[]; to: FlowNodeRef[]; label?: string; line: FlowLineStyle; bidirectional: boolean; where: string }
  | { type: 'warning'; message: string };

const SILENT = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/;

interface Opener {
  open: string;
  close: string[];
  shape?: FlowShape;
}

// De la apertura más larga a la más corta, para que `(((` gane a `((` y `(`.
const OPENERS: Opener[] = [
  { open: '(((', close: [')))'] },
  { open: '((', close: ['))'] },
  { open: '([', close: ['])'], shape: 'stadium' },
  { open: '[(', close: [')]'], shape: 'cylinder' },
  { open: '[[', close: [']]'] },
  { open: '[/', close: ['/]', '\\]'] },
  { open: '[\\', close: ['\\]', '/]'] },
  { open: '{{', close: ['}}'] },
  { open: '(', close: [')'] },
  { open: '[', close: [']'] },
  { open: '{', close: ['}'] },
  { open: '>', close: [']'] },
];

const NODE_ID = /^[^\s\-=.&|"'()[\]{}<>;:,]+/u;
const LABELED_EDGE = /^(--|==|-\.)\s+(.+?)\s+(-{2,}|={2,}|\.-)(>|[xo](?=\s|$))?/;
const SIMPLE_EDGE = /^(<|[xo](?=-|=))?(-\.+-|={2,}|-{2,})(>|[xo](?=\s|$))?/;

/** Lee un nodo (`A`, `A[Texto]`, `A(("Texto"))`…) al inicio de `s`; devuelve el nodo y lo que sobra. */
function readNode(s: string): { node: FlowNodeRef; rest: string } | undefined {
  const idm = NODE_ID.exec(s);
  if (!idm) return undefined;
  const alias = idm[0];
  let rest = s.slice(alias.length);
  let label: string | undefined;
  let shape: FlowShape | undefined;
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
function readNodeGroup(s: string): { nodes: FlowNodeRef[]; rest: string } | undefined {
  const nodes: FlowNodeRef[] = [];
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
  line: FlowLineStyle;
  rest: string;
}

function lineStyle(op: string): FlowLineStyle {
  return op.includes('.') ? 'dotted' : op.startsWith('=') ? 'thick' : 'solid';
}

function readEdge(s: string): EdgeOp | undefined {
  const rest = s.trimStart();
  const labeled = LABELED_EDGE.exec(rest);
  if (labeled) return { label: labeled[2].trim(), bidirectional: false, line: lineStyle(labeled[1]), rest: rest.slice(labeled[0].length) };
  const m = SIMPLE_EDGE.exec(rest);
  if (!m) return undefined;
  let after = rest.slice(m[0].length);
  let label: string | undefined;
  const lm = /^\|([^|]*)\|/.exec(after);
  if (lm) {
    label = lm[1].trim();
    after = after.slice(lm[0].length);
  }
  return { label, bidirectional: m[1] === '<' && m[3] === '>', line: lineStyle(m[2]), rest: after };
}

/** Analiza el cuerpo (sin la cabecera) de un `flowchart` / `graph`. */
export function parseFlowchart(lines: MermaidLine[]): FlowchartEvent[] {
  const events: FlowchartEvent[] = [];
  for (const { no, text } of lines) {
    const where = `línea ${no}`;
    for (const stmt of splitStatements(text)) {
      if (stmt === 'end') {
        events.push({ type: 'subgraph-end' });
        continue;
      }
      const sg = /^subgraph\s+(.+)$/.exec(stmt);
      if (sg) {
        const m = /^([^\s[]+)\s*\[\s*"?([^\]"]*)"?\s*\]$/.exec(sg[1]) ?? /^"?(.+?)"?$/.exec(sg[1]);
        const alias = m?.[1] ?? sg[1];
        events.push({ type: 'subgraph-start', alias, label: m?.[2] ?? alias, where });
        continue;
      }
      if (SILENT.test(stmt) || /^(flowchart|graph)\b/.test(stmt)) continue;

      let group = readNodeGroup(stmt);
      if (!group) {
        events.push({ type: 'warning', message: `${where}: no se entiende «${truncate(stmt)}»; se omite.` });
        continue;
      }
      group.nodes.forEach((node) => events.push({ type: 'node', node, where }));
      let rest = group.rest;
      while (rest.trim() !== '') {
        const edge = readEdge(rest);
        if (!edge) {
          events.push({ type: 'warning', message: `${where}: no se entiende «${truncate(rest.trim())}»; se omite.` });
          break;
        }
        const next = readNodeGroup(edge.rest);
        if (!next) {
          events.push({ type: 'warning', message: `${where}: falta el nodo de destino después de la flecha; se omite.` });
          break;
        }
        next.nodes.forEach((node) => events.push({ type: 'node', node, where }));
        events.push({ type: 'edge', from: group.nodes, to: next.nodes, label: edge.label, line: edge.line, bidirectional: edge.bidirectional, where });
        group = next;
        rest = next.rest;
      }
    }
  }
  return events;
}
