import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { platformEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { buildScene, toSvg } from './export/render';
import {
  IconPackError,
  awsIconPack,
  azureIconPack,
  buildCatalog,
  getIconPack,
  iconCatalog,
  listIconPacks,
  parseIconPack,
  platformIconPackJsonSchema,
  registerIconPack,
  resolveIcon,
  suggestService,
  unregisterIconPack,
  type IconPack,
} from './icons';
import { iconIssues } from './icons/issues';
import { platformModule } from './module';
import { formatPlatformIssues, validatePlatformDocument } from './schema';
import type { PlatformDocument } from './types';
import { findView } from './views';

const parse = (input: unknown): PlatformDocument => {
  const r = validatePlatformDocument(input);
  if (!r.ok) throw new Error(formatPlatformIssues(r.issues));
  return r.document;
};

const SQUARE = 'M2 2h12v12H2z';
const gcp: IconPack = {
  id: 'gcp-propio',
  name: 'Google Cloud',
  provider: 'gcp',
  color: '#1a73e8',
  aliases: ['google cloud'],
  icons: {
    gke: { label: 'Google Kubernetes Engine', paths: [SQUARE, 'M5 5h6v6H5z'], kinds: ['cluster'], keywords: ['gke', 'kubernetes'] },
    'cloud-sql': { label: 'Cloud SQL', paths: ['M3 4h10v8H3z'], kinds: ['database'], keywords: ['cloud sql', 'postgresql'] },
  },
};

/** Una nube en AWS (con una VPC y un clúster que aloja servicios), otra en Azure y un recurso de GCP sin paquete registrado. */
const cloud = parse({
  workspace: { name: 'Nube', iconPacks: [gcp] },
  environments: [
    { id: 'aws', name: 'Producción', kind: 'prod', provider: 'AWS' },
    { id: 'az', name: 'Recuperación', kind: 'dr', provider: 'Azure' },
  ],
  networks: [
    { id: 'vpc', name: 'VPC', environmentId: 'aws', provider: 'aws' },
    { id: 'subred', name: 'Subred', environmentId: 'aws', parentId: 'vpc', provider: 'aws' },
    { id: 'vnet', name: 'VNet', environmentId: 'az', provider: 'azure', service: 'virtual-network' },
  ],
  resources: [
    { id: 'eks', name: 'eks-prod', kind: 'cluster', environmentId: 'aws', networkId: 'subred', technology: 'Kubernetes', provider: 'aws' },
    { id: 'db', name: 'Pedidos DB', kind: 'database', environmentId: 'aws', technology: 'PostgreSQL', provider: 'AWS' },
    { id: 'cola', name: 'Cola', kind: 'queue', environmentId: 'aws', provider: 'aws' },
    { id: 'sns', name: 'Avisos', kind: 'queue', environmentId: 'aws', provider: 'aws', service: 'sns' },
    { id: 'sin-nube', name: 'Caché local', kind: 'cache', environmentId: 'aws' },
    { id: 'sql-az', name: 'Pedidos DB (DR)', kind: 'database', environmentId: 'az', provider: 'azure', service: 'SQL Database' },
    { id: 'aks', name: 'aks-dr', kind: 'cluster', environmentId: 'az', networkId: 'vnet', provider: 'azure', service: 'aks' },
    { id: 'gke', name: 'gke-analitica', kind: 'cluster', environmentId: 'az', provider: 'Google Cloud', technology: 'GKE' },
    { id: 'oci-db', name: 'Base en OCI', kind: 'database', environmentId: 'az', provider: 'oci' },
  ],
  services: [{ id: 'api', name: 'API', owner: 'x' }, { id: 'fn', name: 'Función', provider: 'aws', service: 'lambda' }],
  deployments: [{ id: 'api-aws', serviceId: 'api', environmentId: 'aws', hostId: 'eks', replicas: 2, version: '1.0.0' }],
  dependencies: [{ id: 'api-db', sourceId: 'api', targetId: 'db', kind: 'data' }],
});

const tiles = (svg: string, color: string): number => svg.split(`rx="5" fill="#ffffff" stroke="${color}"`).length - 1;

afterEach(() => {
  unregisterIconPack('aws-oficial');
  unregisterIconPack('gcp-propio');
  unregisterIconPack('test-pack');
});

describe('registro de paquetes de iconos', () => {
  it('trae AWS y Azure con la cobertura pedida, con el color de acento de cada proveedor', () => {
    expect(getIconPack('aws')).toBe(listIconPacks().find((p) => p.provider === 'aws'));
    expect(Object.keys(awsIconPack.icons)).toEqual(
      expect.arrayContaining(['ec2', 'eks', 'ecs', 'fargate', 'lambda', 's3', 'rds', 'dynamodb', 'elasticache', 'sqs', 'sns', 'elb', 'alb', 'api-gateway', 'route53', 'cloudfront', 'secrets-manager', 'ecr', 'vpc']),
    );
    expect(Object.keys(azureIconPack.icons)).toEqual(
      expect.arrayContaining(['vm', 'aks', 'app-service', 'functions', 'blob-storage', 'sql-database', 'cosmos-db', 'cache-redis', 'service-bus', 'load-balancer', 'application-gateway', 'api-management', 'dns', 'key-vault', 'container-registry', 'virtual-network']),
    );
    expect(awsIconPack.color).toBe('#ec7211');
    expect(azureIconPack.color).toBe('#0078d4');
  });

  it('cada glifo propio es un trazado válido, distinto de los demás de su paquete', () => {
    for (const pack of [awsIconPack, azureIconPack]) {
      expect(() => parseIconPack(pack)).not.toThrow();
      const seen = new Set<string>();
      for (const [key, def] of Object.entries(pack.icons)) {
        expect(def.label, key).not.toBe('');
        expect(def.paths.length, key).toBeGreaterThan(0);
        // Dentro de la caja de 16 × 16 (los trazados absolutos; los relativos no se comprueban).
        for (const d of def.paths) for (const m of d.matchAll(/[MLHVCSQTA]\s*(-?\d*\.?\d+)/g)) expect(Number(m[1]), `${key}: ${d}`).toBeLessThanOrEqual(16);
        seen.add(def.paths.join('|'));
      }
      // Hay glifos que se comparten a propósito (las bases de datos relacionales, los balanceadores), pero no todos son el mismo.
      expect(seen.size).toBeGreaterThan(Object.keys(pack.icons).length * 0.75);
    }
  });

  it('registra un paquete propio, lo sustituye con el mismo id y lo quita', () => {
    const before = listIconPacks().length;
    registerIconPack({ ...gcp, id: 'test-pack' });
    expect(listIconPacks()).toHaveLength(before + 1);
    expect(iconCatalog(undefined).find('GCP')?.provider).toBe('gcp');
    registerIconPack({ ...gcp, id: 'test-pack', name: 'Otro nombre' });
    expect(listIconPacks()).toHaveLength(before + 1);
    expect(getIconPack('test-pack')?.name).toBe('Otro nombre');
    expect(unregisterIconPack('test-pack')).toBe(true);
    expect(unregisterIconPack('test-pack')).toBe(false);
    expect(iconCatalog(undefined).find('gcp')).toBeUndefined();
  });

  it('rechaza los paquetes que podrían colar marcado o que no tienen la forma pedida', () => {
    const bad = (patch: Record<string, unknown>): string => {
      try {
        parseIconPack({ ...gcp, ...patch });
      } catch (error) {
        expect(error).toBeInstanceOf(IconPackError);
        return (error as Error).message;
      }
      return '';
    };
    expect(bad({ color: 'red' })).toContain('color');
    expect(bad({ color: '#12345' })).toContain('color');
    expect(bad({ icons: { x: { label: 'X', paths: ['M0 0"/><script>'] } } })).toContain('trazado');
    expect(bad({ icons: { x: { label: 'X', paths: [] } } })).toContain('al menos un trazado');
    expect(bad({ icons: { 'mala clave': { label: 'X', paths: [SQUARE] } } })).toBeTruthy();
    expect(bad({ icons: { x: { label: '', paths: [SQUARE] } } })).toBeTruthy();
    expect(bad({ icons: { x: { label: 'X', paths: [SQUARE], kinds: ['nube'] } } })).toBeTruthy();
    expect(bad({ id: '' })).toBeTruthy();
    expect(() => parseIconPack('{no es json')).toThrow(/no es JSON válido/);
    expect(() => registerIconPack({ ...gcp, color: 'azul' })).toThrow(IconPackError);
    expect(getIconPack('gcp-propio')).toBeUndefined();
  });

  it('el paquete se puede escribir como JSON, con el esquema de `iark schema`', () => {
    const fromText = parseIconPack(JSON.stringify(gcp));
    expect(fromText).toEqual(gcp);
    const schema = platformIconPackJsonSchema() as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['id', 'name', 'provider', 'color', 'icons']));
    expect(schema.required).toEqual(expect.arrayContaining(['id', 'provider', 'color', 'icons']));
  });

  it('un paquete del mismo proveedor sustituye servicio a servicio a los anteriores (los iconos oficiales con licencia)', () => {
    registerIconPack({ id: 'aws-oficial', name: 'AWS (oficiales)', provider: 'AWS', color: '#ff9900', icons: { rds: { label: 'Amazon RDS (oficial)', paths: ['M1 1h14v14H1z'] } } });
    const aws = iconCatalog(undefined).find('aws')!;
    expect(aws.icons.rds.paths).toEqual(['M1 1h14v14H1z']);
    // Lo que el paquete nuevo no dice (para qué clases y tecnologías sirve) lo hereda del servicio que sustituye.
    expect(aws.icons.rds.kinds).toEqual(['database']);
    expect(suggestService(aws, { kind: 'database', technology: 'PostgreSQL' })).toBe('rds');
    expect(aws.icons.s3.paths).toEqual(awsIconPack.icons.s3.paths);
    expect(aws.color).toBe('#ff9900');
    expect(aws.packIds).toEqual(['aws', 'aws-oficial']);
    expect(iconCatalog(undefined).providers.filter((p) => p.provider.toLowerCase() === 'aws')).toHaveLength(1);
  });

  it('un proveedor se nombra por su clave, un alias o el nombre del paquete, sin distinguir mayúsculas ni acentos', () => {
    const catalog = buildCatalog([awsIconPack, azureIconPack, gcp]);
    for (const text of ['aws', 'AWS', ' Amazon Web Services ', 'amazon']) expect(catalog.find(text)?.provider).toBe('aws');
    for (const text of ['azure', 'Microsoft Azure']) expect(catalog.find(text)?.provider).toBe('azure');
    expect(catalog.find('google cloud')?.provider).toBe('gcp');
    expect(catalog.find('oci')).toBeUndefined();
    expect(catalog.find(undefined)).toBeUndefined();
    expect(catalog.find('')).toBeUndefined();
  });
});

