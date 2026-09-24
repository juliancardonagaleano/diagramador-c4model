import { BaseEdge, EdgeLabelRenderer, Position, getSmoothStepPath, useInternalNode, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';
import { memo } from 'react';
import type { C4Relationship } from '../../../core/model/types';

export type RelationshipEdgeData = { relationship: C4Relationship; implied: boolean };
export type RelationshipEdgeType = Edge<RelationshipEdgeData, 'relationship'>;

/** Punto de la frontera de un nodo hacia el centro del otro (aristas "flotantes"). */
function borderPoint(node: InternalNode, other: InternalNode): { x: number; y: number; position: Position } {
  const w = node.measured.width ?? node.width ?? 0;
  const h = node.measured.height ?? node.height ?? 0;
  const ow = other.measured.width ?? other.width ?? 0;
  const oh = other.measured.height ?? other.height ?? 0;
  const cx = node.internals.positionAbsolute.x + w / 2;
  const cy = node.internals.positionAbsolute.y + h / 2;
  const ocx = other.internals.positionAbsolute.x + ow / 2;
  const ocy = other.internals.positionAbsolute.y + oh / 2;
  const dx = ocx - cx;
  const dy = ocy - cy;
  if (Math.abs(dx) * h > Math.abs(dy) * w) {
    // sale por izquierda/derecha
    const sign = dx > 0 ? 1 : -1;
    return { x: cx + (sign * w) / 2, y: cy + ((dy / (Math.abs(dx) || 1)) * w) / 2, position: sign > 0 ? Position.Right : Position.Left };
  }
  const sign = dy > 0 ? 1 : -1;
  return { x: cx + ((dx / (Math.abs(dy) || 1)) * h) / 2, y: cy + (sign * h) / 2, position: sign > 0 ? Position.Bottom : Position.Top };
}

function RelationshipEdgeComponent({ id, source, target, data, selected, markerEnd }: EdgeProps<RelationshipEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;
  const s = borderPoint(sourceNode, targetNode);
  const t = borderPoint(targetNode, sourceNode);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: s.x,
    sourceY: s.y,
    sourcePosition: s.position,
    targetX: t.x,
    targetY: t.y,
    targetPosition: t.position,
    borderRadius: 6,
  });
  const rel = data?.relationship;
  return (
    <g className="c4-edge-hover">
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={data?.implied ? { strokeDasharray: '6 4' } : undefined} interactionWidth={16} />
      {rel && (rel.description || rel.technology) && (
        <EdgeLabelRenderer>
          <div
            className={`c4-edge-label nodrag nopan ${selected ? 'ring-1 ring-blue-500' : ''}`}
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {rel.description && <b>{rel.description}</b>}
            {rel.technology && <small>[{rel.technology}]</small>}
          </div>
        </EdgeLabelRenderer>
      )}
    </g>
  );
}

export const RelationshipEdge = memo(RelationshipEdgeComponent);
