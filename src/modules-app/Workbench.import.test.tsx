// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { pretty } from '@iark/kernel';
import { WorkbenchController, type ModuleSource } from './controller';
import { installFlowMocks } from './testing-dom';
import { FAKE_DOC, fakeModule } from './testing-editor';
import { Workbench } from './Workbench';

beforeAll(installFlowMocks);

const AVISOS = ['3 recursos sin mapear', 'una red sin exposición'];

// Un módulo con un importador `.fake` que deja avisos (salvo si el texto dice «limpio»), para ver por dónde llegan a la pantalla.
const conImportador = {
  ...fakeModule,
  importers: [
    {
      id: 'falso',
      label: 'Falso',
      extensions: ['.fake'],
      detect: (t: string) => t.startsWith('FAKE'),
      import: (t: string) => ({ document: FAKE_DOC, warnings: t.includes('limpio') ? [] : AVISOS }),
    },
  ],
};
const SOURCES: ModuleSource[] = [{ id: 'fake', label: 'Con importador', load: async () => conImportador as never, example: async () => pretty(FAKE_DOC) }];

async function open(): Promise<WorkbenchController> {
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0 });
  await controller.selectModule('fake');
  render(<Workbench controller={controller} />);
  await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
  return controller;
}

/** jsdom no implementa `Blob.text()`, que es lo que usa el banco de trabajo para leer un archivo abierto. */
const fileWith = (content: string, name: string): File => Object.defineProperty(new File([content], name, { type: 'text/plain' }), 'text', { value: async () => content });

/** «Abrir archivo…» del encabezado (no el «Abrir archivo a importar…» del panel). */
const openFromHeader = (content: string, name: string): Promise<void> => userEvent.upload(screen.getByLabelText('Abrir archivo…'), fileWith(content, name));

describe('avisos del panel «Importar»', () => {
  it('«Abrir archivo…» del encabezado deja los avisos en la pestaña Importar y en su contador', async () => {
    await open();
    expect(screen.getByRole('tab', { name: 'Importar' })).toBeInTheDocument();
    await openFromHeader('FAKE', 'tienda.fake');

    expect(await screen.findByRole('tab', { name: 'Importar (2)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Importar (2)' }));
    const notes = screen.getByTestId('import-warnings');
    expect(notes).toHaveTextContent('2 avisos de la importación:');
    expect(notes).toHaveTextContent('Origen: falso · tienda.fake');
    for (const aviso of AVISOS) expect(notes).toHaveTextContent(aviso);
  });

  it('siguen ahí al cambiar de pestaña y volver, y salen al editar el documento', async () => {
    const controller = await open();
    await openFromHeader('FAKE', 'tienda.fake');
    await userEvent.click(await screen.findByRole('tab', { name: 'Importar (2)' }));
    expect(screen.getByTestId('import-warnings')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Exportar' }));
    expect(screen.queryByTestId('import-warnings')).toBeNull();
    await userEvent.click(screen.getByRole('tab', { name: 'Importar (2)' }));
    expect(screen.getByTestId('import-warnings')).toHaveTextContent(AVISOS[0]);

    // Editar el documento (aquí, el JSON del editor) los descarta, y con ellos el contador de la pestaña.
    fireEvent.change(screen.getByLabelText('Documento JSON'), { target: { value: `${controller.getState().text}\n` } });
    await waitFor(() => expect(screen.queryByTestId('import-warnings')).toBeNull());
    expect(screen.getByRole('tab', { name: 'Importar' })).toBeInTheDocument();
  });

  it('importar desde la propia pestaña los muestra igual y otra importación sustituye a los anteriores', async () => {
    const controller = await open();
    await userEvent.click(screen.getByRole('tab', { name: 'Importar' }));
    await userEvent.type(screen.getByLabelText('Texto a importar'), 'FAKE');
    await userEvent.click(screen.getByRole('button', { name: 'Importar', exact: true }));
    expect(await screen.findByTestId('import-warnings')).toHaveTextContent('2 avisos de la importación:');
    expect(screen.getByRole('tab', { name: 'Importar (2)' })).toBeInTheDocument();

    // Una importación que no trae avisos quita los de la anterior.
    await controller.openText('FAKE limpio', 'limpio.fake');
    await waitFor(() => expect(screen.queryByTestId('import-warnings')).toBeNull());
    expect(screen.getByRole('tab', { name: 'Importar' })).toBeInTheDocument();
  });

  it('abrir un JSON del módulo con «Abrir archivo…» (otro contenido) descarta los avisos', async () => {
    await open();
    await openFromHeader('FAKE', 'tienda.fake');
    await screen.findByRole('tab', { name: 'Importar (2)' });
    await openFromHeader(pretty(FAKE_DOC), 'documento.json');
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Importar' })).toBeInTheDocument());
  });

  it('el toast de «Abrir archivo…» dice dónde ver los avisos', async () => {
    await open();
    await openFromHeader('FAKE', 'tienda.fake');
    expect(await screen.findByText('Importado desde falso con 2 avisos (se ven en la pestaña Importar)')).toBeInTheDocument();
  });
});
