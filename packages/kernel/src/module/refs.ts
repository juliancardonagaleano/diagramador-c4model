/**
 * Conserva las referencias entre módulos (`ref: "urn:iark:<módulo>:<id>"`) al refinar un documento con IA. El modelo no
 * conoce las URN de otros documentos y las especificaciones de generación no las incluyen; sin esto, refinar un documento
 * perdería los enlaces de trazabilidad. Los elementos se casan por su colección (la ruta de propiedades hasta ellos) y su
 * `id`, y solo se rellena `ref` en los que no lo traen.
 */
export function carryRefs<T>(base: unknown, generated: T): T {
  const refs = new Map<string, string>();
  const walk = (value: unknown, path: string, visit: (record: Record<string, unknown>, key: string) => void): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, visit);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.id === 'string') visit(record, `${path}#${record.id}`);
      for (const [key, child] of Object.entries(record)) walk(child, `${path}/${key}`, visit);
    }
  };
  walk(base, '', (record, key) => {
    if (typeof record.ref === 'string') refs.set(key, record.ref);
  });
  if (refs.size === 0) return generated;

  const result = structuredClone(generated);
  walk(result, '', (record, key) => {
    if (record.ref === undefined && refs.has(key)) record.ref = refs.get(key);
  });
  return result;
}
