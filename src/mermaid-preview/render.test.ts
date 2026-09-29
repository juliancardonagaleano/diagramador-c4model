// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 320.4 180" style="max-width: 320.4px"><g/></svg>';

/** Mermaid simulado: cuenta cuántas veces se inicializa y cuántos dibujos hay a la vez. */
function fakeMermaid() {
  const state = { initialize: vi.fn(), active: 0, maxActive: 0, render: vi.fn() };
  state.render.mockImplementation(async (id: string, text: string) => {
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    state.active -= 1;
    if (text.includes('MAL')) throw new Error('Parse error on line 2:\n...--> b[[\n-----------^\nExpecting SQE, got EOF');
    return { svg: SVG.replace('<g/>', `<g id="${id}"/>`) };
  });
  return state;
}

/** Módulo `render` recién cargado (el estado de carga es del módulo) con el Mermaid simulado. */
async function load(mermaid: ReturnType<typeof fakeMermaid>) {
  vi.resetModules();
  vi.doMock('mermaid', () => ({ default: { initialize: mermaid.initialize, render: mermaid.render } }));
  return import('./render');
}

describe('renderMermaid', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.doUnmock('mermaid');
  });

  it('carga la librería la primera vez, la configura una sola vez y devuelve el SVG con su tamaño', async () => {
    const mermaid = fakeMermaid();
    const { renderMermaid } = await load(mermaid);
    expect(mermaid.initialize).not.toHaveBeenCalled();

    const first = await renderMermaid('flowchart LR\n a --> b');
    const second = await renderMermaid('flowchart LR\n b --> c');
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false }));
    expect(first).toMatchObject({ ok: true, width: 321, height: 180 });
    expect(first.ok && first.svg.startsWith('<svg')).toBe(true);
    expect(second.ok && first.ok && second.svg !== first.svg).toBe(true); // ids de dibujo distintos
  });

  it('serializa los dibujos: nunca hay dos a la vez', async () => {
    const mermaid = fakeMermaid();
    const { renderMermaid } = await load(mermaid);
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((n) => renderMermaid(`flowchart LR\n ${n} --> x`)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(mermaid.render).toHaveBeenCalledTimes(4);
    expect(mermaid.maxActive).toBe(1);
  });

  it('un texto vacío no carga la librería', async () => {
    const mermaid = fakeMermaid();
    const { renderMermaid } = await load(mermaid);
    expect(await renderMermaid('  \n ')).toEqual({ ok: false, message: 'No hay texto de Mermaid que dibujar.' });
    expect(mermaid.initialize).not.toHaveBeenCalled();
  });

  it('un error de sintaxis se devuelve con el fragmento que señala Mermaid, limpia el documento y no rompe el siguiente dibujo', async () => {
    const mermaid = fakeMermaid();
    const { renderMermaid } = await load(mermaid);
    const stray = document.createElement('div');
    stray.id = 'diark-mermaid-1'; // el contenedor temporal que Mermaid puede dejar tras fallar
    document.body.append(stray);

    const bad = await renderMermaid('flowchart LR\n MAL');
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.message).toContain('Parse error on line 2');
    expect(!bad.ok && bad.message).toContain('-----------^');
    expect(document.getElementById('diark-mermaid-1')).toBeNull();

    expect((await renderMermaid('flowchart LR\n a --> b')).ok).toBe(true);
  });

  it('si la librería no se puede cargar lo dice y el siguiente intento vuelve a probar', async () => {
    const mermaid = fakeMermaid();
    mermaid.initialize.mockImplementationOnce(() => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const { renderMermaid } = await load(mermaid);

    const down = await renderMermaid('flowchart LR\n a --> b');
    expect(!down.ok && down.message).toBe('No se pudo cargar la librería de Mermaid: Failed to fetch dynamically imported module');
    expect((await renderMermaid('flowchart LR\n a --> b')).ok).toBe(true);
    expect(mermaid.initialize).toHaveBeenCalledTimes(2);
  });
});

describe('svgSize', () => {
  it('toma el tamaño del viewBox y, sin él, uno por defecto', async () => {
    const { svgSize } = await load(fakeMermaid());
    expect(svgSize('<svg viewBox="4 4 1529.2 936.34">')).toEqual({ width: 1530, height: 937 });
    expect(svgSize('<svg viewBox="0,0,100,50">')).toEqual({ width: 100, height: 50 });
    expect(svgSize('<svg width="100%">')).toEqual({ width: 640, height: 360 });
  });
});

describe('wellFormedSvg', () => {
  it('deja intacto un SVG válido', async () => {
    const { wellFormedSvg } = await load(fakeMermaid());
    expect(wellFormedSvg(SVG)).toBe(SVG);
  });

  it('corrige el HTML suelto de un foreignObject para que el <img> lo acepte', async () => {
    const { wellFormedSvg } = await load(fakeMermaid());
    const broken = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>a<br>b</p></div></foreignObject></svg>';
    expect(new DOMParser().parseFromString(broken, 'image/svg+xml').querySelector('parsererror')).not.toBeNull();
    const fixed = wellFormedSvg(broken);
    expect(new DOMParser().parseFromString(fixed, 'image/svg+xml').querySelector('parsererror')).toBeNull();
    expect(fixed).toContain('foreignObject');
    expect(fixed).toMatch(/<br[^>]*\/>/);
  });
});
