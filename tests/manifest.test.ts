import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifestSchema } from '@iark/kernel';
import { createDefaultRegistry } from '../src/cli/registry';
import { suiteManifest } from '../src/cli/suiteManifest';
import { MANIFEST_PATH, renderManifest } from '../scripts/generate-manifest';

describe('manifiesto de federación del sitio estático', () => {
  const published = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

  it('está al día con el registro de módulos (regenerar con `npm run manifest`)', () => {
    expect(readFileSync(MANIFEST_PATH, 'utf8')).toBe(renderManifest());
  });

  it('cumple el esquema iark.manifest/1 y lista todos los módulos del CLI', () => {
    const parsed = manifestSchema.safeParse(published);
    expect(parsed.success).toBe(true);
    expect(published.modules.map((m: { id: string }) => m.id)).toEqual(createDefaultRegistry().ids());
  });

  it('cada endpoint apunta a algo que el sitio publica', () => {
    for (const module of published.modules) {
      // relativos al manifiesto: `public/.well-known/iark.json` → raíz del sitio = `..`
      expect(module.endpoints.schema).toBe(`../schema/${module.id}-document.schema.json`);
      expect(existsSync(module.endpoints.schema.replace('../', ''))).toBe(true);
      const embed = new URL(module.endpoints.embed, 'http://sitio/.well-known/iark.json');
      const page = embed.pathname === '/' ? 'index.html' : embed.pathname.slice(1);
      expect(existsSync(page), `${module.id}: ${page}`).toBe(true);
      if (module.id !== 'c4') expect(embed.searchParams.get('module')).toBe(module.id);
      expect(module.endpoints.api).toBeUndefined();
    }
  });

  it('una instancia con servicio HTTP anuncia además su API por módulo', () => {
    const manifest = suiteManifest(createDefaultRegistry(), { version: '1.2.3', api: '/api/' });
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.modules.find((m) => m.id === 'data')!.endpoints!.api).toBe('/api/data');
  });
});
