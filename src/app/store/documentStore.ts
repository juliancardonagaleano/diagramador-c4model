import { create, useStore } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import { temporal } from 'zundo';
import {
  createElement,
  createEmptyDocument,
  createRelationship,
  createView,
  suggestViewElements,
} from '../../core/model/factories';
import { sampleDocument } from '../../core/model/sample';
import { autoLayoutView, type LayoutOptions } from '../../core/layout/elkLayout';
import {
  DEFAULT_SIZES,
  VIEW_SCOPE_TYPE,
  type C4Document,
  type C4Element,
  type C4Relationship,
  type C4View,
  type ElementType,
  type LayoutDirection,
  type ViewType,
} from '../../core/model/types';

export type Selection =
  | { kind: 'element'; id: string }
  | { kind: 'relationship'; id: string }
  | { kind: 'none' };

export type PanelTab = 'elements' | 'relationships' | 'views' | 'ai';
export type Theme = 'light' | 'dark';

export interface UiState {
  theme: Theme;
  showHeader: boolean;
  showSidebar: boolean;
  showIssues: boolean;
  showMinimap: boolean;
  showGrid: boolean;
  sidebarWidth: number;
  sidebarMode: 'structure' | 'json';
  panelTab: PanelTab;
  direction: LayoutDirection;
}

export interface DocumentState {
  doc: C4Document;
  activeViewId: string | null;
  selection: Selection;
  modified: boolean;
  lastSavedAt: number | null;
  /** Texto de estado inyectado por el anfitrión (modo embebido). */
  statusMessage: string | null;
  readOnly: boolean;
  ui: UiState;
  layoutBusy: boolean;
}

export interface DocumentActions {
  setDocument: (doc: C4Document, opts?: { activeViewId?: string; markSaved?: boolean }) => void;
  newDocument: () => void;
  loadSample: () => void;
  mergeDocument: (incoming: C4Document) => void;
  setWorkspaceName: (name: string) => void;
  select: (selection: Selection) => void;
  setActiveView: (viewId: string | null) => void;
  addElement: (type: ElementType, position?: { x: number; y: number }, partial?: Partial<C4Element>) => C4Element;
  updateElement: (id: string, patch: Partial<Omit<C4Element, 'id'>>) => void;
  removeElement: (id: string) => void;
  addRelationship: (sourceId: string, targetId: string, partial?: Partial<C4Relationship>) => C4Relationship | null;
  updateRelationship: (id: string, patch: Partial<Omit<C4Relationship, 'id'>>) => void;
  removeRelationship: (id: string) => void;
  addView: (type: ViewType, scopeId?: string, title?: string) => C4View;
  updateView: (id: string, patch: Partial<Omit<C4View, 'id' | 'elements'>>) => void;
  removeView: (id: string) => void;
  addElementToView: (viewId: string, elementId: string, position?: { x: number; y: number }) => void;
  removeElementFromView: (viewId: string, elementId: string) => void;
  moveElements: (viewId: string, moves: Array<{ id: string; x: number; y: number }>) => void;
  runAutoLayout: (viewId?: string, options?: LayoutOptions) => Promise<void>;
  markSaved: () => void;
  setStatusMessage: (message: string | null, modified?: boolean) => void;
  setReadOnly: (readOnly: boolean) => void;
  setUi: (patch: Partial<UiState>) => void;
  toggleTheme: () => void;
}

export type DocumentStore = DocumentState & DocumentActions;

const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
export const isEmbedMode = params.get('embed') === '1';

const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

const defaultUi: UiState = {
  theme: 'light',
  showHeader: true,
  showSidebar: true,
  showIssues: true,
  showMinimap: true,
  showGrid: true,
  sidebarWidth: 420,
  sidebarMode: 'structure',
  panelTab: 'elements',
  direction: 'DOWN',
};

function firstViewId(doc: C4Document): string | null {
  return doc.views[0]?.id ?? null;
}

