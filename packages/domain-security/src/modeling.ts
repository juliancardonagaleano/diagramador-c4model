import { uniqueId, type EditResult, type EditorAction } from '@iark/kernel';
import { crossings, effectiveClassification, type Crossing } from './graph';
import {
  CONTROL_LABELS,
  CONTROL_STANDARDS,
  STANDARD_LABELS,
  STRIDE_BY_ELEMENT,
  STRIDE_LABELS,
  TRUST_LABELS,
  controlStatusOf,
  flowName,
  indexElements,
  sensitive,
  trustOf,
  type Asset,
  type Control,
  type ControlKind,
  type ControlStandard,
  type Flow,
  type SecurityDocument,
  type Stride,
  type Threat,
} from './types';

const ok = (document: SecurityDocument, id?: string): EditResult<SecurityDocument> => ({ ok: true, document, id });
const fail = (reason: string): EditResult<SecurityDocument> => ({ ok: false, reason });

/** Flujos que cruzan una frontera de confianza, por id. */
export const crossingsById = (doc: SecurityDocument): Map<string, Crossing> => new Map(crossings(doc).map((c) => [c.flow.id, c]));

/** Texto del cruce: «Internet (no confiable) → Interna (interna)». */
export const crossingLabel = (c: Crossing): string => `${c.from.name} (${TRUST_LABELS[trustOf(c.from)]}) → ${c.to.name} (${TRUST_LABELS[trustOf(c.to)]})`;

/** Un flujo que entra en una zona más confiable debe autenticar a quien lo envía. */
export const needsAuthentication = (c: Crossing | undefined): boolean => c?.direction === 'ingress';

/** Control que suele mitigar cada categoría STRIDE. */
export const CONTROL_FOR_STRIDE: Record<Stride, ControlKind> = {
  spoofing: 'authentication',
  tampering: 'validation',
  repudiation: 'logging',
  'information-disclosure': 'encryption',
  'denial-of-service': 'rate-limit',
  'elevation-of-privilege': 'authorization',
};

/**
 * Amenazas STRIDE que aplican a lo seleccionado (o, sin selección, a todo lo que toca una frontera de confianza): por
 * tipo de activo (`STRIDE_BY_ELEMENT`) y, en los flujos, solo los que cruzan una frontera. Excluye las ya modeladas.
 */
export function suggestThreats(doc: SecurityDocument, scope: string[] = []): Threat[] {
  const crossing = crossingsById(doc);
  const explicit = new Set(scope);
  const chosen = doc.assets.some((a) => explicit.has(a.id)) || doc.flows.some((f) => explicit.has(f.id));
  const touched = new Set([...crossing.values()].flatMap((c) => [c.flow.sourceId, c.flow.targetId]));
  const taken = new Set([...indexElements(doc).keys()]);
  const existing = new Set(doc.threats.map((t) => `${t.targetId}|${t.category}`));
  const out: Threat[] = [];
  const propose = (target: Asset | Flow, kind: keyof typeof STRIDE_BY_ELEMENT, name: string): void => {
    const c = crossing.get(target.id);
    const classification = 'zoneId' in target ? effectiveClassification(doc, target) : target.classification;
    for (const category of STRIDE_BY_ELEMENT[kind]) {
      if (existing.has(`${target.id}|${category}`)) continue;
      const id = uniqueId(`${target.id}-${category}`, taken);
      taken.add(id);
      out.push({
        id,
        title: `${STRIDE_LABELS[category]} en ${name}`,
        category,
        targetId: target.id,
        ...(c && trustOf(c.from) === 'untrusted' ? { likelihood: 'high' as const } : {}),
        ...(sensitive(classification) ? { impact: 'high' as const } : {}),
        description: c ? `Propuesta: el flujo cruza una frontera de confianza (${crossingLabel(c)}).` : 'Propuesta por el tipo de elemento (STRIDE).',
        suggested: true,
      });
    }
  };
  for (const a of doc.assets) if (chosen ? explicit.has(a.id) : touched.has(a.id)) propose(a, a.kind, a.name);
  for (const f of doc.flows) if (chosen ? explicit.has(f.id) : crossing.has(f.id)) propose(f, 'flow', flowName(doc, f));
  return out;
}

/** Controles por estándar y cuántas amenazas cubren; «Sin estándar» agrupa los que no declaran ninguno. */
export function standardsCoverage(doc: SecurityDocument): Array<{ standard: ControlStandard | 'none'; label: string; controls: number; threats: number }> {
  const rows = [...CONTROL_STANDARDS, 'none' as const].map((standard) => {
    const controls = doc.controls.filter((c) => (c.standard ?? 'none') === standard);
    const ids = new Set(controls.map((c) => c.id));
    return { standard, label: standard === 'none' ? 'Sin estándar' : STANDARD_LABELS[standard], controls: controls.length, threats: doc.threats.filter((t) => (t.controlIds ?? []).some((c) => ids.has(c))).length };
  });
  return rows.filter((r) => r.standard !== 'none' || r.controls > 0);
}

/** Cobertura de una amenaza por los controles de un catálogo de estándares: con un control implementado, solo con controles previstos o ninguna. */
export type Coverage = 'covered' | 'planned' | 'none';
export const COVERAGE_LABELS: Record<Coverage, string> = { covered: 'cubierta', planned: 'cobertura prevista', none: 'sin cobertura' };

/**
 * Cobertura de una amenaza por los controles de una vista de estándares (`controlIds`, los de la vista): cubierta si alguno de
 * sus controles enlazados dentro de ese conjunto está implementado, con cobertura prevista si los que tiene solo están
 * previstos, y sin cobertura si no tiene ninguno. `controls` son los enlazados que cuentan, sin repetir y en el orden de la
 * amenaza.
 */
