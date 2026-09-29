import { createView, suggestViewElements } from '../model/factories';
import { DOCUMENT_VERSION, VIEW_TYPE_LABELS, type C4Document, type C4Element, type C4Relationship, type C4View, type ViewType } from '../model/types';

/**
 * Vistas por defecto para un modelo sin vistas propias (lo que importan las fuentes que no traen vistas, como Mermaid):
 * contexto y contenedores de cada sistema con contenedores, componentes de cada contenedor con ellos y, si ningún
 * sistema tiene contenedores, un único panorama de sistemas.
 */
export function defaultViews(elements: C4Element[], relationships: C4Relationship[]): C4View[] {
  const modelDoc: C4Document = { version: DOCUMENT_VERSION, workspace: { name: 'x' }, model: { elements, relationships }, views: [] };
  const views: C4View[] = [];
  const ids = new Set<string>();
  const push = (type: ViewType, scope: C4Element | undefined, title: string): void => {
    const view = createView(
      type,
      { scopeId: scope?.id, title, elements: suggestViewElements(modelDoc, type, scope?.id).filter((id) => type === 'systemContext' || id !== scope?.id).map((id) => ({ id })) },
      ids,
    );
    ids.add(view.id);
    views.push(view);
  };
  const systems = elements.filter((e) => e.type === 'softwareSystem' && elements.some((c) => c.type === 'container' && c.parentId === e.id));
  if (systems.length === 0) {
    push('systemContext', undefined, 'Panorama de sistemas');
    return views;
  }
  for (const system of systems) {
    push('systemContext', system, `${VIEW_TYPE_LABELS.systemContext} - ${system.name}`);
    push('container', system, `${VIEW_TYPE_LABELS.container} - ${system.name}`);
    for (const container of elements.filter((e) => e.type === 'container' && e.parentId === system.id)) {
      if (elements.some((c) => c.type === 'component' && c.parentId === container.id)) {
        push('component', container, `${VIEW_TYPE_LABELS.component} - ${container.name}`);
      }
    }
  }
  return views;
}
