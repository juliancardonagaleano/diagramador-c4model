import { pickId } from '@iark/kernel';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import { PLATFORM_DOCUMENT_VERSION, type Dependency, type DependencyKind, type PlatformDocument, type Resource, type ResourceKind, type Service } from '../types';
import { PlatformImportError } from './fromMermaid';

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
  style?: string;
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

/** Tipo de recurso de cada nodo de integración que no es un sistema. */
const RESOURCE_OF: Record<string, ResourceKind> = { store: 'database', gateway: 'gateway', broker: 'queue', queue: 'queue' };

/**
 * Crea el inventario de la plataforma a partir de un documento del módulo de integraciones (leído como JSON, sin depender
 * de ese módulo): cada sistema pasa a ser un servicio (los externos se marcan como tales) y los almacenes, pasarelas,
 * brokers y colas, recursos de un entorno de producción que se crea por defecto; las APIs y los tópicos se funden en el
 * sistema o el broker al que pertenecen. Las interacciones se convierten en dependencias (llamadas, mensajes o datos). No
 * se crean despliegues ni anfitriones: los declara quien conoce la infraestructura. Cada elemento lleva su referencia
 * `urn:iark:integration:<id>`.
 */
export function fromIntegrationJson(input: unknown, options: { name?: string } = {}): { document: PlatformDocument; warnings: string[] } {
  const raw = input as { workspace?: { name?: string }; nodes?: unknown[]; interactions?: unknown[] } | null;
  if (!raw || !Array.isArray(raw.nodes)) throw new PlatformImportError('La entrada no es un documento de integración (falta "nodes").');
  const warnings: string[] = [];
  const nodes = raw.nodes.filter(isNode);
  const systems = nodes.filter((n) => n.kind === 'system');
  if (systems.length === 0) throw new PlatformImportError('El documento de integración no tiene sistemas que pasar a servicios.');
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const environment = { id: pickId('prod', new Set(nodes.map((n) => n.id))), name: 'Producción', kind: 'prod' as const };
  const services: Service[] = systems.map((n) => ({
    id: n.id,
    name: n.name,
    ...(n.description ? { description: n.description } : {}),
    ...(n.technology ? { technology: n.technology } : {}),
    ...(n.owner ? { owner: n.owner } : {}),
    ...(n.external ? { external: true } : {}),
    ref: `urn:iark:integration:${n.id}`,
  }));
  // Un tópico o una cola de un broker o de una pasarela se funde en su contenedor; una cola suelta es un recurso propio.
  const inContainer = (n: NodeLike): boolean => ['broker', 'gateway'].includes(byId.get(n.parentId ?? '')?.kind ?? '');
  const resourceNodes = nodes.filter((n) => (n.kind === 'store' || n.kind === 'gateway' || n.kind === 'broker') || (n.kind === 'queue' && !inContainer(n)));
  const resources: Resource[] = resourceNodes.map((n) => ({
    id: n.id,
    name: n.name,
    kind: RESOURCE_OF[n.kind],
    environmentId: environment.id,
    ...(n.technology ? { technology: n.technology } : {}),
    ...(n.owner ? { owner: n.owner } : {}),
    ...(n.description ? { description: n.description } : {}),
    ref: `urn:iark:integration:${n.id}`,
  }));

  // Un extremo que es una API o un servidor MCP de un sistema cuenta como ese sistema, y un tópico o cola de un broker o pasarela, como su contenedor.
  const resolve = (id: string): { id: string; type: 'service' | 'resource' } | undefined => {
    const n = byId.get(id);
    if (!n) return undefined;
    if (n.kind === 'system') return { id: n.id, type: 'service' };
    if ((n.kind === 'api' || n.kind === 'mcp') && n.parentId && byId.get(n.parentId)?.kind === 'system') return { id: n.parentId, type: 'service' };
    if ((n.kind === 'topic' || n.kind === 'queue') && n.parentId && inContainer(n)) return { id: n.parentId, type: 'resource' };
    return resourceNodes.some((r) => r.id === n.id) ? { id: n.id, type: 'resource' } : undefined;
  };
  const dependencyIds = new Set<string>();
  const signatures = new Set<string>();
  const dependencies: Dependency[] = [];
  let skipped = 0;
  for (const i of (raw.interactions ?? []).filter(isInteraction)) {
    const [from, to] = [resolve(i.sourceId), resolve(i.targetId)];
    if (!from || !to || from.id === to.id) {
      skipped += 1;
      continue;
    }
    // Quien depende de un broker es el que lo usa: si la interacción sale del broker o de una cola, el que depende es el sistema de destino.
    // (Una pasarela, en cambio, depende de los servicios a los que encamina.)
    const fromBroker = from.type === 'resource' && byId.get(from.id)?.kind !== 'gateway' && byId.get(from.id)?.kind !== 'store';
    const [source, target] = fromBroker && to.type === 'service' ? [to, from] : [from, to];
    if (source.type === 'resource' && target.type === 'resource') {
      skipped += 1;
      continue;
    }
    const kind: DependencyKind = target.type === 'resource' ? (byId.get(target.id)?.kind === 'store' ? 'data' : byId.get(target.id)?.kind === 'gateway' ? 'calls' : 'messages') : i.style === 'request-response' ? 'calls' : 'messages';
    const signature = `${kind}|${source.id}|${target.id}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    dependencies.push({
      id: pickId(`${source.id}--${target.id}`, dependencyIds),
      sourceId: source.id,
      targetId: target.id,
      kind,
      ...(i.protocol ? { protocol: i.protocol } : {}),
      ...(i.description ? { description: i.description } : {}),
    });
  }

  const omitted = nodes.length - systems.length - resourceNodes.length;
  if (omitted > 0) warnings.push(`${omitted} nodo(s) (APIs, tópicos y colas de un broker) se funden en el sistema o el broker al que pertenecen.`);
  if (skipped > 0) warnings.push(`${skipped} interacción(es) no se convierten en dependencias (extremos que no son servicios ni recursos, o recurso con recurso).`);
  warnings.push('Se crea el entorno «Producción» con todos los recursos. No se crean redes, anfitriones ni despliegues: declara dónde corre cada servicio.');

  const result = validatePlatformDocument({
    version: PLATFORM_DOCUMENT_VERSION,
    workspace: { name: options.name?.trim() || `Plataforma - ${raw.workspace?.name ?? 'Integración'}` },
    environments: [environment],
    resources,
    services,
    dependencies,
  });
  if (!result.ok) throw new PlatformImportError(`No se pudo construir un documento válido:\n${formatPlatformIssues(result.issues)}`);
  return { document: result.document, warnings };
}