describe('sugerencia del servicio desde la clase y la tecnología', () => {
  const aws = buildCatalog([awsIconPack]).find('aws')!;
  const azure = buildCatalog([azureIconPack]).find('azure')!;

  it('sugiere cuando solo un servicio del paquete encaja', () => {
    expect(suggestService(aws, { kind: 'database', technology: 'PostgreSQL' })).toBe('rds');
    expect(suggestService(aws, { kind: 'database', technology: 'Amazon DynamoDB' })).toBe('dynamodb');
    expect(suggestService(aws, { kind: 'cache', technology: 'Redis' })).toBe('elasticache');
    expect(suggestService(aws, { kind: 'cache' })).toBe('elasticache');
    expect(suggestService(aws, { kind: 'load-balancer', technology: 'AWS ALB' })).toBe('alb');
    expect(suggestService(aws, { kind: 'cluster', technology: 'Kubernetes 1.29' })).toBe('eks');
    expect(suggestService(aws, { kind: 'storage' })).toBe('s3');
    expect(suggestService(aws, { kind: 'gateway' })).toBe('api-gateway');
    expect(suggestService(aws, { kind: 'network' })).toBe('vpc');
    expect(suggestService(azure, { kind: 'database', technology: 'Azure SQL' })).toBe('sql-database');
    expect(suggestService(azure, { kind: 'cluster', technology: 'k8s' })).toBe('aks');
    expect(suggestService(azure, { kind: 'queue', technology: 'Service Bus' })).toBe('service-bus');
    expect(suggestService(azure, { kind: 'load-balancer', technology: 'Application Gateway' })).toBe('application-gateway');
    expect(suggestService(azure, { kind: 'other', technology: 'Azure Functions' })).toBe('functions');
  });

  it('no adivina si encajan varios, ninguno o la tecnología es de otro producto', () => {
    expect(suggestService(aws, { kind: 'database' })).toBeUndefined();
    expect(suggestService(aws, { kind: 'queue' })).toBeUndefined();
    expect(suggestService(aws, { kind: 'queue', technology: 'Kafka' })).toBeUndefined();
    expect(suggestService(aws, { kind: 'database', technology: 'MongoDB' })).toBeUndefined();
    expect(suggestService(aws, { kind: 'cluster' })).toBeUndefined();
    expect(suggestService(aws, { kind: 'cache', technology: 'PostgreSQL' })).toBeUndefined();
    expect(suggestService(azure, { kind: 'gateway' })).toBeUndefined();
    expect(suggestService(azure, { kind: 'database', technology: 'PostgreSQL' })).toBeUndefined();
    expect(suggestService(aws, {})).toBeUndefined();
    // Una palabra clave solo cuenta entera: «ecs» no está en «specs».
    expect(suggestService(aws, { kind: 'cluster', technology: 'specs' })).toBeUndefined();
  });

  it('el icono indicado manda; sin servicio se usa la sugerencia; sin proveedor o sin paquete no hay icono', () => {
    const catalog = iconCatalog(cloud);
    expect(resolveIcon(catalog, { provider: 'aws', service: 'sns', kind: 'queue' })).toMatchObject({ service: 'sns', suggested: false, color: '#ec7211' });
    expect(resolveIcon(catalog, { provider: 'AWS', kind: 'database', technology: 'PostgreSQL' })).toMatchObject({ service: 'rds', suggested: true });
    expect(resolveIcon(catalog, { provider: 'azure', service: 'SQL Database' })?.service).toBe('sql-database');
    expect(resolveIcon(catalog, { provider: 'aws', kind: 'queue' })).toBeUndefined();
    expect(resolveIcon(catalog, { provider: 'aws', service: 'inventado' })).toBeUndefined();
    expect(resolveIcon(catalog, { provider: 'oci', service: 'x' })).toBeUndefined();
    expect(resolveIcon(catalog, { service: 'rds' })).toBeUndefined();
  });
});

