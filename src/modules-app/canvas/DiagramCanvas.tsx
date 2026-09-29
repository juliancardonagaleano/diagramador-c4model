import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { layoutGraph, pretty, type EditResult, type EditorSpec, type GraphLayout } from '@iark/kernel';
import './canvas.css';
import { buildFlow, structureKey, type FlowEdge, type FlowNode } from './flow';
import type { EditHistory } from './history';
import { Inspector, type LinkTools } from './Inspector';
import { NotationNode } from './NotationNode';
import { ShapeSvg } from './shapes';
import { CANVAS_SHORTCUTS, matchShortcut } from './shortcuts';

export interface DiagramCanvasProps {
  moduleId: string;
  spec: EditorSpec<unknown>;
  /** Documento válido actual; sin él el lienzo avisa en vez de dibujar. */
  document: unknown | undefined;
  text: string;
  viewId?: string;
  views: Array<{ id: string; title: string }>;
  onView(id: string): void;
  readOnly: boolean;
  history: EditHistory;
  onText(text: string): void;
  notify(message: string): void;
  /** Elemento que hay que seleccionar y encuadrar (al llegar desde otro diagrama). */
  focusId?: string;
  links?: LinkTools;
  /** Hay un diagrama al que volver (Alt+↑). */
  onBack?(): void;
  /** Avisa de qué elemento está seleccionado (para la miga de pan al seguir un enlace). */
  onSelect?(id: string | undefined): void;
}

const nodeTypes = { notation: NotationNode };

const positionsKey = (moduleId: string, viewId: string | undefined): string => `iark.canvas.${moduleId}.${viewId ?? ''}`;
const readPositions = (key: string): Map<string, { x: number; y: number }> => {
  try {
    const raw = window.localStorage.getItem(key);
    return new Map(raw ? (JSON.parse(raw) as Array<[string, { x: number; y: number }]>) : []);
  } catch {
    return new Map();
  }
};
const writePositions = (key: string, positions: Map<string, { x: number; y: number }>): void => {
  try {
    window.localStorage.setItem(key, JSON.stringify([...positions]));
  } catch {
    /* sin almacenamiento: las posiciones solo duran la sesión */
  }
};

