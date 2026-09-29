import { indexElements, KIND_LABELS, type Capability, type EnterpriseDocument } from '../types';
import { listViews } from '../views';
import { applicationsByCapability } from '../graph';
import { MATURITY_COLORS, MATURITY_UNKNOWN, edgeLabel, elementLines, graphNodeStyle, isDashed, layoutView } from './render';

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

const SHAPES = {
  technology: 'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=12;',
  process: 'rounded=1;arcSize=50;',
  capability: 'rounded=1;',
  application: 'rounded=0;',
} as const;

/** Exporta todas las vistas (mapa de capacidades, paisaje y unidades) a un `.drawio`, una página por vista, ya colocadas. */
export async function toDrawio(doc: EnterpriseDocument): Promise<string> {
  const pages: string[] = [];
  const all = indexElements(doc);
  const capabilities = new Map<string, Capability>(doc.capabilities.map((c) => [c.id, c]));
  const apps = applicationsByCapability(doc);
  for (const v of listViews(doc)) {
    const { view, layout, elements, edges, contextIds } = await layoutView(doc, v.id);
    const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
    for (const g of layout.groups) {
      cells.push(
        `<mxCell id="n-${esc(g.id)}" value="${esc(all.get(g.id)!.name)}" style="rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f8fafc;strokeColor=#94a3b8;verticalAlign=top;align=left;spacingLeft=10;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" as="geometry"/></mxCell>`,
      );
    }
    for (const b of layout.nodes) {
      let value: string;
      let style: string;
      if (view.type === 'capabilities') {
        const c = capabilities.get(b.id)!;
        const count = apps.get(b.id)?.size ?? 0;
        const [title, ...rest] = elementLines(all.get(b.id)!, doc);
        value = [`<b>${esc(title)}</b>`, ...rest.map(esc), count === 0 ? '<i>sin aplicación</i>' : `${count} ${count === 1 ? 'aplicación' : 'aplicaciones'}`].join('<br>');
        style = `${SHAPES.capability}whiteSpace=wrap;html=1;fillColor=${c.maturity ? MATURITY_COLORS[c.maturity - 1] : MATURITY_UNKNOWN};fontColor=#0f172a;strokeColor=#495057;${count === 0 ? 'dashed=1;' : ''}`;
      } else {
        const e = elements.get(b.id)!;
        const s = graphNodeStyle(e, doc, contextIds.has(b.id));
        const [title, ...rest] = s.lines;
        value = [`<b>${esc(title)}</b>`, ...rest.map(esc), `<i>${KIND_LABELS[e.kind]}</i>`].join('<br>');
        style = `${SHAPES[e.kind as keyof typeof SHAPES] ?? 'rounded=1;'}whiteSpace=wrap;html=1;fillColor=${s.fill};fontColor=#ffffff;strokeColor=${s.stroke.slice(0, 7)};${s.dashed ? 'dashed=1;' : ''}`;
      }
      cells.push(`<mxCell id="n-${esc(b.id)}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" as="geometry"/></mxCell>`);
    }
    for (const e of layout.edges) {
      const { relation, source, target } = edges.get(e.id)!;
      const points = e.points.slice(1, -1).map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`).join('');
      cells.push(
        `<mxCell id="e-${esc(e.id)}" value="${esc(edgeLabel(relation) ?? '')}" style="edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;${isDashed(relation) ? 'dashed=1;' : ''}" edge="1" parent="1" source="n-${esc(source)}" target="n-${esc(target)}"><mxGeometry relative="1" as="geometry">${points ? `<Array as="points">${points}</Array>` : ''}</mxGeometry></mxCell>`,
      );
    }
    pages.push(
      `<diagram id="${esc(view.id)}" name="${esc(view.title.slice(0, 60))}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram>`,
    );
  }
  return `<mxfile host="iark-diagrams" agent="iark-diagrams" version="24.0.0" type="device">\n${pages.join('\n')}\n</mxfile>\n`;
}
