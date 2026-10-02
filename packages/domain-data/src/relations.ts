import type { Participation, Relation } from './types';

/** Multiplicidad UML de un extremo de una relación. */
export type Multiplicity = '1' | '0..1' | '1..*' | '0..*';

export interface RelationEnd {
  /** Admite varios (`N` o `M`). */
  many: boolean;
  /** Mínimo: `0` opcional, `1` obligatorio. */
  min: Participation;
}

/** Notación con la que se dibuja el modelo entidad-relación: pata de gallo (por defecto) o UML con multiplicidades. */
export type ErdNotation = 'crowfoot' | 'uml';

type Shape = Pick<Relation, 'cardinality' | 'sourceMin' | 'targetMin'>;

/**
 * Los dos extremos de una relación a partir de su cardinalidad (`1:N` = un origen, varios destinos) y de `sourceMin`/`targetMin`.
 * Sin ellos, el extremo de uno es obligatorio (`1`) y el de varios es opcional (`0..*`).
 */
export function relationSides(r: Shape): { source: RelationEnd; target: RelationEnd } {
  const [from, to] = r.cardinality.split(':');
  const end = (side: string, min: Participation | undefined): RelationEnd => {
    const many = side !== '1';
    return { many, min: min ?? (many ? 0 : 1) };
  };
  return { source: end(from, r.sourceMin), target: end(to, r.targetMin) };
}

export function formatMultiplicity(end: RelationEnd): Multiplicity {
  if (!end.many) return end.min === 0 ? '0..1' : '1';
  return end.min === 0 ? '0..*' : '1..*';
}

/** Multiplicidad UML escrita junto a cada extremo: `1:N` = `1` junto al origen y `0..*` junto al destino. */
export function multiplicities(r: Shape): { source: Multiplicity; target: Multiplicity } {
  const { source, target } = relationSides(r);
  return { source: formatMultiplicity(source), target: formatMultiplicity(target) };
}

/** Remates de una relación de `erDiagram` (Mermaid): izquierda `||`, `|o`, `}o`, `}|` y derecha `||`, `o|`, `o{`, `|{`. */
export function erSymbols(r: Shape): { left: string; right: string } {
  const { source, target } = relationSides(r);
  const left = source.many ? (source.min === 0 ? '}o' : '}|') : source.min === 0 ? '|o' : '||';
  const right = target.many ? (target.min === 0 ? 'o{' : '|{') : target.min === 0 ? 'o|' : '||';
  return { left, right };
}

/** Opcionalidad que expresa un remate de `erDiagram` (`o` = cero como mínimo), solo si difiere de la que la cardinalidad da por defecto. */
export function participationOfSymbol(symbol: string, many: boolean): Participation | undefined {
  const min: Participation = symbol.includes('o') ? 0 : 1;
  return min === (many ? 0 : 1) ? undefined : min;
}
