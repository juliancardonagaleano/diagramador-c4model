import { STYLE_LABELS } from './notation';
import { CHANNEL_KINDS, KIND_LABELS, type IntegrationNode, type InteractionStyle, type NodeKind } from './types';

export type ConnectionRule = 'channel-sync' | 'channel-link' | 'channel-publisher' | 'channel-consumer' | 'store-source' | 'store-style' | 'scheduler-target' | 'user-source' | 'user-target';

export interface ConnectionViolation {
  rule: ConnectionRule;
  message: string;
}

/** Quién puede publicar en una cola o un tópico, y quién puede leer de ellos. */
const PUBLISHERS: readonly NodeKind[] = ['system', 'api', 'gateway', 'connector', 'scheduler', 'pattern', 'mcp'];
const CONSUMERS: readonly NodeKind[] = ['system', 'api', 'gateway', 'connector', 'pattern', 'mcp'];
/** A qué puede llamar un usuario final. */
const USER_TARGETS: readonly NodeKind[] = ['system', 'api', 'gateway', 'mcp', 'connector'];

const label = (kind: NodeKind): string => `«${KIND_LABELS[kind]}»`;
const list = (kinds: readonly NodeKind[]): string => kinds.map((k) => KIND_LABELS[k].toLowerCase()).join(', ');

/**
 * Reglas de conexión por tipo: los sistemas publican en colas y tópicos y leen de ellos (un canal no se une con otro canal,
 * hace falta un conector o un patrón entre ambos), un almacén solo recibe lectura y escritura, una tarea programada solo
 * dispara y un usuario final solo llama. Devuelve la primera que se incumple, o `undefined` si la interacción encaja.
 */
export function connectionViolation(source: Pick<IntegrationNode, 'kind'>, target: Pick<IntegrationNode, 'kind'>, style: InteractionStyle): ConnectionViolation | undefined {
  const s = source.kind;
  const t = target.kind;
  const sourceIsChannel = CHANNEL_KINDS.includes(s);
  const targetIsChannel = CHANNEL_KINDS.includes(t);

  if (style === 'request-response' && (sourceIsChannel || targetIsChannel)) {
    return { rule: 'channel-sync', message: 'Una cola o un tópico no admite petición-respuesta: se publica con un mensaje asíncrono o un evento y se lee con un consumidor.' };
  }
  if (sourceIsChannel && targetIsChannel) {
    return { rule: 'channel-link', message: 'Una cola o un tópico no se une directamente con otro canal: pon entre ambos un conector o un patrón.' };
  }
  if (targetIsChannel && !PUBLISHERS.includes(s)) {
    return { rule: 'channel-publisher', message: `${label(s)} no publica en ${KIND_LABELS[t].toLowerCase()}: publican ${list(PUBLISHERS)}.${s === 'store' ? ' Para sacar datos de un almacén usa un conector.' : ''}` };
  }
  if (sourceIsChannel && !CONSUMERS.includes(t)) {
    return { rule: 'channel-consumer', message: `${label(t)} no lee de ${KIND_LABELS[s].toLowerCase()}: leen ${list(CONSUMERS)}.${t === 'store' ? ' Para guardar mensajes en un almacén usa un conector.' : ''}` };
  }
  if (s === 'store') {
    return { rule: 'store-source', message: 'Un almacén solo recibe lectura y escritura: no inicia interacciones (la interacción va hacia el almacén).' };
  }
  if (t === 'store' && style !== 'request-response' && style !== 'batch') {
    return { rule: 'store-style', message: `Un almacén solo admite lectura y escritura (${STYLE_LABELS['request-response'].toLowerCase()} o ${STYLE_LABELS.batch.toLowerCase()}), no ${STYLE_LABELS[style].toLowerCase()}.` };
  }
  if (t === 'scheduler') {
    return { rule: 'scheduler-target', message: 'Una tarea programada solo dispara: no recibe interacciones.' };
  }
  if (s === 'user' && !USER_TARGETS.includes(t)) {
    return { rule: 'user-source', message: `Un usuario final usa ${list(USER_TARGETS)}, no ${label(t)}.` };
  }
  if (t === 'user' && style !== 'async-message' && style !== 'event') {
    return { rule: 'user-target', message: 'A un usuario final solo llegan notificaciones (mensaje asíncrono o evento).' };
  }
  return undefined;
}
