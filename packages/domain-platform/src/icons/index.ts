import type { Network, Resource, Service } from '../types';
import type { IconSubject } from './registry';

export * from './types';
export * from './registry';
export { MAX_ICONS_PER_PACK, iconDefSchema, iconPackSchema, iconPathSchema, platformIconPackJsonSchema } from './schema';
export { awsIconPack } from './aws';
export { azureIconPack } from './azure';

/** Lo que dice un recurso para elegir su icono: el proveedor, el servicio (o, si falta, su clase y su tecnología para sugerirlo). */
export const subjectOfResource = (r: Resource): IconSubject => ({ provider: r.provider, service: r.service, kind: r.kind, technology: r.technology });
export const subjectOfService = (s: Service): IconSubject => ({ provider: s.provider, service: s.service, technology: s.technology });
/** Una red de nivel superior es la VPC o la red virtual del proveedor; una subred no se sugiere. */
export const subjectOfNetwork = (n: Network): IconSubject => ({ provider: n.provider, service: n.service, ...(n.parentId ? {} : { kind: 'network' as const }) });
