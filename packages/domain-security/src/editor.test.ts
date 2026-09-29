import { describe, expect, it } from 'vitest';
import example from '../../../examples/seguridad-ejemplo.json';
import { securityEditor } from './editor';
import { securityModule } from './module';
import type { SecurityDocument } from './types';

const doc = securityModule.schema.parse(example) as SecurityDocument;
const valid = (d: SecurityDocument): boolean => securityModule.schema.safeParse(d).success;

describe('editor de seguridad', () => {
  it('el DFD anida las zonas de confianza coloreadas por nivel y distingue los flujos por cifrado', () => {
    const g = securityEditor.project(doc, 'dfd');
    expect(g.nodes.find((n) => n.id === 'internet')).toMatchObject({ kind: 'zone', fill: '#fa5252' });
    expect(g.nodes.find((n) => n.id === 'datos')).toMatchObject({ kind: 'zone', parentId: 'interna' });
    expect(g.nodes.find((n) => n.id === 'pedidos-db')).toMatchObject({ kind: 'datastore', parentId: 'datos' });
    expect(g.nodes.find((n) => n.id === 'cliente')).toMatchObject({ kind: 'actor', parentId: 'internet' });
    const kinds = new Set(g.edges.map((e) => e.kind));
    expect(kinds.has('flow-encrypted')).toBe(true);
    expect(g.edges.find((e) => e.id === 'notificaciones-a-correo')?.kind).toBe('flow-plain');
  });

  it('el modelo de amenazas dibuja amenazas por riesgo con su categoría STRIDE, unidas a lo que amenazan y a sus controles', () => {
    const g = securityEditor.project(doc, 'threats');
    const threat = g.nodes.find((n) => n.id === 'exfiltracion-db');
    expect(threat).toMatchObject({ kind: 'threat' });
    expect(threat?.sublabel).toContain('Divulgación de información');
    expect(g.nodes.find((n) => n.id === 'cliente-navega')).toMatchObject({ kind: 'flow' });
    expect(g.edges.find((e) => e.id === 't:exfiltracion-db')).toMatchObject({ kind: 'threat', source: 'exfiltracion-db', target: 'pedidos-db' });
    expect(g.edges.find((e) => e.id === 'm:cifrado-reposo:exfiltracion-db')).toMatchObject({ kind: 'mitigates' });
  });

  it('un flujo se crea con su cifrado según el tipo elegido y se edita con sí/no/no se sabe', () => {
    expect(securityEditor.canConnect!(doc, 'flow', 'cliente', 'waf-lb')).toMatch(/ya existe/);
    expect(securityEditor.canConnect!(doc, 'flow', 'facturacion', 'pedidos-db')).toBeUndefined();
    expect(securityEditor.canConnect!(doc, 'flow', 'cliente', 'internet')).toMatch(/dos activos/);
    const added = securityEditor.addEdge(doc, 'flow-plain', 'facturacion', 'pedidos-db');
    if (!added.ok) throw new Error(added.reason);
    expect(added.document.flows.find((f) => f.id === added.id)).toMatchObject({ sourceId: 'facturacion', targetId: 'pedidos-db', encrypted: false });
    expect(securityEditor.read(added.document, added.id!)).toMatchObject({ type: 'edge', kind: 'flow-plain', values: { encrypted: 'no' } });
    const edited = securityEditor.update(added.document, added.id!, { encrypted: '', protocol: 'JDBC', classification: 'confidential' });
    if (!edited.ok) throw new Error(edited.reason);
    const flow = edited.document.flows.find((f) => f.id === added.id)!;
    expect(flow.encrypted).toBeUndefined();
    expect(flow).toMatchObject({ protocol: 'JDBC', classification: 'confidential' });
    expect(valid(edited.document)).toBe(true);
  });

  it('una amenaza nace sobre el elemento seleccionado con una categoría que le aplica; «amenaza a» y «mitiga» respetan STRIDE y los tipos', () => {
    const added = securityEditor.addNode(doc, 'threat', 'Borrado de pedidos', 'pedidos-db');
    if (!added.ok) throw new Error(added.reason);
    expect(added.document.threats.find((t) => t.id === added.id)).toMatchObject({ targetId: 'pedidos-db', category: 'tampering' });
    // Suplantación no aplica a un almacén de datos.
    expect(securityEditor.canConnect!(doc, 'threat', 'robo-credenciales', 'pedidos-db')).toMatch(/no aplica/);
    const retargeted = securityEditor.addEdge(doc, 'threat', 'robo-credenciales', 'tienda-web');
    if (!retargeted.ok) throw new Error(retargeted.reason);
    expect(retargeted.document.threats.find((t) => t.id === 'robo-credenciales')?.targetId).toBe('tienda-web');
    const mitigated = securityEditor.addEdge(added.document, 'mitigates', added.id!, 'cifrado-reposo');
    if (!mitigated.ok) throw new Error(mitigated.reason);
    expect(mitigated.document.threats.find((t) => t.id === added.id)?.controlIds).toEqual(['cifrado-reposo']);
    expect(securityEditor.canConnect!(mitigated.document, 'mitigates', 'cifrado-reposo', added.id!)).toMatch(/ya mitiga/);
    expect(securityEditor.remove(mitigated.document, `t:${added.id}`)).toMatchObject({ ok: false });
    const unlinked = securityEditor.remove(mitigated.document, `m:cifrado-reposo:${added.id}`);
    expect(unlinked.ok && unlinked.document.threats.find((t) => t.id === added.id)?.controlIds).toEqual([]);
    expect(valid(mitigated.document)).toBe(true);
  });

  it('borrar una zona arrastra sus zonas hijas, sus activos, los flujos de esos activos y las amenazas que recaían sobre ellos', () => {
    const removed = securityEditor.remove(doc, 'interna');
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.document.zones.map((z) => z.id)).toEqual(['internet', 'perimetro']);
    expect(removed.document.assets.some((a) => a.id === 'pedidos-db')).toBe(false);
    expect(removed.document.flows.some((f) => f.id === 'pedidos-a-db')).toBe(false);
    expect(removed.document.threats.some((t) => t.id === 'exfiltracion-db')).toBe(false);
    expect(valid(removed.document)).toBe(true);
    // Un activo nuevo dentro de una zona; el cifrado en reposo solo lo guardan los almacenes.
    const added = securityEditor.addNode(doc, 'datastore', 'Caché de sesiones', 'datos');
    if (!added.ok) throw new Error(added.reason);
    const edited = securityEditor.update(added.document, added.id!, { encryptedAtRest: 'yes', classification: 'internal' });
    expect(edited.ok && edited.document.assets.find((a) => a.id === added.id)).toMatchObject({ zoneId: 'datos', encryptedAtRest: true });
    const asProcess = securityEditor.update(edited.ok ? edited.document : doc, added.id!, { kind: 'process' });
    expect(asProcess.ok && asProcess.document.assets.find((a) => a.id === added.id)?.encryptedAtRest).toBeUndefined();
    expect(asProcess.ok && valid(asProcess.document)).toBe(true);
  });
});
