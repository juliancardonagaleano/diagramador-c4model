// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from './documentStore';

function reset() {
  useDocumentStore.getState().loadSample();
  useDocumentStore.temporal.getState().clear();
}

describe('documentStore', () => {
  beforeEach(reset);

  describe('updateElement', () => {
    it('un nombre vacío se ignora: no deja el elemento sin nombre', () => {
      const { updateElement } = useDocumentStore.getState();
      updateElement('cliente', { name: '' });
      const el = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'cliente')!;
      expect(el.name).toBe('Cliente personal');
      expect(el.name).toBeTruthy();
    });

    it('un nombre solo con espacios también se ignora', () => {
      const { updateElement } = useDocumentStore.getState();
      updateElement('cliente', { name: '   ' });
      const el = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'cliente')!;
      expect(el.name).toBe('Cliente personal');
    });

    it('un nombre válido sí se aplica', () => {
      const { updateElement } = useDocumentStore.getState();
      updateElement('cliente', { name: 'Cliente premium' });
      const el = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'cliente')!;
      expect(el.name).toBe('Cliente premium');
    });
  });

  describe('moveElements con reparent', () => {
    it('mover y reparentar en una sola llamada deja un único paso de deshacer', () => {
      const before = useDocumentStore.temporal.getState().pastStates.length;
      useDocumentStore.getState().moveElements('contenedores', [{ id: 'api', x: 500, y: 500 }], { id: 'api', parentId: undefined });
      const after = useDocumentStore.temporal.getState().pastStates.length;
      expect(after - before).toBe(1);
    });

    it('reparent con parentId limpia el padre anterior (desvincular)', () => {
      const { moveElements } = useDocumentStore.getState();
      moveElements('contenedores', [{ id: 'api', x: 10, y: 10 }], { id: 'api', parentId: undefined });
      const el = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'api')!;
      expect(el.parentId).toBeUndefined();
    });

    it('reparent con un nuevo id de padre lo adopta', () => {
      const { moveElements } = useDocumentStore.getState();
      moveElements('contenedores', [{ id: 'api', x: 10, y: 10 }], { id: 'api', parentId: 'banca' });
      const el = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'api')!;
      expect(el.parentId).toBe('banca');
    });

    it('sin reparent, solo mueve la posición y deja igual el padre', () => {
      const { moveElements } = useDocumentStore.getState();
      moveElements('contenedores', [{ id: 'api', x: 42, y: 42 }]);
      const el = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'api')!;
      expect(el.parentId).toBe('banca');
      const viewEl = useDocumentStore.getState().doc.views.find((v) => v.id === 'contenedores')!.elements.find((e) => e.id === 'api')!;
      expect(viewEl.x).toBe(42);
      expect(viewEl.y).toBe(42);
    });
  });

  describe('addRelationship', () => {
    it('rechaza una relación con el mismo origen y destino que otra ya existente', () => {
      const { addRelationship } = useDocumentStore.getState();
      const before = useDocumentStore.getState().doc.model.relationships.length;
      const first = addRelationship('cliente', 'mainframe');
      expect(first).not.toBeNull();
      const duplicate = addRelationship('cliente', 'mainframe');
      expect(duplicate).toBeNull();
      expect(useDocumentStore.getState().doc.model.relationships.length).toBe(before + 1);
    });

    it('sigue rechazando la auto-referencia', () => {
      const { addRelationship } = useDocumentStore.getState();
      expect(addRelationship('cliente', 'cliente')).toBeNull();
    });
  });

  describe('updateRelationship', () => {
    it('ignora una edición que dejaría sourceId === targetId', () => {
      const rel = useDocumentStore.getState().doc.model.relationships[0];
      const { updateRelationship } = useDocumentStore.getState();
      updateRelationship(rel.id, { targetId: rel.sourceId });
      const after = useDocumentStore.getState().doc.model.relationships.find((r) => r.id === rel.id)!;
      expect(after.targetId).toBe(rel.targetId);
    });

    it('ignora una edición que duplicaría otra relación existente', () => {
      const { addRelationship, updateRelationship } = useDocumentStore.getState();
      const rel = useDocumentStore.getState().doc.model.relationships.find((r) => r.sourceId === 'cliente')!;
      const other = addRelationship('cliente', 'mainframe')!;
      updateRelationship(other.id, { targetId: rel.targetId });
      const after = useDocumentStore.getState().doc.model.relationships.find((r) => r.id === other.id)!;
      expect(after.targetId).toBe('mainframe');
    });

    it('una edición válida sí se aplica', () => {
      const rel = useDocumentStore.getState().doc.model.relationships[0];
      const { updateRelationship } = useDocumentStore.getState();
      updateRelationship(rel.id, { description: 'Nueva descripción' });
      const after = useDocumentStore.getState().doc.model.relationships.find((r) => r.id === rel.id)!;
      expect(after.description).toBe('Nueva descripción');
    });
  });

  describe('purga de rutas muertas en view.edges', () => {
    function withFakeRoute(viewId: string, edgeId: string) {
      useDocumentStore.setState((s) => ({
        doc: { ...s.doc, views: s.doc.views.map((v) => (v.id === viewId ? { ...v, edges: [{ id: edgeId, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }] } : v)) },
      }));
    }

    it('removeElement purga las rutas (directas e implícitas) que tocaban al elemento borrado', () => {
      withFakeRoute('contenedores', 'r11'); // relación directa api->db
      withFakeRoute('contexto', 'r2@banca->mainframe'); // implícita
      useDocumentStore.getState().removeElement('mainframe');
      expect(useDocumentStore.getState().doc.views.find((v) => v.id === 'contexto')!.edges).toEqual([]);
      // La ruta de "contenedores" no tocaba a "mainframe", así que sigue intacta.
      expect(useDocumentStore.getState().doc.views.find((v) => v.id === 'contenedores')!.edges).toHaveLength(1);
    });

    it('removeRelationship purga la ruta de esa relación (directa e implícitas derivadas)', () => {
      withFakeRoute('contenedores', 'r11');
      useDocumentStore.getState().removeRelationship('r11');
      expect(useDocumentStore.getState().doc.views.find((v) => v.id === 'contenedores')!.edges).toEqual([]);
    });
  });
});
