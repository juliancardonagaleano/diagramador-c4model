import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadManifest, ManifestError } from './manifest';

const published = readFileSync(new URL('../../public/.well-known/iark.json', import.meta.url), 'utf8');
const respond = (body: string, status = 200): typeof fetch => (async () => new Response(body, { status })) as typeof fetch;

describe('descubrimiento de módulos por manifiesto', () => {
  it('resuelve los endpoints relativos al manifiesto, bajo cualquier ruta base', async () => {
    const manifest = await loadManifest('https://juliancardonagaleano.github.io/diagramador-c4model/.well-known/iark.json', respond(published));
    expect(manifest.name).toBe('IArk - DIAgrams');
    expect(manifest.modules.map((m) => m.id)).toEqual(['c4', 'integration', 'data', 'enterprise', 'platform', 'security']);
    const c4 = manifest.modules.find((m) => m.id === 'c4')!;
    expect(c4.embedUrl).toBe('https://juliancardonagaleano.github.io/diagramador-c4model/');
    const security = manifest.modules.find((m) => m.id === 'security')!;
    expect(security.embedUrl).toBe('https://juliancardonagaleano.github.io/diagramador-c4model/modulos.html?module=security');
    expect(security.schemaUrl).toBe('https://juliancardonagaleano.github.io/diagramador-c4model/schema/security-document.schema.json');
    expect(security.apiUrl).toBeUndefined();
  });

  it('una instancia remota con API resuelve también el endpoint de la API', async () => {
    const remote = JSON.stringify({
      schema: 'iark.manifest/1',
      name: 'Otra instancia',
      version: '2.0.0',
      modules: [{ id: 'data', name: 'Datos', version: '1', documentVersion: '1.0', importFormats: [], exportFormats: ['svg'], endpoints: { embed: '/w/modulos.html?module=data', api: '/api/data' } }],
    });
    const manifest = await loadManifest('https://otra.example/.well-known/iark.json', respond(remote));
    expect(manifest.modules[0].embedUrl).toBe('https://otra.example/w/modulos.html?module=data');
    expect(manifest.modules[0].apiUrl).toBe('https://otra.example/api/data');
  });

  it('explica por qué falla: red, estado HTTP, JSON o esquema', async () => {
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    await expect(loadManifest('https://x.example/m.json', offline)).rejects.toThrow(/CORS/);
    await expect(loadManifest('https://x.example/m.json', respond('nada', 404))).rejects.toThrow(/respondió 404/);
    await expect(loadManifest('https://x.example/m.json', respond('<html>'))).rejects.toThrow(/no es JSON válido/);
    await expect(loadManifest('https://x.example/m.json', respond('{"schema":"otro"}'))).rejects.toBeInstanceOf(ManifestError);
  });
});
