import { readFileSync } from 'node:fs';
import { ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { platformModule } from '../module';
import { validatePlatformDocument } from '../schema';
import type { PlatformDocument } from '../types';

/** Lo que hace la CLI y el banco de trabajo: elegir el importador del módulo por extensión y, si no, por contenido. */
const registry = new ModuleRegistry().register(platformModule);
const pick = (text: string, file?: string): string | undefined => registry.detectImporter<PlatformDocument>('platform', file, text)?.id;
const read = (path: string): string => readFileSync(path, 'utf8');
const TF = 'tests/fixtures/importar/terraform';
const K8S = 'tests/fixtures/importar/kubernetes';

describe('módulo de plataforma: importadores registrados', () => {
  it('declara Mermaid, Terraform y Kubernetes, con sus extensiones', () => {
    expect(platformModule.importers.map((i) => [i.id, i.label, i.extensions])).toEqual([
      ['mermaid', 'Mermaid', ['.mmd', '.mermaid', '.md']],
      ['terraform', 'Terraform', ['.tf', '.tf.json', '.tfstate']],
      ['kubernetes', 'Kubernetes', ['.yaml', '.yml']],
    ]);
    for (const i of platformModule.importers) expect(typeof i.detect).toBe('function');
  });

  it.each([
    ['tests/fixtures/importar/terraform/aws-tienda/main.tf', 'terraform'],
    [`${TF}/aws-tienda-staging/terraform.tfstate`, 'terraform'],
    [`${TF}/json-config/main.tf.json`, 'terraform'],
    [`${TF}/aws-tienda-dev/plan.json`, 'terraform'],
    [`${TF}/azure-aks/main.tf`, 'terraform'],
    [`${TF}/gcp-gke/main.tf`, 'terraform'],
    [`${K8S}/tienda/manifests.yaml`, 'kubernetes'],
    [`${K8S}/tienda-kubectl/get-all.yaml`, 'kubernetes'],
    [`${K8S}/multi-entorno/entornos.yaml`, 'kubernetes'],
    [`${K8S}/malla-gateway/gateway.yaml`, 'kubernetes'],
    ['examples/banca.mmd', 'mermaid'],
  ])('%s se reconoce como %s, con su nombre de archivo y también solo por el contenido', (path, expected) => {
    const text = read(path);
    expect(pick(text, path)).toBe(expected);
    expect(pick(text)).toBe(expected);
  });

  it('un manifiesto de Kubernetes en un archivo .txt o sin extensión se reconoce por el contenido', () => {
    const text = read(`${K8S}/tienda/manifests.yaml`);
    expect(pick(text, 'manifiestos.txt')).toBe('kubernetes');
    expect(pick(text, 'manifiestos')).toBe('kubernetes');
    expect(pick(read(`${TF}/aws-tienda/main.tf`), 'infra.txt')).toBe('terraform');
  });

  it('el JSON del propio módulo y los de otros módulos no se toman por Terraform ni por Kubernetes', () => {
    for (const file of ['examples/plataforma-ejemplo.json', 'examples/pedidos-integracion.json', 'examples/banca.json', 'examples/seguridad-ejemplo.json']) {
      expect(pick(read(file))).toBeUndefined();
    }
  });

  it('Mermaid con cabecera YAML (---) sigue siendo Mermaid y un YAML con --- inicial sigue siendo Kubernetes', () => {
    expect(pick('---\ntitle: Tienda\n---\nflowchart LR\n  a --> b\n')).toBe('mermaid');
    expect(pick('---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: y\n')).toBe('kubernetes');
  });

  it.each(['importar', 'importacion'])('un texto cualquiera (%s) no se reconoce', (text) => {
    expect(pick(text)).toBeUndefined();
  });

  it('cada importador devuelve un documento válido con su nombre de archivo como nombre del sistema', async () => {
    for (const [file, id, name] of [
      [`${TF}/aws-tienda/main.tf`, 'terraform', 'aws-tienda'],
      [`${TF}/azure-aks/main.tf`, 'terraform', 'azure-aks'],
      [`${K8S}/tienda/manifests.yaml`, 'kubernetes', 'tienda'],
      [`${K8S}/multi-entorno/entornos.yaml`, 'kubernetes', 'entornos'],
    ]) {
      const importer = platformModule.importers.find((i) => i.id === id)!;
      const outcome = await importer.import(read(file), { file, fallbackName: file.split('/').pop() });
      expect(validatePlatformDocument(outcome.document).ok).toBe(true);
      expect(outcome.document.workspace.name).toBe(name);
      expect(Array.isArray(outcome.warnings)).toBe(true);
    }
  });

  it('el nombre explícito del contexto manda sobre el del archivo', async () => {
    const importer = platformModule.importers.find((i) => i.id === 'kubernetes')!;
    const outcome = await importer.import(read(`${K8S}/tienda/manifests.yaml`), { name: 'Tienda online', file: `${K8S}/tienda/manifests.yaml` });
    expect(outcome.document.workspace.name).toBe('Tienda online');
  });

  it('sin ruta de archivo (stdin) se usa el nombre de reserva y, si no, un nombre por defecto', async () => {
    const importer = platformModule.importers.find((i) => i.id === 'terraform')!;
    const text = 'resource "aws_s3_bucket" "a" {\n  bucket = "x"\n}\n';
    expect((await importer.import(text, { fallbackName: 'mi-infra.tf' })).document.workspace.name).toBe('mi-infra');
    expect((await importer.import(text, {})).document.workspace.name).toBe('Arquitectura de plataforma');
  });
});
