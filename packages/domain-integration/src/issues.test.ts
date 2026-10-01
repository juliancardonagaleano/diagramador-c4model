import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyzeIntegration } from './issues';
import { validateIntegrationDocument } from './schema';
import type { IntegrationDocument } from './types';

const parse = (input: unknown): IntegrationDocument => {
  const r = validateIntegrationDocument(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.document;
};

const messages = (input: unknown): string[] => analyzeIntegration(parse(input)).map((i) => i.message);

describe('análisis de las reglas de conexión', () => {
  it('avisa de las uniones que incumplen las reglas por tipo, una sola vez por interacción', () => {
    const found = messages({
      nodes: [
        { id: 'db', kind: 'store', name: 'Base' },
        { id: 'a', kind: 'system', name: 'A', owner: 'x' },
        { id: 'k', kind: 'broker', name: 'K' },
        { id: 'q', kind: 'queue', name: 'Q', parentId: 'k' },
        { id: 't', kind: 'topic', name: 'T', parentId: 'k' },
        { id: 'job', kind: 'scheduler', name: 'Job' },
      ],
      interactions: [
        { id: 'db-a', sourceId: 'db', targetId: 'a', style: 'request-response' },
        { id: 'q-t', sourceId: 'q', targetId: 't', style: 'event' },
        { id: 'a-job', sourceId: 'a', targetId: 'job', style: 'event' },
        { id: 'a-q', sourceId: 'a', targetId: 'q', style: 'request-response' },
      ],
    });
    expect(found.filter((m) => m.includes('incumple las reglas de conexión'))).toEqual([
      expect.stringContaining('Base → A incumple las reglas de conexión: Un almacén solo recibe lectura y escritura'),
      expect.stringContaining('Q → T incumple las reglas de conexión: Una cola o un tópico no se une directamente'),
      expect.stringContaining('A → Job incumple las reglas de conexión: Una tarea programada solo dispara'),
    ]);
    // la petición-respuesta contra una cola ya tenía su aviso propio
    expect(found.filter((m) => m.includes('petición-respuesta contra cola'))).toHaveLength(1);
  });

  it('el ejemplo no incumple ninguna regla', () => {
    const doc = parse(JSON.parse(readFileSync('examples/pedidos-integracion.json', 'utf8')));
    expect(analyzeIntegration(doc).filter((i) => i.message.includes('incumple las reglas'))).toEqual([]);
  });
});

describe('análisis de patrones, dominios y contratos de los nodos', () => {
  it('un nodo de patrón necesita entrada y salida', () => {
    const found = messages({
      nodes: [
        { id: 'p', kind: 'pattern', name: 'Traductor', pattern: 'message-translator' },
        { id: 'a', kind: 'system', name: 'A', owner: 'x' },
      ],
      interactions: [{ id: 'a-p', sourceId: 'a', targetId: 'p', style: 'async-message' }],
    });
    expect(found.some((m) => m.includes('«Traductor» (Traductor de mensajes) transforma mensajes: necesita una interacción de entrada y otra de salida'))).toBe(true);
  });

  it('avisa si el mismo patrón está en la insignia de la línea y en el nodo de su extremo', () => {
    const found = messages({
      nodes: [
        { id: 'a', kind: 'system', name: 'A', owner: 'x' },
        { id: 'p', kind: 'pattern', name: 'Filtro', pattern: 'filter' },
        { id: 'b', kind: 'system', name: 'B', owner: 'x' },
      ],
      interactions: [
        { id: 'a-p', sourceId: 'a', targetId: 'p', style: 'async-message', pattern: 'filter' },
        { id: 'p-b', sourceId: 'p', targetId: 'b', style: 'async-message' },
      ],
    });
    expect(found.some((m) => m.includes('ya lo dibuja como nodo: basta uno de los dos'))).toBe(true);
  });

  it('el dominio de un hijo se ignora y lo dice', () => {
    const found = messages({
      nodes: [
        { id: 's', kind: 'system', name: 'S', owner: 'x', domain: 'Ventas' },
        { id: 'api', kind: 'api', name: 'API', parentId: 's', domain: 'Otro' },
      ],
    });
    expect(found.some((m) => m.includes('El dominio de API «API» se ignora'))).toBe(true);
  });

  it('un contrato en el nodo cuenta como contrato de sus interacciones y como usado', () => {
    const found = messages({
      nodes: [
        { id: 'a', kind: 'system', name: 'A', owner: 'x' },
        { id: 'api', kind: 'api', name: 'API', owner: 'x', contractId: 'c' },
      ],
      contracts: [{ id: 'c', name: 'C', format: 'other', version: '1' }],
      interactions: [{ id: 'a-api', sourceId: 'a', targetId: 'api', style: 'request-response' }],
    });
    expect(found.filter((m) => m.includes('no declara contrato') || m.includes('no tiene contrato') || m.includes('no lo usa'))).toEqual([]);
  });

  it('avisa del contenido incorrecto de un contrato con la línea del problema', () => {
    const found = messages({
      nodes: [{ id: 'api', kind: 'api', name: 'API', owner: 'x', contractId: 'c' }],
      contracts: [{ id: 'c', name: 'Mi OpenAPI', format: 'openapi', version: '1', content: '{\n  "openapi": "3.0.3",\n  "info": { "title": "X" }\n}' }],
    });
    const contract = found.filter((m) => m.startsWith('Contrato «Mi OpenAPI» (openapi)'));
    expect(contract.length).toBeGreaterThan(0);
    expect(contract.some((m) => /línea \d+/.test(m))).toBe(true);
  });

  it('un contrato sin contenido o con contenido válido no genera avisos de contenido', () => {
    const found = messages({
      nodes: [{ id: 'm', kind: 'mcp', name: 'MCP', contractId: 'c' }],
      contracts: [{ id: 'c', name: 'Herramientas', format: 'mcp', version: '1', content: '{"name":"x","version":"1","tools":[{"name":"hola","description":"d","inputSchema":{"type":"object","properties":{}}}]}' }],
    });
    expect(found.filter((m) => m.startsWith('Contrato «'))).toEqual([]);
  });
});
