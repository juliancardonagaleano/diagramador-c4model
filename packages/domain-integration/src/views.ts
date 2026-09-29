import type { IntegrationDocument, Interaction } from './types';

export interface IntegrationView {
  /** `map` (todo el documento) o `flow:<id>` (solo lo que recorre ese flujo). */
  id: string;
  type: 'map' | 'flow';
  title: string;
  nodeIds: string[];
  /** Interacciones dibujadas, en orden (en un flujo, el orden de sus pasos). */
  interactions: Array<{ interaction: Interaction; step?: number }>;
}

/** Vistas derivadas del documento: el mapa completo y una por flujo. */
export function listViews(doc: IntegrationDocument): IntegrationView[] {
  const byId = new Map(doc.interactions.map((i) => [i.id, i]));
  const views: IntegrationView[] = [
    { id: 'map', type: 'map', title: `Mapa de integración - ${doc.workspace.name}`, nodeIds: doc.nodes.map((n) => n.id), interactions: doc.interactions.map((interaction) => ({ interaction })) },
  ];
  for (const flow of doc.flows) {
    const steps = flow.steps.flatMap((s, index) => {
      const interaction = byId.get(s.interactionId);
      return interaction ? [{ interaction, step: index + 1 }] : [];
    });
    const ids = new Set<string>();
    for (const { interaction } of steps) {
      ids.add(interaction.sourceId);
      ids.add(interaction.targetId);
    }
    // Un participante sin nodo padre visible arrastra al padre, para que el flujo conserve sus agrupaciones.
    const parents = new Map(doc.nodes.map((n) => [n.id, n.parentId]));
    for (const id of [...ids]) {
      const parent = parents.get(id);
      if (parent) ids.add(parent);
    }
    views.push({ id: `flow:${flow.id}`, type: 'flow', title: `Flujo - ${flow.name}`, nodeIds: doc.nodes.filter((n) => ids.has(n.id)).map((n) => n.id), interactions: steps });
  }
  return views;
}

export function findView(doc: IntegrationDocument, viewId?: string): IntegrationView {
  const views = listViews(doc);
  if (!viewId) return views[0];
  const view = views.find((v) => v.id === viewId) ?? views.find((v) => v.id === `flow:${viewId}`);
  if (!view) throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${views.map((v) => v.id).join(', ')}.`);
  return view;
}
