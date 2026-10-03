import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { toDrawio } from '../export/drawio';
import { toMermaid } from '../export/mermaid';
import { buildScene, toSvg } from '../export/render';
import { analyzePlatform } from '../issues';
import { platformModule } from '../module';
import { formatPlatformIssues, validatePlatformDocument } from '../schema';
import type { PlatformDocument, Resource } from '../types';
import { listViews } from '../views';
import { PlatformImportError } from './fromMermaid';
import { joinSourceFiles } from '@iark/kernel';
import { fromTerraform, fromTerraformFiles } from './fromTerraform';
import { looksLikeTerraform } from './terraformModel';

const DIR = 'tests/fixtures/importar/terraform';
const read = (name: string): string => readFileSync(`${DIR}/${name}`, 'utf8');
const load = (name: string) => fromTerraform(read(name), { file: `${DIR}/${name}` });
const byId = <T extends { id: string }>(items: T[], id: string): T => {
  const found = items.find((i) => i.id === id);
  if (!found) throw new Error(`No hay «${id}» entre ${items.map((i) => i.id).join(', ')}`);
  return found;
};
const dep = (doc: PlatformDocument, source: string, target: string) => doc.dependencies.find((d) => d.sourceId === source && d.targetId === target);

/** Lo que se le pide a todo lo importado: documento válido, gobierno sin errores ni avisos y vistas que se dibujan (incluida la de despliegue de cada entorno). */
async function expectHealthy(doc: PlatformDocument): Promise<void> {
  const valid = validatePlatformDocument(doc);
  expect(valid.ok ? [] : formatPlatformIssues(valid.issues)).toEqual([]);
  expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  expect(analyzePlatform(doc).filter((i) => i.severity !== 'info')).toEqual([]);
  expect(platformModule.validate(doc).filter((i) => i.severity !== 'info')).toEqual([]);
  const views = listViews(doc);
  for (const env of doc.environments) expect(views.map((v) => v.id)).toContain(`env:${env.id}`);
  for (const view of views) {
    expect(toMermaid(doc, { viewId: view.id }).length).toBeGreaterThan(20);
    expect(await toDrawio(doc, view.id)).toContain('<mxfile');
    expect(await toSvg(doc, view.id)).toContain('<svg');
  }
  // Todo recurso del entorno está dibujado en su vista (como nodo o como grupo).
  for (const env of doc.environments) {
    const scene = buildScene(doc, views.find((v) => v.id === `env:${env.id}`)!);
    for (const r of doc.resources.filter((x) => x.environmentId === env.id)) expect(scene.nodes.has(r.id) || scene.groups.has(r.id)).toBe(true);
    for (const n of doc.networks.filter((x) => x.environmentId === env.id && doc.resources.some((r) => r.networkId === x.id))) expect(scene.groups.has(n.id)).toBe(true);
  }
}

