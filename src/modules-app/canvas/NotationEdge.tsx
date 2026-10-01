import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import type { EdgeMark } from '@iark/kernel';
import { edgeLabelText, type FlowEdgeData } from './flow';

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

/** Relación del lienzo: línea con ángulos rectos, estilo de la notación y, sobre ella, las insignias gráficas y la etiqueta. */
function NotationEdgeImpl({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, style, selected, data }: EdgeProps<NotationEdgeType>) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const marks = data?.edge.marks ?? [];
  const text = data ? edgeLabelText(data.edge) : '';
  const onPick = data?.onPick;

  return (
    <>
      {selected && <path d={path} className="cv-edge-halo" fill="none" strokeWidth={(typeof style?.strokeWidth === 'number' ? style.strokeWidth : 1.5) + 6} />}
      <BaseEdge id={id} path={path} markerStart={markerStart} markerEnd={markerEnd} style={style} />
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
