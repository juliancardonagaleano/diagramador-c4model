import type { DerivedView } from '../model/viewDerivation';
import { measureDerived, runElkLayout, type LayoutResult, type LayoutVariant, type ResolvedLayoutParams } from './elkLayout';

/**
 * Autolayout con autocorrección: prueba varias estrategias de ELK y se queda con
 * la de mejor calidad (menos cruces y solapes, menor área). Se detiene en cuanto
 * un candidato es "limpio" (0 cruces, 0 solapes).
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

function isClean(r: LayoutResult): boolean {
  const q = r.quality;
  return !!q && q.crossings === 0 && q.edgeNodeOverlaps === 0 && q.labelOverlaps === 0;
}

export async function smartLayout(derived: DerivedView, params: ResolvedLayoutParams, variants: LayoutVariant[] = BASE_VARIANTS): Promise<LayoutResult> {
  let best: LayoutResult | null = null;
  let tried = 0;

  const attempt = async (variant: LayoutVariant): Promise<boolean> => {
    let result: LayoutResult;
    try {
      result = await runElkLayout(derived, params, variant);
    } catch (error) {
      // Algunas combinaciones (p. ej. restricciones de capa con jerarquía) pueden ser rechazadas por ELK.
      if (variant.noLayerConstraints) throw error;
      result = await runElkLayout(derived, params, { ...variant, noLayerConstraints: true });
    }
    tried += 1;
    result.quality = { ...measureDerived(derived, result.positions, result.boundaries, params.direction, result.routes), strategy: variant.name };
    if (!best || result.quality.score < best.quality!.score) best = result;
    return isClean(result);
  };

  for (const v of variants) if (await attempt(v)) break;
  if (best && !isClean(best)) {
    for (const v of RESCUE_VARIANTS) if (await attempt(v)) break;
  }

  const chosen = best!;
  chosen.quality = { ...chosen.quality!, candidates: tried };
  return chosen;
}
