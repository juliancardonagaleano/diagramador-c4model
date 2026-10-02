// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorSpec } from '@iark/kernel';
import { enterpriseEditor, enterpriseModule, type EnterpriseDocument } from '@iark/domain-enterprise';
import example from '../../../examples/empresa-arquitectura.json';
import { installFlowMocks } from '../testing-dom';
import { DiagramCanvas } from './DiagramCanvas';
import { EditHistory } from './history';

beforeAll(installFlowMocks);
beforeEach(() => window.localStorage.clear());

const spec = enterpriseEditor as unknown as EditorSpec<unknown>;
const base = enterpriseModule.schema.parse(example) as EnterpriseDocument;
// El ejemplo más una composición (rombo), un disparo (flecha abierta) y una asignación (punto).
const doc: EnterpriseDocument = {
  ...base,
  processes: [...base.processes, { id: 'preparacion-pedido', name: 'Preparación de pedido', ownerId: 'logistica' }],
  applications: [...base.applications, { id: 'erp-facturacion', name: 'ERP · facturación', ownerId: 'finanzas' }],
  relations: [
    ...base.relations,
    { id: 'erp--composes--erp-facturacion', kind: 'composes', sourceId: 'erp', targetId: 'erp-facturacion' },
    { id: 'alta-pedido--triggers--preparacion-pedido', kind: 'triggers', sourceId: 'alta-pedido', targetId: 'preparacion-pedido' },
    { id: 'ventas--assigned-to--alta-pedido', kind: 'assigned-to', sourceId: 'ventas', targetId: 'alta-pedido' },
  ],
};
const views = enterpriseModule.views!(doc);

function mount(viewId: string, onView = vi.fn()): void {
  render(
    <DiagramCanvas moduleId="enterprise" spec={spec} document={doc} text="" viewId={viewId} views={views} onView={onView} readOnly={false} history={new EditHistory()} onText={vi.fn()} notify={vi.fn()} />,
  );
}

describe('lienzo empresarial', () => {
  it('cada nodo lleva el icono de su tipo en la esquina y el color de su capa', async () => {
    mount('landscape');
    await waitFor(() => expect(screen.getByTestId('node-tienda-web')).toBeInTheDocument(), { timeout: 5000 });
    expect(within(screen.getByTestId('node-tienda-web')).getByTestId('icon-tienda-web')).toBeInTheDocument();
    expect(within(screen.getByTestId('node-kubernetes')).getByTestId('icon-kubernetes')).toBeInTheDocument();
    expect(screen.getByTestId('node-tienda-web').querySelector('path')?.getAttribute('fill')).toBe('#74c0fc');
    expect(screen.getByTestId('node-kubernetes').querySelector('path')?.getAttribute('fill')).toBe('#8ce99a');
  });

  it('la composición y la asignación se dibujan con su adorno de origen y el disparo con la flecha abierta', async () => {
    mount('landscape');
    await waitFor(() => expect(document.querySelector('.react-flow__edge[data-id="erp--composes--erp-facturacion"]')).not.toBeNull(), { timeout: 5000 });
    const tail = (id: string) => document.querySelector(`.react-flow__edge[data-id="${id}"] [data-testid="edge-tail"]`);
    expect(tail('erp--composes--erp-facturacion')?.getAttribute('data-tail')).toBe('diamond');
    expect(tail('ventas--assigned-to--alta-pedido')?.getAttribute('data-tail')).toBe('dot');
    expect(tail('tienda-web--supports--alta-pedido')).toBeNull();
    const path = (id: string) => document.querySelector(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`) as SVGPathElement;
    expect(path('alta-pedido--triggers--preparacion-pedido').getAttribute('marker-end')).toContain('arrow');
    expect(path('alta-pedido--triggers--preparacion-pedido').getAttribute('marker-end')).not.toContain('arrowclosed');
    expect(path('erp--composes--erp-facturacion').getAttribute('marker-end')).toBeNull();
  });

  it('el mapa de capacidades muestra su leyenda y deja elegir con qué se colorea', async () => {
    const onView = vi.fn();
    mount('capabilities', onView);
    await waitFor(() => expect(screen.getByTestId('node-ventas-online')).toBeInTheDocument(), { timeout: 5000 });
    const legend = screen.getByTestId('canvas-legend');
    expect(legend).toHaveTextContent('Color: madurez');
    expect(legend).toHaveTextContent('sin indicar');
    const select = screen.getByTestId('canvas-variant') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Madurez', 'Importancia', 'Criticidad de las aplicaciones', 'Ciclo de vida de las aplicaciones']);
    // Las variantes no ensucian el selector «Vista».
    const viewSelect = screen.getByTestId('canvas-view') as HTMLSelectElement;
    expect([...viewSelect.options].map((o) => o.value)).toEqual(['capabilities', 'landscape', 'roadmap', ...views.filter((v) => v.id.startsWith('unit:')).map((v) => v.id)]);
    fireEvent.change(select, { target: { value: 'capabilities:criticality' } });
    expect(onView).toHaveBeenCalledWith('capabilities:criticality');
  });

  it('en una variante se muestra su leyenda y el selector sigue sobre ella', async () => {
    mount('capabilities:criticality');
    await waitFor(() => expect(screen.getByTestId('node-ventas-online')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.getByTestId('canvas-legend')).toHaveTextContent('Color: criticidad de las aplicaciones');
    expect((screen.getByTestId('canvas-variant') as HTMLSelectElement).value).toBe('capabilities:criticality');
    expect((screen.getByTestId('canvas-view') as HTMLSelectElement).value).toBe('capabilities');
  });

  it('las vistas de relaciones no llevan selector de color ni leyenda', async () => {
    mount('landscape');
    await waitFor(() => expect(screen.getByTestId('node-tienda-web')).toBeInTheDocument(), { timeout: 5000 });
    expect(screen.queryByTestId('canvas-variant')).toBeNull();
    expect(screen.queryByTestId('canvas-legend')).toBeNull();
  });
});
