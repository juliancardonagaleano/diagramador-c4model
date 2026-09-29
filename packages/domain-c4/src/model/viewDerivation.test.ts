import { describe, expect, it } from 'vitest';
import { sampleDocument } from './sample';
import { deriveView, resolveDropReparent } from './viewDerivation';
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

  it('rechaza una vista de contexto que no incluye su propio sistema', () => {
    const doc = structuredClone(sampleDocument);
    const ctx = doc.views.find((v) => v.id === 'contexto')!;
    ctx.elements = ctx.elements.filter((e) => e.id !== ctx.scopeId);
    const r = validateDocument(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues).toContainEqual({
        path: 'views.0.elements',
        message: expect.stringMatching(/debe incluir su alcance "banca"/),
      });
    }
  });

  it('no exige el alcance entre los elementos de las vistas de contenedores (es su boundary)', () => {
    const cont = sampleDocument.views.find((v) => v.type === 'container')!;
    expect(cont.elements.some((e) => e.id === cont.scopeId)).toBe(false);
    expect(validateDocument(sampleDocument).ok).toBe(true);
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

describe('resolveDropReparent (soltar un nodo tras arrastrarlo)', () => {
  const laid = async () => (await import('../layout/elkLayout')).autoLayoutDocument(structuredClone(sampleDocument));

  it('no toca la jerarquía de un nodo cuyo padre no se dibuja como boundary en la vista (spa/db en C3)', async () => {
    const doc = await laid();
    const c3 = deriveView(doc, 'componentes-api');
    expect(c3.boundaries.map((b) => b.id)).toEqual(['api']); // "banca" (padre de spa/db/mobile-app) no es boundary aquí
    for (const id of ['spa', 'mobile-app', 'db']) {
      const n = c3.nodes.find((x) => x.id === id)!;
      expect(resolveDropReparent(c3, id, { x: n.x! + 500, y: n.y! + 500 })).toBeNull();
    }
  });

  it('desvincula al sacar un nodo de la caja de su boundary y no hace nada mientras siga dentro', async () => {
    const doc = await laid();
    const c2 = deriveView(doc, 'contenedores');
    const banca = c2.boundaries.find((b) => b.id === 'banca')!;
    const api = c2.nodes.find((n) => n.id === 'api')!;
    // Dentro de la caja: sin cambios.
    expect(resolveDropReparent(c2, 'api', { x: api.x!, y: api.y! })).toBeNull();
    // Muy por fuera de la caja: se desvincula.
    expect(resolveDropReparent(c2, 'api', { x: banca.x! + banca.width! + 800, y: banca.y! + banca.height! + 800 })).toEqual({ id: 'api', parentId: undefined });
  });

  it('adopta el boundary compatible al soltar un nodo sin padre dentro de él, y no adopta uno incompatible', async () => {
    const doc = structuredClone(await laid());
    doc.model.elements.find((e) => e.id === 'db')!.parentId = undefined;
    delete doc.model.elements.find((e) => e.id === 'db')!.parentId;
    const c2 = deriveView(doc, 'contenedores');
    const banca = c2.boundaries.find((b) => b.id === 'banca')!;
    const inside = { x: banca.x! + banca.width! / 2 - 120, y: banca.y! + banca.height! / 2 - 65 };
    expect(resolveDropReparent(c2, 'db', inside)).toEqual({ id: 'db', parentId: 'banca' });
    // Una persona no admite padre: soltarla dentro del boundary no cambia nada.
    expect(resolveDropReparent(c2, 'cliente', inside)).toBeNull();
  });
});