describe('esquema del documento', () => {
  it('acepta provider y service en recursos, servicios y redes, y los paquetes en workspace.iconPacks', () => {
    expect(cloud.resources.find((r) => r.id === 'db')).toMatchObject({ provider: 'AWS' });
    expect(cloud.services.find((s) => s.id === 'fn')).toMatchObject({ provider: 'aws', service: 'lambda' });
    expect(cloud.networks.find((n) => n.id === 'vnet')).toMatchObject({ provider: 'azure', service: 'virtual-network' });
    expect(cloud.workspace.iconPacks).toEqual([gcp]);
  });

  it('un documento sin iconos sigue siendo válido y no cambia', () => {
    const plain = parse({ environments: [{ id: 'p', name: 'Prod' }], resources: [{ id: 'r', name: 'R', kind: 'database', environmentId: 'p', technology: 'PostgreSQL' }] });
    expect(plain.workspace.iconPacks).toBeUndefined();
    expect(plain.resources[0]).not.toHaveProperty('provider');
    expect(iconIssues(plain)).toEqual([]);
  });

  it('rechaza un paquete inválido o repetido en el documento', () => {
    const base = { environments: [{ id: 'p', name: 'Prod' }] };
    expect(validatePlatformDocument({ ...base, workspace: { name: 'x', iconPacks: [{ ...gcp, color: 'rojo' }] } }).ok).toBe(false);
    const dup = validatePlatformDocument({ ...base, workspace: { name: 'x', iconPacks: [gcp, gcp] } });
    expect(dup.ok).toBe(false);
    expect(!dup.ok && dup.issues[0].message).toContain('Id de paquete de iconos duplicado');
  });

  it('el JSON Schema del módulo describe los campos nuevos', () => {
    const text = JSON.stringify(platformModule.jsonSchema());
    expect(text).toContain('iconPacks');
    expect(text).toContain('"provider"');
    expect(text).toContain('"service"');
  });
});

