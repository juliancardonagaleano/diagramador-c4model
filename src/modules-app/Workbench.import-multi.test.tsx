// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { pretty, sourceFilesOf, type ImportContext } from '@iark/kernel';
import { WorkbenchController, type ModuleSource } from './controller';
import { installFlowMocks } from './testing-dom';
import { FAKE_DOC, fakeModule } from './testing-editor';
import { Workbench } from './Workbench';

beforeAll(installFlowMocks);

// Un módulo con un importador que se reparte en `.part` (como el Terraform) y otro de un solo archivo: dejan a la vista lo que reciben.
const received: Array<{ text: string; context: ImportContext }> = [];
const conImportadores = {
  ...fakeModule,
  importers: [
    {
      id: 'partes',
      label: 'Partes',
      extensions: ['.part'],
      multiFile: { extensions: ['.part'] },
      detect: (t: string) => t.startsWith('PART'),
      import: (text: string, context: ImportContext) => (received.push({ text, context }), { document: FAKE_DOC, warnings: sourceFilesOf(context.extra) ? ['juntos'] : [] }),
    },
    { id: 'solo', label: 'Solo', extensions: ['.uno'], import: () => ({ document: FAKE_DOC, warnings: [] }) },
  ],
};
const SOURCES: ModuleSource[] = [{ id: 'fake', label: 'Con importadores', load: async () => conImportadores as never, example: async () => pretty(FAKE_DOC) }];

async function openImport(): Promise<WorkbenchController> {
  received.length = 0;
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0 });
  await controller.selectModule('fake');
  render(<Workbench controller={controller} />);
  await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
  await userEvent.click(screen.getByRole('tab', { name: 'Importar' }));
  return controller;
}

/** jsdom no implementa `Blob.text()`, que es lo que usa el banco de trabajo para leer un archivo abierto. */
const fileWith = (content: string, name: string): File => Object.defineProperty(new File([content], name, { type: 'text/plain' }), 'text', { value: async () => content });
const picker = (): HTMLInputElement => screen.getByLabelText('Abrir archivo a importar…') as HTMLInputElement;
const area = (): HTMLTextAreaElement => screen.getByLabelText('Texto a importar') as HTMLTextAreaElement;

describe('«Abrir archivo a importar…» con varios archivos', () => {
  it('admite selección múltiple', async () => {
    await openImport();
    expect(picker().multiple).toBe(true);
  });

  it('varios archivos del mismo formato se juntan en orden alfabético y se importan como uno', async () => {
    const controller = await openImport();
    await userEvent.upload(picker(), [fileWith('PART c', 'c.part'), fileWith('PART a', 'a.part'), fileWith('PART b', 'B.part')]);

    await waitFor(() => expect(area()).toHaveValue('PART a\nPART b\nPART c'));
    expect(screen.getByTestId('import-files')).toHaveTextContent('3 archivos se importan juntos (en orden alfabético): a.part, B.part, c.part.');
    await userEvent.click(screen.getByRole('button', { name: 'Importar', exact: true }));

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].text).toBe('PART a\nPART b\nPART c');
    expect(sourceFilesOf(received[0].context.extra)?.map((f) => f.name)).toEqual(['a.part', 'B.part', 'c.part']);
    expect(await screen.findByText('Aviso de la importación:')).toBeInTheDocument();
    expect(screen.getByTestId('import-warnings')).toHaveTextContent('Origen: partes · 3 archivos');
    expect(screen.getByRole('tab', { name: 'Importar (1)' })).toBeInTheDocument();
    expect(controller.getState().analysis.status).toBe('ok');
    expect(controller.getState().modified).toBe(true);
  });

  it('con archivos de distinto formato avisa y no toca el cuadro', async () => {
    await openImport();
    fireEvent.change(area(), { target: { value: 'lo que había' } });
    await userEvent.upload(picker(), [fileWith('PART a', 'a.part'), fileWith('x', 'b.uno')]);
    expect(await screen.findByRole('alert')).toHaveTextContent('Los archivos (a.part, b.uno) no son todos del mismo formato: solo se leen juntos los .part.');
    expect(area()).toHaveValue('lo que había');
    expect(screen.queryByTestId('import-files')).toBeNull();
  });

  it('con el formato elegido a mano que no se reparte en varios archivos, avisa', async () => {
    await openImport();
    await userEvent.selectOptions(screen.getByLabelText('Formato de importación'), 'solo');
    await userEvent.upload(picker(), [fileWith('x', 'a.part'), fileWith('x', 'b.part')]);
    expect(await screen.findByRole('alert')).toHaveTextContent('El formato «solo» no se puede leer repartido en varios archivos: importa uno solo.');
  });

  it('un solo archivo se carga como siempre, y editar el texto a mano suelta los archivos elegidos', async () => {
    await openImport();
    await userEvent.upload(picker(), [fileWith('PART a', 'a.part'), fileWith('PART b', 'b.part')]);
    await screen.findByTestId('import-files');
    fireEvent.change(area(), { target: { value: 'PART editado' } });
    expect(screen.queryByTestId('import-files')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Importar', exact: true }));
    await waitFor(() => expect(received).toHaveLength(1));
    // Importado como texto (sin el detalle por archivo).
    expect(received[0].text).toBe('PART editado');
    expect(sourceFilesOf(received[0].context.extra)).toBeUndefined();

    await userEvent.upload(picker(), fileWith('PART solo', 'solo.part'));
    await waitFor(() => expect(area()).toHaveValue('PART solo'));
    expect(screen.queryByTestId('import-files')).toBeNull();
  });
});