describe('Terraform: configuración HCL de AWS (VPC, EKS, RDS, SQS, ALB…)', () => {
  const { document: doc, warnings } = load('aws-tienda/main.tf');

  it('deduce el entorno de la variable y el nombre del sistema de la carpeta', () => {
    expect(doc.workspace.name).toBe('aws-tienda');
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'production', name: 'production', kind: 'prod', provider: 'aws', region: 'eu-west-1' })]);
    expect(doc.environments[0].description).toMatch(/variable «environment»/);
  });

  it('la VPC y las subredes son redes con su exposición, su CIDR y su VPC como padre', () => {
    expect(doc.networks.map((n) => n.id)).toEqual(['vpc-main', 'public-a', 'public-b', 'private-a', 'private-b', 'data-a', 'data-b', 'transit']);
    expect(byId(doc.networks, 'vpc-main')).toMatchObject({ name: 'tienda-production-vpc', cidr: '10.20.0.0/16' });
    expect(byId(doc.networks, 'vpc-main').exposure).toBeUndefined();
    for (const id of ['public-a', 'public-b']) expect(byId(doc.networks, id)).toMatchObject({ exposure: 'public', parentId: 'vpc-main' });
    for (const id of ['private-a', 'private-b', 'data-a', 'data-b']) expect(byId(doc.networks, id)).toMatchObject({ exposure: 'private', parentId: 'vpc-main' });
    expect(byId(doc.networks, 'public-a').cidr).toBe('10.20.0.0/24');
  });

  it('cada recurso cae en su clase, con la tecnología y la versión que declara', () => {
    const kinds = Object.fromEntries(doc.resources.map((r) => [r.id, r.kind]));
    expect(kinds).toEqual({
      'kms-key-main': 'secret-store',
      'eks-cluster-main': 'cluster',
      web: 'registry',
      orders: 'database',
      sessions: 'cache',
      'orders-dlq': 'queue',
      'sqs-queue-orders': 'queue',
      logs: 'storage',
      'acm-certificate-main': 'certificate',
      public: 'load-balancer',
      'route53-zone-main': 'dns',
    });
    expect(byId(doc.resources, 'orders')).toMatchObject({ technology: 'Amazon RDS PostgreSQL', version: '15.4', name: 'tienda-production-orders' });
    expect(byId(doc.resources, 'eks-cluster-main')).toMatchObject({ technology: 'Amazon EKS', version: '1.29' });
    expect(byId(doc.resources, 'sessions')).toMatchObject({ technology: 'Amazon ElastiCache Redis', version: '7.1' });
    for (const r of doc.resources) expect(r.environmentId).toBe('production');
    expect(byId(doc.resources, 'orders').description).toContain('aws_db_instance.orders');
  });

  it('coloca cada recurso en la red que dice el código: base y caché en datos, balanceador en la pública, clúster en las privadas', () => {
    expect(byId(doc.resources, 'orders').networkId).toBe('data-a');
    expect(byId(doc.resources, 'sessions').networkId).toBe('data-a');
    expect(byId(doc.resources, 'public').networkId).toBe('public-a');
    expect(byId(doc.resources, 'eks-cluster-main').networkId).toBe('private-a');
    // Los servicios gestionados sin red (colas, buckets, KMS…) no se inventan una.
    for (const id of ['sqs-queue-orders', 'orders-dlq', 'logs', 'kms-key-main', 'route53-zone-main']) expect(byId(doc.resources, id).networkId).toBeUndefined();
  });

  it('deduce dependencias de las referencias, de los grupos de seguridad, del listener y del DNS', () => {
    expect(dep(doc, 'public', 'eks-cluster-main')).toMatchObject({ kind: 'calls', protocol: 'tcp/30000-32767' });
    expect(dep(doc, 'eks-cluster-main', 'orders')).toMatchObject({ kind: 'data', protocol: 'tcp/5432' });
    expect(dep(doc, 'public', 'acm-certificate-main')).toBeDefined();
    expect(dep(doc, 'route53-zone-main', 'public')).toBeDefined();
    expect(dep(doc, 'sqs-queue-orders', 'orders-dlq')).toMatchObject({ kind: 'messages' });
    expect(dep(doc, 'orders', 'kms-key-main')).toBeDefined();
    expect(dep(doc, 'public', 'logs')).toMatchObject({ kind: 'data' });
    // No se inventa nada entre lo que no se relaciona (colas y base de datos solo comparten la clave).
    expect(dep(doc, 'sqs-queue-orders', 'orders')).toBeUndefined();
    expect(dep(doc, 'orders', 'sessions')).toBeUndefined();
    for (const d of doc.dependencies) expect(d.description).toBeTruthy();
    // Las descripciones son las etiquetas de las flechas del lienzo: cortas y con la dirección de Terraform que las origina.
    expect(dep(doc, 'public', 'eks-cluster-main')?.description).toBe('Regla aws_security_group_rule.nodes_from_alb');
    expect(dep(doc, 'eks-cluster-main', 'orders')?.description).toBe('Ingreso aws_security_group.db');
    expect(dep(doc, 'route53-zone-main', 'public')?.description).toBe('Registro aws_route53_record.www');
    expect(dep(doc, 'orders', 'kms-key-main')?.description).toBe('Referencia aws_kms_key.main');
    for (const d of doc.dependencies) expect(d.description!.length).toBeLessThanOrEqual(80);
  });

  it('avisa, agrupado, de lo que no importa: tipos sin mapear, soporte, datos, módulos y redes sin exposición', () => {
    expect(warnings).toHaveLength(5);
    expect(warnings.join('\n')).toMatch(/1 recurso de un tipo sin mapear.*aws_xray_group/);
    expect(warnings.join('\n')).toMatch(/22 recursos de soporte que no se dibujan.*aws_internet_gateway.*aws_nat_gateway/);
    expect(warnings.join('\n')).toMatch(/2 fuentes de datos \(data\) sin importar: data\.aws_caller_identity\.current, data\.aws_availability_zones\.available/);
    expect(warnings.join('\n')).toMatch(/1 módulo sin mapear.*module\.observabilidad/);
    expect(warnings.join('\n')).toMatch(/1 red sin dato de exposición.*se importan como privadas: transit/);
  });

  it('es válido, pasa el gobierno sin errores ni avisos y se dibuja en la vista de despliegue del entorno', async () => {
    await expectHealthy(doc);
    expect(analyzePlatform(doc).map((i) => i.severity)).toEqual(expect.arrayContaining(['info']));
    expect(listViews(doc).map((v) => v.id)).toEqual(['env:production']);
  });

  it('un recurso sensible no cae en una red pública salvo que lo ponga ahí el código', () => {
    const sensitive: Array<Resource['kind']> = ['database', 'cache', 'queue', 'storage', 'secret-store'];
    const publicIds = new Set(doc.networks.filter((n) => n.exposure === 'public').map((n) => n.id));
    for (const r of doc.resources.filter((x) => sensitive.includes(x.kind))) expect(publicIds.has(r.networkId ?? '')).toBe(false);
  });

  it('importar dos veces el mismo texto da el mismo documento', () => {
    expect(load('aws-tienda/main.tf').document).toEqual(doc);
    expect(load('aws-tienda/main.tf').warnings).toEqual(warnings);
  });

  it('el CRLF, el BOM y los comentarios no cambian el resultado', () => {
    const text = read('aws-tienda/main.tf');
    const crlf = fromTerraform(`﻿${text.replace(/\n/g, '\r\n')}`, { file: `${DIR}/aws-tienda/main.tf` });
    expect(crlf.document).toEqual(doc);
  });
});

