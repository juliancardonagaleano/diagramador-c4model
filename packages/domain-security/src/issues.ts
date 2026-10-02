import type { ModuleIssue } from '@iark/kernel';
import { crossings, effectiveClassification, isCrownJewel } from './graph';
import { surfaceDepths } from './views';
import {
  ASSET_LABELS,
  DATA_LABELS,
  ELEMENT_LABELS,
  RATING_LABELS,
  STRIDE_BY_ELEMENT,
  STRIDE_LABELS,
  TRUST_LABELS,
  classificationRank,
  controlStatusOf,
  indexElements,
  residualOf,
  riskOf,
  sensitive,
  statusOf,
  trustOf,
  trustRank,
  type Asset,
  type Element,
  type Flow,
  type SecurityDocument,
  type Zone,
} from './types';

const label = (e: Element): string => {
  if (e.kind === 'asset') return `${ASSET_LABELS[(e.item as Asset).kind]} «${e.name}»`;
  return `${ELEMENT_LABELS[e.kind]} «${e.name}»`;
};
const inline = (e: Element): string => {
  const text = label(e);
  return `${text[0].toLowerCase()}${text.slice(1)}`;
};

/** Elementos del modelo de amenazas a los que se aplica cada categoría STRIDE (activo o flujo). */
export function applicableCategories(e: Element): readonly string[] {
  return e.kind === 'flow' ? STRIDE_BY_ELEMENT.flow : e.kind === 'asset' ? STRIDE_BY_ELEMENT[(e.item as Asset).kind] : [];
}

/**
 * Reglas de gobierno del modelo de seguridad (avisos que no invalidan el documento pero conviene corregir): fronteras de
 * confianza cruzadas sin cifrar ni autenticar, datos sensibles sin proteger en reposo o en zonas poco confiables,
 * amenazas de riesgo alto abiertas, marcadas como mitigadas sin un control que lo respalde o que no aplican a su
 * elemento, y controles sin uso.
 */
