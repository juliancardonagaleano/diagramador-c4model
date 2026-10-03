import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generatedToPlatform, toGenerated } from './ai/generation';
import { platformEditor } from './editor';
import { analyzePlatform } from './issues';
import { platformModule } from './module';
import { formatPlatformIssues, platformJsonSchema, validatePlatformDocument } from './schema';
import type { PlatformDocument } from './types';

const parse = (input: unknown): PlatformDocument => {
  const r = validatePlatformDocument(input);
  if (!r.ok) throw new Error(formatPlatformIssues(r.issues));
  return r.document;
};
/** Hoy, para medir las caducidades. */
const TODAY = new Date('2026-10-02T15:30:00Z');
const messages = (doc: PlatformDocument, severity?: string): string[] => analyzePlatform(doc, TODAY).filter((i) => !severity || i.severity === severity).map((i) => i.message);

/** Producción en un proveedor de nube con su región, un clúster, un servicio crítico, otro normal y lo que se quiera añadir. */
const production = (extra: Record<string, unknown[]> = {}, environment: Record<string, unknown> = {}): PlatformDocument =>
  parse({
    environments: [{ id: 'dev', name: 'Dev', kind: 'dev' }, { id: 'prod', name: 'Producción', kind: 'prod', provider: 'AWS', region: 'eu-west-1', ...environment }],
    resources: [
      { id: 'k8s', name: 'k8s', kind: 'cluster', environmentId: 'prod' },
      { id: 'k8s-dev', name: 'k8s-dev', kind: 'cluster', environmentId: 'dev' },
      ...(extra.resources ?? []),
    ],
    services: [
      { id: 'pagos', name: 'Pagos', criticality: 'critical', owner: 'x' },
      { id: 'informes', name: 'Informes', criticality: 'low', owner: 'x' },
      { id: 'saas', name: 'SaaS', external: true },
    ],
    deployments: [
      { id: 'pagos-prod', serviceId: 'pagos', environmentId: 'prod', hostId: 'k8s', replicas: 2 },
      { id: 'informes-prod', serviceId: 'informes', environmentId: 'prod', hostId: 'k8s' },
      { id: 'pagos-dev', serviceId: 'pagos', environmentId: 'dev', hostId: 'k8s-dev' },
    ],
    dependencies: extra.dependencies ?? [],
  });
const cert = (extra: Record<string, unknown> = {}, environmentId = 'prod'): Record<string, unknown> => ({ id: 'cert', name: 'tienda.example.com', kind: 'certificate', environmentId, ...extra });
const used = (id: string): Record<string, unknown> => ({ id: `u-${id}`, sourceId: 'pagos', targetId: id, kind: 'data' });