describe('Terraform: estado (.tfstate)', () => {
  const { document: doc, warnings } = load('aws-tienda-staging/terraform.tfstate');

  it('lee los recursos del estado, con el entorno de las etiquetas', () => {
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'staging', kind: 'staging', provider: 'aws', region: 'eu-west-1' })]);
    expect(doc.environments[0].description).toMatch(/etiqueta de entorno/);
    expect(doc.networks.map((n) => n.id)).toEqual(['vpc-main', 'public-a', 'public-b', 'private-a', 'private-b']);
    expect(doc.resources.map((r) => [r.id, r.kind])).toEqual([
      ['kms-key-main', 'secret-store'],
      ['orders', 'database'],
      ['eks-cluster-main', 'cluster'],
      ['sqs-queue-orders', 'queue'],
      ['public', 'load-balancer'],
      ['assets', 'storage'],
      ['db', 'secret-store'],
    ]);
    expect(byId(doc.resources, 'orders')).toMatchObject({ networkId: 'private-a', technology: 'Amazon RDS PostgreSQL' });
    expect(byId(doc.resources, 'public').networkId).toBe('public-a');
  });

  it('las dependencias salen de las que registra el estado y de los grupos de seguridad (por identificador físico)', () => {
    expect(dep(doc, 'orders', 'kms-key-main')?.description).toMatch(/^Estado aws_kms_key\.main$/);
    expect(dep(doc, 'sqs-queue-orders', 'kms-key-main')).toBeDefined();
    expect(dep(doc, 'eks-cluster-main', 'orders')).toMatchObject({ kind: 'data', protocol: 'tcp/5432' });
  });

  it('nunca copia valores del estado: ni la contraseña ni el secreto', () => {
    const everything = JSON.stringify({ doc, warnings });
    expect(read('aws-tienda-staging/terraform.tfstate')).toContain('S3cr3t-p4ss-do-not-leak!');
    expect(everything).not.toContain('S3cr3t-p4ss');
    expect(everything).not.toContain('secret_string');
  });

  it('es válido y se dibuja', async () => {
    await expectHealthy(doc);
    expect(warnings.join('\n')).toMatch(/fuente de datos/);
  });

  it('un estado de versión anterior a 0.12 se rechaza con una explicación', () => {
    expect(() => fromTerraform('{"version":3,"modules":[]}')).toThrow(/versión 3.*actualízalo/);
  });
});