export function analyzeSecurity(doc: SecurityDocument): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const elements = indexElements(doc);
  const at = (id: string): Element => elements.get(id)!;
  const zones = new Map<string, Zone>(doc.zones.map((z) => [z.id, z]));
  const assets = new Map<string, Asset>(doc.assets.map((a) => [a.id, a]));
  const controls = new Map(doc.controls.map((c) => [c.id, c]));
  const add = (severity: ModuleIssue['severity'], id: string, message: string): void => void issues.push({ severity, elementId: id, message });
  const flowLabel = (f: Flow): string => label(at(f.id));
  const zoneOfAsset = (a: Asset): Zone | undefined => zones.get(a.zoneId);

  for (const z of doc.zones) {
    if (!doc.assets.some((a) => a.zoneId === z.id) && !doc.zones.some((c) => c.parentId === z.id)) add('info', z.id, `${label(at(z.id))} no contiene ningún activo.`);
  }

  const withFlows = new Set(doc.flows.flatMap((f) => [f.sourceId, f.targetId]));
  for (const a of doc.assets) {
    const e = at(a.id);
    const zone = zoneOfAsset(a);
    if (!withFlows.has(a.id)) add('info', a.id, `${label(e)} no intercambia datos con ningún otro activo.`);
    if (a.kind === 'datastore') {
      if (sensitive(a.classification) && a.encryptedAtRest !== true) {
        add('warning', a.id, `${label(e)} guarda datos ${DATA_LABELS[a.classification!]} ${a.encryptedAtRest === false ? 'sin cifrar' : 'y no se sabe si están cifrados'} en reposo.`);
      }
      if (sensitive(a.classification) && zone && trustRank(trustOf(zone)) < trustRank('internal')) {
        add('warning', a.id, `${label(e)} guarda datos ${DATA_LABELS[a.classification!]} en la zona ${TRUST_LABELS[trustOf(zone)]} «${zone.name}»: deberían estar en una zona interna o restringida.`);
      }
    }
    if ((a.kind === 'process' || a.kind === 'datastore') && sensitive(a.classification) && !a.owner) add('info', a.id, `${label(e)} trata datos ${DATA_LABELS[a.classification!]} y no tiene responsable.`);
    // Un activo trata al menos la información de los flujos que envía o recibe.
    const flowsMax = effectiveClassification(doc, a);
    if ((a.kind === 'process' || a.kind === 'datastore') && a.classification && flowsMax && classificationRank(flowsMax) > classificationRank(a.classification)) {
      add('info', a.id, `${label(e)} declara datos ${DATA_LABELS[a.classification]}, pero intercambia datos ${DATA_LABELS[flowsMax]}.`);
    }
  }

  const crossingByFlow = new Map(crossings(doc).map((c) => [c.flow.id, c]));
  for (const f of doc.flows) {
    const [source, target] = [assets.get(f.sourceId)!, assets.get(f.targetId)!];
    const crossing = crossingByFlow.get(f.id);
    const data = f.classification ?? effectiveClassification(doc, source);
    if (crossing) {
      const weak = trustRank(trustOf(crossing.from)) <= trustRank('dmz') || trustRank(trustOf(crossing.to)) <= trustRank('dmz');
      if (f.encrypted !== true) {
        add(sensitive(data) || weak ? 'warning' : 'info', f.id, `${flowLabel(f)} cruza la frontera de «${crossing.from.name}» a «${crossing.to.name}» ${f.encrypted === false ? 'sin cifrar' : 'y no se sabe si va cifrado'}.`);
      }
      if (crossing.direction === 'ingress') {
        if (f.authentication === 'none') add('warning', f.id, `${flowLabel(f)} entra a la zona ${TRUST_LABELS[trustOf(crossing.to)]} «${crossing.to.name}» sin autenticación.`);
        else if (f.authentication === undefined && trustOf(crossing.from) !== 'internal') add('info', f.id, `${flowLabel(f)} entra a «${crossing.to.name}» desde «${crossing.from.name}» y no se indica cómo se autentica.`);
      }
      if (crossing.direction === 'ingress' && crossing.gap >= 2) {
        add('warning', f.id, `${flowLabel(f)} salta de la zona ${TRUST_LABELS[trustOf(crossing.from)]} «${crossing.from.name}» a la ${TRUST_LABELS[trustOf(crossing.to)]} «${crossing.to.name}» sin pasar por una zona intermedia.`);
      }
    }
    if (target.kind === 'external' && sensitive(data)) {
      add('warning', f.id, `${flowLabel(f)} envía datos ${DATA_LABELS[data!]} al sistema externo «${target.name}».`);
    }
    if (source.kind === 'datastore' && target.kind === 'actor' && sensitive(source.classification)) {
      add('warning', f.id, `${flowLabel(f)} entrega datos ${DATA_LABELS[source.classification!]} de un almacén directamente a un actor.`);
    }
  }

  const covered = new Set<string>();
  for (const t of doc.threats) {
    const e = at(t.id);
    const target = at(t.targetId);
    const risk = riskOf(t);
    const status = statusOf(t);
    const linked = (t.controlIds ?? []).map((id) => controls.get(id)!);
    for (const id of t.controlIds ?? []) covered.add(id);
    if (!applicableCategories(target).includes(t.category)) {
      add('info', t.id, `${label(e)}: ${STRIDE_LABELS[t.category].toLowerCase()} no suele aplicarse a ${inline(target)}.`);
    }
    if (status === 'open' && (risk.rating === 'critical' || risk.rating === 'high')) {
      add('warning', t.id, `${label(e)} sigue abierta con riesgo ${RATING_LABELS[risk.rating]} (${risk.score}) sobre ${inline(target)}${linked.length === 0 ? ' y sin controles' : ''}.`);
    }
    if (status === 'mitigated') {
      if (linked.length === 0) add('warning', t.id, `${label(e)} figura como mitigada pero no tiene ningún control asociado.`);
      else if (!linked.some((c) => controlStatusOf(c) === 'implemented')) add('warning', t.id, `${label(e)} figura como mitigada pero sus controles están solo previstos.`);
    }
    if (status === 'accepted' && risk.rating === 'critical') add('warning', t.id, `${label(e)} tiene riesgo crítico y está aceptada sin mitigar.`);
    const residual = residualOf(doc, t);
    if (residual.implemented > 0 && (residual.rating === 'critical' || residual.rating === 'high')) {
      add('warning', t.id, `${label(e)} mantiene riesgo residual ${RATING_LABELS[residual.rating]} (${residual.score}) pese a ${residual.implemented} ${residual.implemented === 1 ? 'control implementado' : 'controles implementados'}: refuerza los controles o acepta el riesgo.`);
    }
    if (status === 'open' && linked.some((c) => controlStatusOf(c) === 'implemented')) {
      add('info', t.id, `${label(e)} sigue abierta pese a tener controles implementados: revisa si ya está mitigada.`);
    }
  }
  for (const c of doc.controls) if (!covered.has(c.id)) add('info', c.id, `${label(at(c.id))} no mitiga ninguna amenaza.`);

  // Si algún control remite a un estándar, los que no lo declaran se salen de la cobertura.
  if (doc.controls.some((c) => c.standard !== undefined)) {
    for (const c of doc.controls) if (c.standard === undefined) add('info', c.id, `${label(at(c.id))} no indica a qué estándar remite (OWASP ASVS, NIST 800-53, ISO 27001, CIS) y queda fuera de la cobertura.`);
  }

  // Amenazas sin ningún control que remita a un estándar (con la cobertura de estándares en marcha).
  if (doc.controls.some((c) => c.standard !== undefined)) {
    for (const t of doc.threats) {
      if (statusOf(t) === 'accepted') continue;
      if (!(t.controlIds ?? []).some((id) => controls.get(id)?.standard !== undefined)) add('info', t.id, `${label(at(t.id))} no está cubierta por ningún control que remita a un estándar.`);
    }
  }

  // Superficie de ataque: lo que se alcanza desde una zona no confiable.
  const depths = surfaceDepths(doc);
  const threatenedAssets = new Set(doc.threats.map((t) => t.targetId));
  for (const a of doc.assets) {
    const depth = depths[a.id];
    if (depth === undefined || depth === 0) continue;
    const crown = isCrownJewel(doc, a);
    if (crown && depth <= 2) {
      add('warning', a.id, `${label(at(a.id))} es un activo a proteger y ${depth === 1 ? 'recibe flujos directamente desde una zona no confiable' : 'está a un salto de un activo expuesto a una zona no confiable'}.`);
    } else if (crown) add('info', a.id, `${label(at(a.id))} es un activo a proteger y se alcanza a ${depth - 1} saltos de la entrada desde una zona no confiable.`);
    if (depth === 1 && doc.threats.length > 0 && !threatenedAssets.has(a.id)) add('info', a.id, `${label(at(a.id))} está expuesto a una zona no confiable y no tiene amenazas analizadas.`);
  }

  // Con un análisis en marcha, lo que cruza fronteras o guarda datos sensibles debería tener sus amenazas estudiadas.
  if (doc.threats.length > 0) {
    const threatened = new Set(doc.threats.map((t) => t.targetId));
    for (const a of doc.assets) {
      if ((a.kind === 'process' || a.kind === 'datastore') && sensitive(a.classification) && !threatened.has(a.id)) add('info', a.id, `${label(at(a.id))} trata datos ${DATA_LABELS[a.classification!]} y no tiene amenazas analizadas.`);
    }
    for (const f of doc.flows) {
      if (crossingByFlow.has(f.id) && !threatened.has(f.id)) add('info', f.id, `${flowLabel(f)} cruza una frontera de confianza y no tiene amenazas analizadas.`);
    }
  }
  return issues;
}
