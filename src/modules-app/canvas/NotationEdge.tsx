import { BaseEdge, EdgeLabelRenderer, Position, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { edgeEndPaths, polylineMidpoint, routePath, type EdgeEnd, type EdgeMark } from '@iark/kernel';
import { edgeLabelText, followRoute, type FlowEdgeData } from './flow';

export type NotationEdgeType = Edge<FlowEdgeData, 'notation'>;

const MARK_INK = '#334155';

function Mark({ mark, edgeId, index }: { mark: EdgeMark; edgeId: string; index: number }) {
  const color = mark.color ?? MARK_INK;
  const testId = `edge-mark-${edgeId}-${index}`;
  if (mark.icon && mark.icon.length > 0) {
    return (
      <span className="cv-mark cv-mark-icon" style={{ color, borderColor: color }} title={mark.title} role="img" aria-label={mark.title ?? 'Insignia'} data-testid={testId}>
        <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {mark.icon.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      </span>
    );
  }
  return (
    <span className="cv-mark cv-mark-num" style={{ background: color }} title={mark.title} data-testid={testId}>
      {mark.text}
    </span>
  );
}

const OUTWARD: Record<Position, { x: number; y: number }> = {
  [Position.Left]: { x: -1, y: 0 },
  [Position.Right]: { x: 1, y: 0 },
  [Position.Top]: { x: 0, y: -1 },
  [Position.Bottom]: { x: 0, y: 1 },
};

/** Remate de pata de gallo en el extremo de una relación: la línea sale del nodo en la dirección de su asa, hacia fuera. */
function EdgeEndGlyph({ end, at, position, id, side }: { end: EdgeEnd; at: { x: number; y: number }; position: Position; id: string; side: 'source' | 'target' }) {
  // `edgeEndPaths` espera la dirección en que va la línea desde el nodo (hacia fuera del asa).
  const dir = OUTWARD[position];
  return (
    <path
      d={edgeEndPaths(end, at, dir).join(' ')}
      className="cv-edge-end"
      fill="none"
      strokeLinecap="round"
      data-testid={`edge-end-${id}-${side}`}
      data-end={end}
    />
  );
}

/** Relación del lienzo: línea con ángulos rectos, estilo de la notación y, sobre ella, las insignias gráficas y la etiqueta. */
/** Adorno en el origen de la línea (rombo de la composición, punto de la asignación): sale por la derecha del nodo de origen. */
function Tail({ kind, x, y, color }: { kind: 'diamond' | 'dot'; x: number; y: number; color: string }) {
  return kind === 'dot' ? (
    <circle cx={x + 4} cy={y} r={4} fill={color} data-testid="edge-tail" data-tail="dot" />
  ) : (
    <path d={`M${x} ${y} L${x + 6} ${y - 4} L${x + 12} ${y} L${x + 6} ${y + 4} z`} fill={color} data-testid="edge-tail" data-tail="diamond" />
  );
}

function NotationEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, style, selected, data }: EdgeProps<NotationEdgeType>) {
  // La colocación de la vista puede fijar dónde gira la arista (la pista que evita que se corte con las demás); si el usuario
  // ha movido los nodos y ese giro ya no queda entre los dos extremos, se traza como siempre.
  const vertical = sourcePosition === Position.Top || sourcePosition === Position.Bottom;
  const bend = data?.bend;
  const pinned = bend !== undefined && (vertical ? (bend - sourceY) * (bend - targetY) < 0 : (bend - sourceX) * (bend - targetX) < 0);
  // Con más de un codo (sube por un pasillo libre, por ejemplo) la vista fija el recorrido entero y el lienzo lo sigue mientras los nodos no se muevan.
  const route = data?.route && data.route.length > 4 ? followRoute(data.route, { x: sourceX, y: sourceY }, { x: targetX, y: targetY }) : undefined;
  const [stepPath, stepLabelX, stepLabelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, ...(pinned ? { offset: 8, ...(vertical ? { centerY: bend } : { centerX: bend }) } : {}) });
  const middle = route ? polylineMidpoint(route) : undefined;
  const [path, labelX, labelY] = route && middle ? [routePath(route), middle.x, middle.y] : [stepPath, stepLabelX, stepLabelY];
  const marks = data?.edge.marks ?? [];
  const text = data ? edgeLabelText(data.edge) : '';
  const onPick = data?.onPick;

  return (
    <>
      {selected && <path d={path} className="cv-edge-halo" fill="none" strokeWidth={(typeof style?.strokeWidth === 'number' ? style.strokeWidth : 1.5) + 6} />}
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} />
      {data?.notation.tail && <Tail kind={data.notation.tail} x={sourceX} y={sourceY} color={String(style?.stroke ?? '#475569')} />}
      {data?.edge.ends?.source && <EdgeEndGlyph end={data.edge.ends.source} at={{ x: sourceX, y: sourceY }} position={sourcePosition} id={id} side="source" />}
      {data?.edge.ends?.target && <EdgeEndGlyph end={data.edge.ends.target} at={{ x: targetX, y: targetY }} position={targetPosition} id={id} side="target" />}
      {(marks.length > 0 || text) && (
        <EdgeLabelRenderer>
          <div
            className="cv-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            data-selected={selected || undefined}
            data-testid={`edge-label-${id}`}
            onClick={(e) => onPick?.(id, e.ctrlKey || e.metaKey)}
          >
            {marks.map((mark, i) => (
              <Mark key={i} mark={mark} edgeId={id} index={i} />
            ))}
            {text && <span className="cv-edge-text">{text}</span>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const NotationEdge = memo(NotationEdgeImpl);
