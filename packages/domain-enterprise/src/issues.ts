import type { ModuleIssue } from '@iark/kernel';
import { applicationsByCapability, capabilityChildren, dependencyGraph, ownership, stageCapabilities, streamStages } from './graph';
import {
  CRITICALITY_LABELS,
  CRITICALITY_RANK,
  KIND_LABELS,
  LIFECYCLE_LABELS,
  indexElements,
  lifecycleOf,
  type Application,
  type Capability,
  type Element,
  type EnterpriseDocument,
  type Lifecycle,
  type BusinessService,
  type Process,
  type Technology,
  type ValueStage,
  type ValueStream,
} from './types';

/** Número de aplicaciones a partir del cual una capacidad se marca como posible duplicidad. */
export const REDUNDANCY_THRESHOLD = 3;
/** Con cuántos meses de antelación se avisa de que una tecnología sale de soporte. */
const EOL_HORIZON_MONTHS = 12;

export interface AnalyzeOptions {
  /** Fecha de referencia para el fin de soporte (por defecto, hoy). */
  today?: Date;
}

const ALIVE: Lifecycle[] = ['planned', 'active'];
const label = (e: Element): string => `${KIND_LABELS[e.kind]} «${e.name}»`;
const inline = (e: Element): string => `${KIND_LABELS[e.kind].toLowerCase()} «${e.name}»`;
const lifecycleOfElement = (e: Element): Lifecycle => lifecycleOf(e.item as { lifecycle?: Lifecycle });

/** Último instante del día (o del mes, si solo se da `AAAA-MM`) de una fecha de fin de soporte. */
function endOfLifeDate(text: string): Date {
  const [y, m, d] = text.split('-').map(Number);
  return d ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59)) : new Date(Date.UTC(y, m, 0, 23, 59, 59));
}

/**
 * Reglas de gobierno del modelo empresarial (avisos que no invalidan el documento pero conviene corregir): capacidades
 * sin aplicación, aplicaciones sin responsable de negocio o sin uso, dependencias de tecnología en retirada o fuera de
 * soporte, aplicaciones en retirada que nadie sustituye, duplicidades, procesos sin capacidad, etapas de un flujo de valor
 * que ninguna capacidad habilita y servicios de negocio que no exponen nada.
 */
