import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildTraceGraph, traceMermaid, traceReach, traceReachReport, traceReport, type AnyModule } from '@iark/kernel';
import { dataModule, enterpriseModule, integrationModule, platformModule, securityModule } from '../src/modules-app/testing';

const doc = (file: string): unknown => JSON.parse(readFileSync(`examples/${file}`, 'utf8'));
const parse = (module: AnyModule, file: string): unknown => module.schema.parse(doc(file));

const inputs = () => [
  { module: securityModule, document: parse(securityModule, 'seguridad-ejemplo.json'), source: 'seguridad.json' },
  { module: platformModule, document: parse(platformModule, 'plataforma-ejemplo.json'), source: 'plataforma.json' },
  { module: integrationModule, document: parse(integrationModule, 'pedidos-integracion.json'), source: 'integracion.json' },
  { module: enterpriseModule, document: parse(enterpriseModule, 'empresa-arquitectura.json') },
  { module: dataModule, document: parse(dataModule, 'ventas-datos.json') },
];

describe('trazabilidad entre módulos', () => {
  it('reúne los enlaces por URN de los ejemplos: seguridad → plataforma → integración', () => {
    const graph = buildTraceGraph(inputs());
    expect(graph.problems).toEqual([]);
    expect(graph.links).toHaveLength(14);
    expect(graph.links).toContainEqual({ from: 'urn:iark:security:pedidos', to: 'urn:iark:platform:pedidos' });
    expect(graph.links).toContainEqual({ from: 'urn:iark:platform:pedidos', to: 'urn:iark:integration:pedidos' });
    expect(graph.documents.find((d) => d.module === 'security')).toMatchObject({ source: 'seguridad.json' });
    expect(graph.nodes.find((n) => n.urn === 'urn:iark:platform:kafka-prod')).toMatchObject({ name: 'Kafka (prod)', kind: 'resource' });
  });

  it('el impacto de un elemento atraviesa módulos: quién se apoya en él, y de qué se apoya', () => {
    const graph = buildTraceGraph(inputs());
    const impact = traceReach(graph, 'urn:iark:integration:pedidos', { direction: 'referrers' });
    expect(impact.map((r) => [r.node.urn, r.distance])).toEqual([
      ['urn:iark:integration:pedidos', 0],
      ['urn:iark:platform:pedidos', 1],
      ['urn:iark:security:pedidos', 2],
    ]);
    const depends = traceReach(graph, 'urn:iark:security:pedidos', { direction: 'refs' });
    expect(depends.map((r) => r.node.urn)).toEqual(['urn:iark:security:pedidos', 'urn:iark:platform:pedidos', 'urn:iark:integration:pedidos']);
    expect(traceReach(graph, 'urn:iark:security:pedidos', { direction: 'refs', depth: 1 })).toHaveLength(2);
    const middle = traceReach(graph, 'urn:iark:platform:pedidos');
    expect(middle.filter((r) => r.direction === 'referrers').map((r) => r.node.module)).toEqual(['security']);
    expect(middle.filter((r) => r.direction === 'refs').map((r) => r.node.module)).toEqual(['integration']);
    expect(() => traceReach(graph, 'urn:iark:platform:nada')).toThrow(/No existe el elemento «urn:iark:platform:nada»/);
  });

  it('distingue las referencias colgantes, las mal formadas y las de módulos sin documento', () => {
    const security = parse(securityModule, 'seguridad-ejemplo.json') as { assets: Array<{ id: string; ref?: string }> };
    const broken = structuredClone(security);
    broken.assets.find((a) => a.id === 'pedidos')!.ref = 'urn:iark:platform:no-existe';
    broken.assets.find((a) => a.id === 'kafka')!.ref = 'esto no es una urn';
    const graph = buildTraceGraph([
      { module: securityModule, document: broken },
      { module: platformModule, document: parse(platformModule, 'plataforma-ejemplo.json') },
    ]);
    expect(graph.problems.map((p) => [p.from, p.reason])).toEqual(
      expect.arrayContaining([
        ['urn:iark:security:pedidos', 'dangling'],
        ['urn:iark:security:kafka', 'invalid'],
      ]),
    );
    const unresolved = buildTraceGraph([{ module: platformModule, document: parse(platformModule, 'plataforma-ejemplo.json') }]);
    expect(unresolved.problems.every((p) => p.reason === 'unresolved' && p.ref.startsWith('urn:iark:integration:'))).toBe(true);
    expect(unresolved.links).toEqual([]);
  });

  it('no admite dos documentos del mismo módulo (las URN colisionarían)', () => {
    const one = { module: securityModule, document: parse(securityModule, 'seguridad-ejemplo.json') };
    expect(() => buildTraceGraph([one, one])).toThrow(/aparece más de una vez/);
  });

  it('informes y Mermaid', () => {
    const graph = buildTraceGraph(inputs());
    const report = traceReport(graph);
    expect(report).toContain('5 documentos');
    expect(report).toContain('**security → platform** (5)');
    expect(report).toContain('- platform:pedidos (Servicio de pedidos) → integration:pedidos (Servicio de pedidos)');
    const impact = traceReachReport(traceReach(graph, 'urn:iark:integration:pedidos', { direction: 'referrers' }), 'referrers');
    expect(impact).toContain('security:pedidos (Servicio de pedidos) · asset · a 2 saltos');
    expect(impact).not.toContain('De lo que se apoya');
    expect(impact).toContain('Módulos alcanzados: platform, security');

    const mermaid = traceMermaid(graph);
    expect(mermaid.startsWith('flowchart LR')).toBe(true);
    expect(mermaid).toContain('subgraph security["security"]');
    expect((mermaid.match(/-\.->/g) ?? []).length).toBe(14);
    const subset = traceMermaid(graph, new Set(['urn:iark:integration:pedidos', 'urn:iark:platform:pedidos']));
    expect((subset.match(/-\.->/g) ?? []).length).toBe(1);
  });
});

