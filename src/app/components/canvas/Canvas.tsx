import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deriveView } from '../../../core/model/viewDerivation';
import { PARENT_TYPE } from '../../../core/model/types';
import { useDocumentStore } from '../../store/documentStore';
import { BoundaryNode, type BoundaryNodeType } from './BoundaryNode';
import { ElementNode, elementColor, type ElementNodeType } from './ElementNode';
import { RelationshipEdge, type RelationshipEdgeType } from './RelationshipEdge';

const nodeTypes = { element: ElementNode, boundary: BoundaryNode };
const edgeTypes = { relationship: RelationshipEdge };

type CanvasNode = ElementNodeType | BoundaryNodeType;

export function Canvas() {
  const doc = useDocumentStore((s) => s.doc);
  const activeViewId = useDocumentStore((s) => s.activeViewId);
  const selection = useDocumentStore((s) => s.selection);
  const readOnly = useDocumentStore((s) => s.readOnly);
  const showGrid = useDocumentStore((s) => s.ui.showGrid);
  const showMinimap = useDocumentStore((s) => s.ui.showMinimap);
  const theme = useDocumentStore((s) => s.ui.theme);
  const layoutBusy = useDocumentStore((s) => s.layoutBusy);
  const { moveElements, addRelationship, select, updateElement, runAutoLayout } = useDocumentStore.getState();
  const { fitView } = useReactFlow();

  const derived = useMemo(() => (activeViewId && doc.views.some((v) => v.id === activeViewId) ? deriveView(doc, activeViewId) : null), [doc, activeViewId]);

  // Autolayout automático cuando hay elementos sin posición (p. ej. documento generado por IA o recién importado).
  const layoutRequested = useRef<string | null>(null);
  useEffect(() => {
    if (!derived || layoutBusy) return;
    const needs = derived.nodes.some((n) => !n.positioned);
    const key = `${derived.view.id}:${derived.nodes.map((n) => n.id).join(',')}`;
    if (needs && layoutRequested.current !== key) {
      layoutRequested.current = key;
      void runAutoLayout(derived.view.id, { force: false }).then(() => setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50));
    }
  }, [derived, layoutBusy, runAutoLayout, fitView]);

  const derivedNodes = useMemo<CanvasNode[]>(() => {
    if (!derived) return [];
    const boundaries: BoundaryNodeType[] = derived.boundaries
      .filter((b) => b.x !== undefined)
      .map((b) => ({
        id: b.id,
        type: 'boundary',
        position: { x: b.x!, y: b.y! },
        width: b.width,
        height: b.height,
        data: { element: b.element },
        selected: selection.kind === 'element' && selection.id === b.id,
        draggable: !readOnly,
        selectable: true,
        zIndex: -1,
        style: { width: b.width, height: b.height },
      }));
    const nodes: ElementNodeType[] = derived.nodes
      .filter((n) => n.positioned)
      .map((n) => ({
        id: n.id,
        type: 'element',
        position: { x: n.x!, y: n.y! },
        width: n.width,
        height: n.height,
        data: { element: n.element, readOnly },
        selected: selection.kind === 'element' && selection.id === n.id,
        draggable: !readOnly,
        connectable: !readOnly,
      }));
    return [...boundaries, ...nodes];
  }, [derived, selection, readOnly]);

  const derivedEdges = useMemo<RelationshipEdgeType[]>(() => {
    if (!derived) return [];
    return derived.edges.map((e) => ({
      id: e.id,
      type: 'relationship',
      source: e.sourceId,
      target: e.targetId,
      data: { relationship: e.relationship, implied: e.implied },
      selected: selection.kind === 'relationship' && selection.id === e.relationship.id,
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: selection.kind === 'relationship' && selection.id === e.relationship.id ? '#175e7a' : '#808080' },
    }));
  }, [derived, selection]);

  // Estado local para arrastre fluido; se sincroniza con el store al terminar.
  const [nodes, setNodes] = useState<CanvasNode[]>(derivedNodes);
  useEffect(() => setNodes(derivedNodes), [derivedNodes]);

  const dragStart = useRef<Map<string, { x: number; y: number }>>(new Map());

  const onNodesChange = useCallback((changes: NodeChange<CanvasNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const onNodeDragStart = useCallback((_: unknown, __: Node, dragged: Node[]) => {
    dragStart.current = new Map(dragged.map((n) => [n.id, { ...n.position }]));
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, __: Node, dragged: Node[]) => {
      if (!derived) return;
      const moves: Array<{ id: string; x: number; y: number }> = [];
      const boundaryIds = new Set(derived.boundaries.map((b) => b.id));
      const descendantsOf = (boundaryId: string): string[] => {
        const b = derived.boundaries.find((x) => x.id === boundaryId);
        if (!b) return [];
        return b.children.flatMap((c) => (boundaryIds.has(c) ? descendantsOf(c) : [c]));
      };
      const draggedIds = new Set(dragged.map((n) => n.id));
      for (const n of dragged) {
        const start = dragStart.current.get(n.id);
        if (boundaryIds.has(n.id)) {
          if (!start) continue;
          const dx = n.position.x - start.x;
          const dy = n.position.y - start.y;
          for (const cid of descendantsOf(n.id)) {
            if (draggedIds.has(cid)) continue;
            const child = derived.nodes.find((x) => x.id === cid);
            if (child?.positioned) moves.push({ id: cid, x: child.x! + dx, y: child.y! + dy });
          }
        } else {
          moves.push({ id: n.id, x: n.position.x, y: n.position.y });
        }
      }
      moveElements(derived.view.id, moves);

      // Soltar un nodo dentro de un boundary compatible lo adopta como padre.
      if (dragged.length === 1 && !boundaryIds.has(dragged[0].id)) {
        const n = dragged[0];
        const node = derived.nodes.find((x) => x.id === n.id);
        if (node) {
          const cx = n.position.x + node.width / 2;
          const cy = n.position.y + node.height / 2;
          const target = derived.boundaries.find(
            (b) =>
              b.x !== undefined &&
              cx >= b.x &&
              cx <= b.x + (b.width ?? 0) &&
              cy >= b.y! &&
              cy <= b.y! + (b.height ?? 0) &&
              PARENT_TYPE[node.element.type] === b.element.type &&
              node.element.parentId !== b.id,
          );
          if (target) updateElement(n.id, { parentId: target.id });
        }
      }
    },
    [derived, moveElements, updateElement],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (readOnly || !c.source || !c.target || c.source === c.target) return;
      addRelationship(c.source, c.target);
    },
    [addRelationship, readOnly],
  );

  const onSelectionChange = useCallback(
    ({ nodes: sn, edges: se }: OnSelectionChangeParams) => {
      const current = useDocumentStore.getState().selection;
      if (sn.length > 0) {
        const id = sn[sn.length - 1].id;
        if (current.kind !== 'element' || current.id !== id) select({ kind: 'element', id });
      } else if (se.length > 0) {
        const data = (se[0] as Edge<{ relationship: { id: string } }>).data;
        const id = data?.relationship.id ?? se[0].id;
        if (current.kind !== 'relationship' || current.id !== id) select({ kind: 'relationship', id });
      } else if (current.kind !== 'none') {
        select({ kind: 'none' });
      }
    },
    [select],
  );

  if (!derived) {
    return (
      <div className="c4-canvas flex h-full w-full items-center justify-center text-color-2">
        <div className="text-center">
          <div className="text-lg font-semibold">No hay ninguna vista</div>
          <div className="text-sm">Crea una vista en la pestaña "Vistas" o carga un documento.</div>
        </div>
      </div>
    );
  }

  return (
    <ReactFlow
      className="c4-canvas"
      colorMode={theme}
      nodes={nodes}
      edges={derivedEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onSelectionChange={onSelectionChange}
      connectionMode={ConnectionMode.Loose}
      nodesConnectable={!readOnly}
      elementsSelectable
      deleteKeyCode={null}
      panOnScroll
      selectionOnDrag={false}
      panOnDrag={[1, 2]}
      zoomOnScroll={false}
      zoomActivationKeyCode="Control"
      minZoom={0.1}
      maxZoom={3}
      snapToGrid
      snapGrid={[12, 12]}
      fitView
      fitViewOptions={{ padding: 0.15 }}
      defaultEdgeOptions={{ type: 'relationship' }}
    >
      {showGrid && <Background variant={BackgroundVariant.Dots} gap={24} size={1.7} color="rgb(99, 152, 191)" />}
      {showMinimap && (
        <MiniMap
          pannable
          zoomable
          nodeColor={(n) => (n.type === 'boundary' ? 'transparent' : elementColor((n as ElementNodeType).data.element))}
          nodeStrokeWidth={2}
          maskColor={theme === 'dark' ? 'rgba(22,22,26,0.7)' : 'rgba(240,240,240,0.7)'}
        />
      )}
    </ReactFlow>
  );
}
