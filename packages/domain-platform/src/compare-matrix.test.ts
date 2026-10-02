import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformCommands } from './commands';
import { compareEnvironments, compareMatrix, comparableEnvironments, matrixReport, resolveEnvironments, summarizeMatrix } from './compare';
import { platformEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { buildScene, layoutView, toSvg } from './export/render';
import { platformModule } from './module';
import { formatPlatformIssues, validatePlatformDocument } from './schema';
import type { PlatformDocument } from './types';
import { findView, listViews } from './views';

const example = JSON.parse(readFileSync('examples/plataforma-ejemplo.json', 'utf8')) as Record<string, Array<Record<string, unknown>>>;
const parse = (input: unknown): PlatformDocument => {
  const r = validatePlatformDocument(input);
  if (!r.ok) throw new Error(formatPlatformIssues(r.issues));
  return r.document;
};

/**
 * El ejemplo (desarrollo y producción) con una preproducción en medio, un servicio que solo corre en preproducción y producción
 * (Auditoría), otro que falta en preproducción (Notificaciones) y un balanceador que solo tienen preproducción y producción.
 */
function threeEnvironments(): PlatformDocument {
  const json = JSON.parse(JSON.stringify(example)) as Record<string, Array<Record<string, unknown>>>;
  json.environments.splice(1, 0, { id: 'stg', name: 'Preproducción', kind: 'staging', provider: 'AWS', region: 'eu-west-1' });
  json.resources.push(
    { id: 'k8s-stg', name: 'k8s-stg', kind: 'cluster', environmentId: 'stg', technology: 'Kubernetes', version: '1.28' },
    { id: 'pedidos-db-stg', name: 'Base de pedidos (stg)', kind: 'database', environmentId: 'stg', technology: 'PostgreSQL', version: '14' },
    { id: 'kafka-stg', name: 'Kafka (stg)', kind: 'queue', environmentId: 'stg', technology: 'Kafka' },
    { id: 'lb-stg', name: 'Balanceador público', kind: 'load-balancer', environmentId: 'stg', technology: 'AWS ALB' },
  );
  json.services.push({ id: 'auditoria', name: 'Auditoría', owner: 'Equipo Finanzas' });
  const at = (id: string, serviceId: string, environmentId: string, hostId: string, version: string, replicas?: number): Record<string, unknown> => ({ id, serviceId, environmentId, hostId, version, ...(replicas ? { replicas } : {}) });
  json.deployments.push(
    at('pedidos-stg', 'pedidos', 'stg', 'k8s-stg', '3.1.0', 2),
    at('tienda-web-stg', 'tienda-web', 'stg', 'k8s-stg', '2.4.0', 1),
    at('facturacion-stg', 'facturacion', 'stg', 'k8s-stg', '1.7.4', 1),
    at('reportes-stg', 'reportes', 'stg', 'k8s-stg', '0.4.0'),
    at('auditoria-stg', 'auditoria', 'stg', 'k8s-stg', '0.1.0', 1),
    at('auditoria-prod', 'auditoria', 'prod', 'k8s-prod', '0.1.0', 2),
  );
  return parse(json);
}

const doc = threeEnvironments();
const two = parse(example);

describe('entornos de una vista compare', () => {
  const ids = (text: string, d = doc): string[] => resolveEnvironments(d, text).map((e) => e.id);

  it('resuelve una lista de entornos por id o por nombre, con el primero como referencia', () => {
    expect(ids('dev:stg:prod')).toEqual(['dev', 'stg', 'prod']);
    expect(ids('prod:stg:dev')).toEqual(['prod', 'stg', 'dev']);
    expect(ids('Desarrollo:preproducción:PROD')).toEqual(['dev', 'stg', 'prod']);
  });

  it('«all» (o «todos») son todos los entornos con contenido, y «A:all» los mismos con A como referencia', () => {
    expect(ids('all')).toEqual(['dev', 'stg', 'prod']);
    expect(ids('todos')).toEqual(['dev', 'stg', 'prod']);
    expect(ids('prod:all')).toEqual(['prod', 'dev', 'stg']);
    expect(ids('stg:todos')).toEqual(['stg', 'dev', 'prod']);
    // Un entorno vacío no se compara.
    const empty = parse({ ...JSON.parse(JSON.stringify(doc)), environments: [...doc.environments, { id: 'vacio', name: 'Vacío' }] });
    expect(comparableEnvironments(empty).map((e) => e.id)).toEqual(['dev', 'stg', 'prod']);
    expect(ids('all', empty)).toEqual(['dev', 'stg', 'prod']);
  });

  it('mantiene el significado de siempre de `A`, `A:B` y de un nombre con «:»', () => {
    expect(ids('dev', two)).toEqual(['dev', 'prod']);
    expect(ids('prod', two)).toEqual(['prod', 'dev']);
    expect(ids('dev:prod', two)).toEqual(['dev', 'prod']);
    const colon = parse({ environments: [{ id: 'a', name: 'A' }, { id: 'b', name: 'Pre: prod' }, { id: 'prod', name: 'Prod' }], resources: [{ id: 'r', name: 'R', kind: 'cluster', environmentId: 'a' }] });
    expect(ids('a:Pre: prod', colon)).toEqual(['a', 'b']);
    expect(ids('a:Pre: prod:prod', colon)).toEqual(['a', 'b', 'prod']);
  });

  it('rechaza los entornos inexistentes, repetidos o los que no dejan con qué comparar', () => {
    expect(() => ids('dev:qa:prod')).toThrow(/No existe el entorno «qa»/);
    expect(() => ids('dev:stg:dev')).toThrow(/repetido/);
    expect(() => ids('dev:all:stg:prod')).not.toThrow();
    expect(() => ids('all', parse({ environments: [{ id: 'a', name: 'A' }] }))).toThrow(/no tiene entornos con contenido/);
    expect(() => compareMatrix(doc, ['dev'])).toThrow(/al menos dos/);
    expect(() => compareMatrix(doc, ['dev', 'stg', 'dev'])).toThrow(/distintos/);
    expect(() => compareMatrix(doc, ['dev', 'qa', 'prod'])).toThrow(/No existe el entorno «qa»/);
  });
});

describe('matriz de entornos', () => {
  const matrix = compareMatrix(doc, ['dev', 'stg', 'prod']);
  const row = (id: string) => matrix.services.find((r) => r.service.id === id)!;
  const kinds = (id: string) => row(id).cells.map((c) => c.kinds);

  it('compara cada entorno con el primero: versión, réplicas, lo que falta y lo que la referencia no tiene', () => {
    expect(kinds('tienda-web')).toEqual([[], [], ['version', 'replicas']]);
    expect(kinds('pedidos')).toEqual([[], ['replicas'], ['version', 'replicas']]);
    expect(kinds('facturacion')).toEqual([[], ['version'], ['version', 'replicas']]);
    expect(kinds('notificaciones')).toEqual([[], ['only-a'], []]);
    expect(row('notificaciones').cells[1].presence).toBeUndefined();
    expect(kinds('auditoria')).toEqual([[], ['only-b'], ['only-b']]);
    expect(row('auditoria').cells[0].presence).toBeUndefined();
    expect(row('pedidos').cells.map((c) => c.presence?.replicas)).toEqual([1, 2, 3]);
    expect(matrix.services.map((r) => r.service.id)).not.toContain('pasarela-pagos');
  });

  it('con dos entornos coincide con la comparación de dos entornos de siempre', () => {
    const [pair, legacy] = [compareMatrix(two, ['dev', 'prod']), compareEnvironments(two, 'dev', 'prod')];
    expect(pair.services.map((r) => [r.service.id, r.cells[1].kinds, r.cells[0].presence?.replicas, r.cells[1].presence?.replicas])).toEqual(legacy.services.map((s) => [s.service.id, s.kinds, s.a?.replicas, s.b?.replicas]));
    const sorted = (xs: string[]): string[] => [...xs].sort();
    expect(sorted(pair.resources.map((r) => `${r.cells[0].resource?.id}|${r.cells[1].resource?.id}|${r.cells[1].kinds}|${r.cells[1].matchedBy}`))).toEqual(sorted(legacy.resources.map((r) => `${r.a?.id}|${r.b?.id}|${r.kinds}|${r.matchedBy}`)));
  });

  it('empareja los recursos con los de la referencia, dice cómo, y junta los que ella no tiene en una sola fila', () => {
    const rowOf = (id: string) => matrix.resources.find((r) => r.cells.some((c) => c.resource?.id === id))!;
    expect(rowOf('k8s-dev').cells.map((c) => c.resource?.id)).toEqual(['k8s-dev', 'k8s-stg', 'k8s-prod']);
    expect(rowOf('k8s-dev').cells.map((c) => c.kinds)).toEqual([[], ['version'], []]);
    expect(rowOf('k8s-dev').cells.map((c) => c.matchedBy)).toEqual([undefined, 'normalized', 'normalized']);
    expect(rowOf('kafka-dev').cells.map((c) => c.resource?.id)).toEqual(['kafka-dev', 'kafka-stg', 'kafka-prod']);
    // El balanceador no está en desarrollo: es una fila, no dos.
    expect(rowOf('lb-stg')).toBe(rowOf('lb-prod'));
    expect(rowOf('lb-stg').cells.map((c) => [c.resource?.id, c.kinds])).toEqual([[undefined, []], ['lb-stg', ['only-b']], ['lb-prod', ['only-b']]]);
    expect(matrix.resources).toHaveLength(4);
  });

  it('un recurso de la referencia que falta en otro entorno queda marcado como falta', () => {
    const noKafka = parse({ ...JSON.parse(JSON.stringify(doc)), resources: doc.resources.filter((r) => r.id !== 'kafka-stg') });
    const kafka = compareMatrix(noKafka, ['dev', 'stg', 'prod']).resources.find((r) => r.cells[0].resource?.id === 'kafka-dev')!;
    expect(kafka.cells.map((c) => [c.resource?.id, c.kinds])).toEqual([['kafka-dev', []], [undefined, ['only-a']], ['kafka-prod', []]]);
  });

  it('resume cuántos elementos difieren de la referencia en cada entorno', () => {
    const [stg, prod] = summarizeMatrix(matrix);
    expect(stg.environment.id).toBe('stg');
    expect(stg.counts).toEqual({ 'only-a': 1, 'only-b': 2, version: 3, replicas: 1, same: 3 });
    expect(prod.counts).toEqual({ 'only-a': 0, 'only-b': 2, version: 4, replicas: 3, same: 4 });
  });

  it('el informe lleva una tabla de servicios y otra de recursos, lo que difiere y el resumen frente a la referencia', () => {
    const text = matrixReport(matrix);
    expect(text).toContain('Comparación de 3 entornos: «Desarrollo» (A, referencia), «Preproducción» (B), «Producción» (C)');
    expect(text).toContain('| Servicio | Desarrollo (A, referencia) | Preproducción (B) | Producción (C) |');
    expect(text).toContain('| Servicio de pedidos | v3.1.0 ×1 | v3.1.0 ×2 ≠ réplicas | v3.0.2 ×3 ≠ versión y réplicas |');
    expect(text).toContain('| Notificaciones | v0.9.0 ×1 | — falta | v0.9.0 ×1 |');
    expect(text).toContain('| Auditoría | — | v0.1.0 ×1 (no está en la referencia) | v0.1.0 ×2 (no está en la referencia) |');
    expect(text).toContain('| Clúster «k8s-dev» | «k8s-dev» v1.29 | «k8s-stg» v1.28 ≠ versión (emparejado por nombre normalizado) | «k8s-prod» v1.29 |');
    expect(text).toContain('- Preproducción (B): versión distinta: 3 · réplicas distintas: 1 · faltan: 1 · no están en la referencia: 2 · iguales: 3');
    expect(text).toContain('Iguales en los 3 entornos: 1 elemento(s).');
    const same = compareMatrix(parse({ environments: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], resources: ['a', 'b', 'c'].map((e) => ({ id: `r-${e}`, name: 'Caché', kind: 'cache', environmentId: e })) }), ['a', 'b', 'c']);
    expect(matrixReport(same)).toContain('Los 3 entornos son equivalentes');
  });
});

