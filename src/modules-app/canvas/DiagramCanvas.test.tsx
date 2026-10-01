// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pretty, type EditorSpec } from '@iark/kernel';
import { installFlowMocks, pickNode, pressKey } from '../testing-dom';
import { FAKE_DOC, fakeEditor, type FakeDoc } from '../testing-editor';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

beforeAll(installFlowMocks);

const spec = fakeEditor as unknown as EditorSpec<unknown>;

interface Harness {
  history: EditHistory;
  notify: ReturnType<typeof vi.fn>;
  onOpenAttachment: ReturnType<typeof vi.fn>;
  doc(): FakeDoc;
}

function mount(options: { doc?: FakeDoc | undefined; readOnly?: boolean } = {}): Harness {
  const history = new EditHistory();
  const notify = vi.fn();
  const onOpenAttachment = vi.fn();
  let current = JSON.stringify('doc' in options ? options.doc : FAKE_DOC);
  function Host() {
    const [text, setText] = useState(pretty('doc' in options ? options.doc : FAKE_DOC));
    current = text;
    return (
      <DiagramCanvas
        moduleId="fake"
        spec={spec}
        document={'doc' in options && options.doc === undefined ? undefined : (JSON.parse(text) as unknown)}
        text={text}
        views={[]}
        onView={vi.fn()}
        readOnly={options.readOnly ?? false}
        history={history}
        onText={setText}
        notify={notify}
        onOpenAttachment={onOpenAttachment}
      />
    );
  }
  render(<Host />);
  return { history, notify, onOpenAttachment, doc: () => JSON.parse(current) as FakeDoc };
}

const ready = async (): Promise<void> => {
  await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('edge-label-api-cola')).toBeInTheDocument(), { timeout: 5000 });
};

beforeEach(() => window.localStorage.clear());

describe('aristas con insignias', () => {
  it('dibujan el número de paso y el icono del patrón sobre la línea, con su título accesible', async () => {
    mount();
    await ready();
    const label = screen.getByTestId('edge-label-api-cola');
    expect(within(label).getByTitle('Paso 1')).toHaveTextContent('1');
    expect(within(label).getByRole('img', { name: 'Patrón saga' })).toHaveAttribute('title', 'Patrón saga');
    expect(within(screen.getByTestId('edge-label-cola-worker')).getByTitle('Paso 2')).toHaveTextContent('2');
    expect(label.querySelectorAll('.cv-mark')).toHaveLength(2);
  });

  it('el estilo de la notación llega a la línea (guiones y flecha) aunque no haya etiqueta de texto', async () => {
    mount();
    await ready();
    const path = document.querySelector('.react-flow__edge[data-id="api-cola"] .react-flow__edge-path') as SVGPathElement;
    expect(path.style.strokeDasharray).toBe('6 4');
    expect(path.getAttribute('marker-end')).toContain('arrowclosed');
    expect(screen.getByTestId('edge-label-api-cola').querySelector('.cv-edge-text')).toBeNull();
  });

  it('pulsar la etiqueta selecciona la relación y muestra sus propiedades', async () => {
    mount();
    await ready();
    fireEvent.click(screen.getByTestId('edge-label-api-cola'));
    await waitFor(() => expect(screen.getByTestId('inspector')).toHaveTextContent('Asíncrona'));
    expect(screen.getByTestId('edge-label-api-cola')).toHaveAttribute('data-selected');
  });
});