describe('dibujo del icono del proveedor', () => {
  it('el SVG pone una ficha con el color del proveedor en cada recurso, servicio o zona que lo tiene', async () => {
    const svg = await toSvg(cloud, 'env:aws');
    // El clúster (zona con servicios), la VPC (zona) y las bases de datos y colas con servicio, indicado o sugerido; la subred, la cola ambigua y la caché sin proveedor no.
    expect(tiles(svg, '#ec7211')).toBe(4);
    expect(svg).toContain(awsIconPack.icons.rds.paths[0]);
    expect(svg).toContain(awsIconPack.icons.eks.paths[0]);
    expect(svg).toContain(awsIconPack.icons.vpc.paths[0]);
    // La subred es una red anidada: no se sugiere VPC.
    const scene = buildScene(cloud, findView(cloud, 'env:aws'));
    expect(scene.groups.get('vpc')?.icon?.color).toBe('#ec7211');
    expect(scene.groups.get('subred')?.icon).toBeUndefined();
    expect(scene.groups.get('eks')?.icon?.paths).toEqual(awsIconPack.icons.eks.paths);
    expect(scene.nodes.get('db')).toMatchObject({ icon: awsIconPack.icons.rds.paths, iconColor: '#ec7211' });
    expect(scene.nodes.get('cola')?.icon).toBeUndefined();
    expect(scene.nodes.get('sns')?.icon).toEqual(awsIconPack.icons.sns.paths);
    expect(scene.nodes.get('sin-nube')?.icon).toBeUndefined();
  });

  it('Azure usa su azul, un paquete del documento (GCP) su color y un proveedor sin paquete se dibuja como siempre', async () => {
    const svg = await toSvg(cloud, 'env:az');
    // La red virtual (zona), el clúster AKS y la base SQL (por su nombre de servicio con otras mayúsculas).
    expect(tiles(svg, '#0078d4')).toBe(3);
    expect(tiles(svg, '#1a73e8')).toBe(1);
    expect(svg).toContain('M5 5h6v6H5z');
    const scene = buildScene(cloud, findView(cloud, 'env:az'));
    expect(scene.nodes.get('sql-az')?.icon).toEqual(azureIconPack.icons['sql-database'].paths);
    expect(scene.groups.get('vnet')?.icon).toEqual({ paths: azureIconPack.icons['virtual-network'].paths, color: '#0078d4' });
    expect(scene.nodes.get('gke')).toMatchObject({ icon: gcp.icons.gke.paths, iconColor: '#1a73e8' });
    expect(scene.nodes.get('oci-db')?.icon).toBeUndefined();
  });

  it('el icono de un servicio acompaña a todas sus instancias y a su nodo en la topología', () => {
    const doc = parse({
      environments: [{ id: 'p', name: 'Prod' }],
      resources: [{ id: 'k', name: 'K', kind: 'cluster', environmentId: 'p' }],
      services: [{ id: 'fn', name: 'Función', provider: 'aws', service: 'lambda' }, { id: 'web', name: 'Web' }],
      deployments: [{ id: 'fn-p', serviceId: 'fn', environmentId: 'p', hostId: 'k' }],
      dependencies: [{ id: 'd', sourceId: 'web', targetId: 'fn', kind: 'calls' }],
    });
    expect(buildScene(doc, findView(doc, 'env:p')).nodes.get('i:fn-p')?.icon).toEqual(awsIconPack.icons.lambda.paths);
    expect(buildScene(doc, findView(doc, 'topology')).nodes.get('fn')?.iconColor).toBe('#ec7211');
    expect(buildScene(doc, findView(doc, 'topology')).nodes.get('web')?.icon).toBeUndefined();
  });

  it('un paquete registrado en tiempo de ejecución sustituye al de serie sin tocar el documento', async () => {
    const before = await toSvg(cloud, 'env:aws');
    expect(before).not.toContain('#ff9900');
    registerIconPack({ id: 'aws-oficial', name: 'AWS (oficiales)', provider: 'aws', color: '#ff9900', icons: { rds: { label: 'RDS', paths: ['M1 1h14v14H1z'] } } });
    const after = await toSvg(cloud, 'env:aws');
    expect(after).toContain('M1 1h14v14H1z');
    expect(after).toContain('#ff9900');
  });

  it('draw.io lleva la ficha como una celda de imagen aparte, junto a su nodo o zona', async () => {
    const drawio = await toDrawio(cloud);
    const cells = [...drawio.matchAll(/<mxCell id="i-([^"]+)" value="" style="shape=image;html=1;imageAspect=0;image=data:image\/svg\+xml,([A-Za-z0-9+/=]+);"/g)];
    expect(cells.length).toBeGreaterThanOrEqual(5);
    const rds = cells.find((c) => c[1] === 'db')!;
    const svg = Buffer.from(rds[2], 'base64').toString('utf8');
    expect(svg).toContain('stroke="#ec7211"');
    expect(svg).toContain(awsIconPack.icons.rds.paths[0]);
    // La celda del icono está justo después de la de su nodo.
    expect(drawio.indexOf('id="i-db"')).toBeGreaterThan(drawio.indexOf('id="n-db"'));
    expect(cells.some((c) => c[1] === 'eks')).toBe(true);
    expect(cells.some((c) => c[1] === 'vpc')).toBe(true);
  });

  it('Mermaid no cambia: no tiene imágenes por nodo', () => {
    expect(toMermaid(cloud, { viewId: 'env:aws' })).not.toContain('ec7211');
  });

  it('el lienzo proyecta el icono de cada nodo y de cada zona', () => {
    const graph = platformEditor.project(cloud, 'env:aws');
    expect(graph.nodes.find((n) => n.id === 'db')).toMatchObject({ icon: awsIconPack.icons.rds.paths, iconColor: '#ec7211' });
    expect(graph.nodes.find((n) => n.id === 'eks')).toMatchObject({ kind: 'cluster', icon: awsIconPack.icons.eks.paths, iconColor: '#ec7211' });
    expect(graph.nodes.find((n) => n.id === 'vpc')).toMatchObject({ kind: 'network', icon: awsIconPack.icons.vpc.paths });
    expect(graph.nodes.find((n) => n.id === 'cola')).not.toHaveProperty('icon');
    expect(graph.nodes.find((n) => n.id === 'sin-nube')).not.toHaveProperty('icon');
  });
});

