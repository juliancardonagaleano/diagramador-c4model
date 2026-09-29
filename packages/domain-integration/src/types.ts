/**
 * Documento del módulo de integraciones: un grafo de nodos (sistemas, APIs, pasarelas, brokers, colas, tópicos,
 * almacenes) unidos por interacciones con estilo, protocolo, patrón y contrato, más flujos (secuencias ordenadas de
 * interacciones). No guarda coordenadas: los diagramas se calculan al exportar.
 */
export const INTEGRATION_DOCUMENT_VERSION = '1.0' as const;

export const NODE_KINDS = ['system', 'api', 'gateway', 'broker', 'queue', 'topic', 'store'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const INTERACTION_STYLES = ['request-response', 'async-message', 'event', 'batch', 'stream'] as const;
export type InteractionStyle = (typeof INTERACTION_STYLES)[number];

/** Patrones de integración empresarial (EIP) y de resiliencia más habituales. */
export const PATTERNS = [
  'content-based-router',
  'message-translator',
  'splitter',
  'aggregator',
  'filter',
  'enricher',
  'publish-subscribe',
  'polling-consumer',
  'idempotent-receiver',
  'dead-letter-channel',
  'saga',
  'circuit-breaker',
] as const;
export type IntegrationPattern = (typeof PATTERNS)[number];

export const CONTRACT_FORMATS = ['openapi', 'asyncapi', 'graphql', 'protobuf', 'avro', 'json-schema', 'wsdl', 'other'] as const;
export type ContractFormat = (typeof CONTRACT_FORMATS)[number];

export const CRITICALITIES = ['low', 'medium', 'high'] as const;
export type Criticality = (typeof CRITICALITIES)[number];

export interface IntegrationNode {
  id: string;
  kind: NodeKind;
  name: string;
  description?: string;
  technology?: string;
  owner?: string;
  external?: boolean;
  /** Nodo que lo contiene: una cola o tópico dentro de su broker, una API dentro de su sistema. */
  parentId?: string;
  /** Referencia a un elemento de otro módulo (`urn:iark:c4:tienda`). */
  ref?: string;
  tags?: string[];
}

export interface Contract {
  id: string;
  name: string;
  format: ContractFormat;
  version?: string;
  url?: string;
  description?: string;
}

export interface Interaction {
  id: string;
  sourceId: string;
  targetId: string;
  style: InteractionStyle;
  protocol?: string;
  pattern?: IntegrationPattern;
  contractId?: string;
  description?: string;
  dataObjects?: string[];
  criticality?: Criticality;
}

export interface FlowStep {
  interactionId: string;
  note?: string;
}

export interface Flow {
  id: string;
  name: string;
  description?: string;
  steps: FlowStep[];
}

export interface IntegrationDocument {
  version: typeof INTEGRATION_DOCUMENT_VERSION;
  workspace: { name: string; description?: string };
  nodes: IntegrationNode[];
  contracts: Contract[];
  interactions: Interaction[];
  flows: Flow[];
}

/** Tipo de nodo que puede ser padre de cada tipo. */
export const PARENT_KIND: Partial<Record<NodeKind, NodeKind>> = {
  queue: 'broker',
  topic: 'broker',
  api: 'system',
};

export const KIND_LABELS: Record<NodeKind, string> = {
  system: 'Sistema',
  api: 'API',
  gateway: 'Pasarela',
  broker: 'Broker',
  queue: 'Cola',
  topic: 'Tópico',
  store: 'Almacén',
};
