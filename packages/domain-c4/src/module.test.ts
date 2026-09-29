import { ModuleRegistry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { c4Module } from './module';
import { sampleDocument } from './model/sample';
import { validateDocument } from './model/schema';

describe('c4Module', () => {
  const registry = new ModuleRegistry().register(c4Module);

  it('cumple el contrato: esquema, JSON Schema y validación semántica', () => {
    expect(c4Module.schema.safeParse(sampleDocument).success).toBe(true);
    expect((c4Module.jsonSchema() as { type?: string }).type).toBe('object');
    expect(c4Module.validate(sampleDocument).every((i) => ['error', 'warning', 'info'].includes(i.severity))).toBe(true);
  });

  it('detecta el importador por extensión y por contenido', () => {
    const id = (file: string | undefined, text: string) => registry.detectImporter('c4', file, text)?.id;
    expect(id('a.drawio', '')).toBe('drawio');
    expect(id('a.dsl', '')).toBe('dsl');
    expect(id('a.mmd', '')).toBe('mermaid');
    expect(id(undefined, '<mxfile/>')).toBe('drawio');
    expect(id(undefined, 'flowchart LR\nA-->B')).toBe('mermaid');
    expect(id(undefined, 'workspace "x" { }')).toBe('dsl');
    expect(id('datos.json', '{}')).toBeUndefined();
  });

  it('importa y exporta por sus adaptadores', async () => {
    const mermaid = c4Module.importers.find((i) => i.id === 'mermaid')!;
    const { document } = await mermaid.import('flowchart LR\n A[Web] --> B[(BD)]', { fallbackName: 'demo' });
    expect(validateDocument(document).ok).toBe(true);
    expect(document.workspace.name).toBe('demo');

    const text = await c4Module.exporters.find((e) => e.id === 'mermaid')!.export(sampleDocument, { viewId: 'contenedores' });
    expect(text.startsWith('C4Container')).toBe(true);
    const xml = await c4Module.exporters.find((e) => e.id === 'drawio')!.export(sampleDocument, {});
    expect(xml).toContain('<mxfile');
  });

  it('prepara el prompt de IA y expone las entidades referenciables por URN', () => {
    const ai = c4Module.ai!;
    expect(ai.user('Una tienda')).toContain('Una tienda');
    expect(ai.system().length).toBeGreaterThan(100);
    expect(ai.toDocument({ workspace: { name: 'Demo', description: null }, elements: [], relationships: [], views: [] })).toMatchObject({ ok: true });
    const entities = c4Module.entities!(sampleDocument);
    expect(entities.length).toBe(sampleDocument.model.elements.length);
    expect(entities[0]).toMatchObject({ id: sampleDocument.model.elements[0].id, kind: sampleDocument.model.elements[0].type });
  });
});
