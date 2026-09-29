import { formatDataIssues, validateDataDocument } from '../schema';
import { DATA_DOCUMENT_VERSION, type AssetKind, type DataAsset, type DataDocument } from '../types';
import { DataImportError } from './fromMermaid';

interface IntegrationNodeLike {
  id: string;
  kind: string;
  name: string;
  description?: string;
  technology?: string;
  owner?: string;
  external?: boolean;
}

const KIND_MAP: Record<string, AssetKind> = { store: 'database', queue: 'stream', topic: 'stream' };

const isNode = (x: unknown): x is IntegrationNodeLike => {
  const n = x as Partial<IntegrationNodeLike> | null;
  return !!n && typeof n.id === 'string' && typeof n.kind === 'string' && typeof n.name === 'string';
};

/**
 * Crea el inventario de activos de datos a partir de un documento del módulo de integraciones (leído como JSON, sin
 * depender de ese módulo): los almacenes pasan a bases de datos y las colas y tópicos a streams, cada uno con su
 * referencia `urn:iark:integration:<id>`. Los pipelines los declara quien modela los datos.
 */
export function fromIntegrationJson(input: unknown, options: { name?: string } = {}): { document: DataDocument; warnings: string[] } {
  const raw = input as { workspace?: { name?: string }; nodes?: unknown[] } | null;
  if (!raw || !Array.isArray(raw.nodes)) throw new DataImportError('La entrada no es un documento de integración (falta "nodes").');
  const warnings: string[] = [];
  const nodes = raw.nodes.filter(isNode);
  const assets: DataAsset[] = nodes
    .filter((n) => n.kind in KIND_MAP)
    .map((n) => ({
      id: n.id,
      kind: KIND_MAP[n.kind],
      name: n.name,
      ...(n.description ? { description: n.description } : {}),
      ...(n.technology ? { technology: n.technology } : {}),
      ...(n.owner ? { owner: n.owner } : {}),
      ...(n.external ? { external: true } : {}),
      ref: `urn:iark:integration:${n.id}`,
    }));
  if (assets.length === 0) throw new DataImportError('El documento de integración no tiene almacenes, colas ni tópicos que pasar a datos.');
  const skipped = nodes.length - assets.length;
  if (skipped > 0) warnings.push(`Se omitieron ${skipped} nodo(s) que no guardan datos (sistemas, APIs, pasarelas, brokers).`);
  warnings.push('No se crean pipelines: describe cómo se mueven los datos entre los activos.');
  const result = validateDataDocument({
    version: DATA_DOCUMENT_VERSION,
    workspace: { name: options.name?.trim() || `Datos - ${raw.workspace?.name ?? 'Integración'}` },
    assets,
  });
  if (!result.ok) throw new DataImportError(`No se pudo construir un documento válido:\n${formatDataIssues(result.issues)}`);
  return { document: result.document, warnings };
}
