import { BaseEdge, EdgeLabelRenderer, type Edge, type EdgeProps } from '@xyflow/react';
import { memo } from 'react';
import { labelPosition, pathFromPoints, type Anchor, type Point } from '../../../core/layout/edgeAnchors';
import { routeEdge } from '../../../core/layout/edgeAnchors';
import type { C4Relationship } from '../../../core/model/types';

export type RelationshipEdgeData = {
  relationship: C4Relationship;
  implied: boolean;
  /** Ruta calculada por el autolayout (ELK), si sigue siendo válida para las posiciones actuales. */
  route?: { points: Point[]; label?: Point };
  /** Anclajes calculados (puertos virtuales) cuando no hay ruta válida. */
  sourceAnchor?: Anchor;
  targetAnchor?: Anchor;
};
export type RelationshipEdgeType = Edge<RelationshipEdgeData, 'relationship'>;

function RelationshipEdgeComponent({ id, data, selected, markerEnd }: EdgeProps<RelationshipEdgeType>) {
  if (!data) return null;
  let points: Point[];
  let label: Point;
  if (data.route) {
    points = data.route.points;
    label = data.route.label ?? labelPosition(points);
  } else if (data.sourceAnchor && data.targetAnchor) {
    points = routeEdge(data.sourceAnchor, data.targetAnchor);
    label = labelPosition(points);
  } else {
    return null;
  }
  const path = pathFromPoints(points, 8);
  const rel = data.relationship;
  return (
    <g className="c4-edge-hover">
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={data.implied ? { strokeDasharray: '6 4' } : undefined} interactionWidth={16} />
      {(rel.description || rel.technology) && (
        <EdgeLabelRenderer>
          <div
            className={`c4-edge-label nodrag nopan ${selected ? 'ring-1 ring-blue-500' : ''}`}
            style={{ position: 'absolute', transform: `translate(-50%, -50%) translate(${label.x}px, ${label.y}px)` }}
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