describe('Terraform: plan (terraform show -json)', () => {
  const { document: doc, warnings } = load('aws-tienda-dev/plan.json');

  it('resuelve variables, count y módulos hijos con el entorno de las variables', () => {
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'dev', kind: 'dev', provider: 'aws', region: 'eu-west-1' })]);
    expect(doc.networks.map((n) => n.id)).toEqual(['vpc-main', 'private-0', 'private-1']);
    expect(byId(doc.networks, 'vpc-main').cidr).toBe('10.40.0.0/16');
    expect(doc.resources.map((r) => r.id)).toEqual(['orders', 'eks-cluster-main', 'assets', 'colas-sqs-queue', 'legacy']);
  });

  it('lo que el plan va a crear es «planned», lo que va a borrar es «decommissioned» y lo que no cambia no lleva estado', () => {
    expect(byId(doc.resources, 'orders').status).toBe('planned');
    expect(byId(doc.resources, 'colas-sqs-queue').status).toBe('planned');
    expect(byId(doc.resources, 'legacy').status).toBe('decommissioned');
    expect(byId(doc.resources, 'assets').status).toBeUndefined();
  });

  it('no copia las contraseñas del plan', () => {
    expect(read('aws-tienda-dev/plan.json')).toContain('plan-time-password-do-not-leak');
    expect(JSON.stringify({ doc, warnings })).not.toContain('plan-time-password');
  });

  it('es válido y se dibuja', async () => {
    await expectHealthy(doc);
  });
});

