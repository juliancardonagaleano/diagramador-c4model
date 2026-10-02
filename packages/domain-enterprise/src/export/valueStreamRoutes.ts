import type { Point } from '@iark/kernel';

/**
 * Rutas de las aristas de los flujos de valor: pistas del canal que separa las etapas de las capacidades, orden de las
 * capacidades por búsqueda local, pasillos por los que suben las aristas hacia capacidades de flujos anteriores y la métrica
 * de cruces con la que se comparan. Es geometría pura: no sabe nada del documento.
 */

/** Arista etapa → capacidad: `ax` y `bx` son los centros de las dos cajas; el tramo horizontal gira en una pista. */
export interface Wire {
  ax: number;
  bx: number;
  source: string;
  target: string;
}

/**
 * Reparte los tramos horizontales de las aristas de un canal en pistas, de la más cercana al origen (0) a la más lejana,
 * para que no se corten ni se monten. Si el tramo vertical de salida de una arista cae dentro del recorrido horizontal de
 * otra, la primera tiene que girar antes (en una pista más cercana al origen) para no atravesarla; si es el de llegada
 * el que cae dentro, después. Dos aristas con el mismo origen (o destino) comparten el tramo vertical; las rectas
 * (`ax === bx`) no necesitan pista (-1). Cuando las condiciones se contradicen (la capacidad de una etapa queda al otro lado
 * de la de otra) hay un cruce inevitable: se rompe el ciclo por la arista con menos condiciones pendientes (y, a igualdad, la más a la izquierda).
 */
export function assignTracks(wires: Wire[]): { levels: number[]; count: number } {
  const levels = wires.map(() => -1);
  const bent = wires.flatMap((w, i) => (w.ax === w.bx ? [] : [i]));
  const lo = (i: number): number => Math.min(wires[i].ax, wires[i].bx);
  const hi = (i: number): number => Math.max(wires[i].ax, wires[i].bx);
  const within = (x: number, i: number): boolean => x >= lo(i) && x <= hi(i);
  const earlier = new Map<number, Set<number>>(bent.map((i) => [i, new Set<number>()]));
  for (const e of bent) {
    for (const f of bent) {
      if (e === f) continue;
      if (wires[e].source !== wires[f].source && within(wires[e].ax, f)) earlier.get(f)!.add(e);
      if (wires[e].target !== wires[f].target && within(wires[e].bx, f)) earlier.get(e)!.add(f);
    }
  }
  // Dos tramos horizontales que se tocan no pueden ir en la misma pista, salvo si solo coinciden en el punto donde se unen
  // al tramo vertical que comparten.
  const clash = (i: number, j: number): boolean => {
    const from = Math.max(lo(i), lo(j));
    const to = Math.min(hi(i), hi(j));
    if (from > to) return false;
    return from < to || (wires[i].source !== wires[j].source && wires[i].target !== wires[j].target);
  };
  // Cada vez se coloca la arista con menos condiciones pendientes (a igualdad, la más a la izquierda y la primera del documento).
  const waiting = new Map(bent.map((i) => [i, earlier.get(i)!.size]));
  const unlocks = new Map<number, number[]>(bent.map((i) => [i, []]));
  for (const [f, before] of earlier) for (const e of before) unlocks.get(e)!.push(f);
  const sooner = (a: number, b: number): boolean => waiting.get(a)! - waiting.get(b)! < 0 || (waiting.get(a) === waiting.get(b) && (lo(a) - lo(b) || hi(a) - hi(b) || a - b) < 0);
  const placed = new Map<number, number[]>();
  const pending = new Set(bent);
  while (pending.size > 0) {
    let next = -1;
    for (const i of pending) if (next < 0 || sooner(i, next)) next = i;
    pending.delete(next);
    for (const f of unlocks.get(next)!) waiting.set(f, waiting.get(f)! - 1);
    let level = Math.max(-1, ...[...earlier.get(next)!].map((p) => levels[p])) + 1;
    while ((placed.get(level) ?? []).some((j) => clash(next, j))) level += 1;
    levels[next] = level;
    placed.set(level, [...(placed.get(level) ?? []), next]);
  }
  return { levels, count: Math.max(0, ...levels) + (bent.length > 0 ? 1 : 0) };
}

/**
 * Posiciones lo más cercanas posible a las deseadas (mínimos cuadrados) que respetan el orden dado y se separan al menos
 * `gap`: los vecinos que se estorban forman un bloque que se reparte alrededor de la media de lo que querían.
 */
