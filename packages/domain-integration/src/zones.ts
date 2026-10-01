import type { IntegrationNode } from './types';

/** Zona de un equipo o dominio: agrupa los nodos de primer nivel que comparten `domain`. */
export interface Zone {
  /** `domain:<nombre en kebab-case>`; es también el id del nodo-grupo que dibuja el lienzo. */
  id: string;
  name: string;
  stroke: string;
  fill: string;
  nodeIds: string[];
}

const PALETTE: Array<{ stroke: string; fill: string }> = [
  { stroke: '#3b82f6', fill: '#eff6ff' },
  { stroke: '#10b981', fill: '#ecfdf5' },
  { stroke: '#f59e0b', fill: '#fffbeb' },
  { stroke: '#8b5cf6', fill: '#f5f3ff' },
  { stroke: '#ef4444', fill: '#fef2f2' },
  { stroke: '#14b8a6', fill: '#f0fdfa' },
  { stroke: '#ec4899', fill: '#fdf2f8' },
  { stroke: '#64748b', fill: '#f1f5f9' },
];

const slug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'zona';

export const ZONE_PREFIX = 'domain:';

export const zoneId = (name: string): string => `${ZONE_PREFIX}${slug(name)}`;

export const isZoneId = (id: string): boolean => id.startsWith(ZONE_PREFIX);

/** Color estable por nombre: la misma zona se ve igual en el lienzo, el SVG y draw.io. */
export function zoneColors(name: string): { stroke: string; fill: string } {
  let hash = 0;
  for (const ch of slug(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/** Dominio efectivo de un nodo: el suyo o, si tiene padre, el de su padre (un hijo siempre va dentro de su padre). */
export function domainOf(node: IntegrationNode, byId: ReadonlyMap<string, IntegrationNode>): string | undefined {
  const parent = node.parentId ? byId.get(node.parentId) : undefined;
  if (parent) return domainOf(parent, byId);
  const name = node.domain?.trim();
  return name ? name : undefined;
}

/**
 * Zonas de los nodos `visible`. Un miembro es un nodo de primer nivel (sin padre visible): los hijos van dentro de su padre
 * y la zona los envuelve. Dos nombres que dan el mismo id (`Ventas` y `ventas`) son la misma zona; manda el primero.
 */
export function zonesOf(nodes: IntegrationNode[], visible?: ReadonlySet<string>): Zone[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const zones = new Map<string, Zone>();
  for (const n of nodes) {
    if (visible && !visible.has(n.id)) continue;
    if (n.parentId && (!visible || visible.has(n.parentId))) continue;
    const name = domainOf(n, byId);
    if (!name) continue;
    const id = zoneId(name);
    const zone = zones.get(id) ?? { id, name, ...zoneColors(name), nodeIds: [] };
    zone.nodeIds.push(n.id);
    zones.set(id, zone);
  }
  return [...zones.values()];
}