describe('selector del proveedor en las propiedades', () => {
  const fieldsOf = (kind: string, values: Record<string, unknown>) => platformEditor.fields({ type: 'node', kind }, cloud, values);

  it('ofrece el proveedor y, de su paquete, los servicios; marca el sugerido', () => {
    const [provider, service] = fieldsOf('database', { provider: 'aws', technology: 'PostgreSQL' }).filter((f) => f.key === 'provider' || f.key === 'service');
    expect(provider).toMatchObject({ type: 'select', label: 'Proveedor de nube', allowEmpty: true });
    expect(provider.type === 'select' && provider.options.map((o) => o.value)).toEqual(['aws', 'azure', 'gcp']);
    expect(service.type === 'select' && service.options.find((o) => o.value === 'rds')?.label).toBe('Amazon RDS (sugerido)');
    expect(service.type === 'select' && service.options.map((o) => o.value)).toEqual(expect.arrayContaining(['dynamodb', 'ec2', 'vpc']));
    expect(service.type === 'select' && service.options.map((o) => o.value)).not.toContain('aks');
    // Con el servicio ya elegido no se marca ninguno.
    const chosen = fieldsOf('database', { provider: 'aws', service: 'dynamodb', technology: 'PostgreSQL' }).find((f) => f.key === 'service');
    expect(chosen?.type === 'select' && chosen.options.some((o) => o.label.includes('sugerido'))).toBe(false);
  });

  it('sin proveedor no hay servicios que elegir, y uno sin paquete o un servicio ajeno se conserva para poder verlo', () => {
    const none = fieldsOf('cache', {}).find((f) => f.key === 'service');
    expect(none?.type === 'select' && none.options).toEqual([]);
    const unknown = fieldsOf('cache', { provider: 'oci', service: 'x' });
    expect(unknown.find((f) => f.key === 'provider')).toMatchObject({ options: expect.arrayContaining([{ value: 'oci', label: 'oci (sin paquete de iconos)' }]) });
    expect(unknown.find((f) => f.key === 'service')).toMatchObject({ options: [{ value: 'x', label: 'x (no está en el paquete)' }] });
  });

  it('está en los recursos, los servicios y las redes, y el formulario sigue siendo el de siempre sin valores', () => {
    for (const kind of ['database', 'vm', 'service', 'worker', 'external', 'network']) expect(fieldsOf(kind, {}).map((f) => f.key)).toEqual(expect.arrayContaining(['provider', 'service']));
    expect(platformEditor.fields({ type: 'node', kind: 'database' }, cloud).map((f) => f.key)).toEqual(expect.arrayContaining(['provider', 'service']));
    expect(platformEditor.fields({ type: 'node', kind: 'pipeline' }, cloud).map((f) => f.key)).not.toContain('provider');
    expect(platformEditor.fields({ type: 'node', kind: 'environment' }, cloud).filter((f) => f.key === 'provider')).toHaveLength(1);
  });

  it('read muestra el proveedor con el nombre de su paquete', () => {
    expect(platformEditor.read(cloud, 'db')?.values.provider).toBe('aws');
    expect(platformEditor.read(cloud, 'gke')?.values.provider).toBe('gcp');
    expect(platformEditor.read(cloud, 'oci-db')?.values.provider).toBe('oci');
  });

  it('elegir el proveedor sugiere el servicio si es inequívoco; cambiar de proveedor quita el que ya no existe', () => {
    const edited = platformEditor.update(cloud, 'sin-nube', { provider: 'azure' });
    expect(edited.ok && edited.document.resources.find((r) => r.id === 'sin-nube')).toMatchObject({ provider: 'azure', service: 'cache-redis' });
    // Si encajan varios servicios del paquete (una cola de AWS es SQS o SNS) no se inventa ninguno.
    const ambiguous = platformEditor.update(cloud, 'cola', { provider: 'aws' });
    expect(ambiguous.ok && ambiguous.document.resources.find((r) => r.id === 'cola')).toMatchObject({ provider: 'aws' });
    expect(ambiguous.ok && ambiguous.document.resources.find((r) => r.id === 'cola')).not.toHaveProperty('service');
    const switched = platformEditor.update(cloud, 'sns', { provider: 'azure' });
    expect(switched.ok && switched.document.resources.find((r) => r.id === 'sns')).toMatchObject({ provider: 'azure', service: 'service-bus' });
    const noPackage = platformEditor.update(cloud, 'sns', { provider: 'oci' });
    expect(noPackage.ok && noPackage.document.resources.find((r) => r.id === 'sns')).toMatchObject({ provider: 'oci', service: 'sns' });
  });

  it('elegir el servicio exige un proveedor y que sea del paquete; vaciar el proveedor quita el servicio', () => {
    const chosen = platformEditor.update(cloud, 'cola', { service: 'sqs' });
    expect(chosen.ok && chosen.document.resources.find((r) => r.id === 'cola')).toMatchObject({ provider: 'aws', service: 'sqs' });
    const wrong = platformEditor.update(cloud, 'cola', { service: 'aks' });
    expect(wrong).toMatchObject({ ok: false });
    expect(!wrong.ok && wrong.reason).toContain('no tiene el servicio «aks»');
    const orphan = platformEditor.update(cloud, 'sin-nube', { service: 'elasticache' });
    expect(!orphan.ok && orphan.reason).toContain('Elige primero el proveedor');
    const cleared = platformEditor.update(cloud, 'sns', { provider: '' });
    const sns = cleared.ok && cleared.document.resources.find((r) => r.id === 'sns');
    expect(sns).not.toHaveProperty('provider');
    expect(sns).not.toHaveProperty('service');
    // Un cambio ajeno a la iconografía no toca provider ni service, aunque el servicio no esté en el paquete.
    const odd = parse({ environments: [{ id: 'p', name: 'P' }], resources: [{ id: 'r', name: 'R', kind: 'cache', environmentId: 'p', provider: 'aws', service: 'inventado' }] });
    const renamed = platformEditor.update(odd, 'r', { name: 'Renombrado' });
    expect(renamed.ok && renamed.document.resources[0]).toMatchObject({ name: 'Renombrado', provider: 'aws', service: 'inventado' });
  });

  it('también se edita en servicios y redes', () => {
    const service = platformEditor.update(cloud, 'api', { provider: 'aws', service: 'lambda' });
    expect(service.ok && service.document.services.find((s) => s.id === 'api')).toMatchObject({ provider: 'aws', service: 'lambda' });
    const network = platformEditor.update(cloud, 'vpc', { service: 'vpc' });
    expect(network.ok && network.document.networks.find((n) => n.id === 'vpc')).toMatchObject({ provider: 'aws', service: 'vpc' });
    const wrong = platformEditor.update(cloud, 'vpc', { service: 'aks' });
    expect(wrong.ok).toBe(false);
    const subnet = platformEditor.update(cloud, 'subred', { provider: 'azure' });
    expect(subnet.ok && subnet.document.networks.find((n) => n.id === 'subred')).not.toHaveProperty('service');
  });
});

