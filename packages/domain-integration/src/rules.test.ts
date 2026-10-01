import { describe, expect, it } from 'vitest';
import { connectionViolation } from './rules';
import { INTERACTION_STYLES, NODE_KINDS, PARENT_KINDS, type InteractionStyle, type NodeKind } from './types';
import { validateIntegrationDocument } from './schema';

const check = (source: NodeKind, target: NodeKind, style: InteractionStyle) => connectionViolation({ kind: source }, { kind: target }, style)?.rule;

describe('reglas de conexión por tipo', () => {
  it('los sistemas publican en colas y tópicos y leen de ellos', () => {
    for (const channel of ['queue', 'topic'] as const) {
      expect(check('system', channel, 'event')).toBeUndefined();
      expect(check('connector', channel, 'async-message')).toBeUndefined();
      expect(check('scheduler', channel, 'event')).toBeUndefined();
      expect(check('pattern', channel, 'event')).toBeUndefined();
      expect(check(channel, 'system', 'event')).toBeUndefined();
      expect(check(channel, 'pattern', 'event')).toBeUndefined();
    }
  });

  it('un almacén, un usuario o un broker no publican en un canal, y un almacén o un usuario no leen de él', () => {
    expect(check('store', 'queue', 'event')).toBe('channel-publisher');
    expect(check('user', 'topic', 'event')).toBe('channel-publisher');
    expect(check('broker', 'topic', 'event')).toBe('channel-publisher');
    expect(check('queue', 'store', 'event')).toBe('channel-consumer');
    expect(check('topic', 'user', 'event')).toBe('channel-consumer');
  });

  it('un canal no se une con otro canal y no admite petición-respuesta', () => {
    expect(check('queue', 'topic', 'event')).toBe('channel-link');
    expect(check('topic', 'topic', 'event')).toBe('channel-link');
    expect(check('system', 'queue', 'request-response')).toBe('channel-sync');
    expect(check('queue', 'system', 'request-response')).toBe('channel-sync');
  });

  it('un almacén solo recibe lectura y escritura', () => {
    expect(check('system', 'store', 'request-response')).toBeUndefined();
    expect(check('connector', 'store', 'batch')).toBeUndefined();
    expect(check('store', 'system', 'request-response')).toBe('store-source');
    expect(check('system', 'store', 'event')).toBe('store-style');
    expect(check('system', 'store', 'stream')).toBe('store-style');
  });

  it('una tarea programada solo dispara y un usuario solo llama (y recibe notificaciones)', () => {
    expect(check('scheduler', 'system', 'request-response')).toBeUndefined();
    expect(check('system', 'scheduler', 'event')).toBe('scheduler-target');
    expect(check('user', 'api', 'request-response')).toBeUndefined();
    expect(check('user', 'mcp', 'request-response')).toBeUndefined();
    expect(check('user', 'store', 'request-response')).toBe('user-source');
    expect(check('system', 'user', 'event')).toBeUndefined();
    expect(check('system', 'user', 'request-response')).toBe('user-target');
  });

  it('el mensaje dice qué se incumple y cómo arreglarlo', () => {
    const message = (s: NodeKind, t: NodeKind, style: InteractionStyle) => connectionViolation({ kind: s }, { kind: t }, style)?.message ?? '';
    expect(message('store', 'topic', 'event')).toContain('conector');
    expect(message('queue', 'store', 'event')).toContain('almacén');
    expect(message('system', 'store', 'event')).toContain('lote');
  });

  it('toda combinación de tipos y estilos devuelve un resultado definido', () => {
    for (const s of NODE_KINDS) for (const t of NODE_KINDS) for (const style of INTERACTION_STYLES) expect(() => check(s, t, style)).not.toThrow();
  });
});

describe('jerarquía: quién contiene a quién', () => {
  it('solo un broker o una pasarela contiene colas y tópicos; las APIs y los servidores MCP, sistemas', () => {
    expect(PARENT_KINDS.queue).toEqual(['broker', 'gateway']);
    expect(PARENT_KINDS.topic).toEqual(['broker', 'gateway']);
    expect(PARENT_KINDS.api).toEqual(['system']);
    expect(PARENT_KINDS.mcp).toEqual(['system']);
  });

  it('el esquema acepta un tópico dentro de una pasarela y rechaza una cola dentro de un sistema', () => {
    const doc = (parent: string) => ({ nodes: [{ id: 'p', kind: parent, name: 'P' }, { id: 'q', kind: 'queue', name: 'Q', parentId: 'p' }] });
    expect(validateIntegrationDocument(doc('gateway')).ok).toBe(true);
    expect(validateIntegrationDocument(doc('broker')).ok).toBe(true);
    const bad = validateIntegrationDocument(doc('system'));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.issues[0].message).toContain('"broker" o "gateway"');
  });

  it('un nodo de patrón exige su patrón y los demás no lo llevan', () => {
    expect(validateIntegrationDocument({ nodes: [{ id: 'x', kind: 'pattern', name: 'X' }] }).ok).toBe(false);
    expect(validateIntegrationDocument({ nodes: [{ id: 'x', kind: 'pattern', name: 'X', pattern: 'filter' }] }).ok).toBe(true);
    expect(validateIntegrationDocument({ nodes: [{ id: 'x', kind: 'system', name: 'X', pattern: 'filter' }] }).ok).toBe(false);
  });

  it('un nodo que apunta a un contrato inexistente es un error del esquema', () => {
    expect(validateIntegrationDocument({ nodes: [{ id: 'x', kind: 'api', name: 'X', contractId: 'nada' }] }).ok).toBe(false);
    expect(validateIntegrationDocument({ nodes: [{ id: 'x', kind: 'api', name: 'X', contractId: 'c' }], contracts: [{ id: 'c', name: 'C', format: 'mcp' }] }).ok).toBe(true);
  });
});