export function threatCoverage(doc: SecurityDocument, controlIds: readonly string[], t: Threat): { level: Coverage; controls: Control[] } {
  const controls = [...new Set(t.controlIds ?? [])]
    .filter((id) => controlIds.includes(id))
    .map((id) => doc.controls.find((c) => c.id === id))
    .filter((c): c is Control => c !== undefined);
  const level = controls.length === 0 ? 'none' : controls.some((c) => controlStatusOf(c) === 'implemented') ? 'covered' : 'planned';
  return { level, controls };
}

const suggestedIn = (doc: SecurityDocument, ids: string[]): Threat[] => doc.threats.filter((t) => t.suggested === true && ids.includes(t.id));

export const securityActions: Array<EditorAction<SecurityDocument>> = [
  {
    id: 'suggest-threats',
    label: 'Sugerir amenazas',
    hint: 'Propone categorías STRIDE por tipo de elemento y por cruce de frontera (de lo seleccionado o, sin selección, de todo lo que cruza una frontera)',
    needs: 'none',
    disabled: (doc, ids) => (suggestThreats(doc, ids).length === 0 ? 'No hay amenazas nuevas que sugerir.' : undefined),
    run(doc, ids) {
      const proposals = suggestThreats(doc, ids);
      if (proposals.length === 0) return fail('No hay amenazas nuevas que sugerir.');
      return ok({ ...doc, threats: [...doc.threats, ...proposals] }, proposals[0].id);
    },
  },
  {
    id: 'accept-suggestion',
    label: 'Aceptar sugerencia',
    hint: 'Convierte las amenazas sugeridas seleccionadas en amenazas del modelo',
    needs: 'many',
    disabled: (doc, ids) => (suggestedIn(doc, ids).length === 0 ? 'Selecciona una amenaza sugerida.' : undefined),
    run(doc, ids) {
      const chosen = new Set(suggestedIn(doc, ids).map((t) => t.id));
      if (chosen.size === 0) return fail('Selecciona una amenaza sugerida.');
      return ok({
        ...doc,
        threats: doc.threats.map((t) => {
          if (!chosen.has(t.id)) return t;
          const { suggested: _suggested, ...accepted } = t;
          return accepted;
        }),
      });
    },
  },
  {
    id: 'discard-suggestion',
    label: 'Descartar sugerencia',
    hint: 'Borra las amenazas sugeridas seleccionadas',
    needs: 'many',
    disabled: (doc, ids) => (suggestedIn(doc, ids).length === 0 ? 'Selecciona una amenaza sugerida.' : undefined),
    run(doc, ids) {
      const chosen = new Set(suggestedIn(doc, ids).map((t) => t.id));
      if (chosen.size === 0) return fail('Selecciona una amenaza sugerida.');
      return ok({ ...doc, threats: doc.threats.filter((t) => !chosen.has(t.id)) });
    },
  },
  {
    id: 'protect-flow',
    label: 'Proteger flujo',
    hint: 'Cifra el flujo en tránsito, exige autenticación si entra en una zona más confiable y añade el control',
    needs: 'one',
    disabled: (doc, ids) => {
      const flow = doc.flows.find((f) => f.id === ids[0]);
      if (!flow) return 'Selecciona un flujo de datos.';
      return flow.encrypted === true && (flow.authentication ?? 'none') !== 'none' ? 'El flujo ya va cifrado y autenticado.' : undefined;
    },
    run(doc, ids) {
      const flow = doc.flows.find((f) => f.id === ids[0]);
      if (!flow) return fail('Selecciona un flujo de datos.');
      const authentication = (flow.authentication ?? 'none') === 'none' && needsAuthentication(crossingsById(doc).get(flow.id)) ? 'token' : flow.authentication;
      const id = uniqueId(`cifrado-${flow.id}`, indexElements(doc).keys());
      const control: Control = { id, name: `Cifrado en tránsito: ${flowName(doc, flow)}`, kind: 'encryption', status: 'planned', description: 'TLS en el flujo de datos.' };
      const protectedFlow: Flow = { ...flow, encrypted: true, ...(authentication ? { authentication } : {}) };
      const threats = doc.threats.map((t) => (t.targetId === flow.id && t.category === 'information-disclosure' ? { ...t, controlIds: [...(t.controlIds ?? []), id] } : t));
      return ok({ ...doc, flows: doc.flows.map((f) => (f.id === flow.id ? protectedFlow : f)), controls: [...doc.controls, control], threats }, flow.id);
    },
  },
  {
    id: 'mitigate-threat',
    label: 'Mitigar amenaza',
    hint: 'Crea un control previsto para la categoría STRIDE de la amenaza y la enlaza con él',
    needs: 'one',
    disabled: (doc, ids) => (doc.threats.some((t) => t.id === ids[0]) ? undefined : 'Selecciona una amenaza.'),
    run(doc, ids) {
      const threat = doc.threats.find((t) => t.id === ids[0]);
      if (!threat) return fail('Selecciona una amenaza.');
      const kind = CONTROL_FOR_STRIDE[threat.category];
      const id = uniqueId(`${kind}-${threat.id}`, indexElements(doc).keys());
      const control: Control = { id, name: `${CONTROL_LABELS[kind]}: ${threat.title}`, kind, status: 'planned' };
      return ok({ ...doc, controls: [...doc.controls, control], threats: doc.threats.map((t) => (t.id === threat.id ? { ...t, controlIds: [...(t.controlIds ?? []), id] } : t)) }, id);
    },
  },
];
