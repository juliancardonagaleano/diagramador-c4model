import type { ModuleIssue } from '@iark/kernel';
import { inheritance } from './inherit';
import { findLineageCycles, indexLineage } from './lineage';
import { CLASSIFICATION_LABELS, CLASSIFICATION_RANK, ENTITY_KINDS, KIND_LABELS, hasPii, type Column, type ColumnRef, type DataAsset, type DataDocument, type Pipeline } from './types';

const CONFIDENTIAL = CLASSIFICATION_RANK.confidential;

/** Sensibilidad de un activo: su clasificación o, si tiene datos personales y no la declara, confidencial como mínimo. */
export function sensitivity(asset: DataAsset): number | undefined {
  if (asset.classification) return CLASSIFICATION_RANK[asset.classification];
  return hasPii(asset) ? CONFIDENTIAL : undefined;
}

type AssetLabel = (a: DataAsset) => string;

/**
 * Linaje de columnas de un pipeline: un mapeo a (o desde) una columna que el activo no declara y datos personales que
 * llegan a una columna no marcada como tal (salvo que el pipeline anonimice). Los informes y modelos sin columnas
 * declaradas aceptan cualquier nombre, porque describen indicadores y no tablas.
 */
function mappingIssues(p: Pipeline, assets: Map<string, DataAsset>, label: AssetLabel): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const column = (r: ColumnRef): { asset?: DataAsset; column?: Column; missing: boolean } => {
    const asset = assets.get(r.assetId);
    const found = asset?.columns?.find((c) => c.name === r.column);
    const free = !!asset && !found && (asset.columns?.length ?? 0) === 0 && !ENTITY_KINDS.includes(asset.kind);
    return { asset, column: found, missing: !!asset && !found && !free };
  };
  const reported = new Set<string>();
  for (const m of p.mappings ?? []) {
    const from = column(m.from);
    const to = column(m.to);
    for (const [ref, c] of [[m.from, from], [m.to, to]] as const) {
      const key = `${ref.assetId}.${ref.column}`;
      if (!c.missing || reported.has(key)) continue;
      reported.add(key);
      issues.push({ severity: 'warning', elementId: p.id, message: `El pipeline «${p.name}» mapea la columna «${ref.column}», que ${label(c.asset!)} no declara.` });
    }
    if (!p.anonymizes && from.column?.pii && to.asset && to.column && !to.column.pii) {
      issues.push({
        severity: 'warning',
        elementId: to.asset.id,
        message: `La columna «${to.column.name}» de ${label(to.asset)} recibe datos personales de «${m.from.column}» (${label(from.asset!)}) por el pipeline «${p.name}» pero no está marcada como PII. Si anonimiza los datos, márcalo con anonymizes.`,
      });
    }
  }
  return issues;
}

/**
 * Reglas de gobierno y calidad del modelo de datos (avisos que no invalidan el documento pero conviene corregir):
 * datos personales sin clasificar o clasificados a la baja a lo largo del linaje, activos sin responsable, sin origen o
 * sin uso, pipelines sin frecuencia, ciclos de linaje y relaciones N:M sin tabla intermedia.
 */
