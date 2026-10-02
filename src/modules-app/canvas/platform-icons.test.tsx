// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pretty, type EditorSpec } from '@iark/kernel';
import { platformEditor, platformModule, type PlatformDocument } from '@iark/domain-platform';
import example from '../../../examples/plataforma-nubes.json';
import { installFlowMocks, pickNode } from '../testing-dom';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

beforeAll(installFlowMocks);
beforeEach(() => window.localStorage.clear());

const spec = platformEditor as unknown as EditorSpec<unknown>;
const doc = platformModule.schema.parse(example) as PlatformDocument;
const views = platformModule.views!(doc);

function mount(viewId: string): { doc(): PlatformDocument } {
  let current = pretty(doc);
  function Host() {
    const [text, setText] = useState(current);
    current = text;
    return <DiagramCanvas moduleId="platform" spec={spec} document={JSON.parse(text) as unknown} text={text} viewId={viewId} views={views} onView={vi.fn()} readOnly={false} history={new EditHistory()} onText={setText} notify={vi.fn()} />;
  }
  render(<Host />);
  return { doc: () => JSON.parse(current) as PlatformDocument };
}

describe('lienzo de plataforma: iconos de proveedores de nube', () => {
  it('cada recurso con proveedor lleva la ficha de su servicio, con el color del proveedor, y las zonas la suyas', async () => {
    mount('env:aws-prod');
    await waitFor(() => expect(screen.getByTestId('node-rds-pedidos')).toBeInTheDocument(), { timeout: 5000 });
    // La base de datos (servicio sugerido por PostgreSQL) y la cola (indicado) en naranja AWS; la ficha cabalga sobre la esquina del nodo.
    const rds = within(screen.getByTestId('node-rds-pedidos')).getByTestId('icon-rds-pedidos');
    expect(rds).toHaveAttribute('data-provider-icon', '#ec7211');
    expect(rds).toHaveClass('cv-cloud-icon');
    expect(rds.querySelectorAll('path').length).toBeGreaterThan(1);
    expect(within(screen.getByTestId('node-sqs-pedidos')).getByTestId('icon-sqs-pedidos')).toHaveAttribute('data-provider-icon', '#ec7211');
    // El clúster que aloja servicios y la VPC son zonas: la ficha va en su esquina superior derecha.
    expect(within(screen.getByTestId('node-eks-prod')).getByTestId('icon-eks-prod')).toHaveClass('cv-cloud-icon-zone');
    expect(within(screen.getByTestId('node-vpc-prod')).getByTestId('icon-vpc-prod')).toBeInTheDocument();
    // Sin proveedor no hay ficha.
    expect(within(screen.getByTestId('node-subred-datos')).queryByTestId('icon-subred-datos')).toBeNull();
  });

  it('Azure usa su azul y el paquete propio del documento (GCP) el suyo', async () => {
    mount('env:azure-dr');
    await waitFor(() => expect(screen.getByTestId('node-sql-dr')).toBeInTheDocument(), { timeout: 5000 });
    expect(within(screen.getByTestId('node-sql-dr')).getByTestId('icon-sql-dr')).toHaveAttribute('data-provider-icon', '#0078d4');
    expect(within(screen.getByTestId('node-bus-dr')).getByTestId('icon-bus-dr')).toHaveAttribute('data-provider-icon', '#0078d4');
  });

  it('el panel de propiedades elige el proveedor y, de su paquete, el servicio; al cambiar el proveedor se sugiere el servicio', async () => {
    const host = mount('env:aws-prod');
    await waitFor(() => expect(screen.getByTestId('node-s3-facturas')).toBeInTheDocument(), { timeout: 5000 });
    await pickNode('s3-facturas');
    const provider = screen.getByLabelText('Proveedor de nube') as HTMLSelectElement;
    const service = screen.getByLabelText('Servicio de nube') as HTMLSelectElement;
    expect(provider.value).toBe('aws');
    expect([...provider.options].map((o) => o.value)).toEqual(['', 'aws', 'azure', 'gcp']);
    expect([...service.options].map((o) => o.value)).toEqual(expect.arrayContaining(['', 's3', 'rds', 'ecr']));
    expect([...service.options].map((o) => o.value)).not.toContain('aks');
    expect(service.value).toBe('');
    expect([...service.options].find((o) => o.value === 's3')?.textContent).toBe('Amazon S3 (sugerido)');

    fireEvent.change(service, { target: { value: 's3' } });
    await waitFor(() => expect(host.doc().resources.find((r) => r.id === 's3-facturas')).toMatchObject({ provider: 'aws', service: 's3' }));
    fireEvent.change(screen.getByLabelText('Proveedor de nube'), { target: { value: 'azure' } });
    await waitFor(() => expect(host.doc().resources.find((r) => r.id === 's3-facturas')).toMatchObject({ provider: 'azure', service: 'blob-storage' }));
    await waitFor(() => expect(within(screen.getByTestId('node-s3-facturas')).getByTestId('icon-s3-facturas')).toHaveAttribute('data-provider-icon', '#0078d4'));
  });
});
