import { findEnvironment, nextEnvironment } from './actions';
import { ENVIRONMENT_KINDS, RESOURCE_LABELS, type Deployment, type Environment, type PlatformDocument, type Resource, type ResourceKind, type Service } from './types';

/**
 * Comparación de dos entornos (p. ej. preproducción y producción): qué servicios y recursos solo están en uno, y cuáles
 * están en los dos pero con otra versión o con otras réplicas. Es lo que dibuja la vista `compare:<A>:<B>` y lo que cuenta
 * el informe de diferencias. Los servicios se corresponden por id; los recursos, por nombre o, si no, por lo poco que se pueda
 * deducir con certeza (ver `pairResources`), y cada par dice cómo se emparejó (`MatchedBy`).
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

/**
 * Con qué criterio se emparejó un recurso de un entorno con su equivalente del otro (de más a menos fiable): `name` = mismo
 * nombre y clase; `normalized` = mismo nombre una vez quitado el del entorno («Kafka (dev)» y «Kafka (prod)»), los acentos y las
 * mayúsculas; `technology` = única pareja posible de su clase y tecnología; `similar-name` = varias parejas posibles de su clase y
 * tecnología, y se eligió la de nombre más parecido; `only-candidate` = único recurso de su clase en cada entorno, y de una clase
 * que no suele repetirse (un clúster, una pasarela).
 */
export type MatchedBy = 'name' | 'normalized' | 'technology' | 'similar-name' | 'only-candidate';

/** Cómo se cuenta el criterio de emparejado en el informe y en el lienzo. */
export const MATCH_NOTES: Record<MatchedBy, string> = {
  name: 'emparejado por nombre',
  normalized: 'emparejado por nombre normalizado',
  technology: 'emparejado por tecnología',
  'similar-name': 'emparejado por nombre parecido',
  'only-candidate': 'emparejado por ser el único de su clase',
};

export interface ResourceDifference {
  a?: Resource;
  b?: Resource;
  kinds: DiffKind[];
  /** Cómo se emparejaron `a` y `b`; solo cuando están los dos. */
  matchedBy?: MatchedBy;
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

/**
 * Palabras con las que un nombre suele decir en qué entorno está («kafka-prod», «Postgres de pruebas», «Redis (preproducción)»), ya
 * sin acentos ni mayúsculas. Son las de todas las clases de entorno, no solo las del entorno del recurso: una base «de pruebas» puede
 * vivir en preproducción. Se les suman el id y el nombre de cada entorno (los personalizados: «Pruebas de carga», «acme»…).
 */
const ENVIRONMENT_WORDS = [
  'dev', 'develop', 'development', 'desarrollo', 'desa',
  'test', 'testing', 'prueba', 'pruebas', 'qa', 'uat',
  'staging', 'stage', 'stg', 'preprod', 'preproduccion', 'preproduction', 'pre prod', 'pre produccion', 'pre production',
  'prod', 'prd', 'production', 'produccion',
  'dr', 'disaster recovery', 'recuperacion ante desastres',
];
/** Nexos que no dicen nada del recurso: sobran al final o al principio de un nombre al quitarle el entorno («Postgres de pruebas» → «postgres»). */
const CONNECTORS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'en', 'con', 'para', 'of', 'the', 'for', 'in', 'and']);
/**
 * Clases de las que un entorno suele tener una sola: si cada entorno tiene exactamente un recurso de la clase, y no se llevan la
 * contraria en tecnología, se emparejan aunque no haya otra pista. En las que se repiten (bases de datos, colas, cachés, máquinas,
 * almacenamientos, balanceadores, DNS, certificados, espacios de nombres…) un recurso suelto de cada lado puede ser cualquiera
 * de los dos y se prefiere decir «solo en A» y «solo en B» que inventar una diferencia de versión.
 */
const SINGLETON_KINDS: ResourceKind[] = ['cluster', 'gateway', 'secret-store', 'registry'];

/** Palabras de un texto: sin acentos, en minúsculas y sin signos («k8s-dev» → k8s, dev). */
const tokensOf = (text: string): string[] => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Lo que, dicho en el nombre de un recurso, señala a un entorno: las palabras de cualquier clase de entorno («prod», «producción»…) y el id y el nombre del suyo. */
function environmentPhrases(env: Environment): Set<string> {
  const phrases = new Set([...ENVIRONMENT_WORDS, tokensOf(env.id).join(' '), tokensOf(env.name).join(' ')]);
  phrases.delete('');
  return phrases;
}