export function analyzeEnterprise(doc: EnterpriseDocument, options: AnalyzeOptions = {}): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const today = options.today ?? new Date();
  const elements = indexElements(doc);
  const at = (id: string): Element => elements.get(id)!;
  const { ownerOf } = ownership(doc);
  const children = capabilityChildren(doc);
  const appsOf = applicationsByCapability(doc);
  const graph = dependencyGraph(doc);
  const names = (ids: Iterable<string>): string => [...ids].map((id) => `«${at(id).name}»`).join(', ');
  const add = (severity: ModuleIssue['severity'], id: string, message: string): void => void issues.push({ severity, elementId: id, message });

  const capabilityIssues = (c: Capability): void => {
    const e = at(c.id);
    const apps = appsOf.get(c.id) ?? new Set<string>();
    if (!children.has(c.id) && apps.size === 0) {
      add(c.importance === 'differentiating' || c.importance === 'core' ? 'warning' : 'info', c.id, `${label(e)} no está soportada por ninguna aplicación.`);
    }
    if (apps.size >= REDUNDANCY_THRESHOLD) add('info', c.id, `${label(e)} está soportada por ${apps.size} aplicaciones (${names(apps)}): revisa si hay duplicidades.`);
    if (!c.parentId && !ownerOf(c.id)) add('info', c.id, `${label(e)} no tiene responsable (unidad).`);
    if (c.importance === 'differentiating' && c.maturity !== undefined && c.maturity <= 2) {
      add('info', c.id, `${label(e)} es diferenciadora y su madurez es baja (${c.maturity} de 5).`);
    }
  };

  const processIssues = (p: Process): void => {
    const e = at(p.id);
    if (!doc.relations.some((r) => r.kind === 'realizes' && r.sourceId === p.id)) add('info', p.id, `${label(e)} no realiza ninguna capacidad.`);
    if (!doc.relations.some((r) => r.kind === 'supports' && r.targetId === p.id)) add('info', p.id, `${label(e)} no está soportado por ninguna aplicación.`);
    if (!ownerOf(p.id)) add('info', p.id, `${label(e)} no tiene responsable (unidad).`);
  };

  const applicationIssues = (a: Application): void => {
    const e = at(a.id);
    const life = lifecycleOf(a);
    const supported = doc.relations.filter((r) => r.kind === 'supports' && r.sourceId === a.id);
    const dependents = graph.leanedBy.get(a.id) ?? [];
    const aliveDependents = dependents.filter((id) => lifecycleOfElement(at(id)) !== 'retired');

    if (life !== 'retired') {
      if (!ownerOf(a.id)) {
        const severe = a.criticality === 'high' || a.criticality === 'critical';
        add(severe ? 'warning' : 'info', a.id, `${label(e)} no tiene responsable de negocio (unidad).`);
      }
      if (supported.length === 0 && dependents.length === 0) add('info', a.id, `${label(e)} no soporta ninguna capacidad ni proceso.`);
      if (!a.external && !a.technology && !doc.relations.some((r) => r.kind === 'runs-on' && r.sourceId === a.id)) {
        add('info', a.id, `${label(e)} no declara en qué tecnología se ejecuta.`);
      }
    }
    if (life === 'retired' && aliveDependents.length > 0) {
      add('warning', a.id, `${label(e)} está retirada pero todavía se apoyan en ella: ${names(aliveDependents)}.`);
    }
    if (life === 'sunset') {
      for (const r of supported) {
        const alternatives = doc.relations.filter((o) => o.kind === 'supports' && o.targetId === r.targetId && o.sourceId !== a.id && ALIVE.includes(lifecycleOfElement(at(o.sourceId))));
        if (alternatives.length === 0) add('warning', a.id, `${label(e)} está en retirada y es la única que soporta ${inline(at(r.targetId))}: falta la aplicación que la sustituya.`);
      }
    }
  };

  const technologyIssues = (t: Technology): void => {
    const e = at(t.id);
    const life = lifecycleOf(t);
    if (t.endOfLife && life !== 'retired') {
      const end = endOfLifeDate(t.endOfLife);
      const horizon = new Date(today);
      horizon.setUTCMonth(horizon.getUTCMonth() + EOL_HORIZON_MONTHS);
      if (end < today) add('warning', t.id, `${label(e)} está fuera de soporte desde ${t.endOfLife}.`);
      else if (end <= horizon) add('info', t.id, `${label(e)} sale de soporte el ${t.endOfLife}.`);
    }
    if (life === 'active' && (graph.leanedBy.get(t.id) ?? []).length === 0) add('info', t.id, `${label(e)} no la usa ninguna aplicación.`);
    if (life === 'retired' && (graph.leanedBy.get(t.id) ?? []).length > 0) {
      add('warning', t.id, `${label(e)} está retirada pero todavía se apoyan en ella: ${names(graph.leanedBy.get(t.id)!)}.`);
    }
  };

  const enabling = stageCapabilities(doc);
  const stages = streamStages(doc);
  const streamIssues = (v: ValueStream): void => {
    if ((stages.get(v.id) ?? []).length === 0) add('info', v.id, `${label(at(v.id))} no tiene etapas.`);
  };
  const stageIssues = (s: ValueStage): void => {
    if ((enabling.get(s.id) ?? []).length === 0) add('warning', s.id, `${label(at(s.id))} no está habilitada por ninguna capacidad.`);
  };
  const serviceIssues = (b: BusinessService): void => {
    if (!doc.relations.some((r) => r.kind === 'exposes' && r.sourceId === b.id)) add('info', b.id, `${label(at(b.id))} no expone ningún proceso ni capacidad.`);
  };

  doc.valueStreams.forEach(streamIssues);
  doc.valueStages.forEach(stageIssues);
  doc.businessServices.forEach(serviceIssues);
  doc.capabilities.forEach(capabilityIssues);
  doc.processes.forEach(processIssues);
  doc.applications.forEach(applicationIssues);
  doc.technologies.forEach(technologyIssues);

  for (const r of doc.relations) {
    if (r.kind !== 'runs-on' && r.kind !== 'depends-on') continue;
    const source = at(r.sourceId);
    const target = at(r.targetId);
    const [sourceLife, targetLife] = [lifecycleOfElement(source), lifecycleOfElement(target)];
    const verb = r.kind === 'runs-on' ? 'se ejecuta en' : 'depende de';
    if (ALIVE.includes(sourceLife) && !ALIVE.includes(targetLife)) {
      add('warning', source.id, `${label(source)} ${verb} ${inline(target)}, que está ${LIFECYCLE_LABELS[targetLife]}.`);
    }
    if (r.kind === 'depends-on' && source.kind === 'application') {
      const [s, t] = [source.item as Application, target.item as Application];
      if (s.criticality && t.criticality && CRITICALITY_RANK[s.criticality] >= CRITICALITY_RANK.high && t.criticality === 'low') {
        add('info', source.id, `${label(source)} (criticidad ${CRITICALITY_LABELS[s.criticality]}) depende de ${inline(target)}, de criticidad baja.`);
      }
    }
  }
  return issues;
}