export const useDocumentStore = create<DocumentStore>()(
  persist(
    temporal(
      (set, get) => {
        const updateDoc = (fn: (doc: C4Document) => C4Document) => {
          set((s) => ({ doc: fn(s.doc), modified: true }));
        };
        const activeView = (): C4View | undefined => {
          const { doc, activeViewId } = get();
          return doc.views.find((v) => v.id === activeViewId);
        };

        return {
          doc: isEmbedMode ? createEmptyDocument() : sampleDocument,
          activeViewId: isEmbedMode ? null : firstViewId(sampleDocument),
          selection: { kind: 'none' },
          modified: false,
          lastSavedAt: null,
          statusMessage: null,
          readOnly: false,
          ui: defaultUi,
          layoutBusy: false,

          setDocument: (doc, opts = {}) => {
            const activeViewId = opts.activeViewId && doc.views.some((v) => v.id === opts.activeViewId) ? opts.activeViewId : firstViewId(doc);
            set({ doc, activeViewId, selection: { kind: 'none' }, modified: !opts.markSaved, lastSavedAt: opts.markSaved ? Date.now() : get().lastSavedAt });
          },
          newDocument: () => {
            const doc = createEmptyDocument();
            const view = createView('systemContext', { title: 'Contexto del sistema' });
            doc.views.push(view);
            set({ doc, activeViewId: view.id, selection: { kind: 'none' }, modified: false, lastSavedAt: null });
          },
          loadSample: () => {
            set({ doc: structuredClone(sampleDocument), activeViewId: firstViewId(sampleDocument), selection: { kind: 'none' }, modified: false });
          },
          mergeDocument: (incoming) => {
            updateDoc((doc) => {
              const elIds = new Set(doc.model.elements.map((e) => e.id));
              const relIds = new Set(doc.model.relationships.map((r) => r.id));
              const viewIds = new Set(doc.views.map((v) => v.id));
              const elements = [
                ...doc.model.elements.map((e) => incoming.model.elements.find((i) => i.id === e.id) ?? e),
                ...incoming.model.elements.filter((e) => !elIds.has(e.id)),
              ];
              const relationships = [
                ...doc.model.relationships.map((r) => incoming.model.relationships.find((i) => i.id === r.id) ?? r),
                ...incoming.model.relationships.filter((r) => !relIds.has(r.id)),
              ];
              const views = [
                ...doc.views.map((v) => {
                  const inc = incoming.views.find((i) => i.id === v.id);
                  if (!inc) return v;
                  const existing = new Map(v.elements.map((e) => [e.id, e]));
                  return {
                    ...v,
                    ...inc,
                    elements: inc.elements.map((e) => (existing.get(e.id) && e.x === undefined ? existing.get(e.id)! : e)),
                  };
                }),
                ...incoming.views.filter((v) => !viewIds.has(v.id)),
              ];
              return { ...doc, workspace: { ...doc.workspace, ...incoming.workspace }, model: { elements, relationships }, views };
            });
            if (!get().activeViewId) set({ activeViewId: firstViewId(get().doc) });
          },
          setWorkspaceName: (name) => updateDoc((doc) => ({ ...doc, workspace: { ...doc.workspace, name } })),
          select: (selection) => set({ selection }),
          setActiveView: (viewId) => set({ activeViewId: viewId, selection: { kind: 'none' } }),

          addElement: (type, position, partial = {}) => {
            const { doc } = get();
            const view = activeView();
            const parentId =
              partial.parentId ??
              (view && view.scopeId && ((view.type === 'container' && type === 'container') || (view.type === 'component' && type === 'component'))
                ? view.scopeId
                : undefined);
            const element = createElement(type, { ...partial, parentId }, doc.model.elements.map((e) => e.id));
            updateDoc((d) => ({
              ...d,
              model: { ...d.model, elements: [...d.model.elements, element] },
              views: view
                ? d.views.map((v) =>
                    v.id === view.id
                      ? { ...v, elements: [...v.elements, { id: element.id, ...(position ? { x: position.x, y: position.y, ...DEFAULT_SIZES[type] } : {}) }] }
                      : v,
                  )
                : d.views,
            }));
            set({ selection: { kind: 'element', id: element.id } });
            return element;
          },
          updateElement: (id, patch) =>
            updateDoc((doc) => ({
              ...doc,
              model: {
                ...doc.model,
                elements: doc.model.elements.map((e) => {
                  if (e.id !== id) return e;
                  const next = { ...e, ...patch } as C4Element;
                  for (const key of Object.keys(next) as Array<keyof C4Element>) {
                    if (next[key] === undefined || next[key] === '') delete next[key];
                  }
                  return next;
                }),
              },
            })),
          removeElement: (id) => {
            updateDoc((doc) => {
              const descendants = new Set<string>([id]);
              let changed = true;
              while (changed) {
                changed = false;
                for (const e of doc.model.elements) {
                  if (e.parentId && descendants.has(e.parentId) && !descendants.has(e.id)) {
                    descendants.add(e.id);
                    changed = true;
                  }
                }
              }
              return {
                ...doc,
                model: {
                  elements: doc.model.elements.filter((e) => !descendants.has(e.id)),
                  relationships: doc.model.relationships.filter((r) => !descendants.has(r.sourceId) && !descendants.has(r.targetId)),
                },
                views: doc.views
                  .filter((v) => !(v.scopeId && descendants.has(v.scopeId)))
                  .map((v) => ({ ...v, elements: v.elements.filter((e) => !descendants.has(e.id)) })),
              };
            });
            const s = get();
            if (s.selection.kind === 'element' && s.selection.id === id) set({ selection: { kind: 'none' } });
            if (s.activeViewId && !s.doc.views.some((v) => v.id === s.activeViewId)) set({ activeViewId: firstViewId(s.doc) });
          },

          addRelationship: (sourceId, targetId, partial = {}) => {
            if (sourceId === targetId) return null;
            const { doc } = get();
            const rel = createRelationship(sourceId, targetId, { description: 'Usa', ...partial }, doc.model.relationships.map((r) => r.id));
            updateDoc((d) => ({ ...d, model: { ...d.model, relationships: [...d.model.relationships, rel] } }));
            set({ selection: { kind: 'relationship', id: rel.id } });
            return rel;
          },
          updateRelationship: (id, patch) =>
            updateDoc((doc) => ({
              ...doc,
              model: {
                ...doc.model,
                relationships: doc.model.relationships.map((r) => {
                  if (r.id !== id) return r;
                  const next = { ...r, ...patch } as C4Relationship;
                  for (const key of Object.keys(next) as Array<keyof C4Relationship>) {
                    if (next[key] === undefined || next[key] === '') delete next[key];
                  }
                  return next;
                }),
              },
            })),
          removeRelationship: (id) => {
            updateDoc((doc) => ({ ...doc, model: { ...doc.model, relationships: doc.model.relationships.filter((r) => r.id !== id) } }));
            const s = get();
            if (s.selection.kind === 'relationship' && s.selection.id === id) set({ selection: { kind: 'none' } });
          },

          addView: (type, scopeId, title) => {
            const { doc } = get();
            const scope = doc.model.elements.find((e) => e.id === scopeId);
            const validScope = scope && scope.type === VIEW_SCOPE_TYPE[type] ? scope.id : undefined;
            const suggested = suggestViewElements(doc, type, validScope).filter((id) => id !== validScope || type === 'systemContext');
            const view = createView(
              type,
              {
                scopeId: validScope,
                title: title ?? (scope ? `${labelForViewType(type)} - ${scope.name}` : labelForViewType(type)),
                elements: suggested.map((id) => ({ id })),
                layout: { direction: get().ui.direction },
              },
              doc.views.map((v) => v.id),
            );
            updateDoc((d) => ({ ...d, views: [...d.views, view] }));
            set({ activeViewId: view.id, selection: { kind: 'none' } });
            return view;
          },
          updateView: (id, patch) => updateDoc((doc) => ({ ...doc, views: doc.views.map((v) => (v.id === id ? { ...v, ...patch } : v)) })),
          removeView: (id) => {
            updateDoc((doc) => ({ ...doc, views: doc.views.filter((v) => v.id !== id) }));
            const s = get();
            if (s.activeViewId === id) set({ activeViewId: firstViewId(s.doc) });
          },
          addElementToView: (viewId, elementId, position) =>
            updateDoc((doc) => ({
              ...doc,
              views: doc.views.map((v) => {
                if (v.id !== viewId || v.elements.some((e) => e.id === elementId)) return v;
                const el = doc.model.elements.find((e) => e.id === elementId);
                const geo = position && el ? { x: position.x, y: position.y, ...DEFAULT_SIZES[el.type] } : {};
                return { ...v, elements: [...v.elements, { id: elementId, ...geo }] };
              }),
            })),
          removeElementFromView: (viewId, elementId) =>
            updateDoc((doc) => ({
              ...doc,
              views: doc.views.map((v) => (v.id === viewId ? { ...v, elements: v.elements.filter((e) => e.id !== elementId) } : v)),
            })),
          moveElements: (viewId, moves) => {
            if (moves.length === 0) return;
            const byId = new Map(moves.map((m) => [m.id, m]));
            updateDoc((doc) => ({
              ...doc,
              views: doc.views.map((v) =>
                v.id === viewId
                  ? {
                      ...v,
                      elements: v.elements.map((e) => {
                        const m = byId.get(e.id);
                        if (!m) return e;
                        const el = doc.model.elements.find((x) => x.id === e.id);
                        const size = el ? DEFAULT_SIZES[el.type] : { width: 240, height: 130 };
                        return { ...e, x: Math.round(m.x), y: Math.round(m.y), width: e.width ?? size.width, height: e.height ?? size.height };
                      }),
                    }
                  : v,
              ),
            }));
          },

          runAutoLayout: async (viewId, options = {}) => {
            const id = viewId ?? get().activeViewId;
            if (!id) return;
            set({ layoutBusy: true });
            try {
              const direction = options.direction ?? get().ui.direction;
              const laid = await autoLayoutView(get().doc, id, { force: true, ...options, direction });
              const laidView = laid.views.find((v) => v.id === id)!;
              updateDoc((doc) => ({
                ...doc,
                views: doc.views.map((v) =>
                  v.id === id
                    ? {
                        ...v,
                        layout: { ...v.layout, direction },
                        elements: v.elements.map((e) => {
                          const p = laidView.elements.find((x) => x.id === e.id);
                          return p && p.x !== undefined ? { ...e, x: p.x, y: p.y, width: p.width, height: p.height } : e;
                        }),
                      }
                    : v,
                ),
              }));
            } finally {
              set({ layoutBusy: false });
            }
          },

          markSaved: () => set({ modified: false, lastSavedAt: Date.now() }),
          setStatusMessage: (message, modified) => set({ statusMessage: message, ...(modified !== undefined ? { modified } : {}) }),
          setReadOnly: (readOnly) => set({ readOnly }),
          setUi: (patch) => set((s) => ({ ui: { ...s.ui, ...patch } })),
          toggleTheme: () => set((s) => ({ ui: { ...s.ui, theme: s.ui.theme === 'dark' ? 'light' : 'dark' } })),
        };
      },
      {
        partialize: (state) => ({ doc: state.doc }),
        limit: 100,
        equality: (a, b) => a.doc === b.doc,
      },
    ),
    {
      name: 'diagramador-c4model',
      storage: createJSONStorage(() => (isEmbedMode ? noopStorage : localStorage)),
      partialize: (state) => ({ doc: state.doc, activeViewId: state.activeViewId, ui: state.ui, lastSavedAt: state.lastSavedAt }),
      version: 1,
    },
  ),
);

function labelForViewType(type: ViewType): string {
  return type === 'systemContext' ? 'Contexto' : type === 'container' ? 'Contenedores' : 'Componentes';
}

export const useTemporalStore = <T,>(selector: (state: ReturnType<typeof useDocumentStore.temporal.getState>) => T): T =>
  useStore(useDocumentStore.temporal, selector);

export function elementById(doc: C4Document, id: string): C4Element | undefined {
  return doc.model.elements.find((e) => e.id === id);
}
