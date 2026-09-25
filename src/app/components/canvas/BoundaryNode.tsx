import type { Node, NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { ELEMENT_TYPE_LABELS, type C4Element } from '../../../core/model/types';

export type BoundaryNodeData = { element: C4Element };
export type BoundaryNodeType = Node<BoundaryNodeData, 'boundary'>;

function BoundaryNodeComponent({ data, selected }: NodeProps<BoundaryNodeType>) {
  const el = data.element;
  return (
    <div className={`c4-boundary ${selected ? 'selected' : ''}`}>
      <div className="c4-boundary-label truncate" title={`${el.name} [${ELEMENT_TYPE_LABELS[el.type]}]`}>
        <b>{el.name}</b> [{ELEMENT_TYPE_LABELS[el.type]}]
      </div>
    </div>
  );
}

export const BoundaryNode = memo(BoundaryNodeComponent);
