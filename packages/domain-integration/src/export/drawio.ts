import type { IntegrationDocument, NodeKind } from '../types';
import { KIND_LABELS } from '../types';
import { listViews } from '../views';
import { colorOf, layoutView } from './render';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

const SHAPES: Partial<Record<NodeKind, string>> = {
  store: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  queue: 'rounded=1;arcSize=50;',
  topic: 'rounded=1;arcSize=50;',
};

/** Exporta todas las vistas (mapa y flujos) a un `.drawio`, una página por vista, ya colocadas con el autolayout. */
export async function toDrawio(doc: IntegrationDocument): Promise<string> {
  const pages: string[] = [];
  for (const view of listViews(doc)) {
    const { layout, nodes, interactions, labels } = await layoutView(doc, view.id);
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      const n = nodes.get(g.id)!;
      cells.push(
        `<mxCell id="n-${esc(g.id)}" value="${esc(`${KIND_LABELS[n.kind]}: ${n.name}`)}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f8fafc;strokeColor=#94a3b8;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry"/></mxCell>`,
      );
    }
    for (const b of layout.nodes) {
      const n = nodes.get(b.id)!;
      const value = [`<b>${esc(n.name)}</b>`, n.technology ? esc(n.technology) : '', `<i>${KIND_LABELS[n.kind]}</i>`].filter(Boolean).join('<br>');
      const style = `${SHAPES[n.kind] ?? 'rounded=1;'}whiteSpace=wrap;html=1;fillColor=${colorOf(n)};fontColor=#ffffff;strokeColor=#0f172a;${n.external ? 'dashed=1;' : ''}`;
      cells.push(`<mxCell id="n-${esc(b.id)}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`);
    }
    for (const e of layout.edges) {
      const it = interactions.get(e.id)!;
      const dashed = it.style !== 'request-response' ? 'dashed=1;' : '';
      const width = it.style === 'event' || it.style === 'stream' ? 'strokeWidth=3;' : '';
      const points = e.points.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('');
      cells.push(
        `<mxCell id="e-${esc(e.id)}" value="${esc(labels.get(e.id) ?? '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;${dashed}${width}" edge="1" parent="1" source="n-${esc(it.sourceId)}" target="n-${esc(it.targetId)}"><mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
      );
    }
    pages.push(
      `<diagram id="${esc(view.id)}" name="${esc(view.title.slice(0, 60))}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram>`,
    );
  }
  return `<mxfile host="iark-diagrams" agent="iark-diagrams" version="24.0.0" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
}