describe('Terraform: Azure, GCP y .tf.json', () => {
  it('Azure: AKS, PostgreSQL flexible, Redis, Service Bus y Application Gateway; el entorno sale del workspace', async () => {
    const { document: doc, warnings } = load('azure-aks/main.tf');
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'tienda-pre', kind: 'staging', provider: 'azure', region: 'westeurope' })]);
    expect(doc.resources.map((r) => [r.id, r.kind])).toEqual([
      ['container-registry-main', 'registry'],
      ['kubernetes-cluster-main', 'cluster'],
      ['postgresql-flexible-server-main', 'database'],
      ['redis-cache-main', 'cache'],
      ['servicebus-namespace-main', 'queue'],
      ['storage-account-main', 'storage'],
      ['key-vault-main', 'secret-store'],
      ['application-gateway-main', 'load-balancer'],
      ['dns-zone-main', 'dns'],
      ['log-analytics-workspace-main', 'monitoring'],
    ]);
    expect(byId(doc.networks, 'gateway').exposure).toBe('public');
    expect(byId(doc.networks, 'data').exposure).toBe('private');
    expect(byId(doc.resources, 'postgresql-flexible-server-main').networkId).toBe('data');
    expect(byId(doc.resources, 'kubernetes-cluster-main').networkId).toBe('aks');
    expect(dep(doc, 'kubernetes-cluster-main', 'container-registry-main')?.description).toMatch(/^Asignación de rol azurerm_role_assignment\.aks_acr$/);
    expect(JSON.stringify({ doc, warnings })).not.toContain('cambiar-en-el-pipeline');
    await expectHealthy(doc);
  });

  it('GCP: GKE, Cloud SQL, Memorystore, Pub/Sub y GCS; el entorno sale de las etiquetas', async () => {
    const { document: doc } = load('gcp-gke/main.tf');
    expect(doc.environments).toEqual([expect.objectContaining({ id: 'qa', kind: 'test', provider: 'gcp', region: 'europe-west1' })]);
    expect(doc.resources.map((r) => [r.id, r.kind])).toEqual(
      expect.arrayContaining([
        ['container-cluster-main', 'cluster'],
        ['orders', 'database'],
        ['sessions', 'cache'],
        ['pedidos', 'queue'],
        ['assets', 'storage'],
        ['db-password', 'secret-store'],
        ['images', 'registry'],
      ]),
    );
    expect(byId(doc.networks, 'edge').exposure).toBe('public');
    expect(byId(doc.networks, 'gke').exposure).toBe('private');
    await expectHealthy(doc);
  });

  it('.tf.json: la misma configuración en JSON', async () => {
    const { document: doc, warnings } = load('json-config/main.tf.json');
    expect(doc.resources.map((r) => [r.id, r.kind])).toEqual([
      ['orders', 'database'],
      ['pedidos', 'queue'],
    ]);
    expect(byId(doc.resources, 'orders').networkId).toBe('private');
    expect(warnings.join('\n')).toMatch(/aws_db_subnet_group/);
    await expectHealthy(doc);
  });
});

describe('Terraform: casos pequeños', () => {
  const tf = (body: string, options = {}) => fromTerraform(body, options);

  it('un recurso suelto crea un entorno por defecto con el nombre del archivo y avisa', () => {
    const r = tf('resource "aws_s3_bucket" "a" {\n  bucket = "datos"\n}\n', { file: 'infra/tienda-qa/main.tf' });
    expect(r.document.environments).toEqual([expect.objectContaining({ id: 'tienda-qa', kind: 'test' })]);
    expect(r.document.workspace.name).toBe('tienda-qa');
    expect(r.warnings.join('\n')).toMatch(/No se pudo deducir el entorno/);
  });

  it('sin archivo ni pistas el entorno se llama «Entorno principal»', () => {
    expect(tf('resource "aws_s3_bucket" "a" {\n  bucket = "datos"\n}\n').document.environments[0].name).toBe('Entorno principal');
  });

  it('el nombre explícito manda sobre el del archivo', () => {
    expect(tf('resource "aws_s3_bucket" "a" {}\n', { name: 'Mi sistema', file: 'x/y.tf' }).document.workspace.name).toBe('Mi sistema');
    expect(tf('resource "aws_s3_bucket" "a" {}\n', { file: 'x/produccion.tf' }).document.workspace.name).toBe('produccion');
  });

  it('una subred con map_public_ip_on_launch es pública; una sin ninguna pista es privada y se avisa', () => {
    const r = tf(`
variable "environment" { default = "prod" }
resource "aws_vpc" "v" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "abierta" {
  vpc_id = aws_vpc.v.id
  cidr_block = "10.0.1.0/24"
  map_public_ip_on_launch = true
}
resource "aws_subnet" "rara" {
  vpc_id = aws_vpc.v.id
  cidr_block = "10.0.2.0/24"
}
resource "aws_db_instance" "db" {
  engine = "mysql"
  db_subnet_group_name = "grupo"
}`);
    expect(byId(r.document.networks, 'abierta').exposure).toBe('public');
    expect(byId(r.document.networks, 'rara').exposure).toBe('private');
    expect(r.warnings.join('\n')).toMatch(/1 red sin dato de exposición.*rara/);
    expect(r.document.environments[0]).toMatchObject({ id: 'prod', kind: 'prod' });
  });

  it('resuelve count y for_each sin duplicar identificadores', () => {
    const r = tf(`
resource "aws_sqs_queue" "q" {
  count = 3
  name  = "cola-\${count.index}"
}
resource "aws_s3_bucket" "b" {
  for_each = toset(["a", "b"])
  bucket   = "bucket-\${each.key}"
}`);
    const ids = r.document.resources.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(validatePlatformDocument(r.document).ok).toBe(true);
  });

  it('las referencias a módulos o datos que no se pueden resolver no rompen la importación', () => {
    const r = tf(`
resource "aws_db_instance" "db" {
  engine  = "postgres"
  db_subnet_group_name = module.red.db_subnet_group
  vpc_security_group_ids = [module.red.sg_id]
}
resource "aws_sqs_queue" "q" { kms_master_key_id = data.aws_kms_key.k.arn }`);
    expect(r.document.resources.map((x) => x.id)).toEqual(['db', 'q']);
    expect(validatePlatformDocument(r.document).ok).toBe(true);
  });

  it('la clase de un recurso desconocido de un proveedor conocido se agrupa en un solo aviso', () => {
    const r = tf(`
resource "aws_s3_bucket" "b" { bucket = "x" }
resource "aws_xray_group" "a" { group_name = "a" }
resource "aws_xray_group" "b" { group_name = "b" }
resource "aws_macie2_account" "m" {}`);
    expect(r.document.resources.map((x) => x.id)).toEqual(['b']);
    const unmapped = r.warnings.filter((w) => /sin mapear/.test(w));
    expect(unmapped).toHaveLength(1);
    expect(unmapped[0]).toMatch(/3 recursos.*aws_xray_group ×2.*aws_macie2_account/);
  });
});