describe('vistas de comparación de varios entornos', () => {
  it('se listan los pares consecutivos y, con tres o más entornos con contenido, la matriz de todos (compare:all)', () => {
    const ids = listViews(doc).map((v) => v.id);
    expect(ids).toEqual(['topology', 'env:dev', 'env:stg', 'env:prod', 'delivery', 'compare:dev:stg', 'compare:stg:prod', 'compare:all', 'costs']);
    // Con dos entornos no hay matriz: el par ya lo dice todo.
    expect(listViews(two).map((v) => v.id)).not.toContain('compare:all');
    expect(platformModule.views!(doc).find((v) => v.id === 'compare:all')?.title).toMatch(/^Comparación de todos los entornos/);
  });

  it('se pide por id con la lista de entornos; el primero es la referencia', () => {
    expect(findView(doc, 'compare:all')).toMatchObject({ id: 'compare:all', type: 'compare', compareIds: ['dev', 'stg', 'prod'] });
    expect(findView(doc, 'compare:prod:dev:stg')).toMatchObject({ id: 'compare:prod:dev:stg', compareIds: ['prod', 'dev', 'stg'], title: expect.stringContaining('Producción - Desarrollo - Preproducción') });
    expect(findView(doc, 'compare:prod:all').compareIds).toEqual(['prod', 'dev', 'stg']);
    expect(findView(doc, 'compare:dev:prod').compareIds).toEqual(['dev', 'prod']);
    // «Todos» con dos entornos es la comparación de dos.
    expect(findView(two, 'compare:all')).toMatchObject({ id: 'compare:dev:prod', compareIds: ['dev', 'prod'] });
    expect(() => findView(doc, 'compare:dev:qa:prod')).toThrow(/No existe el entorno «qa»/);
    expect(() => findView(doc, 'nada')).toThrow(/compare:<entorno>:<entorno>\[:<entorno>…\], compare:all/);
  });

  it('la vista lleva los servicios y recursos comparados y los despliegues de sus entornos', () => {
    const view = findView(doc, 'compare:all');
    expect(view.elementIds).toEqual(expect.arrayContaining(['pedidos', 'auditoria', 'k8s-stg', 'lb-prod', 'lb-stg', 'kafka-dev']));
    expect(view.elementIds).not.toContain('pasarela-pagos');
    expect(view.deploymentIds).toHaveLength(doc.deployments.length);
    expect(findView(doc, 'compare:dev:stg:prod').elementIds).toEqual(view.elementIds);
  });
});

