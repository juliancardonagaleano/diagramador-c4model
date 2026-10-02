import type { DataAsset, DataDocument } from './types';

/**
 * Responsable, dominio y motor de base de datos efectivos de un activo: los suyos o, si no los declara, los del contenedor
 * más cercano que sí (una tabla hereda de su base de datos, un archivo de su lago).
 */
export function inheritance(doc: DataDocument): {
  ownerOf(id: string): string | undefined;
  domainOf(id: string): string | undefined;
  engineOf(id: string): string | undefined;
} {
  const byId = new Map(doc.assets.map((a) => [a.id, a]));
  const climb = <K extends 'owner' | 'domainId' | 'engine'>(id: string, field: K): DataAsset[K] | undefined => {
    const seen = new Set<string>();
    for (let a = byId.get(id); a && !seen.has(a.id); a = a.parentId ? byId.get(a.parentId) : undefined) {
      if (a[field]) return a[field];
      seen.add(a.id);
    }
    return undefined;
  };
  return { ownerOf: (id) => climb(id, 'owner'), domainOf: (id) => climb(id, 'domainId'), engineOf: (id) => climb(id, 'engine') };
}