describe('selección múltiple', () => {
  it('Ctrl/Cmd + clic suma y quita elementos y el panel resume la selección', async () => {
    mount();
    await ready();
    await pickNode('api');
    expect(screen.getByLabelText('Nombre')).toHaveValue('API');
    await pickNode('worker', true);
    const panel = screen.getByTestId('inspector');
    expect(within(panel).getByText('2 elementos seleccionados')).toBeInTheDocument();
    expect(within(screen.getByTestId('selection-list')).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['APIServicio', 'WorkerServicio']);
    await pickNode('api', true);
    expect(screen.getByLabelText('Nombre')).toHaveValue('Worker');
  });

  it('un clic sin Ctrl sobre un elemento de la selección deja solo ese', async () => {
    mount();
    await ready();
    await pickNode('api');
    await pickNode('worker', true);
    await pickNode('worker');
    expect(screen.getByLabelText('Nombre')).toHaveValue('Worker');
  });

  it('el resumen permite quedarse con un solo elemento', async () => {
    mount();
    await ready();
    await pickNode('api');
    await pickNode('libre', true);
    await userEvent.click(within(screen.getByTestId('selection-list')).getByRole('button', { name: /Servicio libre/ }));
    expect(screen.getByLabelText('Nombre')).toHaveValue('Servicio libre');
  });

  it('borrar varios elementos con Supr o con el botón deja un único paso de deshacer', async () => {
    const h = mount();
    await ready();
    await pickNode('api');
    await pickNode('worker', true);
    pressKey('Delete');
    expect(h.doc().nodes.map((n) => n.id)).toEqual(['zona', 'cola', 'libre']);
    expect(h.doc().edges).toEqual([]);
    pressKey('z', { ctrlKey: true });
    expect(h.doc().nodes.map((n) => n.id)).toEqual(['zona', 'api', 'cola', 'worker', 'libre']);
    expect(h.doc().edges).toHaveLength(2);
    expect(h.history.canUndo).toBe(false);

    await pickNode('libre');
    await pickNode('cola', true);
    await userEvent.click(screen.getByRole('button', { name: 'Borrar selección' }));
    expect(h.doc().nodes.map((n) => n.id)).toEqual(['zona', 'api', 'worker']);
    pressKey('z', { ctrlKey: true });
    expect(h.doc().nodes).toHaveLength(5);
    expect(h.history.canUndo).toBe(false);
  });

  it('el botón de borrar del resumen también lo hace de una vez', async () => {
    const h = mount();
    await ready();
    await pickNode('worker');
    await pickNode('libre', true);
    await userEvent.click(screen.getByRole('button', { name: /Borrar 2 elementos/ }));
    expect(h.doc().nodes.map((n) => n.id)).toEqual(['zona', 'api', 'cola']);
    expect(screen.queryByTestId('selection-list')).toBeNull();
  });

  it('Escape quita la selección', async () => {
    mount();
    await ready();
    await pickNode('api');
    pressKey('Escape');
    expect(screen.queryByLabelText('Nombre')).toBeNull();
  });
});

