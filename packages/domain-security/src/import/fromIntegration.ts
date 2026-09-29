import { pickId } from '@iark/kernel';
import { formatSecurityIssues, validateSecurityDocument } from '../schema';
import { SECURITY_DOCUMENT_VERSION, type Asset, type AssetKind, type Flow, type SecurityDocument, type Zone } from '../types';
import { SecurityImportError } from './fromMermaid';
import { encryptionOf } from './protocols';

interface NodeLike {
  id: string;
  kind: string;
  name: string;
  description?: string;
  technology?: string;
  owner?: string;
  external?: boolean;
  parentId?: string;
}

interface InteractionLike {
  sourceId: string;
  targetId: string;
  protocol?: string;
  description?: string;
}

const isNode = (x: unknown): x is NodeLike => {
  const n = x as Partial<NodeLike> | null;
  return !!n && typeof n.id === 'string' && typeof n.kind === 'string' && typeof n.name === 'string';
};
const isInteraction = (x: unknown): x is InteractionLike => {
  const i = x as Partial<InteractionLike> | null;
  return !!i && typeof i.sourceId === 'string' && typeof i.targetId === 'string';
};

/**
 * Crea el modelo de seguridad a partir de un documento del módulo de integraciones (leído como JSON, sin depender de ese
 * módulo): cada sistema pasa a ser un proceso (los externos, una entidad externa), los almacenes, almacenes de datos y las
 * pasarelas, brokers y colas sueltas, procesos o almacenes según su naturaleza; las APIs y los tópicos se funden en el sistema
 * o el broker al que pertenecen. Las interacciones se convierten en flujos de datos (con el cifrado que se deduzca del
 * protocolo). Las zonas de confianza se proponen por heurística: «Externo» (no confiable) para los sistemas de terceros,
 * «Perímetro» (DMZ) para las pasarelas y «Red interna» para el resto; quien conoce la red debe revisarlas. Cada activo lleva su
 * referencia `urn:iark:integration:<id>`.
 */
export function fromIntegrationJson(input: unknown, options: { name?: string } = {}): { document: SecurityDocument; warnings: string[] } {
  const raw = input as { workspace?: { name?: string }; nodes?: unknown[]; interactions?: unknown[] } | null;
  if (!raw || !Array.isArray(raw.nodes)) throw new SecurityImportError('La entrada no es un documento de integración (falta "nodes").');
  const warnings: string[] = [];
  const nodes = raw.nodes.filter(isNode);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const asAsset = (n: NodeLike): boolean => n.kind === 'system' || n.kind === 'store' || n.kind === 'gateway' || n.kind === 'broker' || (n.kind === 'queue' && byId.get(n.parentId ?? '')?.kind !== 'broker');
  const assetNodes = nodes.filter(asAsset);
  if (assetNodes.length === 0) throw new SecurityImportError('El documento de integración no tiene sistemas, almacenes ni pasarelas que pasar a activos.');

  const ids = new Set(nodes.map((n) => n.id));
  const kindOf = (n: NodeLike): AssetKind => (n.kind === 'store' || n.kind === 'queue' ? 'datastore' : n.kind === 'system' && n.external ? 'external' : 'process');
  const zoneKey = (n: NodeLike): 'externo' | 'perimetro' | 'interna' => (n.kind === 'system' && n.external ? 'externo' : n.kind === 'gateway' ? 'perimetro' : 'interna');
  const zoneIds = new Map<string, string>();
  const zones: Zone[] = [];
  const zoneFor = (n: NodeLike): string => {
    const key = zoneKey(n);
    if (!zoneIds.has(key)) {
      const id = pickId(key === 'interna' ? 'red-interna' : key, ids);
      zoneIds.set(key, id);
      zones.push(key === 'externo' ? { id, name: 'Externo', trust: 'untrusted' } : key === 'perimetro' ? { id, name: 'Perímetro', trust: 'dmz' } : { id, name: 'Red interna', trust: 'internal' });
    }
    return zoneIds.get(key)!;
  };
  const assets: Asset[] = assetNodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: kindOf(n),
    zoneId: zoneFor(n),
    ...(n.description ? { description: n.description } : {}),
    ...(n.technology ? { technology: n.technology } : {}),
    ...(n.owner ? { owner: n.owner } : {}),
    ref: `urn:iark:integration:${n.id}`,
  }));
  const assetIds = new Set(assetNodes.map((n) => n.id));

  // Un extremo que es una API de un sistema cuenta como ese sistema, y un tópico o cola de un broker, como el broker.
  const resolve = (id: string): string | undefined => {
    const n = byId.get(id);
    if (!n) return undefined;
    if (assetIds.has(n.id)) return n.id;
    if ((n.kind === 'api' || n.kind === 'topic' || n.kind === 'queue') && n.parentId && assetIds.has(n.parentId)) return n.parentId;
    return undefined;
  };
  const flows: Flow[] = [];
  const flowIds = new Set([...ids]);
  const signatures = new Set<string>();
  let skipped = 0;
  for (const i of (raw.interactions ?? []).filter(isInteraction)) {
    const [source, target] = [resolve(i.sourceId), resolve(i.targetId)];
    if (!source || !target || source === target) {
      skipped += 1;
      continue;
    }
    const signature = `${source}|${target}|${i.protocol ?? ''}|${i.description ?? ''}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const encrypted = encryptionOf(i.protocol);
    flows.push({
      id: pickId(`${source}--${target}`, flowIds),
      sourceId: source,
      targetId: target,
      ...(i.protocol ? { protocol: i.protocol } : {}),
      ...(i.description ? { description: i.description } : {}),
      ...(encrypted !== undefined ? { encrypted } : {}),
    });
  }

  const folded = nodes.length - assetNodes.length;
  if (folded > 0) warnings.push(`${folded} nodo(s) (APIs, tópicos y colas de un broker) se funden en el sistema o el broker al que pertenecen.`);
  if (skipped > 0) warnings.push(`${skipped} interacción(es) no se convierten en flujos (extremos que no son activos, o un activo consigo mismo).`);
  warnings.push('Las zonas de confianza se proponen por heurística (Externo, Perímetro, Red interna): revísalas. No hay clasificación de datos, autenticación, amenazas ni controles: decláralos.');

  const result = validateSecurityDocument({
    version: SECURITY_DOCUMENT_VERSION,
    workspace: { name: options.name?.trim() || `Seguridad - ${raw.workspace?.name ?? 'Integración'}` },
    zones,
    assets,
    flows,
  });
  if (!result.ok) throw new SecurityImportError(`No se pudo construir un documento válido:\n${formatSecurityIssues(result.issues)}`);
  return { document: result.document, warnings };
}
