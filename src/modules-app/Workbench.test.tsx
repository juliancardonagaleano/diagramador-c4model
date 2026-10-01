// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { pretty } from '@iark/kernel';
import { WorkbenchController, type ModuleSource } from './controller';
import { installFlowMocks, pickNode } from './testing-dom';
import { FAKE_DOC, fakeModule } from './testing-editor';
import { Workbench } from './Workbench';

beforeAll(installFlowMocks);

const plain = { ...fakeModule, id: 'plain', editor: { ...fakeModule.editor!, attachments: undefined } };
const SOURCES: ModuleSource[] = [
  { id: 'fake', label: 'Con contratos', load: async () => fakeModule as never, example: async () => pretty(FAKE_DOC) },
  { id: 'plain', label: 'Sin contratos', load: async () => plain as never, example: async () => pretty(FAKE_DOC) },
];

async function open(moduleId = 'fake', ui: 'full' | 'min' = 'full'): Promise<WorkbenchController> {
  const controller = new WorkbenchController(SOURCES, { renderDelay: 0 });
  await controller.selectModule(moduleId);
  render(<Workbench controller={controller} ui={ui} embed={ui === 'min'} />);
  await waitFor(() => expect(screen.getByTestId('module-canvas')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByTestId('node-api')).toBeInTheDocument());
  return controller;
}

describe('pestaña de adjuntos', () => {
  it('aparece con el título del módulo, también en modo embebido, y solo si el módulo declara adjuntos', async () => {
    await open('fake', 'min');
    expect(screen.getByRole('tab', { name: 'Contratos' })).toBeInTheDocument();
  });

  it('un módulo sin adjuntos no la muestra', async () => {
    await open('plain');
    expect(screen.queryByRole('tab', { name: 'Contratos' })).toBeNull();
  });

  it('«Editar ⤷» del panel de propiedades abre ese adjunto en su pestaña y «Usado por» vuelve al lienzo con el elemento seleccionado', async () => {
    await open();
    await pickNode('api');
    await userEvent.click(await screen.findByTestId('attachment-open'));
    expect(screen.getByRole('tab', { name: 'Contratos' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('module-canvas')).toBeNull();
    expect(screen.getByLabelText('Nombre')).toHaveValue('API de pedidos');

    await userEvent.click(screen.getByTestId('used-by-api'));
    expect(screen.getByRole('tab', { name: 'Lienzo' })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByTestId('node-api').closest('.react-flow__node')).toHaveClass('selected'), { timeout: 5000 });
    expect(within(screen.getByTestId('inspector')).getByLabelText('Nombre')).toHaveValue('API');
  });

  it('«Nuevo contrato (OpenAPI)» crea el contrato desde el panel de propiedades y lo abre en su pestaña', async () => {
    const controller = await open();
    await pickNode('worker');
    await userEvent.click(await screen.findByTestId('attachment-new'));
    expect(screen.getByRole('tab', { name: 'Contratos' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Nombre')).toHaveValue('Contrato de worker');
    const doc = JSON.parse(controller.getState().text) as typeof FAKE_DOC;
    expect(doc.nodes.find((n) => n.id === 'worker')?.contractId).toBe('contrato-worker');
  });

  it('los cambios en los contratos entran en el documento y se deshacen desde el lienzo', async () => {
    const controller = await open();
    await userEvent.click(screen.getByRole('tab', { name: 'Contratos' }));
    await userEvent.click(screen.getByTestId('attachment-format'));
    expect(JSON.parse(controller.getState().text).contracts[0].text).toBe('{\n  "openapi": "3.1.0"\n}');
    await userEvent.click(screen.getByRole('tab', { name: 'Lienzo' }));
    await userEvent.keyboard('{Control>}z{/Control}');
    expect(JSON.parse(controller.getState().text).contracts[0].text).toBe('{"openapi":"3.1.0"}');
  });

  it('con el documento inválido la pestaña avisa y las demás siguen ahí', async () => {
    const controller = await open();
    await userEvent.click(screen.getByRole('tab', { name: 'Contratos' }));
    controller.setText('{ "nodes": ');
    expect(await screen.findByRole('status', { name: '' })).toBeDefined();
    expect(screen.getByText(/El documento no es válido: corrígelo en la pestaña JSON para volver a editar los contratos\./)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Problemas (1)' })).toBeInTheDocument();
  });
});
