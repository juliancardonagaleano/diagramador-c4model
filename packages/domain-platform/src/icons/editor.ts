import type { FieldSpec } from '@iark/kernel';
import type { PlatformDocument } from '../types';
import { findService, iconCatalog, suggestService, type IconSubject } from './registry';
import type { IconKind } from './types';

/**
 * Los campos «Proveedor de nube» y «Servicio de nube» del panel de propiedades de un recurso, un servicio o una red. El servicio se
 * elige entre los del paquete del proveedor (por eso las opciones dependen de los valores actuales) y, si aún no se ha elegido, la
 * opción que se sugiere por la clase y la tecnología del elemento va marcada.
 */
export function iconFields(doc: PlatformDocument, values: Record<string, unknown> | undefined, kind?: IconKind): FieldSpec[] {
  const catalog = iconCatalog(doc);
  const text = (key: string): string => (typeof values?.[key] === 'string' ? (values[key] as string).trim() : '');
  const typed = text('provider');
  const known = catalog.find(typed);
  const provider = known?.provider ?? typed;
  const service = text('service');
  const providers = catalog.providers.map((p) => ({ value: p.provider, label: p.name }));
  if (provider && !known) providers.push({ value: provider, label: `${provider} (sin paquete de iconos)` });
  const suggested = known && !service ? suggestService(known, { kind, technology: text('technology') }) : undefined;
  const services = known
    ? Object.entries(known.icons)
        .map(([key, def]) => ({ value: key, label: key === suggested ? `${def.label} (sugerido)` : def.label }))
        .sort((a, b) => a.label.localeCompare(b.label))
    : [];
  if (service && !services.some((o) => o.value === service)) services.push({ value: service, label: `${service} (no está en el paquete)` });
  return [
    { key: 'provider', label: 'Proveedor de nube', type: 'select', options: providers, allowEmpty: true, hint: 'Dibuja el elemento con el icono del servicio del proveedor' },
    { key: 'service', label: 'Servicio de nube', type: 'select', options: services, allowEmpty: true, hint: known ? 'Servicios del paquete de iconos' : 'Elige primero el proveedor' },
  ];
}

/** Los valores de un elemento con el proveedor escrito como lo llama su paquete («AWS» → `aws`), para que el selector lo muestre. */
export function canonicalProvider<T extends { provider?: string }>(doc: PlatformDocument, values: T): T {
  const known = values.provider ? iconCatalog(doc).find(values.provider) : undefined;
  return known && known.provider !== values.provider ? { ...values, provider: known.provider } : values;
}

export type IconPatchResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Deja coherentes `provider` y `service` de un elemento tras aplicar un cambio (`patch`): sin proveedor no hay servicio; el servicio
 * elegido debe ser de su paquete; al cambiar de proveedor, un servicio que el nuevo no tiene se quita y, si no queda ninguno, se
 * sugiere el que encaje con su clase y su tecnología cuando es inequívoco. Los proveedores sin paquete (texto libre) se admiten tal cual.
 */
export function reconcileIcon<T extends { provider?: string; service?: string }>(doc: PlatformDocument, next: T, patch: Record<string, unknown>, subject: (value: T) => IconSubject): IconPatchResult<T> {
  if (!('provider' in patch) && !('service' in patch)) return { ok: true, value: next };
  const value: T = { ...next };
  if (!value.provider) {
    if (value.service && 'service' in patch) return { ok: false, reason: 'Elige primero el proveedor de nube del servicio.' };
    delete value.service;
    return { ok: true, value };
  }
  const known = iconCatalog(doc).find(value.provider);
  if (!known) return { ok: true, value };
  value.provider = known.provider;
  if (value.service) {
    const key = findService(known, value.service);
    if (key) value.service = key;
    else if ('service' in patch) return { ok: false, reason: `«${known.name}» no tiene el servicio «${value.service}». Servicios: ${Object.keys(known.icons).join(', ')}.` };
    else delete value.service;
  }
  if (!value.service && 'provider' in patch) {
    const suggested = suggestService(known, subject(value));
    if (suggested) value.service = suggested;
  }
  return { ok: true, value };
}
