/**
 * Capa sintáctica común de Mermaid: limpieza del texto, tipo de diagrama y análisis de `flowchart` y `sequenceDiagram`.
 * No conoce ningún modelo: cada módulo de la suite traduce estos eventos a su propio documento.
 */

export interface MermaidLine {
  /** Número de línea (1-based) en el texto de origen. */
  no: number;
  text: string;
}

export type MermaidKind = 'c4' | 'flowchart' | 'sequence' | 'er';

/** Tipos de diagrama de Mermaid que la suite sabe leer (para los mensajes de error). */
export const MERMAID_DIAGRAM_KINDS = ['C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'flowchart / graph', 'sequenceDiagram', 'erDiagram'] as const;

/** Limpia el texto: bloque ```mermaid, frontmatter con `title`, comentarios `%%` y líneas vacías. */
export function preprocessMermaid(source: string): { lines: MermaidLine[]; title?: string } {
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
  const lines: MermaidLine[] = [];
  text.split('\n').forEach((raw, i) => {
    let t = raw.trim();
    if (!t || t.startsWith('%%')) return; // comentarios y directivas %%{init: …}%%
    t = t.replace(/\s%%[^"']*$/, '').trim();
    if (t) lines.push({ no: i + 1, text: t });
  });
  return { lines, title };
}

export function detectMermaidKind(header: string): MermaidKind | undefined {
  const word = header.split(/\s+/)[0];
  if (/^C4(Context|Container|Component|Dynamic|Deployment)$/.test(word)) return 'c4';
  if (word === 'flowchart' || word === 'flowchart-elk' || word === 'graph') return 'flowchart';
  if (word === 'sequenceDiagram') return 'sequence';
  if (word === 'erDiagram') return 'er';
  return undefined;
}

/** ¿Parece texto de Mermaid? (para autodetectar el formato de un archivo sin extensión conocida). */
export function looksLikeMermaid(source: string): boolean {
  try {
    const { lines } = preprocessMermaid(source);
    return lines.length > 0 && detectMermaidKind(lines[0].text) !== undefined;
  } catch {
    return false;
  }
}

/** Texto de un nodo de Mermaid: sin comillas/backticks y con `<br/>` como salto (primer tramo = nombre, resto = descripción). */
export function splitLabel(raw: string): { name: string; description?: string } {
  const text = raw.replace(/^"|"$/g, '').replace(/^`|`$/g, '').trim();
  const parts = text
    .split(/<br\s*\/?>|\\n/i)
    .map((p) => p.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean);
  const [name = '', ...rest] = parts;
  return { name, description: rest.length > 0 ? rest.join(' ') : undefined };
}

/** Separa las sentencias de una línea por `;`, sin cortar los `;` que estén entre comillas. */
export function splitStatements(text: string): string[] {
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

export function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
