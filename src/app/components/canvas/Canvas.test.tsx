// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { installFlowMocks } from '../../../modules-app/testing-dom';
import { useDocumentStore } from '../../store/documentStore';
import { Breadcrumb } from '../header/Breadcrumb';
import { FloatingToolbar } from '../header/FloatingToolbar';
import { Canvas } from './Canvas';

beforeAll(installFlowMocks);

beforeEach(() => {
  window.localStorage.clear();
  // El ejemplo no trae posiciones: cada vista se coloca con ELK la primera vez que se abre.
  useDocumentStore.getState().loadSample();
  useDocumentStore.setState({ layoutBusy: false });
});

const canvas = (): HTMLElement => screen.getByTestId('c4-canvas');
const mount = (withToolbar = false) =>
  render(
    <ReactFlowProvider>
      <Canvas />
      {withToolbar && <FloatingToolbar />}
      {withToolbar && <Breadcrumb />}
    </ReactFlowProvider>,
  );
/** ELK más el encuadre: sobre todo en un equipo cargado, la primera colocación tarda. */
const READY = { timeout: 20000 };
const ready = () => waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), READY);

describe('lienzo asentado', () => {
  it('está pendiente mientras ELK coloca la vista y pasa a «ready» cuando termina de colocarla y encuadrarla', async () => {
    mount();
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    expect(canvas()).toHaveAttribute('data-view', 'contexto');
    await ready();
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(4);
    expect(useDocumentStore.getState().layoutBusy).toBe(false);
  }, 60000);

  it('cambiar a una vista sin colocar lo devuelve a pendiente en el mismo render, sin esperar a ELK, y vuelve a «ready» al colocarla', async () => {
    mount();
    await ready();
    act(() => useDocumentStore.getState().setActiveView('contenedores'));
    expect(canvas()).toHaveAttribute('data-view', 'contenedores');
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await ready();
    expect(document.querySelectorAll('.react-flow__node').length).toBeGreaterThan(4);
  }, 60000);

  it('volver a una vista que ya estaba colocada no necesita ELK: queda «ready» sin recolocar', async () => {
    mount();
    await ready();
    act(() => useDocumentStore.getState().setActiveView('contenedores'));
    await ready();
    act(() => useDocumentStore.getState().setActiveView('contexto'));
    expect(canvas()).toHaveAttribute('data-view', 'contexto');
    expect(useDocumentStore.getState().layoutBusy).toBe(false);
    await waitFor(() => expect(canvas()).toHaveAttribute('data-layout', 'ready'), { timeout: 2000 });
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(4);
  }, 60000);

  it('un cambio de estructura (añadir un elemento sin posición a la vista) la devuelve a pendiente y vuelve a «ready» al recolocar', async () => {
    mount();
    await ready();
    act(() => {
      const state = useDocumentStore.getState();
      const view = state.doc.views.find((v) => v.id === 'contexto')!;
      state.removeElementFromView(view.id, 'cliente');
    });
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node')).toHaveLength(3), READY);
    await ready();
    // Vuelve sin posición y al final de la lista, así que la estructura es otra que la de la primera colocación.
    act(() => useDocumentStore.getState().addElementToView('contexto', 'cliente'));
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await ready();
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(4);
  }, 60000);

  it('editar un texto que no cambia la estructura no la saca de «ready»', async () => {
    mount();
    await ready();
    act(() => useDocumentStore.getState().updateElement('cliente', { name: 'Otro nombre' }));
    expect(canvas()).toHaveAttribute('data-layout', 'ready');
    expect(screen.getByText('Otro nombre')).toBeInTheDocument();
  }, 60000);

  it('un autolayout pedido al almacén la devuelve a pendiente hasta que ELK termina de recolocar', async () => {
    mount();
    await ready();
    act(() => {
      void useDocumentStore.getState().runAutoLayout(undefined, { force: true });
    });
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await ready();
    expect(useDocumentStore.getState().layoutBusy).toBe(false);
  }, 60000);

  it('el botón Autolayout de la barra la deja pendiente desde el mismo clic, antes de que ELK devuelva nada, y vuelve a «ready» al recolocar y encuadrar', async () => {
    mount(true);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Autolayout' }));
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await ready();
    expect(useDocumentStore.getState().layoutBusy).toBe(false);
  }, 60000);

  it('doble clic en un nodo para bajar de nivel: ya pendiente en el render que muestra la vista nueva, incluso si esa vista estaba colocada', async () => {
    mount();
    await ready();
    // Se coloca antes la vista de contenedores, para que bajar a ella no dependa de ELK sino solo del encuadre.
    act(() => useDocumentStore.getState().setActiveView('contenedores'));
    await ready();
    act(() => useDocumentStore.getState().setActiveView('contexto'));
    await ready();

    fireEvent.doubleClick(document.querySelector('.react-flow__node[data-id="banca"]') as HTMLElement);
    expect(canvas()).toHaveAttribute('data-view', 'contenedores');
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await ready();
    expect(canvas()).toHaveAttribute('data-view', 'contenedores');
  }, 60000);

  it('«Subir nivel» del Breadcrumb: pendiente en el render que muestra la vista de arriba, aunque ya estuviera colocada, hasta que acaba el encuadre', async () => {
    mount(true);
    await ready();
    act(() => useDocumentStore.getState().setActiveView('contenedores'));
    await ready();
    expect(canvas()).toHaveAttribute('data-view', 'contenedores');

    fireEvent.click(screen.getByRole('button', { name: 'Subir nivel' }));
    expect(canvas()).toHaveAttribute('data-view', 'contexto');
    expect(canvas()).toHaveAttribute('data-layout', 'pending');
    await ready();
    expect(canvas()).toHaveAttribute('data-view', 'contexto');
  }, 60000);

  it('una vista vacía (p. ej. tras «Nuevo diagrama») también termina «ready»: no queda esperando un encuadre que nunca llega', async () => {
    useDocumentStore.getState().newDocument();
    mount();
    await ready();
    expect(document.querySelectorAll('.react-flow__node')).toHaveLength(0);
  }, 60000);

  it('sin ninguna vista no hay nada que esperar: se publica «ready» y sin vista', () => {
    useDocumentStore.setState({ activeViewId: null });
    mount();
    expect(canvas()).toHaveAttribute('data-layout', 'ready');
    expect(canvas()).toHaveAttribute('data-view', '');
  });
});
