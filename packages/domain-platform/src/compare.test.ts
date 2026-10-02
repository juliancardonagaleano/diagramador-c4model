import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { platformCommands } from './commands';
import { compareEnvironments, compareReport, resolveComparison, summarize, type EnvironmentComparison } from './compare';
import { platformEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { buildScene, toSvg } from './export/render';
import { analyzePlatform } from './issues';
import { platformModule } from './module';
import { formatPlatformIssues, validatePlatformDocument } from './schema';
import type { PlatformDocument, Resource } from './types';
import { findView } from './views';

const example = JSON.parse(readFileSync('examples/plataforma-ejemplo.json', 'utf8')) as unknown;
const parse = (input: unknown): PlatformDocument => {
  const r = validatePlatformDocument(input);
  if (!r.ok) throw new Error(formatPlatformIssues(r.issues));
  return r.document;
};
const base = parse(example);
/** Ejemplo con un servicio solo en desarrollo, otros solo en producción, y cambios de versión y réplicas. */
const doc: PlatformDocument = {
  ...base,
  services: [...base.services, { id: 'solo-prod', name: 'Solo prod' }],
  deployments: [
    ...base.deployments.filter((d) => d.id !== 'reportes-prod' && d.id !== 'notificaciones-dev'),
    { id: 'solo-prod-prod', serviceId: 'solo-prod', environmentId: 'prod', hostId: 'k8s-prod', replicas: 2, version: '1.0.0' },
  ],
};

describe('comparación de entornos', () => {
  const comparison = compareEnvironments(doc, 'dev', 'prod');
  const kinds = (id: string) => comparison.services.find((s) => s.service.id === id)?.kinds;

  it('clasifica los servicios: solo en A, solo en B, versión + réplicas, iguales', () => {
    expect(kinds('reportes')).toEqual(['only-a']);
    expect(kinds('solo-prod')).toEqual(['only-b']);
    expect(kinds('notificaciones')).toEqual(['only-b']);
    expect(kinds('pedidos')).toEqual(['version', 'replicas']);
    expect(kinds('tienda-web')).toEqual(['version', 'replicas']);
    expect(summarize(comparison)['only-b']).toBeGreaterThanOrEqual(2);
    const same = compareEnvironments({ ...doc, deployments: doc.deployments.map((d) => (d.id === 'pedidos-prod' ? { ...d, version: '3.1.0', replicas: 1 } : d)) }, 'dev', 'prod');
    expect(same.services.find((s) => s.service.id === 'pedidos')?.kinds).toEqual([]);
  });

  it('empareja los recursos por nombre, tecnología y clase', () => {
    const pairs = comparison.resources.filter((r) => r.a && r.b).map((r) => [r.a!.id, r.b!.id]);
    expect(pairs).toContainEqual(['kafka-dev', 'kafka-prod']);
    expect(pairs).toContainEqual(['pedidos-db-dev', 'pedidos-db-prod']);
    expect(comparison.resources.find((r) => r.b?.id === 'lb-prod')?.kinds).toEqual(['only-b']);
    // «Kafka (dev)» y «Kafka (prod)» se emparejan por el nombre sin el del entorno, y el resultado lo dice.
    expect(comparison.resources.find((r) => r.a?.id === 'kafka-dev')?.matchedBy).toBe('normalized');
    expect(comparison.resources.find((r) => r.b?.id === 'lb-prod')?.matchedBy).toBeUndefined();
  });

  it('resuelve entornos por id, nombre o contrapartida, y rechaza los inexistentes', () => {
    expect(resolveComparison(doc, 'dev:prod').map((e) => e.id)).toEqual(['dev', 'prod']);
    expect(resolveComparison(doc, 'dev').map((e) => e.id)).toEqual(['dev', 'prod']);
    expect(resolveComparison(doc, 'prod').map((e) => e.id)).toEqual(['prod', 'dev']);
    expect(() => resolveComparison(doc, 'dev:qa')).toThrow(/No existe el entorno/);
    expect(() => compareEnvironments(doc, 'dev', 'dev')).toThrow(/distintos/);
  });

  it('el informe de diferencias lista cada clase', () => {
    const text = compareReport(doc, comparison);
    expect(text).toContain('Servicios solo en');
    expect(text).toMatch(/Reportes nocturnos: 1 réplica · v0\.4\.0/);
    expect(text).toMatch(/Versión distinta[\s\S]*Servicio de pedidos: .* v3\.1\.0 · .* v3\.0\.2/);
    expect(text).toMatch(/Réplicas distintas[\s\S]*Servicio de pedidos: .* 1 · .* 3/);
    expect(text).toContain('Balanceador público');
  });
});

/** Dos entornos con solo recursos, para probar cómo se emparejan. */
const pairing = (staging: Array<Partial<Resource> & Pick<Resource, 'id' | 'name' | 'kind'>>, prod: Array<Partial<Resource> & Pick<Resource, 'id' | 'name' | 'kind'>>): EnvironmentComparison =>
  compareEnvironments(
    parse({
      environments: [{ id: 'stg', name: 'Preproducción', kind: 'staging' }, { id: 'prd', name: 'Producción', kind: 'prod' }],
      resources: [...staging.map((r) => ({ ...r, environmentId: 'stg' })), ...prod.map((r) => ({ ...r, environmentId: 'prd' }))],
    }),
    'stg',
    'prd',
  );
const pairsOf = (c: EnvironmentComparison): string[] => c.resources.filter((r) => r.a && r.b).map((r) => `${r.a!.id}=${r.b!.id}:${r.matchedBy}`);
const aloneOf = (c: EnvironmentComparison): string[] => c.resources.filter((r) => !(r.a && r.b)).map((r) => (r.a ?? r.b)!.id);

describe('emparejado de recursos entre entornos', () => {
  it('empareja por nombre idéntico sin distinguir mayúsculas', () => {
    const c = pairing([{ id: 'a', name: 'Kafka Pedidos', kind: 'queue' }], [{ id: 'b', name: ' kafka pedidos', kind: 'queue' }]);
    expect(pairsOf(c)).toEqual(['a=b:name']);
  });

  it('quita del nombre el entorno (id, nombre y clase), acentos y mayúsculas, como sufijo, prefijo o entre paréntesis', () => {
    const c = pairing(
      [
        { id: 'k-s', name: 'kafka-staging', kind: 'queue' },
        { id: 'p-s', name: 'Postgres de pruebas', kind: 'database', version: '14' },
        { id: 'r-s', name: 'Redis (preproducción)', kind: 'cache' },
        { id: 'c-s', name: '[STG] Caché de sesión', kind: 'cache' },
        { id: 'o-s', name: 'Órdenes Preprod', kind: 'storage' },
      ],
      [
        { id: 'k-p', name: 'kafka-prod', kind: 'queue' },
        { id: 'p-p', name: 'Postgres producción', kind: 'database', version: '15' },
        { id: 'r-p', name: 'REDIS PROD', kind: 'cache' },
        { id: 'c-p', name: 'prod - Cache de sesion', kind: 'cache' },
        { id: 'o-p', name: 'Ordenes (Production)', kind: 'storage' },
      ],
    );
    expect(pairsOf(c)).toEqual(['k-s=k-p:normalized', 'p-s=p-p:normalized', 'r-s=r-p:normalized', 'c-s=c-p:normalized', 'o-s=o-p:normalized']);
    expect(c.resources.find((r) => r.a?.id === 'p-s')?.kinds).toEqual(['version']);
    expect(aloneOf(c)).toEqual([]);
  });

  it('también quita el id y el nombre de un entorno personalizado, y no confunde clases distintas', () => {
    const c = compareEnvironments(
      parse({
        environments: [{ id: 'carga', name: 'Pruebas de carga' }, { id: 'prd', name: 'Producción', kind: 'prod' }],
        resources: [
          { id: 'a', name: 'Kafka (pruebas de carga)', kind: 'queue', environmentId: 'carga' },
          { id: 'b', name: 'Kafka', kind: 'queue', environmentId: 'prd' },
          { id: 'c', name: 'Redis carga', kind: 'cache', environmentId: 'carga' },
          { id: 'd', name: 'Redis', kind: 'queue', environmentId: 'prd' },
        ],
      }),
      'carga',
      'prd',
    );
    expect(pairsOf(c)).toEqual(['a=b:normalized']);
    expect(aloneOf(c).sort()).toEqual(['c', 'd']);
  });

  it('si dos recursos de un lado quedan con el mismo nombre normalizado, no decide entre ellos', () => {
    const c = pairing([{ id: 'a1', name: 'Kafka de pruebas', kind: 'queue' }, { id: 'a2', name: 'Kafka (stg)', kind: 'queue' }], [{ id: 'b', name: 'Kafka', kind: 'queue' }]);
    expect(pairsOf(c)).toEqual([]);
    expect(aloneOf(c)).toEqual(['a1', 'a2', 'b']);
    // Con el nombre idéntico por medio, el resto sí se resuelve.
    expect(pairsOf(pairing([{ id: 'a1', name: 'Kafka de pruebas', kind: 'queue' }, { id: 'a2', name: 'Kafka', kind: 'queue' }], [{ id: 'b', name: 'Kafka', kind: 'queue' }]))).toEqual(['a2=b:name']);
  });

  it('un nombre que es solo el del entorno no se queda vacío', () => {
    expect(pairsOf(pairing([{ id: 'a', name: 'Producción', kind: 'cache' }], [{ id: 'b', name: 'Producción', kind: 'cache' }]))).toEqual(['a=b:name']);
    expect(pairsOf(pairing([{ id: 'a', name: 'Prod', kind: 'cache' }], [{ id: 'b', name: 'Dev', kind: 'cache' }]))).toEqual([]);
  });

  it('empareja por tecnología solo si es uno a uno dentro de su clase y tecnología', () => {
    const c = pairing(
      [{ id: 'a', name: 'Almacén de pedidos', kind: 'database', technology: 'PostgreSQL', version: '14' }],
      [{ id: 'b', name: 'Base transaccional', kind: 'database', technology: 'postgresql', version: '15' }],
    );
    expect(pairsOf(c)).toEqual(['a=b:technology']);
    expect(c.resources[0].kinds).toEqual(['version']);
    // Con otra tecnología no son el mismo recurso: no se inventa una diferencia de versión.
    const other = pairing([{ id: 'a', name: 'Almacén', kind: 'database', technology: 'MySQL', version: '8' }], [{ id: 'b', name: 'Base', kind: 'database', technology: 'PostgreSQL', version: '15' }]);
    expect(pairsOf(other)).toEqual([]);
    expect(other.resources.map((r) => r.kinds)).toEqual([['only-a'], ['only-b']]);
  });

  it('si hay varios candidatos de la misma clase y tecnología, no empareja a ciegas', () => {
    const c = pairing(
      [{ id: 'a1', name: 'Alfa', kind: 'queue', technology: 'Kafka', version: '3.5' }, { id: 'a2', name: 'Beta', kind: 'queue', technology: 'Kafka', version: '3.5' }],
      [{ id: 'b1', name: 'Gamma', kind: 'queue', technology: 'Kafka', version: '3.7' }, { id: 'b2', name: 'Delta', kind: 'queue', technology: 'Kafka', version: '3.7' }],
    );
    expect(pairsOf(c)).toEqual([]);
    expect(aloneOf(c)).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(c.resources.flatMap((r) => r.kinds)).toEqual(['only-a', 'only-a', 'only-b', 'only-b']);
  });

  it('en un grupo ambiguo rompe el empate con las palabras que comparten los nombres, pero solo si es inequívoco', () => {
    const c = pairing(
      [{ id: 'a1', name: 'Pedidos', kind: 'database', technology: 'PostgreSQL' }, { id: 'a2', name: 'Clientes', kind: 'database', technology: 'PostgreSQL' }],
      [{ id: 'b1', name: 'Base de clientes (prod)', kind: 'database', technology: 'PostgreSQL' }, { id: 'b2', name: 'Base de pedidos', kind: 'database', technology: 'PostgreSQL' }],
    );
    expect(pairsOf(c).sort()).toEqual(['a1=b2:similar-name', 'a2=b1:similar-name']);
    // Un nombre que se parece por igual a dos candidatos no decide nada.
    const tie = pairing(
      [{ id: 'a1', name: 'Base de pedidos', kind: 'database', technology: 'PostgreSQL' }, { id: 'a2', name: 'Otra', kind: 'database', technology: 'PostgreSQL' }],
      [{ id: 'b1', name: 'Base principal', kind: 'database', technology: 'PostgreSQL' }, { id: 'b2', name: 'Base secundaria', kind: 'database', technology: 'PostgreSQL' }],
    );
    expect(pairsOf(tie)).toEqual([]);
    // La tecnología compartida no cuenta como parecido.
    const technologyOnly = pairing(
      [{ id: 'a1', name: 'Kafka pedidos', kind: 'queue', technology: 'Kafka' }, { id: 'a2', name: 'Kafka facturas', kind: 'queue', technology: 'Kafka' }],
      [{ id: 'b1', name: 'Kafka alfa', kind: 'queue', technology: 'Kafka' }, { id: 'b2', name: 'Kafka beta', kind: 'queue', technology: 'Kafka' }],
    );
    expect(pairsOf(technologyOnly)).toEqual([]);
  });

  it('el grupo se cuenta entero: un recurso suelto no se empareja con el suelto del otro lado si ya hubo más de uno', () => {
    const c = pairing(
      [{ id: 'a1', name: 'Pedidos', kind: 'queue', technology: 'Kafka' }, { id: 'a2', name: 'Pruebas internas', kind: 'queue', technology: 'Kafka' }],
      [{ id: 'b1', name: 'Pedidos', kind: 'queue', technology: 'Kafka' }, { id: 'b2', name: 'Auditoría', kind: 'queue', technology: 'Kafka' }],
    );
    expect(pairsOf(c)).toEqual(['a1=b1:name']);
    expect(aloneOf(c)).toEqual(['a2', 'b2']);
  });

  it('por clase solo empareja las que no suelen repetirse, si hay una por entorno y las tecnologías no se contradicen', () => {
    // Un clúster por entorno: se empareja aunque el nombre no diga nada.
    const cluster = pairing([{ id: 'a', name: 'Principal', kind: 'cluster', version: '1.28' }], [{ id: 'b', name: 'Producción EKS', kind: 'cluster', version: '1.29' }]);
    expect(pairsOf(cluster)).toEqual(['a=b:only-candidate']);
    expect(cluster.resources[0].kinds).toEqual(['version']);
    // Si declaran tecnologías distintas, no.
    expect(pairsOf(pairing([{ id: 'a', name: 'Uno', kind: 'cluster', technology: 'Nomad' }], [{ id: 'b', name: 'Dos', kind: 'cluster', technology: 'Kubernetes' }]))).toEqual([]);
    // Si un entorno tiene dos, tampoco.
    expect(pairsOf(pairing([{ id: 'a', name: 'Uno', kind: 'cluster' }], [{ id: 'b', name: 'Dos', kind: 'cluster' }, { id: 'c', name: 'Tres', kind: 'cluster' }]))).toEqual([]);
    // Una cola suelta de cada lado puede ser cualquiera: no se empareja.
    const queues = pairing([{ id: 'a', name: 'Cola uno', kind: 'queue', version: '1' }], [{ id: 'b', name: 'Mensajería', kind: 'queue', version: '2' }]);
    expect(pairsOf(queues)).toEqual([]);
    expect(queues.resources.flatMap((r) => r.kinds)).toEqual(['only-a', 'only-b']);
  });

  it('no empareja recursos de clases distintas ni da de baja los dados de baja', () => {
    const c = pairing(
      [{ id: 'a', name: 'Redis', kind: 'cache', technology: 'Redis' }, { id: 'old', name: 'Viejo', kind: 'queue', technology: 'Kafka', status: 'decommissioned' }],
      [{ id: 'b', name: 'Redis', kind: 'queue', technology: 'Redis' }, { id: 'new', name: 'Nuevo', kind: 'queue', technology: 'Kafka' }],
    );
    expect(pairsOf(c)).toEqual([]);
    expect(aloneOf(c)).toEqual(['a', 'b', 'new']);
  });

  it('el informe marca los pares que no se emparejaron por nombre idéntico y lista los deducidos', () => {
    const c = pairing(
      [
        { id: 'a', name: 'Kafka (preprod)', kind: 'queue', version: '3.5' },
        { id: 'd', name: 'Almacén de pedidos', kind: 'database', technology: 'PostgreSQL', version: '14' },
        { id: 'e', name: 'Caché', kind: 'cache', version: '6' },
      ],
      [
        { id: 'b', name: 'Kafka', kind: 'queue', version: '3.7' },
        { id: 'f', name: 'Base transaccional', kind: 'database', technology: 'PostgreSQL', version: '15' },
        { id: 'g', name: 'Caché', kind: 'cache', version: '7' },
      ],
    );
    const text = compareReport(parse({ environments: [], resources: [] }), c);
    expect(text).toContain('Cola o broker «Kafka (preprod)»: Preproducción v3.5 · Producción v3.7 (emparejado por nombre normalizado)');
    expect(text).toContain('Base de datos «Almacén de pedidos»: Preproducción v14 · Producción v15 (emparejado por tecnología)');
    expect(text).toMatch(/Caché «Caché»: Preproducción v6 · Producción v7\n/);
    expect(text).toContain('Recursos emparejados por inferencia (1)');
    expect(text).toContain('- Base de datos «Almacén de pedidos» con «Base transaccional» (emparejado por tecnología)');
    expect(text).not.toMatch(/inferencia[\s\S]*Kafka/);
  });

  it('el lienzo anota en la línea de cada par cómo se emparejó, salvo si fue por nombre idéntico', () => {
    const extra = parse({
      environments: [{ id: 'stg', name: 'Preproducción', kind: 'staging' }, { id: 'prd', name: 'Producción', kind: 'prod' }],
      resources: [
        { id: 'k-s', name: 'Kafka (stg)', kind: 'queue', environmentId: 'stg', version: '3.5' },
        { id: 'k-p', name: 'Kafka', kind: 'queue', environmentId: 'prd', version: '3.7' },
        { id: 'c-s', name: 'Caché', kind: 'cache', environmentId: 'stg' },
        { id: 'c-p', name: 'Caché', kind: 'cache', environmentId: 'prd' },
        { id: 'd-s', name: 'Uno', kind: 'database', environmentId: 'stg', technology: 'PostgreSQL' },
        { id: 'd-p', name: 'Dos', kind: 'database', environmentId: 'prd', technology: 'PostgreSQL' },
      ],
    });
    const graph = platformEditor.project(extra, 'compare:stg:prd');
    const label = (source: string): string | undefined => graph.edges.find((e) => e.source === source)?.label;
    expect(label('k-s')).toBe('v3.5 → v3.7 · emparejado por nombre normalizado');
    expect(label('c-s')).toBeUndefined();
    expect(label('d-s')).toBe('emparejado por tecnología');
  });
});

describe('vista compare', () => {
  it('se pide por id (compare:A:B) o con un solo entorno, y se lista la de los entornos consecutivos en el camino a producción', () => {
    const view = findView(doc, 'compare:dev:prod');
    expect(view).toMatchObject({ id: 'compare:dev:prod', type: 'compare', compareIds: ['dev', 'prod'] });
    expect(findView(doc, 'compare:dev').id).toBe('compare:dev:prod');
    expect(platformModule.views!(doc).map((v) => v.id).filter((id) => id.startsWith('compare'))).toEqual(['compare:dev:prod']);
    expect(platformModule.traceViews!.find((t) => t.prefix === 'compare')!.applies!({ id: 'dev', name: 'Dev', kind: 'environment' })).toBe(true);
    expect(() => findView(doc, 'compare:dev:qa')).toThrow(/No existe el entorno/);
  });

  it('dibuja los dos entornos como grupos y marca las diferencias con color e insignia', () => {
    const scene = buildScene(doc, findView(doc, 'compare:dev:prod'));
    expect([...scene.groups.keys()]).toEqual(['c:dev', 'c:prod']);
    const only = [...scene.nodes.values()].find((n) => n.elementId === 'reportes')!;
    expect(only).toMatchObject({ diff: 'only-a', groupId: 'c:dev', dashed: true });
    expect(only.badge).toMatch(/^Solo en /);
    const mixed = scene.nodes.get('i:pedidos-prod')!;
    expect(mixed).toMatchObject({ diff: 'mixed', badge: 'Versión + réplicas', groupId: 'c:prod' });
    expect(mixed.fill).not.toBe(only.fill);
    expect(scene.edges.get('k:pedidos')).toMatchObject({ source: 'i:pedidos-dev', target: 'i:pedidos-prod', label: 'v3.1.0 → v3.0.2 · 1 → 3 réplicas' });
  });

  it('se exporta a SVG, Mermaid y draw.io', async () => {
    const svg = await toSvg(doc, 'compare:dev:prod');
    expect(svg.toLowerCase()).toContain('versión + réplicas');
    const mmd = toMermaid(doc, { viewId: 'compare:dev:prod' });
    expect(mmd).toContain('subgraph');
    expect(mmd).toContain('classDef diff_only_a');
    const drawio = await toDrawio(doc, 'compare:dev:prod');
    expect(drawio.match(/<diagram /g)).toHaveLength(1);
    expect(drawio).toContain('Versión + réplicas');
    expect((await toDrawio(doc)).match(/<diagram /g)!.length).toBeGreaterThan(1);
  });

  it('el lienzo proyecta las insignias y deja seleccionar los grupos y las instancias', () => {
    const graph = platformEditor.project(doc, 'compare:dev:prod');
    expect(graph.nodes.find((n) => n.id === 'i:pedidos-prod')?.badges).toContain('Versión + réplicas');
    expect(graph.nodes.find((n) => n.id === 'c:dev')?.kind).toBe('environment');
    expect(platformEditor.read(doc, 'i:pedidos-prod')?.kind).toBe('instance');
  });

  it('el comando compare imprime el informe', () => {
    const command = platformCommands.find((c) => c.name === 'compare')!;
    const text = command.run({ args: ['dev', 'prod'], options: {}, input: JSON.stringify(doc) } as never) as string;
    expect(text).toContain('(A) y');
    expect(() => command.run({ args: ['dev', 'qa'], options: {}, input: JSON.stringify(doc) } as never)).toThrow(/No existe el entorno/);
  });
});

describe('avisos de réplicas entre entornos', () => {
  it('avisa si producción tiene menos réplicas que preproducción', () => {
    const staged = parse({
      environments: [{ id: 'stg', name: 'Staging', kind: 'staging' }, { id: 'prd', name: 'Prod', kind: 'prod' }],
      resources: [{ id: 'k1', name: 'K1', kind: 'cluster', environmentId: 'stg' }, { id: 'k2', name: 'K2', kind: 'cluster', environmentId: 'prd' }],
      services: [{ id: 'api', name: 'API', owner: 'x' }],
      deployments: [
        { id: 'a1', serviceId: 'api', environmentId: 'stg', hostId: 'k1', replicas: 4 },
        { id: 'a2', serviceId: 'api', environmentId: 'prd', hostId: 'k2', replicas: 2 },
      ],
    });
    expect(analyzePlatform(staged).map((i) => i.message).join('\n')).toContain('con menos réplicas (2) que en «Staging» (4)');
  });
});

describe('tipos de recurso nuevos (aditivos)', () => {
  it('región, espacio de nombres, certificado y monitorización se validan, se dibujan y se pueden añadir', async () => {
    const extra = parse({
      environments: [{ id: 'prd', name: 'Prod', kind: 'prod' }],
      resources: [
        { id: 'eu', name: 'eu-west-1a', kind: 'region', environmentId: 'prd' },
        { id: 'ns', name: 'pagos', kind: 'namespace', environmentId: 'prd' },
        { id: 'cert', name: 'tienda.example.com', kind: 'certificate', environmentId: 'prd' },
        { id: 'slo', name: 'SLO disponibilidad', kind: 'monitoring', environmentId: 'prd' },
      ],
    });
    expect(extra.resources.map((r) => r.kind)).toEqual(['region', 'namespace', 'certificate', 'monitoring']);
    expect((await toSvg(extra, 'env:prd')).toLowerCase()).toContain('certificado o dominio');
    for (const kind of ['region', 'namespace', 'certificate', 'monitoring']) {
      expect(platformEditor.nodeKinds.some((k) => k.kind === kind)).toBe(true);
      expect(platformEditor.addNode(extra, kind, 'Nuevo', undefined, 'env:prd').ok).toBe(true);
    }
  });
});