describe('avisos de la iconografía', () => {
  it('avisa de un proveedor sin paquete, de un servicio que el paquete no tiene y de un servicio sin proveedor', () => {
    const doc = parse({
      environments: [{ id: 'p', name: 'Prod' }],
      resources: [
        { id: 'a', name: 'A', kind: 'database', environmentId: 'p', provider: 'oci' },
        { id: 'b', name: 'B', kind: 'database', environmentId: 'p', provider: 'aws', service: 'inventado' },
        { id: 'c', name: 'C', kind: 'database', environmentId: 'p', service: 'rds' },
        { id: 'ok', name: 'OK', kind: 'database', environmentId: 'p', provider: 'aws', service: 'rds' },
      ],
    });
    const issues = iconIssues(doc);
    expect(issues.map((i) => [i.elementId, i.severity])).toEqual([['a', 'info'], ['b', 'warning'], ['c', 'info']]);
    expect(issues[0].message).toContain('«oci», que no tiene paquete de iconos');
    expect(issues[1].message).toContain('«inventado», que no está en el paquete');
    expect(platformModule.validate(doc).filter((i) => ['a', 'b', 'c', 'ok'].includes(i.elementId ?? '') && /icono/.test(i.message))).toHaveLength(3);
  });

  it('un paquete del documento evita el aviso', () => {
    expect(iconIssues(cloud).map((i) => i.elementId)).toEqual(['oci-db']);
  });
});

