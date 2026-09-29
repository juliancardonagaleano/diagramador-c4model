import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildManifest, manifestSchema } from './manifest';
import { ModuleRegistry, UnknownModuleError } from './registry';
import type { DomainModule, Importer } from './types';
import { formatUrn, parseUrn } from './urn';

const importer = (id: string, extensions: string[], detect?: (t: string) => boolean): Importer<{ n: number }> => ({
  id,
  label: id,
  extensions,
  detect,
  import: () => ({ document: { n: 1 }, warnings: [] }),
});

function fakeModule(id: string, importers: Importer<{ n: number }>[] = []): DomainModule<{ n: number }> {
  return {
    id,
    name: `Módulo ${id}`,
    version: '1.2.3',
    documentVersion: '1.0',
    schema: z.object({ n: z.number() }),
    jsonSchema: () => ({}),
    validate: () => [],
    importers,
    exporters: [{ id: 'txt', label: 'Texto', extension: '.txt', mime: 'text/plain', export: (d) => String(d.n) }],
  };
}

describe('urn', () => {
  it('formatea y parsea referencias entre módulos', () => {
    const urn = formatUrn('data', 'clientes:v2');
    expect(urn).toBe('urn:iark:data:clientes:v2');
    expect(parseUrn(urn)).toEqual({ module: 'data', id: 'clientes:v2' });
  });

  it('rechaza módulos e ids inválidos y no parsea lo que no es una URN de la suite', () => {
    expect(() => formatUrn('Datos', 'x')).toThrow(/inválido/);
    expect(() => formatUrn('data', 'con espacio')).toThrow(/espacios/);
    expect(parseUrn('urn:otro:data:x')).toBeNull();
    expect(parseUrn('urn:iark:data:')).toBeNull();
  });
});

describe('ModuleRegistry', () => {
  it('registra, consulta y no admite duplicados ni ids inválidos', () => {
    const registry = new ModuleRegistry().register(fakeModule('c4')).register(fakeModule('data'));
    expect(registry.ids()).toEqual(['c4', 'data']);
    expect(registry.has('data')).toBe(true);
    expect(() => registry.register(fakeModule('c4'))).toThrow(/ya está registrado/);
    expect(() => registry.register(fakeModule('Mal Id'))).toThrow(/inválido/);
  });

  it('require falla listando los módulos disponibles', () => {
    const registry = new ModuleRegistry().register(fakeModule('c4'));
    expect(() => registry.require('datos')).toThrow(UnknownModuleError);
    expect(() => registry.require('datos')).toThrow(/Módulos disponibles: c4/);
  });

  it('detectImporter: la extensión manda y, sin ella, se detecta por el contenido', () => {
    const registry = new ModuleRegistry().register(
      fakeModule('c4', [importer('xml', ['.xml'], (t) => t.startsWith('<')), importer('mmd', ['.mmd'], (t) => t.startsWith('graph')), importer('dsl', ['.dsl'], (t) => t.includes('workspace'))]),
    );
    expect(registry.detectImporter('c4', 'a/B.MMD', 'lo que sea')?.id).toBe('mmd');
    expect(registry.detectImporter('c4', undefined, '<x/>')?.id).toBe('xml');
    expect(registry.detectImporter('c4', 'sin-extension', 'workspace {}')?.id).toBe('dsl');
    expect(registry.detectImporter('c4', 'datos.json', '{}')).toBeUndefined();
  });
});

describe('manifiesto de federación', () => {
  it('describe los módulos registrados y valida con su esquema', () => {
    const registry = new ModuleRegistry().register(fakeModule('c4', [importer('xml', ['.xml'])]));
    const manifest = buildManifest(registry, { name: 'IArk - DIAgrams', version: '0.1.0', endpoints: { c4: { embed: '/embed/c4/' } } });
    expect(manifest).toMatchObject({
      schema: 'iark.manifest/1',
      modules: [{ id: 'c4', version: '1.2.3', importFormats: ['xml'], exportFormats: ['txt'], endpoints: { embed: '/embed/c4/' } }],
    });
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifestSchema.safeParse({ ...manifest, schema: 'otro' }).success).toBe(false);
  });
});