describe('iark trace (CLI)', () => {
  const run = (args: string[]) => spawnSync('node_modules/.bin/tsx', ['src/cli/index.ts', 'trace', ...args], { encoding: 'utf8' });
  const docs = ['security=examples/seguridad-ejemplo.json', 'platform=examples/plataforma-ejemplo.json', 'integration=examples/pedidos-integracion.json'];

  it('informe general, impacto con --from y salida JSON/Mermaid', () => {
    const general = run(docs);
    expect(general.status).toBe(0);
    expect(general.stdout).toContain('3 documentos');
    const impact = run([...docs, '--from', 'integration:pedidos', '--direction', 'referrers']);
    expect(impact.stdout).toContain('security:pedidos (Servicio de pedidos)');
    const json = JSON.parse(run([...docs, '--from', 'urn:iark:platform:pedidos', '--format', 'json']).stdout);
    expect(json.from).toBe('urn:iark:platform:pedidos');
    expect(json.reached).toHaveLength(3);
    expect(run([...docs, '--format', 'mermaid']).stdout.startsWith('flowchart LR')).toBe(true);
  });

  it('--strict falla con referencias rotas pero no con las de módulos sin documento; los errores de uso salen con código 2', () => {
    expect(run(['security=examples/seguridad-ejemplo.json', '--strict']).status).toBe(0);
    expect(run(['nada']).stderr).toMatch(/módulo=archivo/);
    expect(run(['nada=examples/banca.json']).status).not.toBe(0);
    expect(run([...docs, '--from', 'platform:inexistente']).stderr).toMatch(/No existe el elemento/);
    expect(run([...docs, '--from', 'sin-formato']).stderr).toMatch(/no es una URN/);
    expect(run([...docs, '--direction', 'lados']).stderr).toMatch(/Sentido inválido/);
    expect(run(['security=examples/seguridad-ejemplo.json', 'security=examples/seguridad-ejemplo.json']).stderr).toMatch(/aparece más de una vez/);
  });
});
