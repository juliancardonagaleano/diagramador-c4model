import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ModuleSource } from '../modules-app/controller';
import { dataModule, enterpriseModule, integrationModule, platformModule, securityModule } from '../modules-app/testing';
import { TraceBoard } from './board';

const file = (name: string) => async () => readFileSync(`examples/${name}`, 'utf8');
const sources: ModuleSource[] = [
  { id: 'integration', label: 'Integración', load: async () => integrationModule, example: file('pedidos-integracion.json') },
  { id: 'data', label: 'Datos', load: async () => dataModule, example: file('ventas-datos.json') },
  { id: 'enterprise', label: 'Empresarial', load: async () => enterpriseModule, example: file('empresa-arquitectura.json') },
  { id: 'platform', label: 'Plataforma', load: async () => platformModule, example: file('plataforma-ejemplo.json') },
  { id: 'security', label: 'Seguridad', load: async () => securityModule, example: file('seguridad-ejemplo.json') },
];

describe('TraceBoard', () => {
  it('carga los ejemplos y forma el grafo transversal', async () => {
    const board = new TraceBoard(sources);
    const results = await board.loadExamples();
    expect(Object.values(results).every((r) => r.ok)).toBe(true);
    const graph = board.graph();
    expect(graph.documents.map((d) => d.module)).toEqual(['integration', 'data', 'enterprise', 'platform', 'security']);
    expect(graph.links).toHaveLength(14);
    expect(graph.problems).toEqual([]);
    expect(board.moduleLabels().security).toBe('Seguridad');
  });

  it('un documento con errores no sustituye al anterior y explica el motivo', async () => {
    const board = new TraceBoard(sources);
    await board.loadExample('security');
    const before = board.documents.get('security')!.document;

    const syntax = await board.load('security', '{ roto', 'pegado');
    expect(syntax).toMatchObject({ ok: false });
    expect(!syntax.ok && syntax.message).toMatch(/No es JSON válido/);

    const schema = await board.load('security', JSON.stringify({ version: '9.9', zones: 3 }), 'pegado');
    expect(!schema.ok && schema.message).toMatch(/No cumple el esquema del módulo/);

    expect(await board.load('security', '   ', 'pegado')).toEqual({ ok: false, message: 'El documento está vacío.' });
    expect(board.documents.get('security')!.document).toBe(before);
  });

  it('un módulo sin su documento deja los enlaces hacia él como «sin resolver» y quitarlo los actualiza', async () => {
    const board = new TraceBoard(sources);
    await board.loadExample('security');
    expect(board.graph().links).toEqual([]);
    expect(board.graph().problems.map((p) => p.reason)).toContain('unresolved');
    await board.loadExample('platform');
    await board.loadExample('integration');
    expect(board.graph().links).toHaveLength(11);
    board.remove('platform');
    expect(board.graph().links).toEqual([]);
    board.clear();
    expect(board.graph().nodes).toEqual([]);
  });

  it('rechaza un módulo que el tablero no ofrece', async () => {
    const board = new TraceBoard(sources);
    await expect(board.load('nada', '{}', 'x')).rejects.toThrow(/no ofrece el módulo «nada»/);
  });
});
