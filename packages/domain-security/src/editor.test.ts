import { describe, expect, it } from 'vitest';
import example from '../../../examples/seguridad-ejemplo.json';
import { securityEditor } from './editor';
import { analyzeSecurity } from './issues';
import { securityModule } from './module';
import { standardsCoverage } from './modeling';
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

  describe('rondas de seguridad', () => {
    const action = (id: string) => securityEditor.actions!.find((a) => a.id === id)!;
    const run = (d: SecurityDocument, id: string, ids: string[] = []): SecurityDocument => {
      const r = action(id).run(d, ids);
      if (!r.ok) throw new Error(r.reason);
      return r.document;
    };

    it('S1: las zonas cruzadas llevan borde discontinuo rojo y los flujos que cruzan, marcador', () => {
      const g = securityEditor.project(doc, 'dfd');
      const internet = g.nodes.find((n) => n.id === 'internet')!;
      expect(internet).toMatchObject({ stroke: '#c92a2a', dashed: true });
      expect(internet.label).toContain('no confiable');
      expect(internet.label).toContain('frontera de confianza');
      const cross = g.edges.find((e) => e.id === 'cliente-navega')!;
      expect(cross.marks?.[0].title).toContain('Cruza frontera de confianza');
      expect(g.edges.find((e) => e.id === 'web-a-pedidos')?.marks).toBeUndefined();
    });

    it('S2: sugerir amenazas propone STRIDE por tipo y cruce, sin repetir lo modelado, y se aceptan o descartan', () => {
      const withSuggestions = run(doc, 'suggest-threats');
      const added = withSuggestions.threats.filter((t) => t.suggested);
      expect(added.length).toBeGreaterThan(0);
      expect(valid(withSuggestions)).toBe(true);
      expect(added.every((t) => !doc.threats.some((o) => o.targetId === t.targetId && o.category === t.category))).toBe(true);
      expect(added.some((t) => t.targetId === 'cliente' && t.category === 'spoofing')).toBe(false);
      expect(added.filter((t) => t.targetId === 'cliente').every((t) => ['spoofing', 'repudiation'].includes(t.category))).toBe(true);
      expect(added.every((t) => t.targetId !== 'web-a-pedidos')).toBe(true);
      const [first, second] = added;
      const accepted = run(withSuggestions, 'accept-suggestion', [first.id]);
      expect(accepted.threats.find((t) => t.id === first.id)?.suggested).toBeUndefined();
      const discarded = run(accepted, 'discard-suggestion', [second.id, first.id]);
      expect(discarded.threats.some((t) => t.id === second.id)).toBe(false);
      expect(discarded.threats.some((t) => t.id === first.id)).toBe(true);
      expect(action('discard-suggestion').disabled!(discarded, [first.id])).toMatch(/sugerida/);
      expect(securityEditor.project(withSuggestions, 'threats').nodes.find((n) => n.id === first.id)?.badges).toContain('sugerida');
    });

    it('S3: el estándar del control es opcional, se edita y avisa de los controles que faltan en la cobertura', () => {
      const id = doc.controls[0].id;
      const edited = securityEditor.update(doc, id, { standard: 'asvs' });
      if (!edited.ok) throw new Error(edited.reason);
      expect(valid(edited.document)).toBe(true);
      expect(securityEditor.project(edited.document, 'threats').nodes.find((n) => n.id === id)?.badges).toContain('OWASP ASVS');
      expect(standardsCoverage(edited.document)[0]).toMatchObject({ standard: 'asvs', controls: 1 });
      expect(analyzeSecurity(edited.document).some((i) => /estándar/.test(i.message))).toBe(true);
      expect(analyzeSecurity(doc).some((i) => /estándar/.test(i.message))).toBe(false);
    });

    it('S5: reglas de conexión', () => {
      expect(securityEditor.canConnect!(doc, 'flow', 'cliente', 'pedidos-db')).toMatch(/almacén/);
      expect(securityEditor.canConnect!(doc, 'flow', 'pedidos-db', 'proveedor-correo')).toMatch(/almacén/);
      const ingress = securityEditor.addEdge(doc, 'flow', 'proveedor-correo', 'notificaciones');
      if (!ingress.ok) throw new Error(ingress.reason);
      expect(ingress.document.flows.find((f) => f.id === ingress.id)?.authentication).toBe('token');
      expect(securityEditor.update(ingress.document, ingress.id!, { authentication: 'none' })).toMatchObject({ ok: false });
      expect(securityEditor.update(ingress.document, ingress.id!, { authentication: 'mtls' }).ok).toBe(true);
      expect(securityEditor.canConnect!(doc, 'threat', 'exfiltracion-db', 'internet')).toBeDefined();
    });

    it('S6: proteger flujo cifra, autentica y añade control; mitigar amenaza crea y enlaza el control', () => {
      const plain = run(doc, 'protect-flow', ['notificaciones-a-correo']);
      expect(plain.flows.find((f) => f.id === 'notificaciones-a-correo')).toMatchObject({ encrypted: true });
      expect(plain.controls.length).toBe(doc.controls.length + 1);
      expect(valid(plain)).toBe(true);
      expect(action('protect-flow').disabled!(doc, ['cliente'])).toMatch(/flujo/);
      const threat = doc.threats[0];
      const mitigated = run(doc, 'mitigate-threat', [threat.id]);
      const t = mitigated.threats.find((x) => x.id === threat.id)!;
      expect(t.controlIds?.length).toBe((threat.controlIds?.length ?? 0) + 1);
      expect(mitigated.controls.length).toBe(doc.controls.length + 1);
      expect(valid(mitigated)).toBe(true);
    });
  });
});
