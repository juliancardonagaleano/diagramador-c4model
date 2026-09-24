import type { C4Element, ElementShape, ElementType } from '../../model/types';

/**
 * Estilos mxGraph de la librería C4 oficial de draw.io (Arrange > Insert > Shape > C4).
 * Las etiquetas usan placeholders (%c4Name%, %c4Type%, %c4Description%, %c4Technology%)
 * que draw.io resuelve a partir de los atributos del <object>.
 */

export type DrawioLocale = 'es' | 'en';

const TYPE_LABELS: Record<DrawioLocale, Record<ElementType | 'boundary-softwareSystem' | 'boundary-container' | 'relationship', string>> = {
  es: {
    person: 'Persona',
    softwareSystem: 'Sistema de software',
    container: 'Contenedor',
    component: 'Componente',
    'boundary-softwareSystem': 'Límite del sistema',
    'boundary-container': 'Límite del contenedor',
    relationship: 'Relación',
  },
  en: {
    person: 'Person',
    softwareSystem: 'Software System',
    container: 'Container',
    component: 'Component',
    'boundary-softwareSystem': 'System Scope Boundary',
    'boundary-container': 'Container Scope Boundary',
    relationship: 'Relationship',
  },
};

export function c4TypeLabel(locale: DrawioLocale, key: keyof (typeof TYPE_LABELS)['es']): string {
  return TYPE_LABELS[locale][key];
}

const POINTS_RECT =
  'points=[[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0.25,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0],[0,0.25,0]];';
const POINTS_PERSON =
  'points=[[0.5,0,0],[1,0.5,0],[1,0.75,0],[0.75,1,0],[0.5,1,0],[0.25,1,0],[0,0.75,0],[0,0.5,0]];';
const POINTS_CYLINDER =
  'points=[[0.5,0,0],[1,0.25,0],[1,0.5,0],[1,0.75,0],[0.5,1,0],[0,0.75,0],[0,0.5,0],[0,0.25,0]];';

interface Palette {
  fill: string;
  stroke: string;
}

const PALETTE: Record<ElementType, { internal: Palette; external: Palette }> = {
  person: {
    internal: { fill: '#083F75', stroke: '#06315C' },
    external: { fill: '#6C6477', stroke: '#4D4D4D' },
  },
  softwareSystem: {
    internal: { fill: '#1061B0', stroke: '#0D5091' },
    external: { fill: '#8C8496', stroke: '#736782' },
  },
  container: {
    internal: { fill: '#23A2D9', stroke: '#0E7DAD' },
    external: { fill: '#8C8496', stroke: '#736782' },
  },
  component: {
    internal: { fill: '#63BEF2', stroke: '#2086C9' },
    external: { fill: '#8C8496', stroke: '#736782' },
  },
};

function paletteFor(el: C4Element): Palette {
  const base = el.external ? PALETTE[el.type].external : PALETTE[el.type].internal;
  if (el.color) return { fill: el.color, stroke: darken(el.color) };
  return base;
}

function darken(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, ((n >> 16) & 255) - 30);
  const g = Math.max(0, ((n >> 8) & 255) - 30);
  const b = Math.max(0, (n & 255) - 30);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

export function elementStyle(el: C4Element): string {
  const { fill, stroke } = paletteFor(el);
  const common = `whiteSpace=wrap;html=1;labelBackgroundColor=none;fillColor=${fill};fontColor=#ffffff;align=center;strokeColor=${stroke};metaEdit=1;resizable=0;`;
  if (el.type === 'person') {
    return `html=1;fontSize=11;dashed=0;whiteSpace=wrap;fillColor=${fill};strokeColor=${stroke};fontColor=#ffffff;shape=mxgraph.c4.person2;align=center;metaEdit=1;${POINTS_PERSON}resizable=0;`;
  }
  const shape: ElementShape = el.shape ?? 'default';
  switch (shape) {
    case 'database':
      return `shape=cylinder3;size=15;boundedLbl=1;rounded=0;fontSize=12;${common}${POINTS_CYLINDER}`;
    case 'queue':
      return `shape=cylinder3;size=15;direction=south;boundedLbl=1;rounded=0;fontSize=12;${common}${POINTS_CYLINDER}`;
    case 'browser':
      return `shape=mxgraph.c4.webBrowserContainer;strokeWidth=1;fontSize=12;${common}${POINTS_RECT}`;
    case 'mobile':
      return `rounded=1;arcSize=30;fontSize=12;${common}${POINTS_RECT}`;
    default:
      return `rounded=1;arcSize=10;${common}${POINTS_RECT}`;
  }
}

export function elementLabel(el: C4Element): string {
  const descColor = el.type === 'component' ? '#333333' : el.type === 'container' ? '#E6E6E6' : '#cccccc';
  const typeLine =
    el.type === 'container' || el.type === 'component'
      ? '<div>[%c4Type%: %c4Technology%]</div>'
      : '<div>[%c4Type%]</div>';
  return `<b>%c4Name%</b>${typeLine}<br><div><font style="font-size: 11px"><font color="${descColor}">%c4Description%</font></div>`;
}

export function boundaryStyle(): string {
  return (
    'rounded=1;fontSize=11;whiteSpace=wrap;html=1;dashed=1;arcSize=20;fillColor=none;strokeColor=#666666;fontColor=#333333;' +
    'labelBackgroundColor=none;align=left;verticalAlign=bottom;labelBorderColor=none;spacingTop=0;spacing=10;dashPattern=8 4;' +
    'metaEdit=1;rotatable=0;perimeter=rectanglePerimeter;noLabel=0;labelPadding=0;allowArrows=0;connectable=0;expand=0;' +
    'recursiveResize=0;editable=1;pointerEvents=0;absoluteArcSize=1;container=1;collapsible=0;' +
    POINTS_RECT
  );
}

export function boundaryLabel(): string {
  return '<div style="text-align: left">%c4Name%</div><div style="text-align: left">[%c4Type%]</div>';
}

export function relationshipStyle(): string {
  return (
    'endArrow=blockThin;html=1;fontSize=10;fontColor=#404040;strokeWidth=1;endFill=1;strokeColor=#828282;elbow=vertical;' +
    'metaEdit=1;endSize=14;startSize=14;jumpStyle=arc;jumpSize=16;rounded=0;edgeStyle=orthogonalEdgeStyle;'
  );
}

export function relationshipLabel(hasTechnology: boolean): string {
  return hasTechnology
    ? '<div style="text-align: left"><b>%c4Description%</b></div><div style="text-align: left">[%c4Technology%]</div>'
    : '<div style="text-align: left"><b>%c4Description%</b></div>';
}
