import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { memo } from 'react';
import type { FlowNodeData } from './flow';
import { ShapeSvg, textColorFor } from './shapes';

export type NotationNodeType = Node<FlowNodeData, 'notation'>;

/** Nodo del lienzo: la figura y el color los dicta la notación del módulo; los nodos con hijos se dibujan como zona. */
function NotationNodeImpl({ data, selected }: NodeProps<NotationNodeType>) {
  const { node, notation, group, width, height } = data;
  const fill = node.fill ?? notation.fill;
  const ink = textColorFor(fill);

  if (group) {
    const line = node.stroke ?? fill;
    const tint = node.fill ? { background: `color-mix(in srgb, ${node.fill} 14%, transparent)` } : undefined;
    return (
      <div className="cv-group" style={{ width, height, borderColor: line, ...tint }} data-selected={selected || undefined} data-testid={`node-${node.id}`} data-kind={node.kind}>
        <Handle type="target" position={Position.Left} />
        <span className="cv-group-title" style={{ color: line }}>
          {notation.glyph} {notation.label}: {node.label}
          {node.ref && (
            <span className="cv-link cv-link-inline" title={`Enlaza con ${node.ref} (doble clic o Alt+↓ para ir)`} data-testid={`link-${node.id}`}>
              ⤷
            </span>
          )}
        </span>
        <Handle type="source" position={Position.Right} />
      </div>
    );
  }

  return (
    <div className="cv-node" style={{ width, height, color: ink }} data-selected={selected || undefined} data-testid={`node-${node.id}`} data-kind={node.kind} data-shape={notation.shape}>
      <ShapeSvg shape={notation.shape} width={width} height={height} fill={fill} stroke={node.stroke ?? notation.stroke} dashed={node.dashed} />
      <Handle type="target" position={Position.Left} />
      {node.lines ? (
        <div className="cv-node-text cv-card-text">
          <span className="cv-kind">{notation.label}</span>
          <strong>{node.label}</strong>
          {node.sublabel && <span className="cv-sub">{node.sublabel}</span>}
          <ul className="cv-lines">
            {node.lines.map((line, i) => (
              <li key={i} data-emphasis={node.lineEmphasis?.[i]}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="cv-node-text">
          <span className="cv-kind">{notation.label}</span>
          <strong>{node.label}</strong>
          {node.sublabel && <span className="cv-sub">{node.sublabel}</span>}
        </div>
      )}
      {node.ref && (
        <span className="cv-link" title={`Enlaza con ${node.ref} (doble clic o Alt+↓ para ir)`} data-testid={`link-${node.id}`}>
          ⤷
        </span>
      )}
      {node.badges && node.badges.length > 0 && (
        <div className="cv-badges">
          {node.badges.map((b) => (
            <span key={b}>{b}</span>
          ))}
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export const NotationNode = memo(NotationNodeImpl);
