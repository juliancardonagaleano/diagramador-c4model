// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toDrawio } from '@core/export/drawio/toDrawio';
import { useDocumentStore } from '../store/documentStore';
import { useActions } from './useActions';

// El autolayout de la exportación (`autoLayoutDocument`, que coloca las vistas sin abrir) se retiene hasta que la prueba lo
// suelta: así se puede editar el documento mientras la exportación espera a ELK, que es la ventana del fallo.
const gate = vi.hoisted(() => ({ hold: undefined as Promise<void> | undefined }));
vi.mock('@core/layout/elkLayout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/layout/elkLayout')>();
  return {
    ...actual,
    autoLayoutDocument: async (...args: Parameters<typeof actual.autoLayoutDocument>) => {
      await gate.hold;
      return actual.autoLayoutDocument(...args);
    },
  };
});
const downloads = vi.hoisted(() => [] as Array<{ name: string; xml: string }>);
vi.mock('../utils/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/files')>()),
  downloadText: (name: string, xml: string) => void downloads.push({ name, xml }),
}));

const store = useDocumentStore;
const doc = () => store.getState().doc;
const history = () => store.temporal.getState();
const placed = (v: { elements: Array<{ x?: number; y?: number }> }): boolean => v.elements.every((e) => typeof e.x === 'number' && typeof e.y === 'number');

beforeEach(() => {
  window.localStorage.clear();
  downloads.length = 0;
  store.getState().loadSample();
  store.setState({ layoutBusy: false, modified: false });
  history().clear();
  history().resume();
});
afterEach(() => {
  gate.hold = undefined;
});

/** Arranca la exportación con el autolayout retenido; `release()` lo suelta y `done` espera a que la exportación termine. */
function startExport() {
  let release: () => void = () => undefined;
  gate.hold = new Promise<void>((resolve) => (release = resolve));
  const { result } = renderHook(() => useActions());
  let done: Promise<void> = Promise.resolve();
  act(() => {
    done = result.current.exportDrawio();
  });
  return { release, done: () => act(async () => done) };
}

describe('exportar a .drawio: lo que se edita mientras la exportación espera a ELK', () => {
  // `exportDrawio` tomaba `doc` antes del `await` del autolayout y después escribía el `laid` completo (calculado a partir de
  // ese `doc`) sobre el store: una edición hecha en la espera (p. ej. renombrar un elemento) se revertía en silencio y,
  // como la exportación no marca `modified`, el usuario no se enteraba.
  it('una edición hecha durante la espera sigue ahí tras exportar', async () => {
    expect(doc().views.some((v) => !placed(v))).toBe(true); // el ejemplo trae vistas sin colocar: la exportación las guarda
    const { release, done } = startExport();

    act(() => store.getState().updateElement('cliente', { name: 'Cliente renombrado' }));
    expect(store.getState().modified).toBe(true);
    release();
    await done();

    expect(downloads).toHaveLength(1);
    expect(doc().model.elements.find((e) => e.id === 'cliente')?.name).toBe('Cliente renombrado');
    expect(store.getState().modified).toBe(true); // la marca de la edición del usuario no se pierde
  }, 60000);

  it('una vista que el usuario editó durante la espera tampoco se pisa con la colocación calculada', async () => {
    const { release, done } = startExport();
    const view = doc().views[0]!;
    act(() => store.getState().updateView(view.id, { title: 'Vista renombrada' }));
    release();
    await done();

    expect(doc().views.find((v) => v.id === view.id)?.title).toBe('Vista renombrada');
    expect(downloads).toHaveLength(1);
  }, 60000);

  it('las posiciones calculadas se guardan igualmente en el documento actual (con la edición incluida)', async () => {
    const { release, done } = startExport();
    act(() => store.getState().updateElement('cliente', { name: 'Cliente renombrado' }));
    release();
    await done();

    expect(doc().views.every(placed)).toBe(true);
    expect(doc().model.elements.find((e) => e.id === 'cliente')?.name).toBe('Cliente renombrado');
  }, 60000);

  it('la descarga sale con las posiciones nuevas y exportar no es una edición (sin «Cambios sin guardar» ni paso de deshacer)', async () => {
    const { release, done } = startExport();
    act(() => store.getState().select({ kind: 'element', id: 'cliente' }));
    release();
    await done();

    expect(downloads).toHaveLength(1);
    expect(downloads[0]!.name).toMatch(/\.drawio$/);
    const first = doc().views[0]!;
    const xml = downloads[0]!.xml;
    for (const e of first.elements) expect(xml).toContain(`<mxGeometry x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" as="geometry"/>`);
    const sinFecha = (x: string) => x.replace(/modified="[^"]*"/, ''); // la cabecera lleva la hora de la exportación
    expect(sinFecha(xml)).toBe(sinFecha(toDrawio(doc(), { notation: 'c4' })));
    expect(store.getState().modified).toBe(false);
    expect(store.getState().selection).toEqual({ kind: 'element', id: 'cliente' }); // no deselecciona
    expect(history().pastStates).toHaveLength(0);
    expect(history().isTracking).toBe(true);
  }, 60000);
});