describe('certificados', () => {
  const issue = (expiresAt: string | undefined, environmentId = 'prod'): Array<{ severity: string; message: string }> =>
    analyzePlatform(production({ resources: [cert({ ...(expiresAt ? { expiresAt } : {}) }, environmentId)], dependencies: [used('cert')] }), TODAY).filter((i) => i.elementId === 'cert');

  it('avisa del que ya caducó y del que caduca en 30 días o menos, y adelanta un aviso a los 90', () => {
    expect(issue('2026-09-01')).toEqual([{ severity: 'warning', elementId: 'cert', message: 'Certificado o dominio «tienda.example.com» caducó el 2026-09-01 (hace 31 días): renuévalo.' }]);
    expect(issue('2026-10-01')[0].message).toContain('hace 1 día)');
    expect(issue('2026-10-02')).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('caduca hoy: renuévalo antes de que caduque') })]);
    expect(issue('2026-10-03')).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('caduca el 2026-10-03 (en 1 día)') })]);
    expect(issue('2026-11-01')).toEqual([expect.objectContaining({ severity: 'warning', message: expect.stringContaining('(en 30 días)') })]);
    expect(issue('2026-11-02')).toEqual([expect.objectContaining({ severity: 'info', message: 'Certificado o dominio «tienda.example.com» caduca el 2026-11-02 (en 31 días).' })]);
    expect(issue('2026-12-31')[0]).toMatchObject({ severity: 'info', message: expect.stringContaining('(en 90 días)') });
    expect(issue('2027-01-01')).toEqual([]);
    // La hora de hoy no cuenta: solo el día.
    expect(analyzePlatform(production({ resources: [cert({ expiresAt: '2026-10-02' })], dependencies: [used('cert')] }), new Date('2026-10-02T23:59:59Z')).some((i) => i.message.includes('hoy'))).toBe(true);
  });

  it('sin fecha de caducidad solo avisa en producción, y uno dado de baja no avisa de nada', () => {
    expect(issue(undefined)).toEqual([expect.objectContaining({ severity: 'info', message: expect.stringContaining('no tiene fecha de caducidad (expiresAt)') })]);
    expect(issue(undefined, 'dev')).toEqual([]);
    const retired = production({ resources: [cert({ expiresAt: '2020-01-01', status: 'decommissioned' })] });
    expect(messages(retired).filter((m) => m.includes('tienda.example.com'))).toEqual([]);
  });

  it('la fecha tiene que existir y escribirse AAAA-MM-DD', () => {
    expect(validatePlatformDocument({ environments: [{ id: 'e', name: 'E' }], resources: [cert({ expiresAt: '2026-02-30' }, 'e')] })).toMatchObject({ ok: false });
    for (const bad of ['31/12/2026', '2026-1-5', 'mañana', '']) {
      const r = validatePlatformDocument({ environments: [{ id: 'e', name: 'E' }], resources: [cert({ expiresAt: bad }, 'e')] });
      expect(r.ok, bad).toBe(false);
      expect(r.ok ? '' : formatPlatformIssues(r.issues)).toContain('fecha de caducidad');
    }
    expect(validatePlatformDocument({ environments: [{ id: 'e', name: 'E' }], resources: [cert({ expiresAt: '2028-02-29' }, 'e')] }).ok).toBe(true);
    const properties = (platformJsonSchema() as { properties: { resources: { items: { properties: { expiresAt: { pattern: string } } } } } }).properties.resources.items.properties;
    expect(properties.expiresAt.pattern).toBe('^\\d{4}-\\d{2}-\\d{2}$');
  });

  it('se edita en el lienzo solo en los certificados, con su formato comprobado, y se muestra como insignia', () => {
    const doc = production({ resources: [cert({ expiresAt: '2026-12-31' }), { id: 'db', name: 'DB', kind: 'database', environmentId: 'prod' }] });
    expect(platformEditor.fields({ type: 'node', kind: 'certificate' }, doc).map((f) => f.key)).toContain('expiresAt');
    expect(platformEditor.fields({ type: 'node', kind: 'database' }, doc).map((f) => f.key)).not.toContain('expiresAt');
    expect(platformEditor.read(doc, 'cert')?.values).toMatchObject({ expiresAt: '2026-12-31' });
    const edited = platformEditor.update(doc, 'cert', { expiresAt: '2027-03-15' });
    expect(edited.ok && edited.document.resources.find((r) => r.id === 'cert')?.expiresAt).toBe('2027-03-15');
    const bad = platformEditor.update(doc, 'cert', { expiresAt: '15/03/2027' });
    expect(bad).toMatchObject({ ok: false, reason: expect.stringContaining('AAAA-MM-DD') });
    const cleared = platformEditor.update(doc, 'cert', { expiresAt: '' });
    expect(cleared.ok && cleared.document.resources.find((r) => r.id === 'cert')).not.toHaveProperty('expiresAt');
    expect(platformEditor.project(doc, 'env:prod').nodes.find((n) => n.id === 'cert')?.badges).toContain('caduca 2026-12-31');
  });

  it('la IA conserva la fecha de caducidad al refinar un documento', () => {
    const doc = production({ resources: [cert({ expiresAt: '2026-12-31' })] });
    const generated = toGenerated(doc);
    expect(generated.resources.find((r) => r.id === 'cert')?.expiresAt).toBe('2026-12-31');
    const back = generatedToPlatform(generated);
    expect(back.ok && back.document.resources.find((r) => r.id === 'cert')?.expiresAt).toBe('2026-12-31');
  });
});

