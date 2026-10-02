import { findEnvironment, nextEnvironment } from './actions';
import { ENVIRONMENT_KINDS, RESOURCE_LABELS, type Deployment, type Environment, type PlatformDocument, type Resource, type Service } from './types';

/**
 * Comparación de dos entornos (p. ej. preproducción y producción): qué servicios y recursos solo están en uno, y cuáles
 * están en los dos pero con otra versión o con otras réplicas. Es lo que dibuja la vista `compare:<A>:<B>` y lo que cuenta
 * el informe de diferencias.
 */
export type DiffKind = 'only-a' | 'only-b' | 'version' | 'replicas';

/** Lo que un servicio tiene desplegado en un entorno (puede correr en varios anfitriones). */
export interface Presence {
  deploymentIds: string[];
  /** Suma de réplicas (una instancia sin réplicas declaradas cuenta una). */
  replicas: number;
  versions: string[];
  hostIds: string[];
}

export interface ServiceDifference {
  service: Service;
  a?: Presence;
  b?: Presence;
  /** Vacío si es igual en los dos entornos. */
  kinds: DiffKind[];
}

export interface ResourceDifference {
  a?: Resource;
  b?: Resource;
  kinds: DiffKind[];
}

export interface EnvironmentComparison {
  a: Environment;
  b: Environment;
  services: ServiceDifference[];
  resources: ResourceDifference[];
}

const presenceIn = (deployments: Deployment[]): Presence | undefined =>
  deployments.length === 0
    ? undefined
    : {
        deploymentIds: deployments.map((d) => d.id),
        replicas: deployments.reduce((sum, d) => sum + (d.replicas ?? 1), 0),
        versions: [...new Set(deployments.map((d) => d.version).filter((v): v is string => !!v))],
        hostIds: deployments.map((d) => d.hostId),
      };

export const versionText = (versions: string[]): string => (versions.length === 0 ? 'sin versión' : versions.map((v) => `v${v}`).join(' + '));
const sameVersions = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Empareja los recursos de dos entornos: primero por nombre, luego por clase y tecnología y por último solo por clase. */
function pairResources(left: Resource[], right: Resource[]): Array<[Resource | undefined, Resource | undefined]> {
  const pairs: Array<[Resource | undefined, Resource | undefined]> = [];
  let restLeft = [...left];
  let restRight = [...right];
  const pass = (key: (r: Resource) => string): void => {
    for (const l of [...restLeft]) {
      const match = restRight.find((r) => r.kind === l.kind && key(r) === key(l));
      if (!match) continue;
      pairs.push([l, match]);
      restLeft = restLeft.filter((x) => x !== l);
      restRight = restRight.filter((x) => x !== match);
    }
  };
  pass((r) => r.name.trim().toLowerCase());
  pass((r) => (r.technology ?? '').trim().toLowerCase());
  pass(() => '');
  return [...pairs, ...restLeft.map((l): [Resource, undefined] => [l, undefined]), ...restRight.map((r): [undefined, Resource] => [undefined, r])];
}

export function compareEnvironments(doc: PlatformDocument, aId: string, bId: string): EnvironmentComparison {
  const a = doc.environments.find((e) => e.id === aId);
  const b = doc.environments.find((e) => e.id === bId);
  if (!a || !b) throw new Error(`No existe el entorno «${!a ? aId : bId}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.`);
  if (a.id === b.id) throw new Error('Elige dos entornos distintos para compararlos.');
  const services: ServiceDifference[] = [];
  for (const service of doc.services) {
    const pa = presenceIn(doc.deployments.filter((d) => d.serviceId === service.id && d.environmentId === a.id));
    const pb = presenceIn(doc.deployments.filter((d) => d.serviceId === service.id && d.environmentId === b.id));
    if (!pa && !pb) continue;
    const kinds: DiffKind[] = [];
    if (pa && !pb) kinds.push('only-a');
    else if (pb && !pa) kinds.push('only-b');
    else if (pa && pb) {
      if (!sameVersions(pa.versions, pb.versions)) kinds.push('version');
      if (pa.replicas !== pb.replicas) kinds.push('replicas');
    }
    services.push({ service, ...(pa ? { a: pa } : {}), ...(pb ? { b: pb } : {}), kinds });
  }
  const resourcesOf = (id: string): Resource[] => doc.resources.filter((r) => r.environmentId === id && r.status !== 'decommissioned');
  const resources = pairResources(resourcesOf(a.id), resourcesOf(b.id)).map(([ra, rb]): ResourceDifference => {
    const kinds: DiffKind[] = ra && !rb ? ['only-a'] : rb && !ra ? ['only-b'] : (ra?.version ?? '') !== (rb?.version ?? '') ? ['version'] : [];
    return { ...(ra ? { a: ra } : {}), ...(rb ? { b: rb } : {}), kinds };
  });
  return { a, b, services, resources };
}

