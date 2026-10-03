import { describe, expect, it } from 'vitest';
import { autoLayoutDocument } from '../../layout/elkLayout';
import { sampleDocument } from '../../model/sample';
import { SvgExportError, toSvg } from './toSvg';

describe('toSvg (C4)', () => {
  it('exige elementos colocados: sin autolayout falla con un error claro', () => {
    const doc = structuredClone(sampleDocument);
    for (const v of doc.views) v.elements = v.elements.map((e) => ({ id: e.id })); // sin x/y: nada colocado
    expect(() => toSvg(doc, { viewId: 'contexto' })).toThrow(SvgExportError);
  });

  it('dibuja la vista de contenedores con las figuras C4: persona como actor y base de datos como cilindro', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const svg = toSvg(laid, { viewId: 'contenedores' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Aplicación web');
    expect(svg).toContain('Base de datos');
    // La etiqueta de tipo se dibuja en mayúsculas sobre el título.
    expect(svg).toContain('CONTENEDOR');
    expect(svg).toContain('PERSONA');
    expect(svg).toContain('SISTEMA DE SOFTWARE EXTERNO');
    // El cilindro lleva el arco de detalle sin relleno; un SVG solo de rectángulos no lo tendría.
    expect(svg).toMatch(/<path d="M1 9 a[^"]*" fill="none"/);
    expect(svg).toContain('<path');
    // El contorno (boundary) del sistema se dibuja como grupo etiquetado.
    expect(svg).toMatch(/Sistema de software: /);
    expect(svg).toContain('marker-end="url(#arrow)"');
  });

  it('sin vista indicada usa la primera y el título de la vista', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const svg = toSvg(laid);
    expect(svg).toContain(laid.views[0].title ?? laid.views[0].id);
  });
});
