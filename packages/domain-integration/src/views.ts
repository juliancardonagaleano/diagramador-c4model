import type { IntegrationDocument, Interaction } from './types';

export interface IntegrationView {
  /** `map` (todo el documento), `flow:<id>` (lo que recorre ese flujo) o `system:<id>` (un sistema y sus vecinos). */
  id: string;
  type: 'map' | 'flow' | 'system';
  title: string;
  nodeIds: string[];
  /**
   * Interacciones dibujadas. `step` es el número que se muestra en la línea: en un flujo, la posición de su paso; en las
   * demás vistas, el puesto por `order` entre las interacciones que lo tienen (que van primero, en ese orden).
   */
  interactions: Array<{ interaction: Interaction; step?: number }>;
}

/** Numera por `order` (1, 2, 3…) las interacciones que lo tienen y las coloca primero; el resto conserva su orden. */
export function numberByOrder(interactions: Interaction[]): Array<{ interaction: Interaction; step?: number }> {
  const ordered = interactions
    .map((interaction, index) => ({ interaction, index }))
    .filter(({ interaction }) => typeof interaction.order === 'number' && Number.isFinite(interaction.order))
    .sort((a, b) => (a.interaction.order as number) - (b.interaction.order as number) || a.index - b.index);
  const numbered = new Set(ordered.map(({ interaction }) => interaction.id));
  return [
    ...ordered.map(({ interaction }, i) => ({ interaction, step: i + 1 })),
    ...interactions.filter((interaction) => !numbered.has(interaction.id)).map((interaction) => ({ interaction })),
  ];
}

/** Con los extremos de las interacciones también entra el padre de cada uno, para que la vista conserve sus agrupaciones. */
function withParents(doc: IntegrationDocument, ids: Set<string>): Set<string> {
  const parents = new Map(doc.nodes.map((n) => [n.id, n.parentId]));
  for (const id of [...ids]) {
    const parent = parents.get(id);
    if (parent) ids.add(parent);
  }
  return ids;
}

/** Vista de un sistema: él, lo que contiene (sus APIs) y los vecinos con los que se habla directamente, con esas interacciones. */
function systemView(doc: IntegrationDocument, systemId: string): IntegrationView {
  const system = doc.nodes.find((n) => n.id === systemId)!;
  const own = new Set([systemId, ...doc.nodes.filter((n) => n.parentId === systemId).map((n) => n.id)]);
  const touching = doc.interactions.filter((i) => own.has(i.sourceId) || own.has(i.targetId));
  const ids = new Set(own);
  for (const i of touching) {
    ids.add(i.sourceId);
    ids.add(i.targetId);
  }
  withParents(doc, ids);
  return {
    id: `system:${systemId}`,
    type: 'system',
    title: `Sistema - ${system.name}`,
    nodeIds: doc.nodes.filter((n) => ids.has(n.id)).map((n) => n.id),
    interactions: numberByOrder(touching),
  };
}

/** Vistas derivadas del documento: el mapa completo, una por flujo y una por sistema. */
export function listViews(doc: IntegrationDocument): IntegrationView[] {
  const byId = new Map(doc.interactions.map((i) => [i.id, i]));
  const views: IntegrationView[] = [
    { id: 'map', type: 'map', title: `Mapa de integración - ${doc.workspace.name}`, nodeIds: doc.nodes.map((n) => n.id), interactions: numberByOrder(doc.interactions) },
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
    withParents(doc, ids);
    views.push({ id: `flow:${flow.id}`, type: 'flow', title: `Flujo - ${flow.name}`, nodeIds: doc.nodes.filter((n) => ids.has(n.id)).map((n) => n.id), interactions: steps });
  }
  for (const n of doc.nodes) if (n.kind === 'system') views.push(systemView(doc, n.id));
  return views;
}

export function findView(doc: IntegrationDocument, viewId?: string): IntegrationView {
  const views = listViews(doc);
  if (!viewId) return views[0];
  const view = views.find((v) => v.id === viewId) ?? views.find((v) => v.id === `flow:${viewId}`) ?? views.find((v) => v.id === `system:${viewId}`);
  if (!view) throw new Error(`No existe la vista «${viewId}». Vistas disponibles: ${views.map((v) => v.id).join(', ')}.`);
  return view;
}