describe('dibujo de la matriz', () => {
  const view = findView(doc, 'compare:all');
  const scene = buildScene(doc, view);

  it('es una columna por entorno y una celda por servicio o recurso, marcada según lo que difiere de la referencia', () => {
    expect([...scene.groups.keys()]).toEqual(['c:dev', 'c:stg', 'c:prod']);
    expect([...scene.groups.values()].map((g) => g.label)).toEqual(['A · Desarrollo (referencia)', 'B · Preproducción', 'C · Producción']);
    const node = (id: string) => scene.nodes.get(id)!;
    expect(node('i:pedidos-dev')).toMatchObject({ diff: 'same', badge: 'Referencia', groupId: 'c:dev' });
    expect(node('i:pedidos-stg')).toMatchObject({ diff: 'replicas', badge: 'Réplicas distintas', groupId: 'c:stg' });
    expect(node('i:pedidos-prod')).toMatchObject({ diff: 'mixed', badge: 'Versión + réplicas', groupId: 'c:prod' });
    expect(node('i:tienda-web-stg')).toMatchObject({ diff: 'same', badge: 'Igual que A' });
    expect(node('i:facturacion-stg')).toMatchObject({ diff: 'version' });
    expect(node('i:auditoria-prod')).toMatchObject({ diff: 'only-b', dashed: true, badge: 'No está en A' });
    expect(node('i:pedidos-prod').lines).toEqual(['Servicio de pedidos', 'v3.0.2 · 3 réplicas']);
    // Lo que falta en un entorno deja su hueco marcado; lo que la referencia no tiene no dibuja nada en ella.
    expect(node('m:notificaciones:stg')).toMatchObject({ diff: 'only-a', dashed: true, badge: 'Falta aquí', groupId: 'c:stg', lines: ['Notificaciones', 'no desplegado'] });
    expect([...scene.nodes.keys()].filter((id) => id.includes('auditoria') && id.endsWith('dev'))).toEqual([]);
    expect(node('k8s-stg')).toMatchObject({ diff: 'version', groupId: 'c:stg' });
    expect(node('k8s-stg').lines).toContain('emparejado por nombre normalizado');
    expect(node('lb-stg')).toMatchObject({ diff: 'only-b' });
    expect(scene.edges.size).toBe(0);
  });

  it('coloca la cuadrícula: columnas alineadas, una fila por elemento, cada celda dentro de su entorno y sin solaparse', async () => {
    const { layout } = await layoutView(doc, 'compare:all');
    const boxes = new Map([...layout.nodes, ...layout.groups].map((b) => [b.id, b]));
    expect(layout.groups.map((g) => g.id)).toEqual(['c:dev', 'c:stg', 'c:prod']);
    expect(new Set(layout.groups.map((g) => g.y))).toEqual(new Set([0]));
    expect(new Set(layout.groups.map((g) => g.height)).size).toBe(1);
    for (const n of layout.nodes) {
      const g = boxes.get(scene.nodes.get(n.id)!.groupId!)!;
      expect(n.x).toBeGreaterThanOrEqual(g.x);
      expect(n.x + n.width).toBeLessThanOrEqual(g.x + g.width);
      expect(n.y).toBeGreaterThanOrEqual(g.y + 40);
      expect(n.y + n.height).toBeLessThanOrEqual(g.y + g.height);
    }
    const [dev, stg, prod] = ['i:pedidos-dev', 'i:pedidos-stg', 'i:pedidos-prod'].map((id) => boxes.get(id)!);
    expect([dev.y, stg.y]).toEqual([prod.y, prod.y]);
    expect(dev.x).toBeLessThan(stg.x);
    expect(stg.x).toBeLessThan(prod.x);
    expect(boxes.get('m:notificaciones:stg')!.y).toBe(boxes.get('i:notificaciones-dev')!.y);
    for (const [i, a] of layout.nodes.entries()) {
      for (const b of layout.nodes.slice(i + 1)) expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height, `${a.id} se solapa con ${b.id}`).toBe(false);
    }
    // Los recursos van tras los servicios.
    expect(boxes.get('k8s-dev')!.y).toBeGreaterThan(boxes.get('i:auditoria-stg')!.y);
    expect(layout.width).toBeGreaterThanOrEqual(Math.max(...layout.groups.map((g) => g.x + g.width)));
  });

  it('el lienzo proyecta la matriz con su leyenda y su propia colocación; el resto de vistas, el autolayout', async () => {
    const graph = platformEditor.project(doc, 'compare:all');
    expect(graph.legend?.items.map((i) => i.label)).toContain('Versión distinta');
    expect(graph.edges).toEqual([]);
    const pedidos = graph.nodes.find((n) => n.id === 'i:pedidos-prod')!;
    expect(pedidos).toMatchObject({ parentId: 'c:prod', label: 'Servicio de pedidos', sublabel: 'v3.0.2 · 3 réplicas', badges: ['Versión + réplicas'] });
    expect(graph.nodes.find((n) => n.id === 'c:stg')).toMatchObject({ kind: 'environment', label: 'B · Preproducción' });
    expect(platformEditor.read(doc, 'i:pedidos-prod')?.kind).toBe('instance');
    const own = await platformEditor.layout!(doc, 'compare:all');
    expect(own?.groups.map((g) => g.id)).toEqual(['c:dev', 'c:stg', 'c:prod']);
    expect([...graph.nodes].every((n) => n.kind === 'environment' || own!.nodes.some((b) => b.id === n.id))).toBe(true);
    expect(await platformEditor.layout!(doc, 'compare:dev:stg')).toBeUndefined();
    expect(await platformEditor.layout!(doc, 'env:prod')).toBeUndefined();
    expect(platformEditor.project(doc, 'compare:dev:stg').legend).toBeUndefined();
  });

  it('se exporta a SVG, Mermaid y draw.io', async () => {
    const svg = await toSvg(doc, 'compare:all');
    expect(svg).toContain('A · Desarrollo (referencia)');
    expect(svg.toLowerCase()).toContain('versión + réplicas');
    expect(svg).toContain('No está en A');
    expect(svg).toContain('Frente a A');
    const width = Number(/width="(\d+)"/.exec(svg)![1]);
    expect(width).toBeGreaterThan(700);
    const mermaid = toMermaid(doc, { viewId: 'compare:all' });
    expect(mermaid.match(/subgraph /g)).toHaveLength(3);
    expect(mermaid).toContain('subgraph stg["B · Preproducción"]');
    for (const cls of ['diff_only_a', 'diff_only_b', 'diff_version', 'diff_replicas', 'diff_mixed']) expect(mermaid).toContain(`classDef ${cls}`);
    expect(mermaid).toContain('classDef matrix_1e293b');
    expect(mermaid).toContain('Servicio de pedidos<br/>v3.0.2 · 3 réplicas<br/>Versión + réplicas');
    const drawio = await toDrawio(doc, 'compare:all');
    expect(drawio.match(/<diagram /g)).toHaveLength(1);
    expect(drawio).toContain('Falta aquí');
    expect(drawio).toContain('C · Producción');
    // La matriz es una de las páginas del libro completo.
    expect((await toDrawio(doc)).match(/<diagram /g)).toHaveLength(listViews(doc).length);
  });
});

