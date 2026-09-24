import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';
import { C4_COLORS, C4_EXTERNAL_COLOR, ELEMENT_TYPE_LABELS, type C4Element } from '../../../core/model/types';

export type ElementNodeData = { element: C4Element; readOnly?: boolean };
export type ElementNodeType = Node<ElementNodeData, 'element'>;

export function elementColor(el: C4Element): string {
  if (el.color) return el.color;
  return el.external ? C4_EXTERNAL_COLOR : C4_COLORS[el.type];
}

function shapeIcon(el: C4Element): string | null {
  switch (el.shape) {
    case 'database':
      return '🛢';
    case 'queue':
      return '📨';
    case 'browser':
      return '🌐';
    case 'mobile':
      return '📱';
    default:
      return null;
  }
}

function ElementNodeComponent({ data, selected, width, height }: NodeProps<ElementNodeType>) {
  const el = data.element;
  const color = elementColor(el);
  const typeLine =
    el.type === 'container' || el.type === 'component'
      ? `[${ELEMENT_TYPE_LABELS[el.type]}${el.technology ? `: ${el.technology}` : ''}]`
      : `[${ELEMENT_TYPE_LABELS[el.type]}${el.external ? ' externo' : ''}]`;
  const icon = shapeIcon(el);
  return (
    <div className={`c4-node group ${selected ? 'selected' : ''} ${el.type === 'person' ? 'is-person' : ''}`} style={{ width, height }}>
      <div className="c4-node-strip" style={{ backgroundColor: color }}>
        {el.type === 'person' && (
          <svg width="30" height="30" viewBox="0 0 24 24" fill="white" aria-hidden>
            <circle cx="12" cy="8" r="4" />
            <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
          </svg>
        )}
      </div>
      <div className="c4-node-header" title={el.name}>
        <span className="truncate">{el.name}</span>
        {icon && <span className="text-sm">{icon}</span>}
      </div>
      <div className="c4-node-type">{typeLine}</div>
      {el.description && <div className="c4-node-desc">{el.description}</div>}
      <Handle type="source" position={Position.Top} id="top" isConnectable={!data.readOnly} />
      <Handle type="source" position={Position.Right} id="right" isConnectable={!data.readOnly} />
      <Handle type="source" position={Position.Bottom} id="bottom" isConnectable={!data.readOnly} />
      <Handle type="source" position={Position.Left} id="left" isConnectable={!data.readOnly} />
    </div>
  );
}

export const ElementNode = memo(ElementNodeComponent);
