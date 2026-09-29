import { KIND_LABELS, type AssetKind, type DataDocument } from '../types';
import { listViews } from '../views';
import { KIND_COLORS, colorOf, entityLines, governanceLine, isDashed, layoutView, pipelineLine, relationLabel, strokeOf } from './render';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

const SHAPES: Partial<Record<AssetKind, string>> = {
  database: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  warehouse: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  lake: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  stream: 'rounded=1;arcSize=50;',
};

/** Exporta todas las vistas (linaje, ERD y dominios) a un `.drawio`, una página por vista, ya colocadas con el autolayout. */
export async function toDrawio(doc: DataDocument): Promise<string> {
  const pages: string[] = [];
  for (const view of listViews(doc)) {
    const { layout, assets, pipelineNodes, edges, contextIds } = await layoutView(doc, view.id);
    const erd = view.type === 'erd';
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      const a = assets.get(g.id)!;
      cells.push(
        `<mxCell id="n-${esc(g.id)}" value="${esc(`${KIND_LABELS[a.kind]}: ${a.name}`)}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f8fafc;strokeColor=#94a3b8;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry"/></mxCell>`,
      );
    }
    for (const b of layout.nodes) {
      const pipeline = pipelineNodes.get(b.id);
      let value: string;
      let style: string;
      if (pipeline) {
        value = [`<b>${esc(pipeline.name)}</b>`, esc(pipelineLine(pipeline)), pipeline.tool ? esc(pipeline.tool) : ''].filter(Boolean).join('<br>');
        style = 'rounded=1;arcSize=50;whiteSpace=wrap;html=1;fillColor=#334155;fontColor=#ffffff;strokeColor=#0f172a;';
      } else if (erd) {
        const a = assets.get(b.id)!;
        const [title, ...rest] = entityLines(a);
        value = [`<b>${esc(title)}</b>`, ...rest.map(esc)].join('<br>');
        style = `rounded=0;whiteSpace=wrap;html=1;align=left;verticalAlign=top;spacingLeft=8;fillColor=#ffffff;fontColor=#0f172a;strokeColor=${KIND_COLORS[a.kind]};`;
      } else {
        const a = assets.get(b.id)!;
        const context = contextIds.has(b.id);
        value = [`<b>${esc(a.name)}</b>`, a.technology ? esc(a.technology) : '', `<i>${KIND_LABELS[a.kind]}</i>`, governanceLine(a) ? esc(governanceLine(a)) : ''].filter(Boolean).join('<br>');
        style = `${SHAPES[a.kind] ?? 'rounded=1;'}whiteSpace=wrap;html=1;fillColor=${colorOf(a, context)};fontColor=#ffffff;strokeColor=${strokeOf(a).slice(0, 7)};${a.external || context ? 'dashed=1;' : ''}`;
      }
      cells.push(`<mxCell id="n-${esc(b.id)}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`);
    }
    for (const e of layout.edges) {
      const { source, target, relation, pipeline } = edges.get(e.id)!;
      const dashed = isDashed(pipeline) ? 'dashed=1;' : '';
      const points = e.points.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('');
      cells.push(
        `<mxCell id="e-${esc(e.id)}" value="${esc(relation ? relationLabel(relation) : '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;${dashed}" edge="1" parent="1" source="n-${esc(source)}" target="n-${esc(target)}"><mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
      );
    }
    pages.push(
      `<diagram id="${esc(view.id)}" name="${esc(view.title.slice(0, 60))}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram>`,
    );
  }
  return `<mxfile host="iark-diagrams" agent="iark-diagrams" version="24.0.0" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
}
