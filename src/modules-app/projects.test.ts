import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryProjectStore } from '@iark/kernel';
import { ProjectSession } from '../projects/session';
import { WorkbenchController, type DraftStorage } from './controller';
import { SuiteLinks } from './links';
import { example, SOURCES } from './testing';

const drafts = (): DraftStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, read: (id) => map.get(id) ?? null, write: (id, text) => void map.set(id, text) };
};

async function setup() {
  const store = new MemoryProjectStore();
  const session = new ProjectSession(store, { debounceMs: 20, broadcast: false, persist: false });
  await session.init();
  const storage = drafts();
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0, storage, projects: session });
  return { store, session, storage, controller };
}

const wait = (ms = 60): Promise<void> => new Promise((r) => setTimeout(r, ms));
const edit = (text: string, key: string, value: string): string => {
  const doc = JSON.parse(text) as Record<string, unknown>;
  (doc.workspace as Record<string, unknown>)[key] = value;
  return JSON.stringify(doc, null, 2);
};

describe('banco de trabajo con proyectos', () => {
  it('abrir un diagrama lo carga en su módulo y sus ediciones se guardan en el proyecto, no en el borrador', async () => {
    const { store, session, storage, controller } = await setup();
    const project = await session.createProject('Tienda');
    const meta = await session.createDiagram({ module: 'integration', name: 'Pedidos', text: example('pedidos-integracion.json') });
    await controller.openDiagram(project.id, meta.id);
    const state = controller.getState();
    expect(state).toMatchObject({ moduleId: 'integration', modified: false });
    expect(state.analysis.status).toBe('ok');
    expect(session.getState()).toMatchObject({ projectId: project.id, diagramId: meta.id });

    controller.setText(edit(state.text, 'name', 'Pedidos v2'));
    await wait();
    const saved = await store.getDiagram(project.id, meta.id);
    expect(JSON.parse(saved!.text).workspace.name).toBe('Pedidos v2');
    expect(storage.map.size).toBe(0); // el borrador del módulo no se toca
    expect(session.getState().save).toBe('saved');
  });

  it('sin diagrama abierto, el documento sigue siendo un borrador del módulo (como antes de los proyectos)', async () => {
    const { session, storage, controller } = await setup();
    await controller.selectModule('data');
    controller.setText(edit(controller.getState().text, 'name', 'Borrador'));
    expect(storage.map.get('data')).toContain('Borrador');
    expect(session.getState().save).toBe('idle');
  });

  it('cambiar de módulo con un proyecto abierto va a su diagrama más reciente de ese módulo, y sin ninguno queda un borrador', async () => {
    const { store, session, storage, controller } = await setup();
    const project = await session.createProject('Tienda');
    await session.createDiagram({ module: 'data', name: 'Viejo', text: example('ventas-datos.json') });
    await new Promise((r) => setTimeout(r, 5));
    const recent = await session.createDiagram({ module: 'data', name: 'Reciente', text: edit(example('ventas-datos.json'), 'name', 'Reciente') });
    const integration = await session.createDiagram({ module: 'integration', name: 'Pedidos', text: example('pedidos-integracion.json') });
    await controller.openDiagram(project.id, integration.id);

    await controller.selectModule('data');
    expect(session.getState().diagramId).toBe(recent.id);
    expect(JSON.parse(controller.getState().text).workspace.name).toBe('Reciente');

    // un módulo sin diagramas en el proyecto: se suelta el diagrama y queda el borrador del módulo
    await controller.selectModule('security');
    expect(session.getState()).toMatchObject({ projectId: project.id, diagramId: undefined });
    expect(controller.getState().moduleId).toBe('security');
    controller.setText(edit(controller.getState().text, 'name', 'Sin guardar'));
    expect(storage.map.get('security')).toContain('Sin guardar');
    expect((await store.getProject(project.id))!.diagrams).toHaveLength(3);

    // guardarlo en el proyecto lo convierte en un diagrama que se guarda solo
    await controller.saveToProject();
    expect(session.getState().diagramId).toBeDefined();
    expect((await store.getProject(project.id))!.diagrams.map((d) => d.module).sort()).toEqual(['data', 'data', 'integration', 'security']);
    controller.setText(edit(controller.getState().text, 'name', 'Ya guardado'));
    await wait();
    const stored = await store.getDiagram(project.id, session.getState().diagramId!);
    expect(JSON.parse(stored!.text).workspace.name).toBe('Ya guardado');
  });

  it('lo pendiente se guarda antes de cambiar de módulo (no se pierde la última edición)', async () => {
    const { store, session, controller } = await setup();
    const project = await session.createProject('Tienda');
    const a = await session.createDiagram({ module: 'integration', name: 'Pedidos', text: example('pedidos-integracion.json') });
    await session.createDiagram({ module: 'data', name: 'Ventas', text: example('ventas-datos.json') });
    await controller.openDiagram(project.id, a.id);
    controller.setText(edit(controller.getState().text, 'name', 'Último cambio'));
    await controller.selectModule('data'); // sin esperar al guardado automático
    expect(JSON.parse((await store.getDiagram(project.id, a.id))!.text).workspace.name).toBe('Último cambio');
  });

  it('enterProject entra en el diagrama más reciente y al salir vuelve el borrador del módulo', async () => {
    const { session, storage, controller } = await setup();
    const project = await session.createProject('Tienda');
    await session.createDiagram({ module: 'enterprise', name: 'Empresa', text: example('empresa-arquitectura.json') });
    session.selectProject(undefined);
    storage.map.set('enterprise', edit(example('empresa-arquitectura.json'), 'name', 'Mi borrador'));
    await controller.selectModule('enterprise');
    expect(JSON.parse(controller.getState().text).workspace.name).toBe('Mi borrador');

    await controller.enterProject(project.id);
    expect(session.getState().diagramId).toBeDefined();
    expect(controller.getState().text).toBe(example('empresa-arquitectura.json'));

    await controller.enterProject(undefined);
    expect(session.getState()).toMatchObject({ projectId: undefined, diagramId: undefined });
    expect(JSON.parse(controller.getState().text).workspace.name).toBe('Mi borrador');
  });

  it('reemplazar un diagrama guardado (ejemplo, importación) se puede deshacer', async () => {
    const { store, session, controller } = await setup();
    const project = await session.createProject('Tienda');
    const mine = edit(example('ventas-datos.json'), 'name', 'Mi trabajo');
    const meta = await session.createDiagram({ module: 'data', name: 'Ventas', text: mine });
    await controller.openDiagram(project.id, meta.id);
    await controller.loadExample();
    expect(controller.getState().text).toBe(example('ventas-datos.json'));
    expect(controller.getState().replaced).toMatchObject({ label: 'Ventas', text: mine });
    controller.undoReplace();
    expect(controller.getState().text).toBe(mine);
    expect(controller.getState().replaced).toBeUndefined();
    await wait();
    expect((await store.getDiagram(project.id, meta.id))!.text).toBe(mine);
    // editar después descarta la posibilidad de deshacer
    await controller.loadExample();
    expect(controller.getState().replaced).toBeDefined();
    controller.setText(edit(controller.getState().text, 'name', 'Otra cosa'));
    expect(controller.getState().replaced).toBeUndefined();
  });

  it('un diagrama de un módulo que el banco no ofrece da un error claro y no queda adjunto', async () => {
    const { session, controller } = await setup();
    const project = await session.createProject('Tienda');
    const meta = await session.createDiagram({ module: 'futuro', name: 'Del futuro', text: '{}' });
    await session.refresh();
    session.detach();
    await controller.openDiagram(project.id, meta.id);
    expect(controller.getState().error).toMatch(/módulo «futuro»/);
    expect(session.getState().diagramId).toBeUndefined();
  });

  describe('enlaces entre diagramas del proyecto', () => {
    beforeEach(() => vi.useRealTimers());
    afterEach(() => vi.useRealTimers());

    it('con un proyecto abierto, los enlaces se resuelven con sus diagramas (varios por módulo), no con los borradores', async () => {
      const { session, storage, controller } = await setup();
      storage.map.set('platform', 'borrador que no cuenta');
      const project = await session.createProject('Tienda');
      await session.createDiagram({ module: 'security', name: 'Amenazas', text: example('seguridad-ejemplo.json') });
      await session.createDiagram({ module: 'platform', name: 'Despliegue', text: example('plataforma-ejemplo.json') });
      const a = await session.createDiagram({ module: 'integration', name: 'Pedidos', text: example('pedidos-integracion.json') });
      await session.createDiagram({ module: 'integration', name: 'Pedidos (copia)', text: example('pedidos-integracion.json') });
      await controller.openDiagram(project.id, a.id);

      const links = new SuiteLinks(controller);
      const docs = await controller.suiteDocuments();
      expect(docs.map((d) => d.label).sort()).toEqual(['Amenazas', 'Despliegue', 'Pedidos', 'Pedidos (copia)']);
      expect(await links.exists('urn:iark:platform:pedidos')).toBe(true);
      expect(await links.exists('urn:iark:data:erp')).toBe(false); // el proyecto no tiene diagrama de datos
      const owners = await links.owners('urn:iark:integration:pedidos');
      expect(owners.map((o) => o.label)).toEqual(['Pedidos', 'Pedidos (copia)']);
      expect(owners.every((o) => !!o.diagramId)).toBe(true);
      expect((await links.owners('urn:iark:platform:pedidos')).map((o) => o.label)).toEqual(['Despliegue']);
      expect((await links.backlinks('integration', 'pedidos')).map((b) => `${b.moduleId}:${b.elementId}`)).toEqual(['platform:pedidos']);
      // los elementos de un módulo no se repiten aunque haya dos diagramas con los mismos ids
      const entities = await links.entities('integration');
      expect(new Set(entities.map((e) => e.id)).size).toBe(entities.length);
    }, 30000);

    it('usa el texto vivo del diagrama que se edita, y el guardado del resto cuando no está abierto', async () => {
      const { session, controller } = await setup();
      const project = await session.createProject('Tienda');
      await session.createDiagram({ module: 'platform', name: 'Despliegue', text: example('plataforma-ejemplo.json') });
      const integ = await session.createDiagram({ module: 'integration', name: 'Pedidos', text: example('pedidos-integracion.json') });
      await controller.openDiagram(project.id, integ.id);
      const links = new SuiteLinks(controller);
      expect(await links.exists('urn:iark:integration:pedidos')).toBe(true);
      // se renombra el id del elemento en el editor sin esperar a guardar: el grafo ya lo ve
      controller.setText(controller.getState().text.replaceAll('"pedidos"', '"pedidos-nuevo"'));
      expect(await links.exists('urn:iark:integration:pedidos-nuevo')).toBe(true);
      expect(await links.exists('urn:iark:integration:pedidos')).toBe(false);
    }, 30000);
  });
});