describe('monitorización', () => {
  const monitoring = { id: 'mon', name: 'Grafana', kind: 'monitoring', environmentId: 'prod' };
  const unmonitored = (doc: PlatformDocument): string[] => messages(doc).filter((m) => m.includes('monitorización'));

  it('si el documento no modela monitorización no avisa de nada', () => {
    expect(unmonitored(production())).toEqual([]);
  });

  it('avisa de los servicios de producción que ninguna monitorización cubre, más grave cuanto más crítico', () => {
    const doc = production({ resources: [monitoring, { id: 'mon-dev', name: 'Grafana dev', kind: 'monitoring', environmentId: 'dev' }], dependencies: [{ id: 'm1', sourceId: 'mon-dev', targetId: 'pagos', kind: 'data' }] });
    const issues = analyzePlatform(doc, TODAY).filter((i) => i.message.includes('monitorización'));
    expect(issues).toEqual(
      expect.arrayContaining([
        { severity: 'warning', elementId: 'pagos', message: 'Servicio «Pagos» corre en «Producción» y ningún recurso de monitorización lo cubre, ni a él ni al anfitrión donde corre.' },
        { severity: 'info', elementId: 'informes', message: 'Servicio «Informes» corre en «Producción» y ningún recurso de monitorización lo cubre, ni a él ni al anfitrión donde corre.' },
      ]),
    );
    // La monitorización de desarrollo no cubre producción, y un servicio externo no se despliega: no cuenta.
    expect(issues.map((i) => i.elementId)).not.toContain('saas');
    expect(issues).toHaveLength(2);
  });

  it('un servicio está cubierto si la monitorización se relaciona con él o con su anfitrión, en cualquier sentido', () => {
    const covered = production({ resources: [monitoring], dependencies: [{ id: 'm1', sourceId: 'mon', targetId: 'pagos', kind: 'data' }, { id: 'm2', sourceId: 'informes', targetId: 'mon', kind: 'messages' }] });
    expect(unmonitored(covered)).toEqual([]);
    const byHost = production({ resources: [monitoring], dependencies: [{ id: 'm1', sourceId: 'mon', targetId: 'k8s', kind: 'data' }] });
    expect(unmonitored(byHost)).toEqual([]);
  });

  it('si producción no tiene monitorización pero el documento la modela en otro entorno, solo avisa de los servicios graves', () => {
    const doc = production({ resources: [{ id: 'mon-dev', name: 'Grafana dev', kind: 'monitoring', environmentId: 'dev' }], dependencies: [{ id: 'm1', sourceId: 'mon-dev', targetId: 'k8s-dev', kind: 'data' }] });
    expect(unmonitored(doc)).toEqual(['Servicio «Pagos» corre en «Producción» y allí no hay ningún recurso de monitorización.']);
  });

  it('una monitorización dada de baja no cubre', () => {
    const doc = production({ resources: [{ ...monitoring, status: 'decommissioned' }] });
    expect(unmonitored(doc)).toEqual([]);
  });
});

describe('región', () => {
  const regional = (doc: PlatformDocument): string[] => messages(doc).filter((m) => m.includes('exige región'));
  const db = { id: 'db', name: 'DB', kind: 'database', environmentId: 'prod' };

  it('en un proveedor de nube pide la región a cada recurso si ni él ni su entorno la tienen', () => {
    const doc = production({ resources: [db, { id: 'dns', name: 'DNS', kind: 'dns', environmentId: 'prod' }] }, { region: undefined });
    expect(regional(doc)).toEqual([
      'Clúster «k8s» está en «Producción» (proveedor AWS), que exige región, y ni el recurso ni el entorno la indican.',
      'Base de datos «DB» está en «Producción» (proveedor AWS), que exige región, y ni el recurso ni el entorno la indican.',
    ]);
    // Más grave en producción que en el resto.
    const severity = (id: string): string | undefined => analyzePlatform(doc, TODAY).find((i) => i.elementId === id && i.message.includes('exige región'))?.severity;
    expect(severity('db')).toBe('warning');
    const dev = production({ resources: [{ id: 'cache-dev', name: 'Caché', kind: 'cache', environmentId: 'dev' }] }, {});
    expect(regional(parse({ ...JSON.parse(JSON.stringify(dev)), environments: [{ id: 'dev', name: 'Dev', kind: 'dev', provider: 'Azure' }, { id: 'prod', name: 'Producción', kind: 'prod' }] }))).toHaveLength(2);
    expect(analyzePlatform(parse({ ...JSON.parse(JSON.stringify(dev)), environments: [{ id: 'dev', name: 'Dev', kind: 'dev', provider: 'Azure' }, { id: 'prod', name: 'Producción', kind: 'prod' }] }), TODAY).find((i) => i.elementId === 'cache-dev')?.severity).toBe('info');
  });

  it('no avisa si la indica el recurso, el entorno o una región modelada en el entorno', () => {
    expect(regional(production({ resources: [{ ...db, region: 'eu-west-1' }] }, { region: '  ' }))).toEqual([expect.stringContaining('Clúster «k8s»')]);
    expect(regional(production({ resources: [db] }, {}))).toEqual([]);
    expect(regional(production({ resources: [db, { id: 'eu', name: 'eu-west-1a', kind: 'region', environmentId: 'prod' }] }, { region: undefined }))).toEqual([]);
  });

  it('solo cuenta en proveedores de nube y en recursos que viven en una región', () => {
    expect(regional(production({ resources: [db] }, { region: undefined, provider: 'Centro de datos propio' }))).toEqual([]);
    expect(regional(production({ resources: [db] }, { region: undefined, provider: undefined }))).toEqual([]);
    for (const provider of ['Google Cloud', 'GCP', 'Microsoft Azure', 'OVH', 'Oracle Cloud', 'DigitalOcean', 'IBM Cloud']) expect(regional(production({ resources: [db] }, { region: undefined, provider })), provider).toHaveLength(2);
    const certificates = production({ resources: [cert(), { id: 'mon', name: 'M', kind: 'monitoring', environmentId: 'prod' }, { ...db, status: 'decommissioned' }] }, { region: undefined });
    expect(regional(certificates)).toEqual([expect.stringContaining('Clúster «k8s»')]);
  });
});