describe('Terraform: reconocimiento del formato', () => {
  it('detecta HCL, .tf.json, estado y plan por el contenido', () => {
    expect(looksLikeTerraform(read('aws-tienda/main.tf'))).toBe(true);
    expect(looksLikeTerraform(read('json-config/main.tf.json'))).toBe(true);
    expect(looksLikeTerraform(read('aws-tienda-staging/terraform.tfstate'))).toBe(true);
    expect(looksLikeTerraform(read('aws-tienda-dev/plan.json'))).toBe(true);
    expect(looksLikeTerraform('variable "x" {\n  default = 1\n}\n')).toBe(true);
  });

  it('no confunde Mermaid, Kubernetes, JSON ajeno ni texto cualquiera con Terraform', () => {
    expect(looksLikeTerraform('flowchart LR\n  a --> b\n')).toBe(false);
    expect(looksLikeTerraform(readFileSync('examples/pedidos-integracion.json', 'utf8'))).toBe(false);
    expect(looksLikeTerraform(readFileSync('examples/plataforma-ejemplo.json', 'utf8'))).toBe(false);
    expect(looksLikeTerraform('apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n')).toBe(false);
    expect(looksLikeTerraform('{"a": 1}')).toBe(false);
    expect(looksLikeTerraform('hola mundo')).toBe(false);
    expect(looksLikeTerraform('')).toBe(false);
  });
});