/** Palabras del nombre de un recurso sin las que nombran a su entorno ni los nexos de los extremos; si no queda nada, las del nombre entero. */
function nameWithoutEnvironment(name: string, phrases: Set<string>): string[] {
  const tokens = tokensOf(name);
  const longest = Math.max(1, ...[...phrases].map((p) => p.split(' ').length));
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let skip = 0;
    for (let length = Math.min(longest, tokens.length - i); length > 0 && skip === 0; length--) if (phrases.has(tokens.slice(i, i + length).join(' '))) skip = length;
    if (skip > 0) i += skip;
    else kept.push(tokens[i++]);
  }
  while (kept.length > 0 && CONNECTORS.has(kept[0])) kept.shift();
  while (kept.length > 0 && CONNECTORS.has(kept[kept.length - 1])) kept.pop();
  return kept.length > 0 ? kept : tokens;
}

/** Parecido entre dos nombres (0 a 1): palabras compartidas sobre palabras distintas, sin nexos ni la tecnología (que ya comparten los del mismo grupo). */
function similarity(a: Set<string>, b: Set<string>): number {
  const shared = [...a].filter((t) => b.has(t)).length;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
}

/** El elemento de `others` más parecido a `x`, solo si lo es de forma inequívoca (parecido mayor que cero y sin empate). */
function mostSimilar<T>(x: Set<string>, others: Array<[T, Set<string>]>): T | undefined {
  const ranked = others.map(([o, tokens]) => ({ o, score: similarity(x, tokens) })).sort((p, q) => q.score - p.score);
  return ranked[0] && ranked[0].score > 0 && ranked[0].score > (ranked[1]?.score ?? 0) ? ranked[0].o : undefined;
}

interface ResourcePair {
  a?: Resource;
  b?: Resource;
  matchedBy?: MatchedBy;
}

/**
 * Empareja los recursos de dos entornos sin adivinar. Siempre dentro de la misma clase y por este orden:
 * 1. por nombre idéntico (sin distinguir mayúsculas);
 * 2. por nombre normalizado: sin el del entorno, los acentos ni las mayúsculas («Kafka (dev)» y «Kafka (prod)»); si dos recursos
 *    de un lado quedan con el mismo nombre normalizado, no decide entre ellos;
 * 3. por tecnología, cuando cada entorno tiene un solo recurso de esa clase y tecnología; si tiene varios, solo si el nombre
 *    más parecido (palabras compartidas) es uno y solo uno, y lo es de los dos lados;
 * 4. por clase, únicamente si es de las que no se repiten (`SINGLETON_KINDS`), cada entorno tiene una sola y no declaran
 *    tecnologías distintas.
 * Lo que no encaja con certeza queda sin pareja («solo en A» o «solo en B»): una pareja equivocada inventaría diferencias de
 * versión que no existen. Los grupos se cuentan sobre todos los recursos del entorno, no solo sobre los que quedan libres: si hay
 * dos colas Kafka y una ya se emparejó por nombre, la otra de cada lado no tiene por qué ser la misma.
 */