describe('región según el proveedor del recurso', () => {
  const regional = (doc: PlatformDocument): string[] => messages(doc).filter((m) => m.includes('exige región'));
  const db = { id: 'db', name: 'DB', kind: 'database', environmentId: 'prod' };
  /** El entorno sin región, para que decida cada recurso; el clúster de `production` va sin proveedor propio y aparte. */
  const sinRegion = { region: undefined };
  const solo = (messagesOf: string[]): string[] => messagesOf.filter((m) => !m.startsWith('Clúster «k8s»'));

  it('un recurso con proveedor de nube distinto al del entorno usa el suyo: lo exige aunque el entorno no sea de nube', () => {
    const doc = production({ resources: [{ ...db, provider: 'aws', service: 'rds' }] }, { ...sinRegion, provider: 'Centro de datos propio' });
    expect(regional(doc)).toEqual(['Base de datos «DB» está en «Producción» (proveedor aws), que exige región, y ni el recurso ni el entorno la indican.']);
    // El clúster sin proveedor propio cae al del entorno (que no es de nube): no se le exige.
    expect(regional(production({ resources: [db] }, { ...sinRegion, provider: 'Centro de datos propio' }))).toEqual([]);
    // Un entorno sin proveedor tampoco impide que el recurso declare el suyo.
    expect(solo(regional(production({ resources: [{ ...db, provider: 'azure' }] }, { ...sinRegion, provider: undefined })))).toEqual(['Base de datos «DB» está en «Producción» (proveedor azure), que exige región, y ni el recurso ni el entorno la indican.']);
  });

  it('con el proveedor de otra nube que el del entorno, el mensaje nombra el del recurso, y con región el recurso no avisa', () => {
    const doc = production({ resources: [{ ...db, provider: 'GCP' }, { id: 'cache', name: 'Caché', kind: 'cache', environmentId: 'prod', provider: 'azure', region: 'westeurope' }] }, sinRegion);
    expect(regional(doc)).toEqual([
      'Clúster «k8s» está en «Producción» (proveedor AWS), que exige región, y ni el recurso ni el entorno la indican.',
      'Base de datos «DB» está en «Producción» (proveedor GCP), que exige región, y ni el recurso ni el entorno la indican.',
    ]);
    expect(analyzePlatform(doc, TODAY).find((i) => i.elementId === 'db' && i.message.includes('exige región'))).toMatchObject({ severity: 'warning' });
  });

  it('un recurso cuyo proveedor no es de nube no se avisa aunque el entorno sí lo sea; con el proveedor en blanco cae al del entorno', () => {
    expect(solo(regional(production({ resources: [{ ...db, provider: 'Centro de datos propio' }] }, sinRegion)))).toEqual([]);
    expect(solo(regional(production({ resources: [{ ...db, provider: 'vmware', service: 'vsphere' }] }, sinRegion)))).toEqual([]);
    expect(solo(regional(production({ resources: [{ ...db, provider: '   ' }] }, sinRegion)))).toEqual(['Base de datos «DB» está en «Producción» (proveedor AWS), que exige región, y ni el recurso ni el entorno la indican.']);
  });

  it('un recurso sin proveedor se comporta como antes: el del entorno decide', () => {
    expect(regional(production({ resources: [db] }, sinRegion))).toHaveLength(2);
    expect(regional(production({ resources: [db] }, { ...sinRegion, provider: 'Centro de datos propio' }))).toEqual([]);
    expect(regional(production({ resources: [db] }, { ...sinRegion, provider: undefined }))).toEqual([]);
    expect(regional(production({ resources: [db] }))).toEqual([]);
  });

  it('con región (la del recurso, la del entorno o una región modelada) y con recursos que no viven en una región, no avisa', () => {
    expect(regional(production({ resources: [{ ...db, provider: 'azure', region: 'westeurope' }] }, { ...sinRegion, provider: 'Centro de datos propio' }))).toEqual([]);
    expect(regional(production({ resources: [{ ...db, provider: 'azure', region: '  ' }] }, { provider: 'Centro de datos propio', region: 'on-prem-1' }))).toEqual([]);
    expect(regional(production({ resources: [{ ...db, provider: 'gcp' }, { id: 'eu', name: 'eu-west-1a', kind: 'region', environmentId: 'prod' }] }, sinRegion))).toEqual([]);
    expect(regional(production({ resources: [{ id: 'dns', name: 'DNS', kind: 'dns', environmentId: 'prod', provider: 'aws' }, { ...db, provider: 'aws', status: 'decommissioned' }] }, { ...sinRegion, provider: 'Centro de datos propio' }))).toEqual([]);
  });

  it('la gravedad sigue la del entorno del recurso, también cuando el proveedor es el del recurso', () => {
    const cache = { id: 'cache-dev', name: 'Caché', kind: 'cache', environmentId: 'dev', provider: 'aws' };
    const doc = production({ resources: [cache, { ...db, provider: 'aws' }] }, { ...sinRegion, provider: 'Centro de datos propio' });
    const severity = (id: string): string | undefined => analyzePlatform(doc, TODAY).find((i) => i.elementId === id && i.message.includes('exige región'))?.severity;
    expect(severity('cache-dev')).toBe('info');
    expect(severity('db')).toBe('warning');
  });

  it('los ejemplos de plataforma siguen sin ningún aviso (y sin pedir región)', () => {
    for (const file of ['examples/plataforma-ejemplo.json', 'examples/plataforma-nubes.json']) {
      const doc = parse(JSON.parse(readFileSync(file, 'utf8')));
      expect(analyzePlatform(doc, TODAY), file).toEqual([]);
    }
  });
});

