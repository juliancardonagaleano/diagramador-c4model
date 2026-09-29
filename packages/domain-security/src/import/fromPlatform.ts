import { pickId } from '@iark/kernel';
import { formatSecurityIssues, validateSecurityDocument } from '../schema';
import { SECURITY_DOCUMENT_VERSION, type Asset, type AssetKind, type Flow, type SecurityDocument, type TrustLevel, type Zone } from '../types';
import { SecurityImportError } from './fromMermaid';
import { encryptionOf } from './protocols';

interface Named {
  id: string;
  name: string;
}
interface EnvironmentLike extends Named {
  kind?: string;
}
interface NetworkLike extends Named {
  environmentId: string;
  parentId?: string;
  exposure?: string;
}
interface ResourceLike extends Named {
  kind: string;
  environmentId: string;
  networkId?: string;
  description?: string;
  technology?: string;
  owner?: string;
}
interface ServiceLike extends Named {
  description?: string;
  technology?: string;
  owner?: string;
  external?: boolean;
}
interface DeploymentLike {
  serviceId: string;
  environmentId: string;
  hostId: string;
}
interface DependencyLike {
  sourceId: string;
  targetId: string;
  protocol?: string;
  description?: string;
}

const list = <T>(x: unknown, ok: (v: unknown) => v is T): T[] => (Array.isArray(x) ? x.filter(ok) : []);
const isNamed = (x: unknown): x is Named => {
  const n = x as Partial<Named> | null;
  return !!n && typeof n.id === 'string' && typeof n.name === 'string';
};
const isDeployment = (x: unknown): x is DeploymentLike => {
  const d = x as Partial<DeploymentLike> | null;
  return !!d && typeof d.serviceId === 'string' && typeof d.environmentId === 'string' && typeof d.hostId === 'string';
};
const isDependency = (x: unknown): x is DependencyLike => {
  const d = x as Partial<DependencyLike> | null;
  return !!d && typeof d.sourceId === 'string' && typeof d.targetId === 'string';
};

/** Recursos que guardan datos; los demás (colas, balanceadores, pasarelas) los mueven y son procesos. */
const DATASTORES = new Set(['database', 'cache', 'storage', 'secret-store', 'registry']);
/** Anfitriones: no son activos, alojan a los servicios. */
const HOSTS = new Set(['cluster', 'vm']);
const TRUST_OF_EXPOSURE: Record<string, TrustLevel> = { public: 'dmz', private: 'internal', isolated: 'restricted' };

/**
 * Crea el modelo de seguridad de un entorno a partir de un documento del módulo de plataforma (leído como JSON, sin depender
 * de ese módulo): cada red pasa a ser una zona de confianza (pública = DMZ, privada = interna, aislada = restringida, con la
 * misma jerarquía), los servicios desplegados y los recursos del entorno, activos (procesos y almacenes de datos; los
 * servicios externos, entidades externas en una zona «Internet» no confiable) y las dependencias, flujos de datos. Si algún
 * activo está en una red pública se añade el actor «Usuarios de Internet». Los servicios van a la zona de la red de su
 * anfitrión. Cada activo lleva su referencia `urn:iark:platform:<id>`. Sin `env`, se toma el entorno de producción.
 */