describe('acciones del módulo', () => {
  it('cada acción se habilita según lo que pide y explica por qué no está disponible', async () => {
    mount();
    await ready();
    expect(screen.getByTestId('action-group')).toBeDisabled();
    expect(screen.getByTestId('action-group')).toHaveAttribute('title', 'Selecciona al menos un elemento.');
    expect(screen.getByTestId('action-renumber')).toBeEnabled();
    expect(screen.getByTestId('action-inspect')).toHaveAttribute('title', 'Selecciona un único elemento.');

    await pickNode('api');
    expect(screen.getByTestId('action-group')).toBeEnabled();
    expect(screen.getByTestId('action-group')).toHaveAttribute('title', 'Mete los servicios seleccionados en una zona');
    expect(screen.getByTestId('action-inspect')).toBeEnabled();

    await pickNode('worker', true);
    expect(screen.getByTestId('action-group')).toBeEnabled();
    expect(screen.getByTestId('action-inspect')).toBeDisabled();

    await pickNode('cola');
    expect(screen.getByTestId('action-inspect')).toBeDisabled();
    expect(screen.getByTestId('action-inspect')).toHaveAttribute('title', 'Las colas no se revisan.');
  });

  it('una acción sin texto se ejecuta al instante con un solo registro de deshacer', async () => {
    const h = mount();
    await ready();
    await userEvent.click(screen.getByTestId('action-renumber'));
    expect(h.doc().edges.map((e) => e.step)).toEqual([1, 2]);
    expect(h.history.canUndo).toBe(true);
    pressKey('z', { ctrlKey: true });
    expect(h.history.canUndo).toBe(false);
  });

  it('una acción con un solo elemento recibe sus ids', async () => {
    const h = mount();
    await ready();
    await pickNode('worker');
    await userEvent.click(screen.getByTestId('action-inspect'));
    expect(h.doc().nodes.find((n) => n.id === 'worker')?.retries).toBe(1);
  });

  it('una acción con texto abre un formulario con el valor inicial y las sugerencias, y se ejecuta con Enter', async () => {
    const h = mount();
    await ready();
    await pickNode('api');
    await userEvent.click(screen.getByTestId('action-group'));
    const form = screen.getByTestId('action-prompt');
    const input = within(form).getByLabelText('Nombre de la zona');
    expect(input).toHaveValue('zona');
    expect(input).toHaveAttribute('placeholder', 'p. ej. Pedidos');
    expect([...form.querySelectorAll('datalist option')].map((o) => o.getAttribute('value'))).toEqual(['Pedidos']);
    await userEvent.clear(input);
    await userEvent.type(input, 'Logística{Enter}');
    expect(screen.queryByTestId('action-prompt')).toBeNull();
    expect(h.doc().nodes.find((n) => n.id === 'api')?.zone).toBe('logistica');
    expect(h.doc().nodes.some((n) => n.id === 'logistica' && n.kind === 'zone')).toBe(true);
    expect(h.history.canUndo).toBe(true);
  });

  it('Escape y Cancelar cierran el formulario sin ejecutar nada', async () => {
    const h = mount();
    await ready();
    await pickNode('api');
    await userEvent.click(screen.getByTestId('action-group'));
    await userEvent.type(screen.getByLabelText('Nombre de la zona'), 'X{Escape}');
    expect(screen.queryByTestId('action-prompt')).toBeNull();
    await userEvent.click(screen.getByTestId('action-group'));
    await userEvent.click(within(screen.getByTestId('action-prompt')).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByTestId('action-prompt')).toBeNull();
    expect(h.history.canUndo).toBe(false);
    expect(h.doc()).toEqual(FAKE_DOC);
  });

  it('si la acción no puede ejecutarse, avisa del motivo y no toca el documento', async () => {
    const h = mount();
    await ready();
    await pickNode('libre');
    await userEvent.click(screen.getByTestId('action-group'));
    await userEvent.clear(screen.getByLabelText('Nombre de la zona'));
    await userEvent.click(within(screen.getByTestId('action-prompt')).getByRole('button', { name: 'Aceptar' }));
    expect(h.notify).toHaveBeenCalledWith('Escribe el nombre de la zona.');
    expect(h.history.canUndo).toBe(false);
  });

  it('el formulario se cierra al cambiar la selección', async () => {
    mount();
    await ready();
    await pickNode('api');
    await userEvent.click(screen.getByTestId('action-group'));
    expect(screen.getByTestId('action-prompt')).toBeInTheDocument();
    await pickNode('worker');
    expect(screen.queryByTestId('action-prompt')).toBeNull();
  });

  it('en solo lectura ninguna acción ni el borrado están disponibles', async () => {
    mount({ readOnly: true });
    await ready();
    await pickNode('api');
    expect(screen.getByTestId('action-group')).toBeDisabled();
    expect(screen.getByTestId('action-renumber')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Borrar selección' })).toBeDisabled();
  });
});

describe('panel de propiedades', () => {
  it('un campo numérico se confirma al salir y lo vacío se guarda como ausente', async () => {
    const h = mount();
    await ready();
    await pickNode('api');
    const retries = screen.getByLabelText('Reintentos');
    expect(retries).toHaveAttribute('type', 'number');
    expect(retries).toHaveAttribute('min', '0');
    expect(retries).toHaveAttribute('step', '1');
    expect(retries).toHaveValue(2);
    await userEvent.clear(retries);
    await userEvent.type(retries, '7');
    expect(h.doc().nodes.find((n) => n.id === 'api')?.retries).toBe(2);
    await userEvent.tab();
    expect(h.doc().nodes.find((n) => n.id === 'api')?.retries).toBe(7);
    await userEvent.clear(screen.getByLabelText('Reintentos'));
    await userEvent.type(screen.getByLabelText('Reintentos'), '{Enter}');
    expect(h.doc().nodes.find((n) => n.id === 'api')).not.toHaveProperty('retries');
  });

  it('un campo que apunta a un adjunto ofrece abrirlo en su editor', async () => {
    const h = mount();
    await ready();
    await pickNode('api');
    expect(screen.queryByTestId('attachment-new')).toBeNull();
    await userEvent.click(screen.getByTestId('attachment-open'));
    expect(h.onOpenAttachment).toHaveBeenCalledWith('api-pedidos');
  });

  it('si el valor está vacío ofrece crear uno nuevo con el formato recomendado, lo asigna y lo abre', async () => {
    const h = mount();
    await ready();
    await pickNode('worker');
    expect(screen.queryByTestId('attachment-open')).toBeNull();
    const create = screen.getByTestId('attachment-new');
    expect(create).toHaveTextContent('Nuevo contrato (OpenAPI)');
    await userEvent.click(create);
    expect(h.doc().contracts.map((c) => c.id)).toEqual(['api-pedidos', 'contrato-worker']);
    expect(h.doc().nodes.find((n) => n.id === 'worker')?.contractId).toBe('contrato-worker');
    expect(h.onOpenAttachment).toHaveBeenCalledWith('contrato-worker');
    expect(h.history.canUndo).toBe(true);
  });

  it('no ofrece crear adjuntos en solo lectura', async () => {
    mount({ readOnly: true });
    await ready();
    await pickNode('worker');
    expect(screen.queryByTestId('attachment-new')).toBeNull();
  });
});

describe('documento inválido', () => {
  it('avisa en lugar de dibujar', () => {
    mount({ doc: undefined });
    expect(screen.getByRole('status')).toHaveTextContent('El documento no es válido');
  });
});