describe('Terraform: entradas rotas', () => {
  const fails = (text: string, message: RegExp): void => {
    expect(() => fromTerraform(text)).toThrow(PlatformImportError);
    expect(() => fromTerraform(text)).toThrow(message);
  };

  it('vacío, solo espacios o texto que no es Terraform', () => {
    fails('', /está vacío/);
    fails('  \n\n', /está vacío/);
    fails('hola mundo', /no contiene bloques de Terraform/);
    fails('flowchart LR\n a --> b', /no contiene bloques de Terraform/);
  });

  it('HCL con la estructura rota dice la línea', () => {
    fails('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16\n}\n', /línea 2.*cadena sin cerrar/);
    fails('resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16"\n', /línea 1.*llave de cierre/);
    fails('resource "a_b" "c" {\n  x = <<EOT\n  texto\n}\n', /línea 2.*heredoc/);
  });

  it('JSON roto o que no es de Terraform', () => {
    fails('{ "resources": [ ', /El JSON de Terraform no es válido/);
    fails('{"a": 1}', /El JSON no es de Terraform/);
    fails('[1, 2]', /Terraform/);
  });

  it('un Terraform sin nada que dibujar explica por qué', () => {
    fails('variable "x" { default = 1 }\n', /no define ningún recurso/);
    fails('data "aws_caller_identity" "c" {}\n', /no define ningún recurso/);
    fails('resource "aws_xray_group" "x" { group_name = "g" }\n', /Tipos sin mapear: aws_xray_group/);
    fails('{"version":4,"terraform_version":"1.7.0","resources":[]}', /no define ningún recurso/);
  });

  it('el HCL con líneas que no entiende sigue importando y avisa de la línea', () => {
    const r = fromTerraform('resource "aws_s3_bucket" "a" {\n  bucket = "x"\n  ???\n}\n');
    expect(r.document.resources).toHaveLength(1);
    expect(r.warnings.join('\n')).toMatch(/línea 3.*no se entiende/);
  });

  it('no desborda con un documento enorme de recursos repetidos', () => {
    const text = Array.from({ length: 400 }, (_, i) => `resource "aws_sqs_queue" "q${i}" {\n  name = "cola-${i}"\n}\n`).join('\n');
    const r = fromTerraform(text);
    expect(r.document.resources).toHaveLength(400);
    expect(r.warnings.length).toBeLessThanOrEqual(51);
    expect(validatePlatformDocument(r.document).ok).toBe(true);
  });
});

