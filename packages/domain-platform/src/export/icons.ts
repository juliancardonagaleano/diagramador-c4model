import { iconCatalog, resolveIcon, subjectOfNetwork, subjectOfResource, subjectOfService, type IconSubject } from '../icons';
import type { PlatformDocument } from '../types';
import type { Scene } from './render';

/**
 * Pone a los nodos y a las zonas de una escena el icono del servicio de su proveedor de nube (`provider` + `service`): una ficha
 * con el color de acento del paquete sobre la esquina del nodo. Los elementos sin proveedor, o de un proveedor sin paquete, no
 * cambian. Las instancias de un servicio, el servicio; los clústeres que alojan servicios y las redes (zonas), los suyos.
 */
export function withProviderIcons(doc: PlatformDocument, scene: Scene): Scene {
  const subjects = new Map<string, IconSubject>();
  for (const r of doc.resources) if (r.provider) subjects.set(r.id, subjectOfResource(r));
  for (const s of doc.services) if (s.provider) subjects.set(s.id, subjectOfService(s));
  for (const n of doc.networks) if (n.provider) subjects.set(n.id, subjectOfNetwork(n));
  if (subjects.size === 0) return scene;
  const catalog = iconCatalog(doc);
  const iconOf = (elementId: string | undefined): { paths: string[]; color: string } | undefined => {
    const subject = elementId ? subjects.get(elementId) : undefined;
    const icon = subject ? resolveIcon(catalog, subject) : undefined;
    return icon ? { paths: icon.paths, color: icon.color } : undefined;
  };
  for (const [id, node] of scene.nodes) {
    const icon = iconOf(node.elementId);
    if (icon) scene.nodes.set(id, { ...node, icon: icon.paths, iconColor: icon.color });
  }
  for (const [id, group] of scene.groups) {
    const icon = iconOf(group.elementId);
    if (icon) scene.groups.set(id, { ...group, icon });
  }
  return scene;
}
