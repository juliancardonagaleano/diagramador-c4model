// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pretty, type EditorSpec, type GraphLayout } from '@iark/kernel';
import { installFlowMocks } from '../testing-dom';
import { FAKE_DOC, fakeEditor } from '../testing-editor';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

// ELK real salvo cuando una prueba lo hace fallar: el resto del tiempo `layoutGraph` delega en el de verdad.
const elk = vi.hoisted(() => ({ real: undefined as undefined | ((...args: unknown[]) => Promise<unknown>), fail: undefined as undefined | Error }));
vi.mock('@iark/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@iark/kernel')>();
  elk.real = actual.layoutGraph as unknown as (...args: unknown[]) => Promise<unknown>;
  return { ...actual, layoutGraph: (...args: unknown[]) => (elk.fail ? Promise.reject(elk.fail) : elk.real!(...args)) };
});

beforeAll(installFlowMocks);
beforeEach(() => {
  window.localStorage.clear();
  elk.fail = undefined;
});
afterEach(() => vi.useRealTimers());

const spec = fakeEditor as unknown as EditorSpec<unknown>;
const canvas = (): HTMLElement => screen.getByTestId('module-canvas');
const BANNER = 'canvas-layout-error';
const box = (id: string, x: number, y: number) => ({ id, x, y, width: 160, height: 64 });
const LAYOUT: GraphLayout = {
  nodes: [box('api', 20, 40), box('cola', 220, 40), box('worker', 420, 40), box('libre', 20, 240)],
  groups: [box('zona', 0, 0)],
  edges: [],
  width: 600,
  height: 320,
};

// El texto vive en el anfitrión, como en el banco de trabajo: añadir un elemento cambia el documento y, con él, la estructura.
function mount(options: { spec?: EditorSpec<unknown> } = {}) {
  const history = new EditHistory();
  function Host() {
    const [text, setText] = useState(pretty(FAKE_DOC));
    return <DiagramCanvas moduleId="fake" spec={options.spec ?? spec} document={JSON.parse(text) as unknown} text={text} views={[]} onView={vi.fn()} readOnly={false} history={history} onText={setText} notify={vi.fn()} />;
  }
  return render(<Host />);
}