export function analyzeData(doc: DataDocument): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const label = (a: DataAsset): string => `${KIND_LABELS[a.kind]} «${a.name}»`;
  const { producers, consumers } = indexLineage(doc);
  const inRelation = new Set(doc.relations.flatMap((r) => [r.sourceId, r.targetId]));
  const children = new Map<string, DataAsset[]>();
  for (const a of doc.assets) if (a.parentId) children.set(a.parentId, [...(children.get(a.parentId) ?? []), a]);

  const { ownerOf, domainOf } = inheritance(doc);
  // Un dato derivado se produce dentro de la plataforma: informes, modelos y lo que vive en un almacén o un lago.
  const isDerived = (a: DataAsset): boolean =>
    a.kind === 'report' || a.kind === 'model' || (['table', 'view', 'file'].includes(a.kind) && ['warehouse', 'lake'].includes(assets.get(a.parentId ?? '')?.kind ?? ''));
  const participates = (a: DataAsset): boolean => producers.has(a.id) || consumers.has(a.id) || inRelation.has(a.id) || (children.get(a.id) ?? []).some(participates);

  for (const a of doc.assets) {
    const pii = hasPii(a);
    const rank = sensitivity(a);
    if (pii && !a.classification) {
      issues.push({ severity: 'warning', elementId: a.id, message: `${label(a)} contiene datos personales pero no tiene clasificación.` });
    } else if (pii && a.classification && CLASSIFICATION_RANK[a.classification] < CONFIDENTIAL) {
      issues.push({ severity: 'warning', elementId: a.id, message: `${label(a)} contiene datos personales pero está clasificado como ${CLASSIFICATION_LABELS[a.classification]}: como mínimo debería ser confidencial.` });
    }
    if (pii && !a.retention) issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} contiene datos personales y no declara política de retención.` });

    if (!a.external && !ownerOf(a.id)) {
      issues.push({
        severity: pii || (rank ?? 0) >= CONFIDENTIAL ? 'warning' : 'info',
        elementId: a.id,
        message: `${label(a)} no tiene responsable (owner).`,
      });
    }

    if (isDerived(a) && !producers.has(a.id)) issues.push({ severity: 'warning', elementId: a.id, message: `${label(a)} no tiene origen: ningún pipeline lo escribe.` });
    if (!participates(a) && a.kind !== 'source') {
      issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} no participa en ningún pipeline ni relación.` });
    }
    if (doc.domains.length > 0 && !a.parentId && !domainOf(a.id)) {
      issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} no pertenece a ningún dominio.` });
    }
    if (a.kind === 'table' && (a.columns?.length ?? 0) > 0 && !a.columns!.some((c) => c.keys?.includes('pk'))) {
      issues.push({ severity: 'info', elementId: a.id, message: `${label(a)} no declara clave primaria.` });
    }
  }

  for (const d of doc.domains) {
    if (!doc.assets.some((a) => a.domainId === d.id)) issues.push({ severity: 'info', elementId: d.id, message: `El dominio «${d.name}» no tiene activos.` });
  }

  for (const p of doc.pipelines) {
    if (!p.schedule && ['batch', 'elt', 'replication', 'api'].includes(p.kind)) {
      issues.push({ severity: 'info', elementId: p.id, message: `El pipeline «${p.name}» no declara su frecuencia (schedule).` });
    }
    issues.push(...mappingIssues(p, assets, label));
    if (p.anonymizes) continue;
    for (const inId of p.inputs) {
      const input = assets.get(inId);
      const inRank = input ? sensitivity(input) : undefined;
      if (!input || inRank === undefined) continue;
      for (const outId of p.outputs) {
        const output = assets.get(outId);
        if (!output) continue;
        const outRank = sensitivity(output);
        const why = input.classification ? `clasificado como ${CLASSIFICATION_LABELS[input.classification]}` : 'con datos personales';
        if (output.classification === undefined && !hasPii(output)) {
          issues.push({ severity: 'warning', elementId: outId, message: `${label(output)} deriva de ${label(input)} (${why}) por el pipeline «${p.name}» pero no tiene clasificación.` });
        } else if (outRank !== undefined && outRank < inRank) {
          issues.push({
            severity: 'warning',
            elementId: outId,
            message: `${label(output)} se clasifica como ${CLASSIFICATION_LABELS[output.classification ?? 'confidential']} pero deriva de ${label(input)} (${why}) por el pipeline «${p.name}». Si anonimiza los datos, márcalo con anonymizes.`,
          });
        }
        if (hasPii(input) && !hasPii(output)) {
          issues.push({ severity: 'info', elementId: outId, message: `${label(output)} deriva de ${label(input)}, que tiene datos personales, y no está marcado como tal.` });
        }
      }
    }
  }

  for (const cycle of findLineageCycles(doc)) {
    issues.push({ severity: 'warning', elementId: cycle[0], message: `Linaje circular: ${cycle.map((id) => assets.get(id)?.name ?? id).join(' → ')}.` });
  }

  for (const r of doc.relations) {
    const s = assets.get(r.sourceId);
    const t = assets.get(r.targetId);
    if (r.cardinality === 'N:M' && s?.kind === 'table' && t?.kind === 'table') {
      issues.push({ severity: 'info', elementId: r.id, message: `La relación N:M entre «${s.name}» y «${t.name}» normalmente se resuelve con una tabla intermedia.` });
    }
  }

  return issues;
}
