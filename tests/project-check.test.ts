import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkProject, MemoryProjectStore, ModuleRegistry, projectTrace, snapshotProject, type AnyModule, type ProjectStore } from '@iark/kernel';
import { dataModule, enterpriseModule, integrationModule, platformModule, securityModule } from '../src/modules-app/testing';

const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');
const registry = new ModuleRegistry();
for (const module of [integrationModule, dataModule, enterpriseModule, platformModule, securityModule] as AnyModule[]) registry.register(module);

async function suite(): Promise<{ store: ProjectStore; projectId: string }> {
  const store = new MemoryProjectStore();
  const project = await store.createProject({ name: 'Tienda' });
  const add = (module: string, name: string, file: string) => store.saveDiagram(project.id, { module, name, text: example(file) });
  await add('security', 'Amenazas', 'seguridad-ejemplo.json');
  await add('platform', 'Despliegue', 'plataforma-ejemplo.json');
  await add('integration', 'Pedidos', 'pedidos-integracion.json');
  await add('enterprise', 'Empresa', 'empresa-arquitectura.json');
  await add('data', 'Ventas', 'ventas-datos.json');
  return { store, projectId: project.id };
}

describe('comprobación de un proyecto', () => {
  it('los ejemplos de la suite juntos en un proyecto enlazan igual que sueltos, sin problemas', async () => {
    const { store, projectId } = await suite();
    const snapshot = await snapshotProject(store, projectId);
    const check = checkProject(snapshot, registry);
    expect(check.ok).toBe(true);
    expect(check.diagrams.map((d) => d.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(check.graph.problems).toEqual([]);
    expect(check.graph.links).toHaveLength(15);
    expect(check.graph.documents.find((d) => d.module === 'security')?.source).toBe('Amenazas');
  });

  it('dos diagramas del mismo módulo conviven; si repiten un id, la URN se marca ambigua', async () => {
    const { store, projectId } = await suite();
    await store.saveDiagram(projectId, { module: 'integration', name: 'Pedidos (copia)', text: example('pedidos-integracion.json') });
    const snapshot = await snapshotProject(store, projectId);
    const check = checkProject(snapshot, registry);
    expect(check.ok).toBe(false);
    expect(check.brokenRefs).toBeGreaterThan(0);
    const ambiguous = check.graph.problems.filter((p) => p.reason === 'ambiguous');
    expect(ambiguous.length).toBeGreaterThan(0);
    expect(ambiguous[0].message).toMatch(/Pedidos \(copia\)|Pedidos/);
    const trace = projectTrace(snapshot, registry);
    expect(trace.owners.get('urn:iark:integration:pedidos')?.map((d) => d.name).sort()).toEqual(['Pedidos', 'Pedidos (copia)']);
    expect(trace.owners.get('urn:iark:platform:pedidos')?.map((d) => d.name)).toEqual(['Despliegue']);
  });

  it('una referencia a un elemento que ya no existe rompe el proyecto; a un módulo sin diagrama es solo un aviso', async () => {
    const { store, projectId } = await suite();
    let snapshot = await snapshotProject(store, projectId);
    const platform = snapshot.diagrams.find((d) => d.module === 'platform')!;
    await store.saveDiagram(projectId, { id: platform.id, text: platform.text.replace('"urn:iark:integration:pedidos"', '"urn:iark:integration:no-existe"') });
    snapshot = await snapshotProject(store, projectId);
    const broken = checkProject(snapshot, registry);
    expect(broken.ok).toBe(false);
    expect(broken.graph.problems.some((p) => p.reason === 'dangling' && p.ref === 'urn:iark:integration:no-existe')).toBe(true);

    // quitar un diagrama entero: las referencias a su módulo quedan sin resolver (aviso), no rotas
    const { store: store2, projectId: id2 } = await suite();
    const snap2 = await snapshotProject(store2, id2);
    await store2.deleteDiagram(id2, snap2.diagrams.find((d) => d.module === 'platform')!.id);
    const lean = checkProject(await snapshotProject(store2, id2), registry);
    expect(lean.graph.problems.some((p) => p.reason === 'unresolved')).toBe(true);
    expect(lean.brokenRefs).toBe(0);
    expect(lean.ok).toBe(true);
  });

  it('un diagrama inválido o de un módulo desconocido se deja fuera del grafo y se informa', async () => {
    const { store, projectId } = await suite();
    await store.saveDiagram(projectId, { module: 'data', name: 'A medias', text: '{ "workspace": ' });
    await store.saveDiagram(projectId, { module: 'data', name: 'Mal esquema', text: '{"workspace": 1}' });
    await store.saveDiagram(projectId, { module: 'vacio', name: 'Vacío', text: '' });
    await store.saveDiagram(projectId, { module: 'otro', name: 'Del futuro', text: '{}' });
    const snapshot = await snapshotProject(store, projectId);
    const check = checkProject(snapshot, registry);
    const byName = Object.fromEntries(check.diagrams.map((d) => [d.name, d.status]));
    expect(byName).toMatchObject({ 'A medias': 'syntax', 'Mal esquema': 'schema', Vacío: 'unknown-module', 'Del futuro': 'unknown-module', Ventas: 'ok' });
    expect(check.ok).toBe(false);
    expect(check.diagrams.find((d) => d.name === 'A medias')?.detail).toMatch(/JSON válido/);
    expect(projectTrace(snapshot, registry).skipped.map((d) => d.name).sort()).toEqual(['A medias', 'Del futuro', 'Mal esquema', 'Vacío']);
  });
});