describe('lienzo: un fallo del autolayout no lo deja colgado', () => {
  it('si ELK rechaza al abrir, el lienzo pasa a «ready», dibuja los elementos y avisa en el propio lienzo', async () => {
    elk.fail = new Error('ELK: grafo imposible');
    mount();
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    // Los elementos se dibujan igualmente (en la colocación de reserva) y se pueden usar.
    expect(screen.getByTestId('node-api')).toBeInTheDocument();
    expect(screen.getByTestId('node-worker')).toBeInTheDocument();
    const banner = screen.getByTestId(BANNER);
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('No se pudo calcular la colocación automática');
    expect(banner).toHaveTextContent('Autolayout');
  });

  // Caso real, sin simular nada: ELK lanza «Referenced shape does not exist» con una arista cuyo extremo no está en el grafo.
  it('un grafo con una arista que apunta a un nodo inexistente hace lanzar a ELK de verdad y el lienzo sigue usable', async () => {
    elk.fail = undefined;
    const dangling = {
      ...spec,
      project: (doc: unknown, viewId?: string) => {
        const graph = spec.project(doc, viewId);
        return { ...graph, edges: [...graph.edges, { id: 'colgante', kind: 'sync', source: 'api', target: 'no-existe' }] };
      },
    } as EditorSpec<unknown>;
    mount({ spec: dangling });
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
    expect(screen.getByTestId('node-api')).toBeInTheDocument();
  });

  it('si el autolayout propio del módulo rechaza, ocurre lo mismo', async () => {
    const failing = { ...spec, layout: () => Promise.reject(new Error('colocación propia rota')) } as EditorSpec<unknown>;
    mount({ spec: failing });
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
  });

  it('un lienzo que se coloca bien no muestra ningún aviso', async () => {
    mount();
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('si falla al recolocar tras un cambio de estructura, conserva el dibujo, vuelve a «ready» y avisa', async () => {
    mount();
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    const at = (id: string): string => (screen.getByTestId(`node-${id}`).closest('.react-flow__node') as HTMLElement).style.transform;
    const before = at('api');
    expect(before).toMatch(/translate/);
    elk.fail = new Error('ELK: grafo imposible');
    fireEvent.click(screen.getByTestId('add-queue'));
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
    expect(at('api')).toBe(before); // lo que ya estaba colocado no se mueve
  });

  it('Autolayout reintenta: si ahora funciona, el aviso desaparece', async () => {
    elk.fail = new Error('ELK: grafo imposible');
    mount();
    await waitFor(() => expect(screen.getByTestId(BANNER)).toBeInTheDocument(), { timeout: 5000 });
    elk.fail = undefined;
    fireEvent.click(screen.getByTestId('autolayout'));
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  it('Autolayout que vuelve a fallar también deja el lienzo usable y con el aviso', async () => {
    mount();
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    elk.fail = new Error('ELK: grafo imposible');
    fireEvent.click(screen.getByTestId('autolayout'));
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 5000 });
    expect(screen.getByTestId(BANNER)).toBeInTheDocument();
  });

  it('al cambiar de vista el aviso de la anterior no se arrastra, y una vista que se coloca bien queda «ready» sin aviso', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const flaky = {
      ...spec,
      layout: (_doc: unknown, viewId?: string) => (viewId === 'a' ? Promise.reject(new Error('vista a rota')) : Promise.resolve(LAYOUT)),
    } as EditorSpec<unknown>;
    const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    const host = (viewId: string) => <DiagramCanvas moduleId="fake" spec={flaky} document={FAKE_DOC} text={pretty(FAKE_DOC)} viewId={viewId} views={[]} onView={vi.fn()} readOnly={false} history={new EditHistory()} onText={vi.fn()} notify={vi.fn()} />;

    const view = render(host('a'));
    await advance(0);
    await advance(2000);
    expect(canvas()).toHaveAttribute('data-layout', 'ready');
    expect(screen.getByTestId(BANNER)).toBeInTheDocument();

    view.rerender(host('b'));
    expect(screen.queryByTestId(BANNER)).toBeNull();
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await advance(0);
    await advance(2000);
    expect(canvas()).toHaveAttribute('data-layout', 'ready');
    expect(canvas()).toHaveAttribute('data-view', 'b');
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });

  // Carrera del primer encuadre (PR #37): el fallo de una colocación ya obsoleta no puede dar por colocada la vista nueva.
  it('el fallo de un autolayout obsoleto no da por colocada la vista nueva ni muestra su aviso', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let failA: (error: Error) => void = () => undefined;
    let releaseB: (layout: GraphLayout) => void = () => undefined;
    const slowA = new Promise<GraphLayout>((_, reject) => (failA = reject));
    const slowB = new Promise<GraphLayout>((resolve) => (releaseB = resolve));
    const slow = { ...spec, layout: (_doc: unknown, viewId?: string) => (viewId === 'a' ? slowA : slowB) } as EditorSpec<unknown>;
    const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
    const host = (viewId: string) => <DiagramCanvas moduleId="fake" spec={slow} document={FAKE_DOC} text={pretty(FAKE_DOC)} viewId={viewId} views={[]} onView={vi.fn()} readOnly={false} history={new EditHistory()} onText={vi.fn()} notify={vi.fn()} />;

    const view = render(host('a'));
    await advance(0);
    view.rerender(host('b')); // se cambia de vista con la colocación de «a» aún en vuelo
    failA(new Error('vista a rota')); // ...y ésta falla después
    await advance(0);
    await advance(2000);
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    expect(screen.queryByTestId(BANNER)).toBeNull();
    releaseB(LAYOUT);
    await advance(0);
    await advance(2000);
    expect(canvas()).toHaveAttribute('data-layout', 'ready');
    expect(screen.queryByTestId(BANNER)).toBeNull();
  });
});
