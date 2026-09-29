import { describe, expect, it } from 'vitest';
import example from '../../../examples/empresa-arquitectura.json';
import { enterpriseEditor } from './editor';
import { enterpriseModule } from './module';
import type { EnterpriseDocument } from './types';

const doc = enterpriseModule.schema.parse(example) as EnterpriseDocument;
const valid = (d: EnterpriseDocument): boolean => enterpriseModule.schema.safeParse(d).success;

describe('editor empresarial', () => {
  it('el mapa de capacidades anida las capacidades, colorea las hojas por madurez y trae su propia colocación en cuadrícula', () => {
    const g = enterpriseEditor.project(doc, 'capabilities');
    expect(g.nodes.length).toBe(doc.capabilities.length);
    expect(g.edges).toEqual([]);
    expect(g.nodes.find((n) => n.id === 'ventas-online')).toMatchObject({ parentId: 'gestion-comercial', fill: '#d8f5a2', badges: ['madurez 4/5'] });
    expect(g.nodes.find((n) => n.id === 'gestion-comercial')?.fill).toBeUndefined();
    const layout = enterpriseEditor.layout!(doc, 'capabilities');
    expect(layout && !(layout instanceof Promise) && layout.groups.some((b) => b.id === 'gestion-comercial')).toBe(true);
    expect(enterpriseEditor.layout!(doc, 'landscape')).toBeUndefined();
  });

  it('el paisaje dibuja capacidad → aplicación → tecnología con las relaciones en el sentido de la dependencia', () => {
    const g = enterpriseEditor.project(doc, 'landscape');
    const kinds = new Set(g.nodes.map((n) => n.kind));
    expect(kinds.has('application') && kinds.has('technology')).toBe(true);
    expect(kinds.has('unit')).toBe(false);
    expect(g.edges.find((e) => e.id === 'tienda-web--supports--ventas-online')).toMatchObject({ kind: 'supports', source: 'ventas-online', target: 'tienda-web' });
    const app = g.nodes.find((n) => n.id === 'tienda-web');
    expect(app?.sublabel).toBeTruthy();
  });

  it('las relaciones respetan las reglas del modelo en cualquier sentido del arrastre', () => {
    expect(enterpriseEditor.canConnect!(doc, 'supports', 'ventas-online', 'tienda-web')).toContain('ya existe');
    expect(enterpriseEditor.canConnect!(doc, 'runs-on', 'ventas-online', 'tienda-web')).toMatch(/se ejecuta en/);
    const added = enterpriseEditor.addEdge(doc, 'realizes', 'gestion-clientes', 'alta-pedido');
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const created = added.document.relations.find((r) => r.id === added.id)!;
    expect(created).toMatchObject({ kind: 'realizes', sourceId: 'alta-pedido', targetId: 'gestion-clientes' });
    expect(valid(added.document)).toBe(true);
    const wrong = enterpriseEditor.update(added.document, created.id, { kind: 'runs-on' });
    expect(wrong).toMatchObject({ ok: false });
  });

  it('añadir, editar (madurez como número, padre sin ciclos) y borrar una capacidad arrastra su subárbol y sus relaciones', () => {
    const added = enterpriseEditor.addNode(doc, 'capability', 'Fidelización', 'gestion-comercial');
    expect(added.ok && added.document.capabilities.find((c) => c.id === added.id)).toMatchObject({ name: 'Fidelización', parentId: 'gestion-comercial' });
    if (!added.ok) return;
    const edited = enterpriseEditor.update(added.document, added.id!, { maturity: '3', importance: 'core', ownerId: 'ventas' });
    expect(edited.ok && edited.document.capabilities.find((c) => c.id === added.id)).toMatchObject({ maturity: 3, importance: 'core', ownerId: 'ventas' });
    if (!edited.ok) return;
    expect(valid(edited.document)).toBe(true);
    expect(enterpriseEditor.read(edited.document, added.id!)?.values.maturity).toBe('3');
    expect(enterpriseEditor.update(edited.document, 'gestion-comercial', { parentId: 'ventas-online' })).toMatchObject({ ok: false });
    expect(enterpriseEditor.update(edited.document, added.id!, { ownerId: 'tienda-web' })).toMatchObject({ ok: false });

    const removed = enterpriseEditor.remove(edited.document, 'gestion-comercial');
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.document.capabilities.some((c) => c.id === 'ventas-online' || c.id === added.id)).toBe(false);
    expect(removed.document.relations.some((r) => r.targetId === 'ventas-online')).toBe(false);
    expect(valid(removed.document)).toBe(true);
  });

  it('una aplicación nueva se edita con sus campos propios y se enlaza por URN', () => {
    const added = enterpriseEditor.addNode(doc, 'application', 'CRM nuevo');
    if (!added.ok) throw new Error('no se añadió');
    const fields = enterpriseEditor.fields({ type: 'node', kind: 'application' }, doc).map((f) => f.key);
    expect(fields).toEqual(expect.arrayContaining(['lifecycle', 'criticality', 'external', 'ref']));
    const edited = enterpriseEditor.update(added.document, added.id!, { lifecycle: 'planned', criticality: 'high', external: true, ref: 'urn:iark:c4:crm' });
    if (!edited.ok) throw new Error(edited.reason);
    expect(valid(edited.document)).toBe(true);
    const removed = enterpriseEditor.remove(edited.document, added.id!);
    expect(removed.ok && removed.document.applications.length).toBe(doc.applications.length);
  });
});
