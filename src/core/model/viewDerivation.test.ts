import { describe, expect, it } from 'vitest';
import { sampleDocument } from './sample';
import { deriveView } from './viewDerivation';
import { validateDocument } from './schema';

describe('deriveView', () => {
  it('la vista de contexto no tiene boundaries y dibuja relaciones directas', () => {
    const d = deriveView(sampleDocument, 'contexto');
    expect(d.boundaries).toHaveLength(0);
    expect(d.nodes.map((n) => n.id).sort()).toEqual(['banca', 'cliente', 'email', 'mainframe']);
    const keys = d.edges.map((e) => `${e.sourceId}->${e.targetId}`);
    expect(keys).toContain('cliente->banca');
    expect(keys).toContain('banca->mainframe');
    // cliente -> web-app/spa/mobile-app se resuelven a cliente -> banca (implícita) y se deduplican.
    const clienteBanca = d.edges.filter((e) => e.sourceId === 'cliente' && e.targetId === 'banca');
    expect(clienteBanca).toHaveLength(1);
    expect(clienteBanca[0].implied).toBe(false);
    // Solo una arista por par, aunque haya varias relaciones implícitas.
    const pairs = d.edges.map((e) => `${e.sourceId}->${e.targetId}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('la vista de contenedores usa el sistema como boundary y no dibuja aristas hacia él', () => {
    const d = deriveView(sampleDocument, 'contenedores');
    expect(d.boundaries.map((b) => b.id)).toEqual(['banca']);
    const banca = d.boundaries[0];
    expect(banca.children.sort()).toEqual(['api', 'db', 'mobile-app', 'spa', 'web-app']);
    expect(d.nodes.find((n) => n.id === 'api')?.boundaryId).toBe('banca');
    expect(d.nodes.find((n) => n.id === 'cliente')?.boundaryId).toBeUndefined();
    expect(d.edges.some((e) => e.targetId === 'banca' || e.sourceId === 'banca')).toBe(false);
    expect(d.edges.map((e) => `${e.sourceId}->${e.targetId}`)).toContain('api->db');
  });

  it('resuelve relaciones implícitas hacia el ancestro visible', () => {
    const d = deriveView(sampleDocument, 'componentes-api');
    // signin -> security es directa; security -> db es directa (db visible);
    // mainframe-facade -> mainframe directa. spa -> api (contenedor = boundary) se ignora.
    const implied = d.edges.filter((e) => e.implied);
    expect(implied).toHaveLength(0);
    // Ahora quitamos "db" de la vista y agregamos una relación hacia un hijo no visible.
    const doc = structuredClone(sampleDocument);
    const view = doc.views.find((v) => v.id === 'contenedores')!;
    // relación cliente -> signin (componente no visible en contenedores) debe resolver a cliente -> api
    doc.model.relationships.push({ id: 'rx', sourceId: 'cliente', targetId: 'signin', description: 'Inicia sesión' });
    const d2 = deriveView(doc, view.id);
    const e = d2.edges.find((x) => x.relationship.id === 'rx');
    expect(e).toBeDefined();
    expect(e!.targetId).toBe('api');
    expect(e!.implied).toBe(true);
  });

  it('calcula la geometría del boundary a partir de sus hijos posicionados', () => {
    const doc = structuredClone(sampleDocument);
    const view = doc.views.find((v) => v.id === 'contenedores')!;
    view.elements = [
      { id: 'api', x: 100, y: 100, width: 240, height: 130 },
      { id: 'db', x: 500, y: 100, width: 240, height: 130 },
    ];
    const d = deriveView(doc, view.id);
    const b = d.boundaries[0];
    expect(b.x).toBeLessThan(100);
    expect(b.y).toBeLessThan(100);
    expect(b.x! + b.width!).toBeGreaterThan(740);
    expect(b.y! + b.height!).toBeGreaterThan(230);
  });
});

describe('validateDocument', () => {
  it('acepta el documento de ejemplo', () => {
    const r = validateDocument(sampleDocument);
    expect(r.ok).toBe(true);
  });

  it('rechaza referencias rotas y jerarquías inválidas', () => {
    const doc = structuredClone(sampleDocument);
    doc.model.elements.push({ id: 'x', type: 'component', name: 'X', parentId: 'banca' });
    doc.model.relationships.push({ id: 'bad', sourceId: 'nope', targetId: 'cliente' });
    doc.views[0].elements.push({ id: 'ghost' });
    const r = validateDocument(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const msgs = r.issues.map((i) => i.message).join('\n');
      expect(msgs).toMatch(/debe ser de tipo "container"/);
      expect(msgs).toMatch(/origen inexistente/);
      expect(msgs).toMatch(/elemento inexistente: "ghost"/);
    }
  });

  it('aplica valores por defecto', () => {
    const r = validateDocument({ model: { elements: [] } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.document.version).toBe('1.0');
      expect(r.document.views).toEqual([]);
      expect(r.document.workspace.name).toBeTruthy();
    }
  });
});