export function fromPlatformJson(input: unknown, options: { name?: string; env?: string } = {}): { document: SecurityDocument; warnings: string[] } {
  const raw = input as { workspace?: { name?: string }; environments?: unknown; networks?: unknown; resources?: unknown; services?: unknown; deployments?: unknown; dependencies?: unknown } | null;
  if (!raw || !Array.isArray(raw.services)) throw new SecurityImportError('La entrada no es un documento de plataforma (falta "services").');
  const warnings: string[] = [];
  const environments = list(raw.environments, isNamed) as EnvironmentLike[];
  const environment = options.env ? environments.find((e) => e.id === options.env) : (environments.find((e) => e.kind === 'prod') ?? environments[0]);
  if (options.env && !environment) throw new SecurityImportError(`No existe el entorno «${options.env}». Entornos: ${environments.map((e) => e.id).join(', ') || 'ninguno'}.`);
  if (!environment) throw new SecurityImportError('El documento de plataforma no define entornos.');
  if (environments.length > 1) warnings.push(`Se toma el entorno «${environment.name}»; usa --env para elegir otro (${environments.map((e) => e.id).join(', ')}).`);

  const networks = (list(raw.networks, isNamed) as NetworkLike[]).filter((n) => n.environmentId === environment.id);
  const resources = (list(raw.resources, isNamed) as ResourceLike[]).filter((r) => r.environmentId === environment.id);
  const services = list(raw.services, isNamed) as ServiceLike[];
  const deployments = list(raw.deployments, isDeployment).filter((d) => d.environmentId === environment.id);
  const networkById = new Map(networks.map((n) => [n.id, n]));
  const resourceById = new Map(resources.map((r) => [r.id, r]));

  const taken = new Set<string>([...networks, ...resources, ...services, ...environments].map((x) => x.id));
  const zones: Zone[] = networks.map((n) => ({
    id: n.id,
    name: n.name,
    trust: TRUST_OF_EXPOSURE[n.exposure ?? 'private'] ?? 'internal',
    ...(n.parentId && networkById.has(n.parentId) ? { parentId: n.parentId } : {}),
  }));
  let internet: string | undefined;
  let unassigned: string | undefined;
  const internetZone = (): string => {
    if (!internet) {
      internet = pickId('internet', taken);
      zones.push({ id: internet, name: 'Internet', trust: 'untrusted' });
    }
    return internet;
  };
  const unassignedZone = (): string => {
    if (!unassigned) {
      unassigned = pickId('sin-red', taken);
      zones.push({ id: unassigned, name: 'Sin red asignada', trust: 'internal' });
    }
    return unassigned;
  };
  const zoneOfNetwork = (networkId: string | undefined): string => (networkId && networkById.has(networkId) ? networkId : unassignedZone());

  const assets: Asset[] = [];
  const add = (a: Asset): void => void assets.push({ ...a, ref: `urn:iark:platform:${a.id}` });
  const own = (x: { description?: string; technology?: string; owner?: string }): Partial<Asset> => ({
    ...(x.description ? { description: x.description } : {}),
    ...(x.technology ? { technology: x.technology } : {}),
    ...(x.owner ? { owner: x.owner } : {}),
  });

  for (const r of resources.filter((x) => !HOSTS.has(x.kind))) {
    const kind: AssetKind = DATASTORES.has(r.kind) ? 'datastore' : 'process';
    add({ id: r.id, name: r.name, kind, zoneId: zoneOfNetwork(r.networkId), ...own(r) });
  }
  let undeployed = 0;
  for (const s of services) {
    if (s.external) {
      add({ id: s.id, name: s.name, kind: 'external', zoneId: internetZone(), ...own(s) });
      continue;
    }
    const placement = deployments.find((d) => d.serviceId === s.id);
    if (!placement) {
      undeployed += 1;
      continue;
    }
    add({ id: s.id, name: s.name, kind: 'process', zoneId: zoneOfNetwork(resourceById.get(placement.hostId)?.networkId), ...own(s) });
  }
  if (undeployed > 0) warnings.push(`${undeployed} servicio(s) no se despliegan en «${environment.name}» y no se incluyen.`);
  const hosts = resources.filter((r) => HOSTS.has(r.kind)).length;
  if (hosts > 0) warnings.push(`${hosts} anfitrión(es) (clústeres, máquinas) no se modelan como activos: cada servicio va a la zona de la red de su anfitrión.`);

  const assetIds = new Set(assets.map((a) => a.id));
  const flowIds = new Set(taken);
  const flows: Flow[] = [];
  const signatures = new Set<string>();
  let skipped = 0;
  for (const d of list(raw.dependencies, isDependency)) {
    if (!assetIds.has(d.sourceId) || !assetIds.has(d.targetId)) {
      skipped += 1;
      continue;
    }
    const signature = `${d.sourceId}|${d.targetId}|${d.protocol ?? ''}|${d.description ?? ''}`;
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const encrypted = encryptionOf(d.protocol);
    flows.push({
      id: pickId(`${d.sourceId}--${d.targetId}`, flowIds),
      sourceId: d.sourceId,
      targetId: d.targetId,
      ...(d.protocol ? { protocol: d.protocol } : {}),
      ...(d.description ? { description: d.description } : {}),
      ...(encrypted !== undefined ? { encrypted } : {}),
    });
  }
  if (skipped > 0) warnings.push(`${skipped} dependencia(s) no se convierten en flujos porque un extremo no está en «${environment.name}».`);

  // Lo que está en una red pública lo alcanza cualquiera desde Internet.
  const publicNetworks = new Set(networks.filter((n) => n.exposure === 'public').map((n) => n.id));
  const exposed = assets.filter((a) => a.kind !== 'external' && publicNetworks.has(a.zoneId));
  if (exposed.length > 0) {
    const actor = pickId('usuarios-internet', flowIds);
    assets.unshift({ id: actor, name: 'Usuarios de Internet', kind: 'actor', zoneId: internetZone() });
    for (const a of exposed) {
      const encrypted = encryptionOf('HTTPS');
      flows.unshift({ id: pickId(`${actor}--${a.id}`, flowIds), sourceId: actor, targetId: a.id, protocol: 'HTTPS', ...(encrypted !== undefined ? { encrypted } : {}) });
    }
    warnings.push(`Se añade el actor «Usuarios de Internet» con un flujo HTTPS hacia lo que está en redes públicas (${exposed.map((a) => a.name).join(', ')}): ajústalo a lo que realmente se expone.`);
  }
  warnings.push('No hay clasificación de datos, cifrado en reposo, autenticación, amenazas ni controles: decláralos.');

  if (assets.length === 0) throw new SecurityImportError(`El entorno «${environment.name}» no tiene servicios desplegados ni recursos que pasar a activos.`);
  const result = validateSecurityDocument({
    version: SECURITY_DOCUMENT_VERSION,
    workspace: { name: options.name?.trim() || `Seguridad - ${raw.workspace?.name ?? 'Plataforma'} (${environment.name})` },
    zones,
    assets,
    flows,
  });
  if (!result.ok) throw new SecurityImportError(`No se pudo construir un documento válido:\n${formatSecurityIssues(result.issues)}`);
  return { document: result.document, warnings };
}
