import { truncate, type MermaidLine } from './preprocess';

export type SequenceArrow = 'sync' | 'reply' | 'async' | 'lost';

export type SequenceEvent =
  | { type: 'title'; text: string }
  | { type: 'participant'; alias: string; label?: string; actor: boolean; where: string }
  | { type: 'message'; from: string; to: string; text: string; arrow: SequenceArrow; where: string }
  | { type: 'warning'; message: string };

const SILENT = /^(autonumber|activate|deactivate|note|loop|alt|else|opt|par|and|end|rect|critical|option|break|box|link|links|properties|details|destroy)\b/i;
const ARROW = /^(\S+?)\s*(--?>>|--?>|--?x|--?\)|<<--?>>)\s*([+-])?\s*([^:\s][^:]*?)\s*:\s*(.*)$/;

function arrowKind(op: string): SequenceArrow {
  if (op.startsWith('--') && op.endsWith('>>')) return 'reply';
  if (op.endsWith(')')) return 'async';
  if (op.endsWith('x')) return 'lost';
  return 'sync';
}

/** Analiza el cuerpo (sin la cabecera) de un `sequenceDiagram`. */
export function parseSequence(lines: MermaidLine[]): SequenceEvent[] {
  const events: SequenceEvent[] = [];
  for (const { no, text } of lines) {
    const where = `línea ${no}`;
    const t = /^title:?\s+(.+)$/i.exec(text);
    if (t) {
      events.push({ type: 'title', text: t[1].trim() });
      continue;
    }
    const decl = /^(?:create\s+)?(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/i.exec(text);
    if (decl) {
      events.push({ type: 'participant', alias: decl[2], label: decl[3]?.trim(), actor: decl[1].toLowerCase() === 'actor', where });
      continue;
    }
    if (SILENT.test(text) || /^sequenceDiagram/.test(text)) continue;
    const m = ARROW.exec(text);
    if (!m) {
      events.push({ type: 'warning', message: `${where}: no se entiende «${truncate(text)}»; se omite.` });
      continue;
    }
    events.push({ type: 'message', from: m[1].trim(), to: m[4].trim(), text: m[5].trim(), arrow: arrowKind(m[2]), where });
  }
  return events;
}