/** El entorno con el que comparar otro cuando no se indica: el siguiente en el camino a producción o, si no lo hay, el anterior. */
export function counterpart(doc: PlatformDocument, environmentId: string): Environment | undefined {
  const next = nextEnvironment(doc, environmentId);
  if (next) return next;
  const rank = (e: Environment): number => (e.kind ? ENVIRONMENT_KINDS.indexOf(e.kind) : -1);
  const from = doc.environments.find((e) => e.id === environmentId);
  if (!from) return undefined;
  const earlier = doc.environments.filter((e) => e.id !== from.id && rank(e) >= 0 && rank(e) < rank(from)).sort((x, y) => rank(y) - rank(x))[0];
  return earlier ?? doc.environments.find((e) => e.id !== from.id);
}

/**
 * Los dos entornos que nombra una vista `compare:<A>:<B>` (el texto tras `compare:`): por id o por nombre. Con uno solo
 * (`compare:<A>`), el otro es su contrapartida en el camino a producción.
 */
export function resolveComparison(doc: PlatformDocument, text: string): [Environment, Environment] {
  const [first = '', ...rest] = text.split(':');
  const a = findEnvironment(doc, first);
  if (!a) throw new Error(`No existe el entorno «${first}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.`);
  const second = rest.join(':');
  const b = second ? findEnvironment(doc, second) : counterpart(doc, a.id);
  if (!b) throw new Error(second ? `No existe el entorno «${second}». Entornos: ${doc.environments.map((e) => e.id).join(', ')}.` : `Indica con qué entorno comparar «${a.name}»: compare:${a.id}:<entorno>.`);
  return [a, b];
}

/** Número de diferencias de cada clase (los elementos iguales no cuentan). */
export function summarize(comparison: EnvironmentComparison): Record<DiffKind | 'same', number> {
  const total: Record<DiffKind | 'same', number> = { 'only-a': 0, 'only-b': 0, version: 0, replicas: 0, same: 0 };
  for (const x of [...comparison.services, ...comparison.resources]) {
    if (x.kinds.length === 0) total.same += 1;
    for (const k of x.kinds) total[k] += 1;
  }
  return total;
}

/** Informe de diferencias en Markdown. */
export function compareReport(doc: PlatformDocument, comparison: EnvironmentComparison): string {
  const { a, b } = comparison;
  const hosts = new Map(doc.resources.map((r) => [r.id, r.name]));
  const describe = (p: Presence): string => [`${p.replicas} ${p.replicas === 1 ? 'réplica' : 'réplicas'}`, versionText(p.versions), `en ${[...new Set(p.hostIds.map((h) => hosts.get(h) ?? h))].join(', ')}`].join(' · ');
  const diffs = comparison.services.filter((s) => s.kinds.length > 0);
  const out = [`Comparación de «${a.name}» (A) y «${b.name}» (B)`, ''];
  const section = (title: string, lines: string[]): void => {
    if (lines.length > 0) out.push(`${title} (${lines.length})`, ...lines.map((l) => `- ${l}`), '');
  };
  section(`Servicios solo en ${a.name}`, diffs.filter((s) => s.kinds.includes('only-a')).map((s) => `${s.service.name}: ${describe(s.a!)}`));
  section(`Servicios solo en ${b.name}`, diffs.filter((s) => s.kinds.includes('only-b')).map((s) => `${s.service.name}: ${describe(s.b!)}`));
  section('Versión distinta', diffs.filter((s) => s.kinds.includes('version')).map((s) => `${s.service.name}: ${a.name} ${versionText(s.a!.versions)} · ${b.name} ${versionText(s.b!.versions)}`));
  section('Réplicas distintas', diffs.filter((s) => s.kinds.includes('replicas')).map((s) => `${s.service.name}: ${a.name} ${s.a!.replicas} · ${b.name} ${s.b!.replicas}`));
  const resourceName = (r: Resource): string => `${RESOURCE_LABELS[r.kind]} «${r.name}»`;
  section(`Recursos solo en ${a.name}`, comparison.resources.filter((r) => r.kinds.includes('only-a')).map((r) => resourceName(r.a!)));
  section(`Recursos solo en ${b.name}`, comparison.resources.filter((r) => r.kinds.includes('only-b')).map((r) => resourceName(r.b!)));
  section('Recursos con otra versión', comparison.resources.filter((r) => r.kinds.includes('version')).map((r) => `${resourceName(r.a!)}: ${a.name} ${r.a!.version ? `v${r.a!.version}` : 'sin versión'} · ${b.name} ${r.b!.version ? `v${r.b!.version}` : 'sin versión'}`));
  const totals = summarize(comparison);
  out.push(totals['only-a'] + totals['only-b'] + totals.version + totals.replicas === 0 ? 'Los dos entornos son equivalentes: mismos servicios, versiones y réplicas.' : `Iguales en ambos: ${totals.same} elemento(s).`);
  return out.join('\n').trimEnd();
}