describe('fromTerraformFiles: varios .tf como un solo stack', () => {
  const MULTI = 'aws-tienda-multiarchivo';
  const folder = (): Array<{ name: string; text: string }> =>
    readdirSync(`${DIR}/${MULTI}`)
      .filter((n) => n.endsWith('.tf'))
      .map((name) => ({ name, text: read(`${MULTI}/${name}`) }));

  it('el fixture tiene varios archivos, entre ellos uno solo de comentarios', () => {
    const names = folder().map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['computo.tf', 'datos.tf', 'entrada.tf', 'outputs.tf', 'providers.tf', 'red.tf', 'seguridad.tf', 'variables.tf']));
    expect(read(`${MULTI}/outputs.tf`).replace(/#.*$/gm, '').trim()).toBe('');
  });

  it('da el mismo documento que importar sus textos concatenados a mano, con los mismos avisos', async () => {
    const joined = joinSourceFiles(folder());
    const together = fromTerraformFiles(folder(), { file: `${DIR}/${MULTI}` });
    const concatenated = fromTerraform(joined.text, { file: `${DIR}/${MULTI}` });
    expect(together.document).toEqual(concatenated.document);
    expect(together.warnings).toEqual(concatenated.warnings);
    expect(together.document.workspace.name).toBe(MULTI);
    await expectHealthy(together.document);
  });

  it('las referencias entre archivos se resuelven: es el mismo stack que el de un solo main.tf', () => {
    const multi = fromTerraformFiles(folder(), { file: `${DIR}/${MULTI}` }).document;
    const single = fromTerraform(read('aws-tienda/main.tf'), { file: `${DIR}/${MULTI}` }).document;
    const ids = (doc: PlatformDocument) => ({
      environments: doc.environments.map((e) => e.id).sort(),
      networks: doc.networks.map((n) => `${n.id}<${n.parentId ?? ''}:${n.exposure}`).sort(),
      resources: doc.resources.map((r) => `${r.id}:${r.kind}:${r.networkId ?? ''}`).sort(),
      dependencies: doc.dependencies.map((d) => `${d.sourceId}>${d.targetId}:${d.kind}:${d.protocol ?? ''}`).sort(),
    });
    expect(ids(multi)).toEqual(ids(single));
    // Una dependencia que cruza archivos: la regla de seguridad (seguridad.tf) conecta el balanceador (entrada.tf) con los nodos (computo.tf).
    expect(multi.dependencies.some((d) => d.sourceId === 'public' && d.targetId === 'eks-cluster-main')).toBe(true);
  });

  it('el orden en que se pasan los archivos no cambia el resultado', () => {
    const files = folder();
    const forward = fromTerraformFiles(joinSourceFiles(files).extra.files, { file: `${DIR}/${MULTI}` });
    const reversed = fromTerraformFiles(joinSourceFiles([...files].reverse()).extra.files, { file: `${DIR}/${MULTI}` });
    expect(reversed).toEqual(forward);
  });

  it('un archivo vacío o de comentarios no es un error, y si están todos vacíos se dice', () => {
    const doc = fromTerraformFiles([{ name: 'a.tf', text: '' }, { name: 'b.tf', text: '# nada\n' }, { name: 'c.tf', text: 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\n' }]);
    expect(doc.document.resources.map((r) => r.id)).toEqual(['q']);
    expect(() => fromTerraformFiles([{ name: 'a.tf', text: '' }, { name: 'b.tf', text: '  \n' }])).toThrow('Los archivos de Terraform están vacíos.');
  });

  it('un error de sintaxis dice de qué archivo y de qué línea', () => {
    const files = [
      { name: 'bien.tf', text: 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\n' },
      { name: 'roto.tf', text: 'resource "aws_vpc" "main" {\n  cidr_block = "10.0.0.0/16\n}\n' },
    ];
    expect(() => fromTerraformFiles(files)).toThrow('El HCL de Terraform no es válido (roto.tf, línea 2): cadena sin cerrar.');
    // Un solo archivo no lleva marca (es el mensaje de siempre).
    expect(() => fromTerraformFiles([files[1]])).toThrow('El HCL de Terraform no es válido (línea 2): cadena sin cerrar.');
    expect(() => fromTerraform(files[1].text)).toThrow('El HCL de Terraform no es válido (línea 2): cadena sin cerrar.');
  });

  it('los avisos de líneas que no entiende llevan el archivo; los de un solo archivo no', () => {
    const bueno = 'resource "aws_s3_bucket" "a" {\n  bucket = "x"\n  ???\n}\n';
    const otro = 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\nresource {\n}\n';
    const several = fromTerraformFiles([{ name: 'almacen.tf', text: bueno }, { name: 'colas.tf', text: otro }]);
    expect(several.warnings.join('\n')).toMatch(/almacen\.tf, línea 3: no se entiende/);
    expect(several.warnings.join('\n')).toMatch(/colas\.tf, línea 4: el bloque resource necesita tipo y nombre; se omite\./);
    const one = fromTerraformFiles([{ name: 'almacen.tf', text: bueno }]);
    expect(one.warnings.join('\n')).toMatch(/^línea 3: no se entiende/m);
  });

  it('el JSON de Terraform no se mezcla con HCL: se indica el archivo', () => {
    const hcl = { name: 'main.tf', text: 'resource "aws_sqs_queue" "q" {\n  name = "q"\n}\n' };
    expect(() => fromTerraformFiles([hcl, { name: 'terraform.tfstate', text: '{"version":4,"resources":[]}' }])).toThrow(/«terraform\.tfstate» no es HCL/);
  });

  it('un solo archivo en la lista es una importación normal', () => {
    const text = read('azure-aks/main.tf');
    expect(fromTerraformFiles([{ name: 'main.tf', text }], { file: `${DIR}/azure-aks/main.tf` })).toEqual(fromTerraform(text, { file: `${DIR}/azure-aks/main.tf` }));
  });

  it('los módulos locales no se resuelven: se avisan como cualquier módulo sin mapear', () => {
    const { warnings } = fromTerraformFiles(folder(), { file: `${DIR}/${MULTI}` });
    expect(warnings.join('\n')).toContain('1 módulo sin mapear (su contenido no está en el archivo): module.observabilidad');
  });
});
