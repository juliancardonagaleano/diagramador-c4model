import { formatUrn, pickId } from '@iark/kernel';
import { formatIntegrationIssues, validateIntegrationDocument } from '../schema';
import { INTEGRATION_DOCUMENT_VERSION, PARENT_KINDS, type IntegrationDocument, type IntegrationNode, type Interaction, type InteractionStyle, type NodeKind } from '../types';
import { IntegrationImportError, type IntegrationImportResult } from './fromMermaid';

interface C4ElementLike {
  id: string;
  type: string;
  name: string;
  description?: string;
  technology?: string;
  external?: boolean;
  parentId?: string;
  shape?: string;
}

interface C4RelationshipLike {
  id: string;
  sourceId: string;
  targetId: string;
  description?: string;
  technology?: string;
}

/** Deduce el tipo de nodo de integración de un contenedor C4 por su forma y su tecnología. */
function kindOfContainer(e: C4ElementLike): NodeKind {
  const text = `${e.name} ${e.technology ?? ''}`;
  if (e.shape === 'database') return 'store';
  if (e.shape === 'queue') return 'queue';
  if (/kafka|rabbit|activemq|service ?bus|event ?hub|sqs|sns|pub\/?sub|nats|broker|\bmq\b/i.test(text)) return /queue|cola|sqs/i.test(text) ? 'queue' : 'broker';
  if (/gateway|pasarela|\besb\b|api ?management|kong|apigee/i.test(text)) return 'gateway';
  if (/\bapi\b|rest|graphql|grpc|soap|openapi/i.test(text)) return 'api';
  return 'system';
}

function styleOf(protocol: string | undefined): InteractionStyle {
  const p = protocol ?? '';
  if (/sftp|ftp|batch|lote|file|fichero|csv/i.test(p)) return 'batch';
  if (/kafka|amqp|rabbit|\bmq\b|sqs|sns|service ?bus|event|mensaje|queue|cola/i.test(p)) return 'async-message';
  return 'request-response';
}

/**
 * Convierte un documento del módulo C4 en un mapa de integración. Solo se lee su estructura JSON (no se depende del
 * código del módulo C4): cada sistema y contenedor pasa a ser un nodo con `ref = urn:iark:c4:<id>`, las personas se
 * omiten y las relaciones entre nodos pasan a ser interacciones (el protocolo sale de la tecnología de la relación).
 */
export function fromC4Json(input: unknown, options: { name?: string } = {}): IntegrationImportResult {
  const doc = input as { workspace?: { name?: string }; model?: { elements?: C4ElementLike[]; relationships?: C4RelationshipLike[] } } | null;
  const elements = doc?.model?.elements;
  const relationships = doc?.model?.relationships ?? [];
  if (!Array.isArray(elements)) throw new IntegrationImportError('La entrada no parece un documento C4: falta «model.elements».');

  const warnings: string[] = [];
  const ids = new Set<string>();
  const idOf = new Map<string, string>();
  const nodes: IntegrationNode[] = [];
  let people = 0;
  for (const e of elements) {
    if (e.type === 'person') {
      people += 1;
      continue;
    }
    if (e.type === 'component') continue; // el detalle de código no es integración
    const kind: NodeKind = e.type === 'softwareSystem' ? 'system' : kindOfContainer(e);
    const id = pickId(e.id, ids);
    idOf.set(e.id, id);
    nodes.push({ id, kind, name: e.name, ...(e.description ? { description: e.description } : {}), ...(e.technology ? { technology: e.technology } : {}), ...(e.external ? { external: true } : {}), ref: formatUrn('c4', e.id) });
  }
  // Solo se conserva el padre C4 si encaja en las reglas de jerarquía de integración (api dentro de su sistema, cola dentro de su broker).
  for (const e of elements) {
    const id = idOf.get(e.id);
    const parent = e.parentId ? idOf.get(e.parentId) : undefined;
    const node = nodes.find((n) => n.id === id);
    const parentNode = nodes.find((n) => n.id === parent);
    if (node && parentNode && PARENT_KINDS[node.kind]?.includes(parentNode.kind)) node.parentId = parentNode.id;
  }
  if (people > 0) warnings.push(`Se omitieron ${people} persona(s): no son nodos de integración.`);

  const interactionIds = new Set<string>();
  const interactions: Interaction[] = [];
  let dropped = 0;
  for (const r of relationships) {
    const sourceId = idOf.get(r.sourceId);
    const targetId = idOf.get(r.targetId);
    if (!sourceId || !targetId || sourceId === targetId) {
      dropped += 1;
      continue;
    }
    interactions.push({
      id: pickId(`${sourceId}--${targetId}`, interactionIds),
      sourceId,
      targetId,
      style: styleOf(r.technology),
      ...(r.technology ? { protocol: r.technology } : {}),
      ...(r.description ? { description: r.description } : {}),
    });
  }
  if (dropped > 0) warnings.push(`Se omitieron ${dropped} relación(es) que involucran personas, componentes o nodos inexistentes.`);
  if (nodes.length === 0) throw new IntegrationImportError('El documento C4 no tiene sistemas ni contenedores que importar.');

  const result = validateIntegrationDocument({
    version: INTEGRATION_DOCUMENT_VERSION,
    workspace: { name: options.name?.trim() || `Integración - ${doc?.workspace?.name ?? 'C4'}` },
    nodes,
    contracts: [],
    interactions,
    flows: [],
  });
  if (!result.ok) throw new IntegrationImportError(`No se pudo construir un documento válido:\n${formatIntegrationIssues(result.issues)}`);
  return { document: result.document as IntegrationDocument, warnings };
}