export function spread(desired: number[], gap: number): number[] {
  const blocks: Array<{ sum: number; count: number }> = [];
  desired.forEach((d, k) => {
    blocks.push({ sum: d - k * gap, count: 1 });
    while (blocks.length > 1) {
      const [a, b] = blocks.slice(-2);
      if (a.sum / a.count <= b.sum / b.count) break;
      blocks.splice(-2, 2, { sum: a.sum + b.sum, count: a.count + b.count });
    }
  });
  return blocks.flatMap((b) => Array.from({ length: b.count }, () => Math.round(b.sum / b.count))).map((x, k) => x + k * gap);
}

/**
 * Mejora un orden por búsqueda local: `cost(a, b)` es lo que cuesta (en cruces) que el elemento `a` quede a la izquierda de `b`.
 * En cada pasada intercambia los vecinos que mejoran y recoloca cada elemento en su mejor posición; solo acepta cambios que reducen
 * estrictamente el coste total (en los empates se queda como estaba) y se detiene al no haber mejora o tras `maxPasses`, así que
 * nunca empeora el orden de partida y siempre da el mismo resultado.
 */
export function refineOrder(order: number[], cost: (left: number, right: number) => number, maxPasses = 16): number[] {
  const next = [...order];
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let changed = false;
    for (let i = 0; i + 1 < next.length; i += 1) {
      const [a, b] = [next[i], next[i + 1]];
      if (cost(b, a) < cost(a, b)) {
        [next[i], next[i + 1]] = [b, a];
        changed = true;
      }
    }
    for (let i = 0; i < next.length; i += 1) {
      const item = next[i];
      const rest = next.filter((_, k) => k !== i);
      const at = (p: number): number => rest.reduce((sum, other, q) => sum + (q < p ? cost(other, item) : cost(item, other)), 0);
      let [best, bestCost] = [i, at(i)];
      for (let p = 0; p <= rest.length; p += 1) {
        const c = at(p);
        if (c < bestCost) [best, bestCost] = [p, c];
      }
      if (best !== i) {
        next.splice(i, 1);
        next.splice(best, 0, item);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return next;
}

// --- Métrica de cruces ---------------------------------------------------------------------------------------------------

/** Ruta de una arista con sus extremos, para contar cruces. */
export interface Traced {
  points: readonly Point[];
  source: string;
  target: string;
}

type Meeting = 'none' | 'cross' | 'touch' | 'overlap';

/** Cómo se encuentran dos tramos ortogonales: se cruzan en un punto interior a los dos, se tocan en un punto o comparten un trozo de línea. */
function meeting(a1: Point, a2: Point, b1: Point, b2: Point): Meeting {
  if ((a1.x === a2.x && a1.y === a2.y) || (b1.x === b2.x && b1.y === b2.y)) return 'none';
  const [aVertical, bVertical] = [a1.x === a2.x, b1.x === b2.x];
  if (aVertical === bVertical) {
    const [axis, other] = aVertical ? (['y', 'x'] as const) : (['x', 'y'] as const);
    if (a1[other] !== b1[other]) return 'none';
    const [from, to] = [Math.max(Math.min(a1[axis], a2[axis]), Math.min(b1[axis], b2[axis])), Math.min(Math.max(a1[axis], a2[axis]), Math.max(b1[axis], b2[axis]))];
    return from < to ? 'overlap' : from === to ? 'touch' : 'none';
  }
  const [v1, v2, h1, h2] = aVertical ? [a1, a2, b1, b2] : [b1, b2, a1, a2];
  const [x, y] = [v1.x, h1.y];
  const [x0, x1, y0, y1] = [Math.min(h1.x, h2.x), Math.max(h1.x, h2.x), Math.min(v1.y, v2.y), Math.max(v1.y, v2.y)];
  if (x < x0 || x > x1 || y < y0 || y > y1) return 'none';
  return x > x0 && x < x1 && y > y0 && y < y1 ? 'cross' : 'touch';
}

/**
 * Cruces entre las rutas ortogonales de un conjunto de aristas: pares de tramos de dos aristas distintas que se cortan. Dos
 * aristas que comparten extremo (salen de la misma etapa o llegan a la misma capacidad) pueden compartir el tramo vertical, así que
 * entre ellas solo cuenta el corte limpio; entre las demás cuenta también que una toque a otra o se monte sobre ella.
 */
export function countCrossings(routes: readonly Traced[]): number {
  const bounds = routes.map((r) => ({ x0: Math.min(...r.points.map((p) => p.x)), x1: Math.max(...r.points.map((p) => p.x)), y0: Math.min(...r.points.map((p) => p.y)), y1: Math.max(...r.points.map((p) => p.y)) }));
  let count = 0;
  for (let i = 0; i < routes.length; i += 1) {
    for (let j = i + 1; j < routes.length; j += 1) {
      const [a, b, p, q] = [routes[i], routes[j], bounds[i], bounds[j]];
      if (p.x1 < q.x0 || q.x1 < p.x0 || p.y1 < q.y0 || q.y1 < p.y0) continue;
      const shared = a.source === b.source || a.target === b.target || a.source === b.target || a.target === b.source;
      for (let s = 1; s < a.points.length; s += 1) {
        for (let t = 1; t < b.points.length; t += 1) {
          const m = meeting(a.points[s - 1], a.points[s], b.points[t - 1], b.points[t]);
          if (m === 'cross' || (m !== 'none' && !shared)) count += 1;
        }
      }
    }
  }
  return count;
}

// --- Aristas que suben hasta una capacidad de un flujo anterior --------------------------------------------------------------

/**
 * Una capacidad que habilita etapas de varios flujos la dibuja el primero. Las aristas de los flujos siguientes suben hasta
 * ella desde la etapa (`from`: índice de su flujo; `to`: el de la capacidad) y llegan por debajo de la capacidad.
 */
export interface Climb {
  id: string;
  stage: string;
  capability: string;
  from: number;
  to: number;
  /** Centros de la etapa y de la capacidad. */
  ax: number;
  bx: number;
}

/**
 * Las aristas que suben desde una misma etapa comparten un tramo vertical, el pasillo (`x`). Si la etapa tiene libre la subida
 * (nada de por medio) el pasillo está sobre ella (`x === ax`); si no, la arista gira bajo el rótulo del recuadro hacia una
 * columna libre fuera de los flujos intermedios (`base` es la más cercana libre a su derecha; `placeRisers` también prueba las de su
 * izquierda, de coordenada negativa, que `routeStreams` compensa desplazando todo) y sube por ella.
 */
export interface Riser {
  stage: string;
  from: number;
  /** El flujo más lejano al que llegan sus aristas (el menor índice). */
  top: number;
  ax: number;
  base: number;
  x: number;
  climbs: Climb[];
}

/** Alturas a las que se traza: la de las etapas, las pistas bajo el rótulo, las del hueco sobre un flujo y la base de cada capacidad. */
export interface Heights {
  stageTop(group: number): number;
  strip(group: number, level: number): number;
  gap(group: number, level: number): number;
  capBottom(capability: string): number;
}

interface Track {
  /** Nivel (0 = la más cercana al origen) de cada tramo, por clave; -1 si es recto. */
  level: Map<string, number>;
  count: number;
}

export interface Lanes {
  /** Pistas bajo el rótulo de cada flujo, por el que sale cada pasillo lateral (clave: la etapa). */
  strip: Map<number, Track>;
  /** Pistas del hueco sobre un flujo por las que giran las aristas hacia las capacidades del flujo anterior (clave: la arista). */
  gap: Map<number, Track>;
}

const track = (wires: Wire[], keys: string[]): Track => {
  const { levels, count } = assignTracks(wires);
  return { level: new Map(keys.map((k, i) => [k, levels[i]])), count };
};

/** Reparte en pistas los tramos horizontales de los pasillos: bajo el rótulo de cada flujo y en el hueco que hay sobre el flujo de cada capacidad. */
export function planLanes(risers: readonly Riser[]): Lanes {
  const strips = new Map<number, Riser[]>();
  const gaps = new Map<number, Array<{ riser: Riser; climb: Climb }>>();
  for (const r of risers) {
    if (r.x !== r.ax) strips.set(r.from, [...(strips.get(r.from) ?? []), r]);
    for (const climb of r.climbs) gaps.set(climb.to + 1, [...(gaps.get(climb.to + 1) ?? []), { riser: r, climb }]);
  }
  return {
    strip: new Map([...strips].map(([group, list]) => [group, track(list.map((r) => ({ ax: r.ax, bx: r.x, source: r.stage, target: `pasillo:${r.stage}` })), list.map((r) => r.stage))])),
    gap: new Map([...gaps].map(([group, list]) => [group, track(list.map(({ riser, climb }) => ({ ax: riser.x, bx: climb.bx, source: riser.stage, target: climb.capability })), list.map(({ climb }) => climb.id))])),
  };
}

/** Recorrido de una arista que sube: sale de la etapa, gira bajo el rótulo hacia el pasillo (si no sube recto), sube y gira sobre la capacidad. */
export function traceClimb(riser: Riser, climb: Climb, lanes: Lanes, y: Heights): Point[] {
  const points: Point[] = [{ x: riser.ax, y: y.stageTop(riser.from) }];
  if (riser.x !== riser.ax) {
    const lane = y.strip(riser.from, lanes.strip.get(riser.from)!.level.get(riser.stage)!);
    points.push({ x: riser.ax, y: lane }, { x: riser.x, y: lane });
  }
  const level = lanes.gap.get(climb.to + 1)!.level.get(climb.id)!;
  if (level >= 0) {
    const lane = y.gap(climb.to + 1, level);
    points.push({ x: riser.x, y: lane }, { x: climb.bx, y: lane });
  }
  points.push({ x: climb.bx, y: y.capBottom(climb.capability) });
  return points;
}

/** Alturas simbólicas (tres franjas por flujo: el hueco que tiene encima, la franja bajo el rótulo y el resto) con las que se puntúan las posiciones de los pasillos antes de saber las reales. */
function symbolicHeights(groupOf: ReadonlyMap<string, number>): Heights {
  const band = 1000;
  return {
    stageTop: (k) => band * (3 * k + 2),
    strip: (k, level) => band * (3 * k + 1) + 900 - 10 * level,
    gap: (g, level) => band * 3 * g + 900 - 10 * level,
    capBottom: (c) => band * (3 * groupOf.get(c)! + 2) + 500,
  };
}

/** Separación entre pasillos vecinos y holgura entre un pasillo y lo que bordea. */
const AISLE = 10;
export const CORRIDOR = 12;
/** Columnas que prueba cada pasillo en cada lado (la más cercana libre y las que le siguen) y trabajo máximo de la búsqueda, en rutas² puntuadas: pasado el tope, los pasillos que faltan van a la primera columna libre de la derecha. */
const COLUMNS = 5;
const SEARCH_WORK = 600_000;

/**
 * Elige la columna de cada pasillo lateral. Primero los más cortos; cada uno prueba, a la derecha de los flujos (desde `base`) y a su
 * izquierda (columnas negativas), las columnas más cercanas, de `AISLE` en `AISLE`, y la primera que no coincide con otro pasillo a la
 * misma altura, y se queda con la que menos cruces da entre las aristas ya colocadas (a igualdad, la de la derecha y la más cercana).
 * Los pasillos rectos (`x === ax`) no se mueven.
 */
export function placeRisers(risers: Riser[], groupOf: ReadonlyMap<string, number>): void {
  const heights = symbolicHeights(groupOf);
  const score = (placed: readonly Riser[]): number => {
    const lanes = planLanes(placed);
    return countCrossings(placed.flatMap((r) => r.climbs.map((c) => ({ points: traceClimb(r, c, lanes, heights), source: c.stage, target: c.capability }))));
  };
  for (const r of risers) r.x = r.base;
  const placed = risers.filter((r) => r.x === r.ax);
  const lateral = risers.filter((r) => r.x !== r.ax).sort((a, b) => a.from - a.top - (b.from - b.top) || a.from - b.from || a.ax - b.ax || (a.stage < b.stage ? -1 : 1));
  const shareHeight = (a: Riser, b: Riser): boolean => a.top <= b.from && b.top <= a.from;
  let work = 0;
  let edges = placed.reduce((sum, r) => sum + r.climbs.length, 0);
  for (const r of lateral) {
    edges += r.climbs.length;
    // Columnas a un lado: las `COLUMNS` primeras desde `start` y, si hace falta, la primera libre.
    const side = (start: number, step: number): { columns: number[]; free: number } => {
      const columns: number[] = [];
      let free: number | undefined;
      for (let t = 0; free === undefined || t < COLUMNS; t += 1) {
        const x = start + t * step;
        if (free === undefined && !placed.some((q) => q.x === x && shareHeight(q, r))) free = x;
        if (t < COLUMNS) columns.push(x);
      }
      return { columns: columns.includes(free) ? columns : [...columns, free], free };
    };
    const [right, left] = [side(r.base, AISLE), side(-CORRIDOR, -AISLE)];
    let [best, bestScore] = [right.free, Infinity];
    if (work <= SEARCH_WORK) {
      for (const x of [...right.columns, ...left.columns]) {
        r.x = x;
        work += edges * edges;
        const s = score([...placed, r]);
        if (s < bestScore) [best, bestScore] = [x, s];
        if (s === 0) break;
      }
    }
    r.x = best;
    placed.push(r);
  }
}
