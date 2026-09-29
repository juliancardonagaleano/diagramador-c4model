import type { AiSpec } from '@iark/kernel';
import { z } from 'zod';
import { formatIntegrationIssues, validateIntegrationDocument } from '../schema';
import { CONTRACT_FORMATS, CRITICALITIES, INTEGRATION_DOCUMENT_VERSION, INTERACTION_STYLES, NODE_KINDS, PATTERNS, type IntegrationDocument } from '../types';

// Lo que produce el modelo: todos los campos presentes (null si no aplican), como exige la salida estructurada.
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const generatedNode = z.object({
  id: z.string(),
  kind: z.enum(NODE_KINDS),
  name: z.string(),
  description: nullable(z.string()),
  technology: nullable(z.string()),
  owner: nullable(z.string()),
  external: nullable(z.boolean()),
  parentId: nullable(z.string()),
});

const generatedContract = z.object({
  id: z.string(),
  name: z.string(),
  format: z.enum(CONTRACT_FORMATS),
  version: nullable(z.string()),
  url: nullable(z.string()),
  description: nullable(z.string()),
});

const generatedInteraction = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  style: z.enum(INTERACTION_STYLES),
  protocol: nullable(z.string()),
  pattern: nullable(z.enum(PATTERNS)),
  contractId: nullable(z.string()),
  description: nullable(z.string()),
  dataObjects: nullable(z.array(z.string())),
  criticality: nullable(z.enum(CRITICALITIES)),
});

const generatedFlow = z.object({
  id: z.string(),
  name: z.string(),
  description: nullable(z.string()),
  steps: z.array(z.object({ interactionId: z.string(), note: nullable(z.string()) })),
});

export const generatedIntegrationSchema = z.object({
  workspace: z.object({ name: z.string(), description: nullable(z.string()) }),
  nodes: z.array(generatedNode),
  contracts: z.array(generatedContract),
  interactions: z.array(generatedInteraction),
  flows: z.array(generatedFlow),
});

export type GeneratedIntegration = z.infer<typeof generatedIntegrationSchema>;

/** Quita los `null` que exige la salida estructurada: el documento usa campos ausentes. */
function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null).map(([k, v]) => [k, dropNulls(v)])) as T;
  }
  return value;
}

export function generatedToIntegration(generated: GeneratedIntegration): { ok: true; document: IntegrationDocument } | { ok: false; issues: string } {
  const result = validateIntegrationDocument({ version: INTEGRATION_DOCUMENT_VERSION, ...dropNulls(generated) });
  return result.ok ? result : { ok: false, issues: formatIntegrationIssues(result.issues) };
}

export function generationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(generatedIntegrationSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

export function systemPrompt(): string {
  return `Eres un arquitecto de integraciones experto en integración de aplicaciones, APIs, mensajería y patrones de
integración empresarial (EIP). Tu tarea es convertir una descripción en lenguaje natural en un modelo de integración
estructurado en JSON. NO produces coordenadas: el diagramador coloca los nodos después. Concéntrate en el modelo.

Nodos (kind):
- "system": aplicación o sistema (interno, o externo si es de terceros: external = true).
- "api": interfaz expuesta por un sistema; su parentId es el id del sistema que la expone.
- "gateway": pasarela de APIs, ESB o proxy de integración.
- "broker": plataforma de mensajería (Kafka, RabbitMQ, Service Bus…). Sus colas y tópicos llevan parentId = id del broker.
- "queue" / "topic": cola punto a punto / tópico de publicación-suscripción.
- "store": base de datos, almacén de ficheros o bucket que forma parte de la integración.
- Solo queue, topic y api pueden tener parentId; los demás lo dejan en null. Ids únicos en kebab-case ASCII.
- owner: equipo o persona responsable, si se menciona.

Interacciones (siempre origen → destino, quien inicia la comunicación es el origen):
- style: "request-response" (llamada síncrona), "async-message" (mensaje por cola), "event" (evento publicado),
  "batch" (carga por lotes o ficheros), "stream" (flujo continuo).
- protocol: REST, gRPC, SOAP, AMQP, Kafka, SFTP, JDBC… si es evidente; null en otro caso.
- pattern: solo si la descripción lo implica (router, traductor, agregador, saga, circuit breaker…).
- Un productor publica EN la cola o tópico (origen = productor, destino = cola/tópico) y un consumidor lee DE ella
  (origen = cola/tópico, destino = consumidor). No enlaces productor y consumidor directamente a través de un broker.
- contractId: id del contrato (OpenAPI, AsyncAPI, Avro, Protobuf…) si se mencionan; declara el contrato en "contracts".
- criticality según el impacto de negocio si se indica. Nunca crees interacciones de un nodo consigo mismo.

Flujos: cuando la descripción narre un proceso paso a paso (p. ej. "un pedido…"), crea un flujo con sus pasos, cada uno
apuntando a una interacción existente y en el orden en que ocurren.

Responde en el idioma de la instrucción del usuario (nombres, descripciones). Sé concreto y no inventes nodos que la
descripción no justifique.`;
}

export function toGenerated(doc: IntegrationDocument): GeneratedIntegration {
  const n = <T,>(v: T | undefined): T | null => v ?? null;
  return {
    workspace: { name: doc.workspace.name, description: n(doc.workspace.description) },
    nodes: doc.nodes.map((x) => ({ id: x.id, kind: x.kind, name: x.name, description: n(x.description), technology: n(x.technology), owner: n(x.owner), external: n(x.external), parentId: n(x.parentId) })),
    contracts: doc.contracts.map((c) => ({ id: c.id, name: c.name, format: c.format, version: n(c.version), url: n(c.url), description: n(c.description) })),
    interactions: doc.interactions.map((i) => ({
      id: i.id,
      sourceId: i.sourceId,
      targetId: i.targetId,
      style: i.style,
      protocol: n(i.protocol),
      pattern: n(i.pattern),
      contractId: n(i.contractId),
      description: n(i.description),
      dataObjects: n(i.dataObjects),
      criticality: n(i.criticality),
    })),
    flows: doc.flows.map((f) => ({ id: f.id, name: f.name, description: n(f.description), steps: f.steps.map((s) => ({ interactionId: s.interactionId, note: n(s.note) })) })),
  };
}

export const integrationAiSpec: AiSpec<IntegrationDocument> = {
  generationSchema: generatedIntegrationSchema,
  generationJsonSchema,
  system: systemPrompt,
  user(instruction, base) {
    if (!base) return `Genera el modelo de integración para la siguiente descripción:\n\n${instruction}`;
    return (
      `Este es el modelo de integración actual en JSON:\n\n${JSON.stringify(toGenerated(base), null, 2)}\n\n` +
      `Aplica la siguiente instrucción de refinamiento y devuelve el modelo COMPLETO actualizado. Conserva los ids ` +
      `existentes de lo que no cambia y solo añade, modifica o elimina lo que la instrucción requiera:\n\n${instruction}`
    );
  },
  retry: (issues) => `El modelo devuelto no pasó la validación. Corrige estos problemas y devuelve el modelo completo de nuevo:\n${issues}`,
  toDocument: (generated) => generatedToIntegration(generated as GeneratedIntegration),
};
