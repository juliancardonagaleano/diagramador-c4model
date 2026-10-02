import { KIND_LABELS, PARENT_KINDS, type AssetKind, type DataAsset } from './types';

/**
 * Reglas de conexión del lienzo de datos. Un pipeline lee sus entradas y escribe sus salidas: el flujo va del origen al
 * destino, así que un informe (que solo consume) nunca es origen y una fuente externa (que solo produce) nunca es destino.
 */

/** Por qué `asset` no puede ser el origen (lo que el pipeline lee) de un flujo, o `undefined` si puede. */
export function readViolation(asset: DataAsset): string | undefined {
  if (asset.kind === 'report') return `El informe «${asset.name}» solo lee datos: no alimenta a ningún pipeline.`;
  return undefined;
}

/** Por qué `asset` no puede ser el destino (lo que el pipeline escribe) de un flujo, o `undefined` si puede. */
export function writeViolation(asset: DataAsset): string | undefined {
  if (asset.kind === 'source' && asset.external) return `La fuente externa «${asset.name}» solo escribe datos: ningún pipeline de este modelo escribe en ella.`;
  return undefined;
}

const labels = (kinds: readonly AssetKind[]): string => kinds.map((k) => KIND_LABELS[k].toLowerCase()).join(', ');

/** Por qué un activo de tipo `kind` no puede colgar de `parent`, o `undefined` si puede (una tabla, solo de una base, un almacén, un lago o una fuente). */
export function containerViolation(kind: AssetKind, parent: DataAsset): string | undefined {
  const allowed = PARENT_KINDS[kind];
  if (!allowed) return `${KIND_LABELS[kind]} no cuelga de ningún contenedor.`;
  if (!allowed.includes(parent.kind)) return `${KIND_LABELS[kind]} solo cuelga de ${labels(allowed)}, no de ${KIND_LABELS[parent.kind].toLowerCase()} «${parent.name}».`;
  return undefined;
}