function CanvasInner({ moduleId, spec, document, text, viewId, views, onView, readOnly, history, onText, notify, focusId, links, onBack, onSelect }: DiagramCanvasProps) {
  const flow = useReactFlow();
  const key = positionsKey(moduleId, viewId);
  const [moved, setMoved] = useState(() => readPositions(key));
  const [layout, setLayout] = useState<GraphLayout | undefined>();
  const [selected, setSelected] = useState<string | undefined>();
  useEffect(() => {
    onSelect?.(selected);
  }, [selected, onSelect]);
  const [edgeKind, setEdgeKind] = useState(spec.defaultEdgeKind ?? spec.edgeKinds[0]?.kind ?? '');
  const [showKeys, setShowKeys] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);

  const graph = useMemo(() => (document === undefined ? undefined : spec.project(document, viewId)), [spec, document, viewId]);
  const signature = graph ? structureKey(graph) : '';

  // Al cambiar de módulo o de vista se encuadra el dibujo una vez que ELK lo haya colocado; después la cámara no se toca.
  const fitPending = useRef(true);
  useEffect(() => {
    setMoved(readPositions(key));
    setSelected(undefined);
    fitPending.current = true;
  }, [key]);

  // El autolayout solo se recalcula cuando cambia la estructura, no al editar un texto de propiedades.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const layoutSeq = useRef(0);
  const relayout = useCallback(async () => {
    const g = graphRef.current;
    if (!g) return;
    const seq = ++layoutSeq.current;
    const kinds = new Map(spec.nodeKinds.map((k) => [k.kind, k]));
    const parents = new Set(g.nodes.filter((n) => n.parentId).map((n) => n.parentId as string));
    const result = await layoutGraph(
      g.nodes.filter((n) => !parents.has(n.id)).map((n) => ({ id: n.id, width: n.width ?? kinds.get(n.kind)?.width ?? 180, height: n.height ?? kinds.get(n.kind)?.height ?? 72, groupId: n.parentId })),
      g.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, label: e.label })),
      g.nodes.filter((n) => parents.has(n.id)).map((n) => ({ id: n.id, groupId: n.parentId })),
      { direction: 'RIGHT' },
    );
    if (seq === layoutSeq.current) setLayout(result);
  }, [spec]);
  useEffect(() => {
    void relayout();
  }, [signature, relayout]);

  const built = useMemo(() => (graph ? buildFlow(spec, graph, layout, moved) : { nodes: [] as FlowNode[], edges: [] as FlowEdge[] }), [spec, graph, layout, moved]);
  const nodes = useMemo(() => built.nodes.map((n) => ({ ...n, selected: n.id === selected })), [built.nodes, selected]);
  const edges = useMemo(() => built.edges.map((e) => ({ ...e, selected: e.id === selected })), [built.edges, selected]);

  useEffect(() => {
    if (!layout || !fitPending.current) return;
    fitPending.current = false;
    const timer = window.setTimeout(() => {
      if (focusId && graph?.nodes.some((n) => n.id === focusId)) {
        setSelected(focusId);
        void flow.fitView({ nodes: [{ id: focusId }], padding: 1.2, duration: 250, maxZoom: 1 });
      } else void flow.fitView({ padding: 0.15, duration: 200, maxZoom: 1 });
    }, 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, flow]);

  // Foco pedido cuando la vista ya está colocada (p. ej. desde «Referenciado por» dentro del mismo módulo).
  useEffect(() => {
    if (!focusId || !layout || !graph?.nodes.some((n) => n.id === focusId)) return;
    setSelected(focusId);
    const timer = window.setTimeout(() => void flow.fitView({ nodes: [{ id: focusId }], padding: 1.2, duration: 250, maxZoom: 1 }), 60);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  const follow = useCallback(
    (id: string | undefined): void => {
      const ref = id ? graph?.nodes.find((n) => n.id === id)?.ref : undefined;
      if (!ref) return notify('El elemento seleccionado no enlaza con ningún otro módulo.');
      if (!links) return notify('Este banco de trabajo no puede seguir enlaces.');
      links.follow(ref);
    },
    [graph, links, notify],
  );

  const commit = useCallback(
    (result: EditResult<unknown>): string | undefined => {
      if (!result.ok) {
        notify(result.reason);
        return undefined;
      }
      history.record(text);
      onText(pretty(result.document));
      return result.id;
    },
    [history, notify, onText, text],
  );

  const addNode = (kind: string): void => {
    if (readOnly || document === undefined) return;
    const label = spec.nodeKinds.find((k) => k.kind === kind)?.label ?? kind;
    const parentNode = selected ? graph?.nodes.find((n) => n.id === selected) : undefined;
    const id = commit(spec.addNode(document, kind, `${label} nuevo`, parentNode?.id));
    if (!id) return;
    const rect = wrapper.current?.getBoundingClientRect();
    const center = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 400) / 2 + Math.random() * 60 - 30, y: (rect?.top ?? 0) + (rect?.height ?? 300) / 2 + Math.random() * 60 - 30 });
    const next = new Map(moved).set(id, { x: Math.round(center.x - 90), y: Math.round(center.y - 36) });
    setMoved(next);
    writePositions(key, next);
    setSelected(id);
  };

  const onConnect = (c: Connection): void => {
    if (readOnly || document === undefined || !c.source || !c.target) return;
    const why = spec.canConnect?.(document, edgeKind, c.source, c.target);
    if (why) return notify(why);
    const id = commit(spec.addEdge(document, edgeKind, c.source, c.target));
    if (id) setSelected(id);
  };

  const remove = useCallback(
    (id: string | undefined): void => {
      if (readOnly || document === undefined || !id) return;
      commit(spec.remove(document, id));
      setSelected(undefined);
    },
    [commit, document, readOnly, spec],
  );

  const patch = (id: string, values: Record<string, unknown>): void => {
    if (document !== undefined) commit(spec.update(document, id, values));
  };

  const undo = useCallback(() => {
    const previous = history.undo(text);
    if (previous !== undefined) onText(previous);
  }, [history, onText, text]);
  const redo = useCallback(() => {
    const next = history.redo(text);
    if (next !== undefined) onText(next);
  }, [history, onText, text]);
  const autoLayout = useCallback(() => {
    setMoved(new Map());
    writePositions(key, new Map());
    void relayout().then(() => flow.fitView({ padding: 0.15, duration: 250 }));
  }, [flow, key, relayout]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const action = matchShortcut(e, typing);
      if (!action) return;
      e.preventDefault();
      if (action === 'undo') undo();
      else if (action === 'redo') redo();
      else if (action === 'delete') remove(selected);
      else if (action === 'layout') autoLayout();
      else if (action === 'fit') void flow.fitView({ padding: 0.15, duration: 250 });
      else if (action === 'deselect') setSelected(undefined);
      else if (action === 'follow') follow(selected);
      else if (action === 'back') onBack?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [autoLayout, flow, follow, onBack, redo, remove, selected, undo]);

  const onNodesChange = useCallback((_: NodeChange[]) => undefined, []);
  const onEdgesChange = useCallback((_: EdgeChange[]) => undefined, []);

  const onDragStop = (): void => {
    const next = new Map(moved);
    for (const n of flow.getNodes()) {
      const internal = flow.getInternalNode(n.id);
      const abs = internal?.internals.positionAbsolute;
      if (abs) next.set(n.id, { x: Math.round(abs.x), y: Math.round(abs.y) });
    }
    setMoved(next);
    writePositions(key, next);
  };

  if (document === undefined) {
    return (
      <div className="cv-empty" role="status">
        El documento no es válido: corrígelo en la pestaña JSON para volver a editarlo en el lienzo.
      </div>
    );
  }

  return (
    <div className="cv-root" ref={wrapper} data-testid="module-canvas">
      <div className="cv-toolbar" role="toolbar" aria-label="Herramientas del lienzo">
        {views.length > 1 && (
          <>
            <label className="cv-edge-kind">
              Vista
              <select value={viewId ?? views[0]?.id ?? ''} onChange={(e) => onView(e.target.value)} data-testid="canvas-view">
                {views.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.title}
                  </option>
                ))}
              </select>
            </label>
            <span className="cv-sep" />
          </>
        )}
        <div className="cv-group-tools" aria-label="Añadir">
          {spec.nodeKinds
            .filter((k) => k.addable !== false)
            .map((k) => (
              <button key={k.kind} type="button" className="cv-tool" disabled={readOnly} title={`Añadir ${k.label.toLowerCase()}${selected ? ' (dentro del contenedor seleccionado si encaja)' : ''}`} onClick={() => addNode(k.kind)} data-testid={`add-${k.kind}`}>
                <span className="cv-tool-shape" aria-hidden="true">
                  <ShapeSvg shape={k.shape} width={28} height={18} fill={k.fill} stroke={k.stroke} />
                </span>
                {k.label}
              </button>
            ))}
        </div>
        <span className="cv-sep" />
        <label className="cv-edge-kind">
          Relación
          <select value={edgeKind} onChange={(e) => setEdgeKind(e.target.value)} data-testid="edge-kind">
            {spec.edgeKinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <span className="cv-sep" />
        <button type="button" className="cv-tool" onClick={undo} disabled={!history.canUndo || readOnly} title="Deshacer (Ctrl+Z)" aria-label="Deshacer">
          ↶
        </button>
        <button type="button" className="cv-tool" onClick={redo} disabled={!history.canRedo || readOnly} title="Rehacer (Ctrl+Y)" aria-label="Rehacer">
          ↷
        </button>
        <button type="button" className="cv-tool" onClick={autoLayout} title="Autolayout (Ctrl+L)" data-testid="autolayout">
          Autolayout
        </button>
        <button type="button" className="cv-tool" onClick={() => void flow.fitView({ padding: 0.15, duration: 250 })} title="Ajustar a la ventana (0)">
          Ajustar
        </button>
        <button type="button" className="cv-tool" disabled={readOnly || !selected} onClick={() => remove(selected)} title="Borrar (Supr)" aria-label="Borrar selección">
          🗑
        </button>
        <button type="button" className="cv-tool" onClick={() => setShowKeys((s) => !s)} aria-pressed={showKeys} title="Atajos de teclado" aria-label="Atajos de teclado">
          ⌨
        </button>
      </div>

      {showKeys && (
        <dl className="cv-keys" data-testid="shortcuts">
          {CANVAS_SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="cv-body">
        <div className="cv-flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable
            onNodeClick={(_, n) => setSelected(n.id)}
            onNodeDoubleClick={(_, n) => follow(n.id)}
            onEdgeClick={(_, e) => setSelected(e.id)}
            onPaneClick={() => setSelected(undefined)}
            onConnect={onConnect}
            onNodeDragStop={onDragStop}
            deleteKeyCode={null}
            minZoom={0.1}
            maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n) => ((n.data as FlowNode['data']).node.fill ?? (n.data as FlowNode['data']).notation.fill)} />
          </ReactFlow>
        </div>
        <Inspector spec={spec} document={document} id={selected ?? ''} readOnly={readOnly} moduleId={moduleId} links={links} onPatch={patch} onRemove={remove} />
      </div>
    </div>
  );
}

/** Lienzo interactivo común a todos los módulos que declaran `editor`. */
export function DiagramCanvas(props: DiagramCanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