function pairResources(left: Resource[], right: Resource[], a: Environment, b: Environment): ResourcePair[] {
  const pairs: ResourcePair[] = [];
  let restLeft = [...left];
  let restRight = [...right];
  const take = (l: Resource, r: Resource, matchedBy: MatchedBy): void => {
    pairs.push({ a: l, b: r, matchedBy });
    restLeft = restLeft.filter((x) => x !== l);
    restRight = restRight.filter((x) => x !== r);
  };
  const [phrasesA, phrasesB] = [environmentPhrases(a), environmentPhrases(b)];
  const technologyOf = (r: Resource): string => tokensOf(r.technology ?? '').join(' ');
  /** Palabras que distinguen a un recurso de los demás de su grupo: su nombre sin entorno, nexos ni tecnología. */
  const wordsOf = (r: Resource, phrases: Set<string>): Set<string> => {
    const technology = new Set(tokensOf(r.technology ?? ''));
    return new Set(nameWithoutEnvironment(r.name, phrases).filter((t) => !CONNECTORS.has(t) && !technology.has(t)));
  };

  /** Empareja por una clave de nombre, dentro de la misma clase. Con `unique`, solo si la clave no se repite entre los libres de ninguno de los dos lados. */
  const byName = (keyA: (r: Resource) => string, keyB: (r: Resource) => string, matchedBy: MatchedBy, unique: boolean): void => {
    for (const l of [...restLeft]) {
      const key = keyA(l);
      const sameLeft = restLeft.filter((x) => x.kind === l.kind && keyA(x) === key);
      const sameRight = restRight.filter((r) => r.kind === l.kind && keyB(r) === key);
      if (key && sameRight.length > 0 && (!unique || (sameLeft.length === 1 && sameRight.length === 1))) take(l, sameRight[0], matchedBy);
    }
  };
  byName((r) => r.name.trim().toLowerCase(), (r) => r.name.trim().toLowerCase(), 'name', false);
  byName((r) => nameWithoutEnvironment(r.name, phrasesA).join(' '), (r) => nameWithoutEnvironment(r.name, phrasesB).join(' '), 'normalized', true);

  for (const group of new Set(restLeft.filter((r) => technologyOf(r)).map((r) => `${r.kind}|${technologyOf(r)}`))) {
    const inGroup = (r: Resource): boolean => `${r.kind}|${technologyOf(r)}` === group;
    const [freeLeft, freeRight] = [restLeft.filter(inGroup), restRight.filter(inGroup)];
    if (freeLeft.length === 0 || freeRight.length === 0) continue;
    if (left.filter(inGroup).length === 1 && right.filter(inGroup).length === 1) {
      take(freeLeft[0], freeRight[0], 'technology');
      continue;
    }
    const [wordsLeft, wordsRight] = [freeLeft.map((r): [Resource, Set<string>] => [r, wordsOf(r, phrasesA)]), freeRight.map((r): [Resource, Set<string>] => [r, wordsOf(r, phrasesB)])];
    for (const [l, words] of wordsLeft) {
      const r = mostSimilar(words, wordsRight);
      if (r && mostSimilar(wordsRight.find(([x]) => x === r)![1], wordsLeft) === l) take(l, r, 'similar-name');
    }
  }

  for (const l of [...restLeft]) {
    const inClass = (r: Resource): boolean => r.kind === l.kind;
    const r = restRight.find(inClass);
    if (!r || !SINGLETON_KINDS.includes(l.kind) || left.filter(inClass).length !== 1 || right.filter(inClass).length !== 1) continue;
    const [techLeft, techRight] = [technologyOf(l), technologyOf(r)];
    if (techLeft && techRight && techLeft !== techRight) continue;
    take(l, r, 'only-candidate');
  }
  return [...pairs, ...restLeft.map((l): ResourcePair => ({ a: l })), ...restRight.map((r): ResourcePair => ({ b: r }))];
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
  const resources = pairResources(resourcesOf(a.id), resourcesOf(b.id), a, b).map(({ a: ra, b: rb, matchedBy }): ResourceDifference => {
    const kinds: DiffKind[] = ra && !rb ? ['only-a'] : rb && !ra ? ['only-b'] : (ra?.version ?? '') !== (rb?.version ?? '') ? ['version'] : [];
    return { ...(ra ? { a: ra } : {}), ...(rb ? { b: rb } : {}), kinds, ...(ra && rb && matchedBy ? { matchedBy } : {}) };
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
  /** Los pares que no se emparejaron por nombre idéntico lo dicen, para que se pueda juzgar si la diferencia es real. */
  const matchNote = (r: ResourceDifference): string => (r.matchedBy && r.matchedBy !== 'name' ? ` (${MATCH_NOTES[r.matchedBy]})` : '');
  section('Recursos con otra versión', comparison.resources.filter((r) => r.kinds.includes('version')).map((r) => `${resourceName(r.a!)}: ${a.name} ${r.a!.version ? `v${r.a!.version}` : 'sin versión'} · ${b.name} ${r.b!.version ? `v${r.b!.version}` : 'sin versión'}${matchNote(r)}`));
  // Las parejas que se dedujeron sin que el nombre las delate se listan aunque no difieran: es lo único que dice que se emparejaron.
  section('Recursos emparejados por inferencia', comparison.resources.filter((r) => r.matchedBy && !['name', 'normalized'].includes(r.matchedBy)).map((r) => `${resourceName(r.a!)} con «${r.b!.name}»${matchNote(r)}`));
  const totals = summarize(comparison);
  out.push(totals['only-a'] + totals['only-b'] + totals.version + totals.replicas === 0 ? 'Los dos entornos son equivalentes: mismos servicios, versiones y réplicas.' : `Iguales en ambos: ${totals.same} elemento(s).`);
  return out.join('\n').trimEnd();
}
