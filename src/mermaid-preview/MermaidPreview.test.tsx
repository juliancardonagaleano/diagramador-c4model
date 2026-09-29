// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MermaidRender } from './render';

const renderMermaid = vi.fn<(text: string) => Promise<MermaidRender>>();
vi.mock('./render', () => ({ renderMermaid: (text: string) => renderMermaid(text) }));

const { MermaidPreview } = await import('./MermaidPreview');

const drawing = (id: string): MermaidRender => ({ ok: true, svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}"/>`, width: 400, height: 200 });

describe('MermaidPreview', () => {
  beforeEach(() => renderMermaid.mockReset());

  it('avisa mientras dibuja y luego enseña el SVG como imagen con su tamaño y descripción', async () => {
    renderMermaid.mockResolvedValue(drawing('uno'));
    render(<MermaidPreview text="flowchart LR\n a --> b" label="Vista previa de la topología" />);
    expect(screen.getByRole('status')).toHaveTextContent('Dibujando con Mermaid');

    const img = await screen.findByRole('img', { name: 'Vista previa de la topología' });
    expect(img).toHaveAttribute('width', '400');
    expect(img).toHaveAttribute('height', '200');
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;charset=utf-8,%3Csvg/);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('«Tamaño real» quita el ajuste al ancho para poder leer los diagramas grandes con desplazamiento', async () => {
    renderMermaid.mockResolvedValue(drawing('grande'));
    render(<MermaidPreview text="flowchart LR\n a --> b" />);
    const canvas = (await screen.findByTestId('mermaid-preview')) as HTMLElement;
    expect(canvas).not.toHaveClass('actual');
    fireEvent.click(screen.getByLabelText('Tamaño real'));
    expect(canvas).toHaveClass('actual');
    fireEvent.click(screen.getByLabelText('Tamaño real'));
    expect(canvas).not.toHaveClass('actual');
  });

  it('si no se puede dibujar, muestra el motivo como alerta', async () => {
    renderMermaid.mockResolvedValue({ ok: false, message: 'Parse error on line 2:' });
    render(<MermaidPreview text="mal" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo dibujar: Parse error on line 2:');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('al cambiar el texto no enseña el dibujo anterior y descarta una respuesta que llega tarde', async () => {
    let releaseSlow: (r: MermaidRender) => void = () => {};
    renderMermaid.mockImplementation((text) => (text === 'lento' ? new Promise((resolve) => (releaseSlow = resolve)) : Promise.resolve(drawing(text))));

    const { rerender } = render(<MermaidPreview text="rapido" />);
    await screen.findByRole('img');
    expect(decodeURIComponent(screen.getByRole('img').getAttribute('src')!)).toContain('id="rapido"');

    rerender(<MermaidPreview text="lento" />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();

    rerender(<MermaidPreview text="definitivo" />);
    await waitFor(() => expect(decodeURIComponent(screen.getByRole('img').getAttribute('src')!)).toContain('id="definitivo"'));

    releaseSlow(drawing('lento')); // llega después de que el texto ya cambió: no debe pisar el dibujo vigente
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(decodeURIComponent(screen.getByRole('img').getAttribute('src')!)).toContain('id="definitivo"');
  });
});
