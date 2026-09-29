import { truncate, type MermaidLine } from './preprocess';

export type ErKey = 'PK' | 'FK' | 'UK';

export interface ErEntityRef {
  /** Nombre tal cual aparece (sin las comillas de un nombre entrecomillado). */
  alias: string;
  /** Alias legible (`pedido["Pedido de venta"]`), si lo hay. */
  label?: string;
}

/** Lo que se lee de un `erDiagram`, en el orden del texto. Una entidad se emite cada vez que se menciona. */
export type ErEvent =
  | { type: 'entity'; entity: ErEntityRef; where: string }
  | {
      type: 'attribute';
      entity: string;
      /** La línea tal cual, con los espacios normalizados. */
      raw: string;
      /** Ausentes si la línea no tiene la forma `tipo nombre [PK, FK…] ["comentario"]`. */
      attrType?: string;
      name?: string;
      keys: ErKey[];
      comment?: string;
      where: string;
    }
  | {
      type: 'relation';
      from: ErEntityRef;
      to: ErEntityRef;
      /** Extremos de la relación tal cual (`||`, `}o`… y `o|`, `o{`…). */
      left: string;
      right: string;
      identifying: boolean;
      label?: string;
      where: string;
    }
  | { type: 'warning'; message: string };

const ENT = '("[^"]*"|[^\\s"\\[{]+)';
const ALIAS = '(?:\\[\\s*"([^"]*)"\\s*\\])?';
const RELATION = new RegExp(`^${ENT}${ALIAS}\\s+(\\S+?)(--|\\.\\.)(\\S+?)\\s+${ENT}${ALIAS}\\s*(?::\\s*(.*))?$`);
const BLOCK = new RegExp(`^${ENT}${ALIAS}\\s*\\{$`);
const LONE = new RegExp(`^${ENT}${ALIAS}$`);
const ATTRIBUTE = /^(\S+)\s+(\S+)(?:\s+((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*))?(?:\s+"([^"]*)")?$/i;

const unquote = (s: string): string => s.replace(/^"|"$/g, '');
const ref = (name: string, label: string | undefined): ErEntityRef => ({ alias: unquote(name), ...(label ? { label } : {}) });

/** Analiza el cuerpo (sin la cabecera) de un `erDiagram`. */
export function parseEr(lines: MermaidLine[]): ErEvent[] {
  const events: ErEvent[] = [];
  let current: string | undefined;
  for (const { no, text } of lines) {
    const where = `línea ${no}`;
    if (current !== undefined) {
      if (text === '}') {
        current = undefined;
        continue;
      }
      const m = ATTRIBUTE.exec(text.replace(/\s+/g, ' '));
      const keys = (m?.[3] ?? '')
        .split(',')
        .map((k) => k.trim().toUpperCase())
        .filter((k): k is ErKey => k === 'PK' || k === 'FK' || k === 'UK');
      events.push({
        type: 'attribute',
        entity: current,
        raw: text.replace(/\s+/g, ' '),
        ...(m ? { attrType: m[1], name: m[2], comment: m[4] } : {}),
        keys,
        where,
      });
      continue;
    }
    const block = BLOCK.exec(text);
    if (block) {
      const entity = ref(block[1], block[2]);
      current = entity.alias;
      events.push({ type: 'entity', entity, where });
      continue;
    }
    if (/^(title|accTitle|accDescr|direction)\b/i.test(text)) continue;
    const rel = RELATION.exec(text);
    if (rel) {
      const from = ref(rel[1], rel[2]);
      const to = ref(rel[6], rel[7]);
      events.push({ type: 'entity', entity: from, where }, { type: 'entity', entity: to, where });
      events.push({ type: 'relation', from, to, left: rel[3], right: rel[5], identifying: rel[4] === '--', label: rel[8]?.replace(/^"|"$/g, '').trim() || undefined, where });
      continue;
    }
    const lone = LONE.exec(text);
    if (lone) {
      events.push({ type: 'entity', entity: ref(lone[1], lone[2]), where });
      continue;
    }
    events.push({ type: 'warning', message: `${where}: no se entiende «${truncate(text)}»; se omite.` });
  }
  return events;
}

/**
 * Multiplicidad de cada extremo de una relación de Mermaid: `many` si admite varios (`}o`, `}|`, `o{`, `|{`).
 * La opcionalidad (`o`) no se conserva: los módulos que la necesitan la leen de `left` y `right`.
 */
export function erEndIsMany(end: string): boolean {
  return end.startsWith('}') || end.endsWith('{');
}
