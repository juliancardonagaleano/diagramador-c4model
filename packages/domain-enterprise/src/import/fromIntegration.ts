import { pickId } from '@iark/kernel';
import { formatEnterpriseIssues, validateEnterpriseDocument } from '../schema';
import { ENTERPRISE_DOCUMENT_VERSION, type Application, type EnterpriseDocument, type Relation, type Technology, type Unit } from '../types';
import { EnterpriseImportError } from './fromMermaid';

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

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/**
 * Crea el inventario de aplicaciones a partir de un documento del módulo de integraciones (leído como JSON, sin depender
 * de ese módulo): cada sistema pasa a ser una aplicación y cada almacén una tecnología (base de datos), con su
 * referencia `urn:iark:integration:<id>`; los responsables (texto) pasan a unidades. Las llamadas síncronas entre
 * sistemas (incluidas las que van a una API del sistema) se convierten en «depende de», y un sistema que usa un almacén
 * «se ejecuta en» él. Las capacidades y procesos los declara quien modela la empresa.
 */
export function fromIntegrationJson(input: unknown, options: { name?: string } = {}): { document: EnterpriseDocument; warnings: string[] } {
  const raw = input as { workspace?: { name?: string }; nodes?: unknown[]; interactions?: unknown[] } | null;
  if (!raw || !Array.isArray(raw.nodes)) throw new EnterpriseImportError('La entrada no es un documento de integración (falta "nodes").');
  const warnings: string[] = [];
  const nodes = raw.nodes.filter(isNode);
  const systems = nodes.filter((n) => n.kind === 'system');
  const stores = nodes.filter((n) => n.kind === 'store');
  if (systems.length === 0) throw new EnterpriseImportError('El documento de integración no tiene sistemas que pasar a aplicaciones.');

  const reserved = new Set(nodes.map((n) => n.id));
  const taken = new Set<string>();
  const units = new Map<string, Unit>();
  const unitFor = (owner: string | undefined): string | undefined => {
    const name = owner?.trim();
    if (!name) return undefined;
    if (!units.has(name)) units.set(name, { id: pickId(slug(name) || 'unidad', taken, reserved), name });
    return units.get(name)!.id;
  };

  const applications: Application[] = systems.map((n) => ({
    id: n.id,
    name: n.name,
    ...(n.description ? { description: n.description } : {}),
    ...(n.technology ? { technology: n.technology } : {}),
    ...(unitFor(n.owner) ? { ownerId: unitFor(n.owner) } : {}),
    ...(n.external ? { external: true } : {}),
    ref: `urn:iark:integration:${n.id}`,
  }));
  const technologies: Technology[] = stores.map((n) => ({
    id: n.id,
    name: n.name,
    kind: 'database',
    ...(n.description ? { description: n.description } : {}),
    ...(n.technology ? { version: n.technology } : {}),
    ...(unitFor(n.owner) ? { ownerId: unitFor(n.owner) } : {}),
    ref: `urn:iark:integration:${n.id}`,
  }));

  // Un extremo que es una API o un servidor MCP de un sistema cuenta como ese sistema.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const systemOf = (id: string): string | undefined => {
    const n = byId.get(id);
    if (n?.kind === 'system') return n.id;
    return (n?.kind === 'api' || n?.kind === 'mcp') && n.parentId && byId.get(n.parentId)?.kind === 'system' ? n.parentId : undefined;
  };
  const relationIds = new Set<string>();
  const signatures = new Set<string>();
  const relations: Relation[] = [];
  let skipped = 0;
  for (const i of (raw.interactions ?? []).filter(isInteraction)) {
    const from = systemOf(i.sourceId);
    const target = byId.get(i.targetId);
    let relation: Omit<Relation, 'id'> | undefined;
    if (from && target?.kind === 'store') relation = { kind: 'runs-on', sourceId: from, targetId: target.id };
    else if (from && i.style === 'request-response' && systemOf(i.targetId) && systemOf(i.targetId) !== from) {
      relation = { kind: 'depends-on', sourceId: from, targetId: systemOf(i.targetId)!, ...(i.description ? { description: i.description } : {}) };
    }
    if (!relation) {
      skipped += 1;
      continue;
    }
    const signature = `${relation.kind}|${relation.sourceId}|${relation.targetId}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    relations.push({ id: pickId(`${relation.sourceId}--${relation.kind}--${relation.targetId}`, relationIds), ...relation });
  }

  const omitted = nodes.length - systems.length - stores.length;
  if (omitted > 0) warnings.push(`Se omitieron ${omitted} nodo(s) que no son aplicaciones ni bases de datos (APIs, pasarelas, brokers, colas, tópicos).`);
  if (skipped > 0) warnings.push(`${skipped} interacción(es) no se convierten en relaciones (solo las llamadas síncronas entre sistemas y el uso de almacenes).`);
  warnings.push('No se crean capacidades ni procesos: describe qué soporta cada aplicación.');

  const result = validateEnterpriseDocument({
    version: ENTERPRISE_DOCUMENT_VERSION,
    workspace: { name: options.name?.trim() || `Empresa - ${raw.workspace?.name ?? 'Integración'}` },
    units: [...units.values()],
    applications,
    technologies,
    relations,
  });
  if (!result.ok) throw new EnterpriseImportError(`No se pudo construir un documento válido:\n${formatEnterpriseIssues(result.issues)}`);
  return { document: result.document, warnings };
}
