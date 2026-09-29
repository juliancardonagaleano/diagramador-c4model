// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { validateDocument } from '../../core/model/schema';
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

    it('no permite cambiar el tipo de un elemento con hijos ni de un alcance de vista (dejaría un documento inválido)', () => {
      const { updateElement } = useDocumentStore.getState();
      updateElement('banca', { type: 'container' });
      expect(useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'banca')!.type).toBe('softwareSystem');
      // El resto del patch sí se aplica aunque el tipo se ignore.
      updateElement('banca', { type: 'container', description: 'Nueva' });
      const banca = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'banca')!;
      expect(banca.type).toBe('softwareSystem');
      expect(banca.description).toBe('Nueva');
    });

    it('al cambiar el tipo, un padre incompatible se descarta (el documento sigue siendo válido)', () => {
      // "accounts" es un componente con padre "api" (container); como softwareSystem no admite padre.
      useDocumentStore.getState().updateElement('accounts', { type: 'softwareSystem' });
      const accounts = useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'accounts')!;
      expect(accounts.type).toBe('softwareSystem');
      expect(accounts.parentId).toBeUndefined();
    });

    it('un elemento hoja sí puede cambiar de tipo', () => {
      useDocumentStore.getState().updateElement('db', { type: 'component', parentId: undefined });
      expect(useDocumentStore.getState().doc.model.elements.find((e) => e.id === 'db')!.type).toBe('component');
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

    it('editar la descripción nunca se bloquea, aunque el documento importado ya tenga el par repetido', () => {
      const { updateRelationship } = useDocumentStore.getState();
      useDocumentStore.setState((s) => ({
        doc: { ...s.doc, model: { ...s.doc.model, relationships: [...s.doc.model.relationships, { id: 'dup', sourceId: 'cliente', targetId: 'banca', description: 'Otra' }] } },
      }));
      updateRelationship('dup', { description: 'Editada' });
      expect(useDocumentStore.getState().doc.model.relationships.find((r) => r.id === 'dup')!.description).toBe('Editada');
      updateRelationship('r1', { technology: 'HTTPS' });
      expect(useDocumentStore.getState().doc.model.relationships.find((r) => r.id === 'r1')!.technology).toBe('HTTPS');
    });

    it('una edición válida sí se aplica', () => {
      const rel = useDocumentStore.getState().doc.model.relationships[0];
      const { updateRelationship } = useDocumentStore.getState();
      updateRelationship(rel.id, { description: 'Nueva descripción' });
      const after = useDocumentStore.getState().doc.model.relationships.find((r) => r.id === rel.id)!;
      expect(after.description).toBe('Nueva descripción');
    });
  });

  describe('el sistema de una vista de contexto', () => {
    const ctx = () => useDocumentStore.getState().doc.views.find((v) => v.id === 'contexto')!;

    it('removeElementFromView no lo quita de su propia vista (dejaría un documento inválido)', () => {
      useDocumentStore.getState().removeElementFromView('contexto', 'banca');
      expect(ctx().elements.map((e) => e.id)).toContain('banca');
      expect(validateDocument(useDocumentStore.getState().doc).ok).toBe(true);
    });

    it('removeElementFromView sigue quitando el resto de elementos de la vista', () => {
      useDocumentStore.getState().removeElementFromView('contexto', 'email');
      expect(ctx().elements.map((e) => e.id)).not.toContain('email');
    });

    it('en una vista de contenedores el alcance tampoco está entre los elementos, y quitar otro no lo afecta', () => {
      useDocumentStore.getState().removeElementFromView('contenedores', 'cliente');
      expect(validateDocument(useDocumentStore.getState().doc).ok).toBe(true);
    });

    it('updateView lo añade a la vista al fijar o cambiar el alcance', () => {
      const { updateView } = useDocumentStore.getState();
      // Se quita a la fuerza (simula un documento viejo) y se vuelve a fijar el alcance.
      useDocumentStore.setState((s) => ({
        doc: { ...s.doc, views: s.doc.views.map((v) => (v.id === 'contexto' ? { ...v, scopeId: undefined, elements: v.elements.filter((e) => e.id !== 'banca') } : v)) },
      }));
      updateView('contexto', { scopeId: 'banca' });
      expect(ctx().elements.map((e) => e.id)).toContain('banca');
      expect(validateDocument(useDocumentStore.getState().doc).ok).toBe(true);
    });

    it('updateView no duplica el sistema si ya estaba en la vista', () => {
      useDocumentStore.getState().updateView('contexto', { scopeId: 'banca' });
      expect(ctx().elements.filter((e) => e.id === 'banca')).toHaveLength(1);
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
