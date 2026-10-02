import type { ModuleIssue } from '@iark/kernel';
import { RESOURCE_LABELS, SERVICE_LABELS, serviceKindOf, type PlatformDocument } from '../types';
import { findService, iconCatalog } from './registry';

/**
 * Avisos de la iconografía de nubes: un servicio de nube sin proveedor, un proveedor para el que no hay paquete de iconos (el
 * elemento se dibuja sin icono) o un servicio que el paquete del proveedor no tiene. Ninguno invalida el documento.
 */
export function iconIssues(doc: PlatformDocument): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const catalog = iconCatalog(doc);
  const check = (id: string, label: string, x: { provider?: string; service?: string }): void => {
    const provider = x.provider?.trim();
    const service = x.service?.trim();
    if (!provider) {
      if (service) issues.push({ severity: 'info', elementId: id, message: `${label} indica el servicio de nube «${service}» sin proveedor: no se dibuja su icono.` });
      return;
    }
    const known = catalog.find(provider);
    if (!known) {
      issues.push({ severity: 'info', elementId: id, message: `${label} indica el proveedor «${provider}», que no tiene paquete de iconos (disponibles: ${catalog.providers.map((p) => p.provider).join(', ')}): se dibuja sin icono. Registra uno o añádelo en workspace.iconPacks.` });
    } else if (service && !findService(known, service)) {
      issues.push({ severity: 'warning', elementId: id, message: `${label} indica el servicio «${service}», que no está en el paquete de iconos de «${known.name}»: se dibuja sin icono. Servicios: ${Object.keys(known.icons).join(', ')}.` });
    }
  };
  for (const r of doc.resources) check(r.id, `${RESOURCE_LABELS[r.kind]} «${r.name}»`, r);
  for (const s of doc.services) check(s.id, `${SERVICE_LABELS[serviceKindOf(s)]} «${s.name}»`, s);
  for (const n of doc.networks) check(n.id, `Red «${n.name}»`, n);
  return issues;
}