describe('recursos transversales sin dependencias', () => {
  const lonely = (doc: PlatformDocument): string[] => messages(doc).filter((m) => m.includes('ninguna dependencia'));
  const resources = [
    { id: 'eu', name: 'eu-west-1a', kind: 'region', environmentId: 'prod' },
    { id: 'ns', name: 'pagos', kind: 'namespace', environmentId: 'prod' },
    cert({ expiresAt: '2027-06-01' }),
    { id: 'mon', name: 'Grafana', kind: 'monitoring', environmentId: 'prod' },
  ];

  it('avisa de la región, el espacio de nombres, el certificado y la monitorización que nada usa ni usan nada', () => {
    expect(lonely(production({ resources }))).toEqual([
      'Región o zona de disponibilidad «eu-west-1a»: no tiene ninguna dependencia, así que no se sabe a qué servicios o recursos afecta.',
      'Espacio de nombres «pagos»: no tiene ninguna dependencia, así que no se sabe a qué servicios o recursos afecta.',
      'Certificado o dominio «tienda.example.com»: no tiene ninguna dependencia, así que no se sabe a qué servicios o recursos afecta.',
      'Monitorización o SLO «Grafana»: no tiene ninguna dependencia, así que no se sabe a qué servicios o recursos afecta.',
    ]);
  });

  it('cualquier dependencia, en un sentido o en otro, basta; y los previstos o dados de baja no avisan', () => {
    const dependencies = [used('eu'), used('ns'), { id: 'c', sourceId: 'cert', targetId: 'k8s', kind: 'data' }];
    expect(lonely(production({ resources, dependencies }))).toEqual([expect.stringContaining('Monitorización o SLO «Grafana»')]);
    expect(lonely(production({ resources: resources.map((r) => ({ ...r, status: 'planned' })) }))).toEqual([]);
    expect(lonely(production({ resources: resources.map((r) => ({ ...r, status: 'decommissioned' })) }))).toEqual([]);
  });

  it('los demás tipos de recurso no se ven afectados', () => {
    expect(lonely(production({ resources: [{ id: 'dns', name: 'DNS', kind: 'dns', environmentId: 'prod' }, { id: 'o', name: 'O', kind: 'other', environmentId: 'prod' }] }))).toEqual([]);
  });
});

describe('compatibilidad', () => {
  it('el módulo valida con la fecha de hoy sin necesidad de pasarla', () => {
    const doc = production({ resources: [cert({ expiresAt: '2000-01-01' })], dependencies: [used('cert')] });
    expect(platformModule.validate(doc).map((i) => i.message).join('\n')).toMatch(/Certificado o dominio «tienda\.example\.com» caducó el 2000-01-01 \(hace \d+ días\): renuévalo\./);
  });
});