describe('comando compare con varios entornos', () => {
  const run = (args: string[], d: PlatformDocument = doc): string => platformCommands.find((c) => c.name === 'compare')!.run({ args, options: {}, input: JSON.stringify(d) } as never) as string;

  it('con una lista separada por comas, «todos» o más de dos argumentos saca la matriz', () => {
    const expected = matrixReport(compareMatrix(doc, ['dev', 'stg', 'prod']));
    expect(run(['dev,stg,prod'])).toBe(expected);
    expect(run(['todos'])).toBe(expected);
    expect(run(['dev,stg', 'prod'])).toBe(expected);
    expect(run(['dev', 'stg,prod'])).toBe(expected);
    expect(run(['prod,dev,stg'])).toContain('Comparación de 3 entornos: «Producción» (A, referencia), «Desarrollo» (B), «Preproducción» (C)');
    expect(run(['dev:stg:prod'])).toBe(expected);
  });

  it('con dos entornos sigue dando el informe de diferencias de siempre', () => {
    expect(run(['dev', 'prod'], two)).toContain('Comparación de «Desarrollo» (A) y «Producción» (B)');
    expect(run(['dev,prod'], two)).toBe(run(['dev', 'prod'], two));
    expect(run(['dev'], two)).toBe(run(['dev', 'prod'], two));
    expect(run(['todos'], two)).toBe(run(['dev', 'prod'], two));
  });

  it('avisa de los entornos que no existen', () => {
    expect(() => run(['dev,qa,prod'])).toThrow(/No existe el entorno «qa»/);
    expect(() => run(['dev,dev'])).toThrow(/repetido/);
  });
});