describe('comando icons', () => {
  const command = platformModule.cliCommands!.find((c) => c.name === 'icons')!;
  const run = async (doc: unknown, options: Record<string, unknown> = {}): Promise<string> => (await command.run({ args: [], options, input: JSON.stringify(doc) })) as string;

  it('lista los paquetes y el icono de cada elemento con proveedor', async () => {
    const text = await run(cloud);
    expect(text).toContain('aws · Amazon Web Services');
    expect(text).toContain('gcp · Google Cloud');
    expect(text).toContain('Base de datos «Pedidos DB»: aws · rds (Amazon RDS) · sugerido por su clase y tecnología');
    expect(text).toContain('Cola o broker «Cola»: proveedor «aws»: sin icono');
    expect(text).toContain('Base de datos «Base en OCI»: proveedor «oci»: sin icono');
    expect(text).not.toContain('Caché local');
  });

  it('valida un paquete en un archivo y lo suma a los del documento', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-icons-'));
    const file = join(dir, 'oci.json');
    writeFileSync(file, JSON.stringify({ id: 'oci-propio', name: 'Oracle Cloud', provider: 'oci', color: '#c74634', icons: { adb: { label: 'Autonomous Database', paths: [SQUARE], kinds: ['database'] } } }));
    const text = await run(cloud, { pack: file });
    expect(text).toContain('oci · Oracle Cloud');
    expect(text).toContain('Paquete oci-propio');
    expect(text).toContain('Base de datos «Base en OCI»: oci · adb (Autonomous Database) · sugerido');
    // El paquete del archivo no queda registrado: solo vale para esa ejecución.
    expect(getIconPack('oci-propio')).toBeUndefined();
    const broken = join(dir, 'roto.json');
    writeFileSync(broken, JSON.stringify({ id: 'x', name: 'X', provider: 'x', color: 'rojo', icons: {} }));
    await expect(run(cloud, { pack: broken })).rejects.toThrow(/color/);
    await expect(run(cloud, { pack: join(dir, 'no-existe.json') })).rejects.toThrow(/No se pudo leer/);
  });

  it('el ejemplo de nubes es válido, sin avisos, y dibuja AWS, Azure y el paquete propio de GCP', async () => {
    const example = parse(JSON.parse(readFileSync('examples/plataforma-nubes.json', 'utf8')));
    expect(platformModule.validate(example)).toEqual([]);
    const drawio = await toDrawio(example);
    const images = [...drawio.matchAll(/image=data:image\/svg\+xml,([A-Za-z0-9+/=]+);/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'));
    for (const color of ['#ec7211', '#0078d4', '#1a73e8']) expect(images.some((svg) => svg.includes(`stroke="${color}"`)), color).toBe(true);
    for (const view of ['env:aws-prod', 'env:azure-dr', 'env:gcp-analitica']) expect(tiles(await toSvg(example, view), view === 'env:azure-dr' ? '#0078d4' : view === 'env:gcp-analitica' ? '#1a73e8' : '#ec7211')).toBeGreaterThanOrEqual(3);
  });
});
