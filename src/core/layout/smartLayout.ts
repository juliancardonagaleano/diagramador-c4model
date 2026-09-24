import type { DerivedView } from '../model/viewDerivation';
import type { LayoutDirection } from '../model/types';
import { distributeCentered } from './distribute';
import {
  boundariesFromPositions,
  measureDerived,
  runElkLayout,
  type LayoutResult,
  type LayoutVariant,
  type ResolvedLayoutParams,
} from './elkLayout';
import { estimateLabelSize } from './labelMetrics';
import { routeEdges } from './router';

/**
 * Autolayout con autocorrección: prueba candidatos (dirección × distribución ×
 * estrategia de ELK) por orden de preferencia y se queda con el primero limpio
 * (0 cruces, 0 solapes) o, si ninguno lo es, con el de mejor puntuación.
 *
 * Prioridad por defecto: C1 arriba→abajo centrado; C2/C3 izquierda→derecha
 * centrado; después las variantes de ELK y por último la otra dirección.
 */

export const BASE_VARIANTS: LayoutVariant[] = [
  { name: 'brandes-koepf' },
  { name: 'network-simplex', nodePlacement: 'NETWORK_SIMPLEX' },
  { name: 'linear-segments', nodePlacement: 'LINEAR_SEGMENTS' },
  { name: 'brandes-koepf+spacing', spacingFactor: 1.35 },
];

export const RESCUE_VARIANTS: LayoutVariant[] = [
  { name: 'layer-sweep-thorough', thoroughness: 100, reverseEdges: true },
  { name: 'network-simplex+spacing', nodePlacement: 'NETWORK_SIMPLEX', spacingFactor: 1.35, thoroughness: 100 },
  { name: 'no-constraints', noLayerConstraints: true, thoroughness: 100 },
];

export interface LayoutCandidate {
  direction: LayoutDirection;
  distribution: 'centered' | 'elk';
  variant: LayoutVariant;
  /** Pertenece a la clase preferida (dirección y distribución preferidas). */
  preferred: boolean;
}

function otherDirection(d: LayoutDirection): LayoutDirection {
  return d === 'DOWN' || d === 'UP' ? 'RIGHT' : 'DOWN';
}

/** Lista ordenada de candidatos según las preferencias resueltas. */
export function buildCandidates(params: ResolvedLayoutParams): LayoutCandidate[] {
  const distributions: Array<'centered' | 'elk'> = params.distribution === 'elk' ? ['elk'] : params.distribution === 'centered' ? ['centered'] : ['centered', 'elk'];
  const directions: LayoutDirection[] = params.directionMode === 'auto' ? [params.direction, otherDirection(params.direction)] : [params.direction];
  const list: LayoutCandidate[] = [];
  directions.forEach((direction, di) => {
    for (const distribution of distributions) {
      const variants = distribution === 'centered' ? BASE_VARIANTS.slice(0, 2) : BASE_VARIANTS;
      for (const variant of variants) {
        list.push({ direction, distribution, variant, preferred: di === 0 && distribution === distributions[0] });
      }
    }
  });
  return list;
}

function isClean(r: LayoutResult): boolean {
  const q = r.quality;
  return !!q && q.crossings === 0 && q.edgeNodeOverlaps === 0 && q.labelOverlaps === 0;
}

/** Ejecuta un candidato: ELK y, si procede, distribución centrada + enrutado propio. */
export async function runCandidate(derived: DerivedView, params: ResolvedLayoutParams, candidate: LayoutCandidate): Promise<LayoutResult> {
  const p = { ...params, direction: candidate.direction };
  let base: LayoutResult;
  try {
    base = await runElkLayout(derived, p, candidate.variant);
  } catch (error) {
    if (candidate.variant.noLayerConstraints) throw error;
    base = await runElkLayout(derived, p, { ...candidate.variant, noLayerConstraints: true });
  }
  if (candidate.distribution === 'elk') {
    base.quality = { ...measureDerived(derived, base.positions, base.boundaries, p.direction, base.routes), strategy: `${p.direction}/elk/${candidate.variant.name}` };
    return base;
  }
  const spacingFactor = candidate.variant.spacingFactor ?? 1;
  const distributed = distributeCentered(base.positions, derived, {
    direction: p.direction,
    spacing: Math.round(p.spacing * spacingFactor),
    layerSpacing: Math.round(p.layerSpacing * spacingFactor),
  });
  const boundaries = boundariesFromPositions(derived, distributed.positions);
  const containment = new Map<string, Set<string>>();
  const boundaryParent = new Map(derived.boundaries.map((b) => [b.id, b.boundaryId]));
  for (const n of derived.nodes) {
    const set = new Set<string>();
    let current = n.boundaryId;
    while (current && !set.has(current)) {
      set.add(current);
      current = boundaryParent.get(current);
    }
    containment.set(n.id, set);
  }
  const routes = routeEdges({
    rects: distributed.positions,
    boundaries,
    containment,
    edges: derived.edges.map((e) => ({ id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: estimateLabelSize(e.relationship.description, e.relationship.technology) })),
    direction: p.direction,
    spacing: p.spacing,
  });
  const result: LayoutResult = { viewId: derived.view.id, positions: distributed.positions, boundaries, routes, direction: p.direction, distribution: 'centered' };
  result.quality = { ...measureDerived(derived, result.positions, result.boundaries, p.direction, routes), strategy: `${p.direction}/centered/${candidate.variant.name}` };
  return result;
}

export async function smartLayout(derived: DerivedView, params: ResolvedLayoutParams, candidates: LayoutCandidate[] = buildCandidates(params)): Promise<LayoutResult> {
  let best: LayoutResult | null = null;
  let bestScore = Infinity;
  let tried = 0;

  const attempt = async (candidate: LayoutCandidate): Promise<boolean> => {
    const result = await runCandidate(derived, params, candidate);
    tried += 1;
    // Bonus a la clase preferida: entre resultados no limpios, gana el preferido salvo diferencia clara.
    const effective = result.quality!.score * (candidate.preferred ? 0.8 : 1);
    if (effective < bestScore) {
      bestScore = effective;
      best = result;
    }
    return isClean(result);
  };

  for (const c of candidates) if (await attempt(c)) break;
  if (best && !isClean(best)) {
    for (const v of RESCUE_VARIANTS) {
      if (await attempt({ direction: params.direction, distribution: 'elk', variant: v, preferred: false })) break;
    }
  }

  const chosen = best!;
  chosen.quality = { ...chosen.quality!, candidates: tried };
  return chosen;
}
