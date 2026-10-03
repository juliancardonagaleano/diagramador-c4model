import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MarkerType,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  useStore as useFlowStore,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import { Toast } from '@douyinfe/semi-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deriveView, resolveDropReparent, type DerivedView } from '@core/model/viewDerivation';
import { findChildView } from '@core/model/factories';
import type { Point, Rect } from '@core/layout/edgeAnchors';
import { estimateLabelSize } from '@core/layout/labelMetrics';
import { routeMatchesNodes } from '@core/layout/quality';
import { routeEdges } from '@core/layout/router';
import { pauseHistory, useDocumentStore } from '../../store/documentStore';
import { BoundaryNode, type BoundaryNodeType } from './BoundaryNode';
import { holdCamera, useCameraPending, useFitCamera } from './camera';
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
  const nodeStyle = useDocumentStore((s) => s.ui.nodeStyle);
  const layoutBusy = useDocumentStore((s) => s.layoutBusy);
  const { moveElements, addRelationship, select, runAutoLayout, drillDown } = useDocumentStore.getState();
  const { fit, fitAfter } = useFitCamera();

  const derived = useMemo(() => (activeViewId && doc.views.some((v) => v.id === activeViewId) ? deriveView(doc, activeViewId) : null), [doc, activeViewId]);

  // Autolayout automático cuando hay elementos sin posición (p. ej. documento generado por IA,
  // recién importado, o la carga inicial de la app antes de que exista nada persistido). No se
  // registra como paso de deshacer propio (pauseHistory, anidable con otras pausas como la de exportar):
  // si no, un Ctrl+Z de más después de las acciones del usuario retrocede a este estado "sin posicionar"
  // en vez de quedarse quieto.
  const layoutRequested = useRef<string | null>(null);
  useEffect(() => {
    if (!derived || layoutBusy) return;
    const needs = derived.nodes.some((n) => !n.positioned);
    const key = `${derived.view.id}:${derived.nodes.map((n) => n.id).join(',')}`;
    if (needs && layoutRequested.current !== key) {
      layoutRequested.current = key;
      const wasModified = useDocumentStore.getState().modified;
      const resumeHistory = pauseHistory();
      const layout = runAutoLayout(derived.view.id, { force: false });
      fitAfter(layout, { padding: 0.15, duration: 300 }, 50);
      void layout
        .catch((error) => Toast.error(`Autolayout automático falló: ${(error as Error).message}`))
        .finally(() => {
          resumeHistory();
          // Colocar por primera vez una vista no es una edición del usuario: no debe marcar "Cambios sin guardar".
          useDocumentStore.setState({ modified: wasModified });
        });
    }
  }, [derived, layoutBusy, runAutoLayout, fitAfter]);

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
        data: { element: n.element, readOnly, nodeStyle, childViewId: findChildView(doc, n.id)?.id },
        selected: selection.kind === 'element' && selection.id === n.id,
        draggable: !readOnly,
        connectable: !readOnly,
      }));
    return [...boundaries, ...nodes];
  }, [derived, selection, readOnly, nodeStyle, doc]);

  // Doble clic: bajar al nivel inferior (sistema → contenedores, contenedor → componentes).
  const onNodeDoubleClick = useCallback(
    (_: unknown, node: Node) => {
      if (node.type !== 'element') return;
      // El encuadre se anota antes de cambiar de vista: el render que ya muestra la vista nueva ya cuenta como pendiente.
      const release = holdCamera();
      const target = drillDown(node.id);
      if (target) fit({ padding: 0.15, duration: 300 }, 80, release);
      else release();
    },
    [drillDown, fit],
  );

  // Estado local para arrastre fluido; se sincroniza con el store al terminar.
  const [nodes, setNodes] = useState<CanvasNode[]>(derivedNodes);
  useEffect(() => setNodes(derivedNodes), [derivedNodes]);

  // Señal de «asentado» para las pruebas y para quien integre el editor (`data-layout` en el lienzo): «ready» cuando la vista
  // activa ya tiene todos sus nodos colocados (ELK no está trabajando), lo dibujado corresponde a esa vista y la cámara ha
  // terminado de encuadrar. Se deriva al renderizar, no en un efecto, así que pasa a «pending» en el mismo render en que
  // cambia la vista o la estructura, sin esperar a ELK. `fitViewQueued` cubre el encuadre inicial de React Flow (prop `fitView`).
  const flowFitQueued = useFlowStore((s) => s.fitViewQueued);
  // React Flow encola su encuadre inicial en un efecto al montarse; hasta que ese efecto ha corrido no se puede saber si lo hay.
  const hasView = derived !== null;
  const [flowMounted, setFlowMounted] = useState(false);
  useEffect(() => setFlowMounted(hasView), [hasView]);
  const cameraPending = useCameraPending();
  const placed = derived !== null && derived.nodes.every((n) => n.positioned);
  // Lo dibujado se mira en el estado interno de React Flow, que va un efecto por detrás del estado local `nodes`.
  const drawn = useFlowStore((s) => s.nodes.length === derivedNodes.length && s.nodes.every((n, i) => n.id === derivedNodes[i].id));
  // Con la vista vacía React Flow deja su encuadre inicial encolado hasta que aparezca el primer nodo: no hay nada que encuadrar.
  const settled = flowMounted && placed && drawn && !layoutBusy && !cameraPending && !(flowFitQueued && derivedNodes.length > 0);

  // Aristas: ruta del autolayout si sigue siendo válida para las posiciones actuales
  // (incluido el arrastre en curso); si no, anclajes repartidos por lado (puertos virtuales).
  const derivedEdges = useMemo<RelationshipEdgeType[]>(() => {
    if (!derived) return [];
    const rects: Rect[] = nodes
      .filter((n) => n.type === 'element')
      .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, width: n.width ?? 240, height: n.height ?? 130 }));
    const rectById = new Map(rects.map((r) => [r.id, r]));
    const direction = derived.view.layout?.direction ?? 'DOWN';
    const stored = new Map((derived.view.edges ?? []).map((r) => [r.id, r]));
    const valid = new Map<string, { points: Point[]; label?: Point }>();
    const pending: DerivedView['edges'] = [];
    for (const e of derived.edges) {
      const route = stored.get(e.id);
      const s = rectById.get(e.sourceId);
      const t = rectById.get(e.targetId);
      if (route && s && t && routeMatchesNodes(route, s, t)) valid.set(e.id, { points: route.points, label: route.label });
      else pending.push(e);
    }
    // Aristas sin ruta válida (p. ej. tras mover un nodo): enrutado propio con esquiva de obstáculos.
    if (pending.length > 0) {
      const boundaryRects: Rect[] = nodes
        .filter((n) => n.type === 'boundary')
        .map((n) => ({ id: n.id, x: n.position.x, y: n.position.y, width: n.width ?? 0, height: n.height ?? 0 }));
      const boundaryParent = new Map(derived.boundaries.map((b) => [b.id, b.boundaryId]));
      const containment = new Map<string, Set<string>>();
      for (const n of derived.nodes) {
        const set = new Set<string>();
        let current = n.boundaryId;
        while (current && !set.has(current)) {
          set.add(current);
          current = boundaryParent.get(current);
        }
        containment.set(n.id, set);
      }
      const routed = routeEdges({
        rects,
        boundaries: boundaryRects,
        containment,
        edges: pending.map((e) => ({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: estimateLabelSize(e.relationship.description, e.relationship.technology) })),
        direction,
        spacing: 70,
      });
      for (const r of routed) valid.set(r.id, { points: r.points, label: r.label });
    }
    return derived.edges.map((e) => {
      const isSelected = selection.kind === 'relationship' && selection.id === e.relationship.id;
      return {
        id: e.id,
        type: 'relationship',
        source: e.sourceId,
        target: e.targetId,
        data: { relationship: e.relationship, implied: e.implied, route: valid.get(e.id) },
        selected: isSelected,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: isSelected ? '#175e7a' : '#808080' },
      };
    });
  }, [derived, selection, nodes]);

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
      // Soltar un nodo dentro de un boundary compatible lo adopta como padre; salir de la caja que lo
      // contenía lo desvincula (ver resolveDropReparent). Se aplica junto con el movimiento en una
      // sola llamada al store para que quede como un único paso de deshacer.
      const reparent =
        dragged.length === 1 && !boundaryIds.has(dragged[0].id) ? (resolveDropReparent(derived, dragged[0].id, dragged[0].position) ?? undefined) : undefined;
      moveElements(derived.view.id, moves, reparent);
    },
    [derived, moveElements],
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
      <div className="c4-canvas flex h-full w-full items-center justify-center text-color-2" data-testid="c4-canvas" data-view="" data-layout="ready">
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
      data-testid="c4-canvas"
      data-view={derived.view.id}
      data-layout={settled ? 'ready' : 'pending'}
      colorMode={theme}
      nodes={nodes}
      edges={derivedEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onNodeDoubleClick={onNodeDoubleClick}
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
