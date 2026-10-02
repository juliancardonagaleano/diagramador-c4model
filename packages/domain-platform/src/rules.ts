import { deploymentEnvironments } from './graph';
import { EXPOSURE_LABELS, HOST_KINDS, RESOURCE_LABELS, SENSITIVE_KINDS, exposureOf, isHost, type Deployment, type PlatformDocument, type Resource, type ResourceKind } from './types';

/**
 * Reglas de conexión y colocación del editor de plataforma. Impiden crear lo que el análisis (`analyzePlatform`) luego
 * señalaría: datos, cachés o colas en una red pública, dependencias que cruzan entornos o servicios en un anfitrión de otro
 * entorno. Son comprobaciones sobre el cambio que se intenta, de modo que un documento que ya las incumple (p. ej. importado)
 * sigue editándose sin quedar bloqueado.
 */

/** Por qué un recurso de esa clase no puede estar en la red indicada, o `undefined` si puede. */
export function placementViolation(doc: PlatformDocument, kind: ResourceKind, networkId: string | undefined): string | undefined {
  if (!networkId || !SENSITIVE_KINDS.includes(kind)) return undefined;
  const network = doc.networks.find((n) => n.id === networkId);
  if (!network || exposureOf(network) !== 'public') return undefined;
  return `${RESOURCE_LABELS[kind]} no puede estar en la red «${network.name}»: es ${EXPOSURE_LABELS.public}. Colócalo en una red privada o aislada.`;
}

/** Por qué una red no puede pasar a ser pública (guarda datos, cachés o colas), o `undefined` si puede. */
export function exposureViolation(doc: PlatformDocument, networkId: string, exposure: string | undefined): string | undefined {
  if (exposure !== 'public') return undefined;
  const inside = doc.resources.filter((r) => r.networkId === networkId && SENSITIVE_KINDS.includes(r.kind));
  if (inside.length === 0) return undefined;
  return `La red no puede ser ${EXPOSURE_LABELS.public}: contiene ${inside.map((r) => `«${r.name}»`).join(', ')} (${[...new Set(inside.map((r) => RESOURCE_LABELS[r.kind].toLowerCase()))].join(', ')}).`;
}

/** Entornos en los que existe un extremo de una dependencia: el de un recurso; los despliegues de un servicio (o el de la instancia concreta). */
export function environmentsOf(doc: PlatformDocument, id: string, instance?: Deployment): string[] {
  const resource = doc.resources.find((r) => r.id === id);
  if (resource) return [resource.environmentId];
  if (instance) return [instance.environmentId];
  return deploymentEnvironments(doc, id);
}

/** Por qué una dependencia no puede unir esos dos extremos por cruzar entornos, o `undefined` si puede. */
export function dependencyEnvironmentViolation(doc: PlatformDocument, sourceId: string, targetId: string, sourceInstance?: Deployment, targetInstance?: Deployment): string | undefined {
  const from = environmentsOf(doc, sourceId, sourceInstance);
  const to = environmentsOf(doc, targetId, targetInstance);
  // Un servicio sin despliegues, o externo, no pertenece a ningún entorno: se une con cualquiera.
  if (from.length === 0 || to.length === 0 || from.some((e) => to.includes(e))) return undefined;
  const name = (environmentId: string): string => doc.environments.find((e) => e.id === environmentId)?.name ?? environmentId;
  return `Una dependencia no cruza entornos: el origen es de ${from.map(name).join(', ')} y el destino, de ${to.map(name).join(', ')}.`;
}

/** Por qué un servicio (o una de sus instancias) no puede correr en ese anfitrión, o `undefined` si puede. */
export function hostViolation(host: Resource | undefined, instance?: Deployment): string | undefined {
  if (!host || !isHost(host)) return `El destino debe ser ${HOST_KINDS.map((k) => RESOURCE_LABELS[k].toLowerCase()).join(' o ')}.`;
  if (host.status === 'decommissioned') return `«${host.name}» está dado de baja: no puede alojar servicios.`;
  if (instance && instance.environmentId !== host.environmentId) return `Esta instancia es del entorno «${instance.environmentId}» y «${host.name}» es del «${host.environmentId}»: para llevar un servicio a otro entorno usa «Promover a otro entorno».`;
  return undefined;
}
