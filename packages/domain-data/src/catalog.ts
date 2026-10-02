import type { ModuleIssue } from '@iark/kernel';
import { inheritance } from './inherit';
import { CLASSIFICATION_LABELS, CLASSIFICATION_RANK, KIND_LABELS, TERM_LABEL, TERM_STATUS_LABELS, type DataAsset, type DataDocument, type GlossaryTerm } from './types';

/**
 * Reglas de gobierno del catálogo: productos de datos, APIs de datos y glosarios con sus términos. Avisos que no
 * invalidan el documento (la estructura la valida el esquema), como el resto de `analyzeData`.
 */

const label = (a: DataAsset): string => `${KIND_LABELS[a.kind]} «${a.name}»`;
const termLabel = (t: GlossaryTerm): string => `${TERM_LABEL} «${t.name}»`;

/** Un término sin estado es un borrador: solo los aprobados se exigen completos. */
const approved = (t: GlossaryTerm): boolean => t.status === 'approved';

/** Lo más sensible que sirve o publica un activo del catálogo (por su clasificación o sus datos personales), con el activo que lo causa. */
function mostSensitive(ids: string[] | undefined, assets: Map<string, DataAsset>, sensitivity: Sensitivity): { asset: DataAsset; rank: number } | undefined {
  let found: { asset: DataAsset; rank: number } | undefined;
  for (const id of ids ?? []) {
    const asset = assets.get(id);
    const rank = asset ? sensitivity(asset) : undefined;
    if (asset && rank !== undefined && (!found || rank > found.rank)) found = { asset, rank };
  }
  return found;
}

/** Sensibilidad de un activo (su clasificación, o confidencial si tiene datos personales sin clasificar): `sensitivity` de `issues.ts`. */
export type Sensitivity = (asset: DataAsset) => number | undefined;

const rankLabel = (rank: number): string => CLASSIFICATION_LABELS[(Object.keys(CLASSIFICATION_RANK) as Array<keyof typeof CLASSIFICATION_RANK>).find((c) => CLASSIFICATION_RANK[c] === rank) ?? 'confidential'];

export function catalogIssues(doc: DataDocument, sensitivity: Sensitivity): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const assets = new Map(doc.assets.map((a) => [a.id, a]));
  const terms = doc.terms ?? [];
  const { ownerOf } = inheritance(doc);
  const add = (severity: ModuleIssue['severity'], elementId: string, message: string): void => void issues.push({ severity, elementId, message });

  /** Una clasificación de la API o el producto por debajo de lo que publica, o ausente cuando publica algo sensible. */
  const exposure = (a: DataAsset, ids: string[] | undefined, verb: string): void => {
    const top = mostSensitive(ids, assets, sensitivity);
    if (!top) return;
    const why = top.asset.classification ? `clasificado como ${CLASSIFICATION_LABELS[top.asset.classification]}` : 'con datos personales';
    if (a.classification === undefined) add('warning', a.id, `${label(a)} ${verb} ${label(top.asset)} (${why}) pero no declara su clasificación.`);
    else if (CLASSIFICATION_RANK[a.classification] < top.rank) {
      add('warning', a.id, `${label(a)} está clasificado como ${CLASSIFICATION_LABELS[a.classification]} pero ${verb} ${label(top.asset)} (${why}): como mínimo debería ser ${rankLabel(top.rank)}.`);
    }
  };

  for (const a of doc.assets) {
    if (a.kind === 'data-product') {
      if (!ownerOf(a.id)) add('warning', a.id, `${label(a)} no tiene dueño (owner): nadie responde de su calidad ni de su SLA.`);
      if ((a.outputPorts ?? []).length === 0) add('warning', a.id, `${label(a)} no publica ningún activo: sin puertos de salida no ofrece nada.`);
      if ((a.inputPorts ?? []).length === 0) add('info', a.id, `${label(a)} no declara puertos de entrada: no se sabe de dónde salen sus datos.`);
      if (!a.freshness && !a.sla) add('info', a.id, `${label(a)} no declara su frescura ni su SLA.`);
      if (!a.contractId) add('info', a.id, `${label(a)} no tiene contrato de datos (contractId).`);
      exposure(a, a.outputPorts, 'publica');
    } else if (a.kind === 'data-api') {
      if (!ownerOf(a.id)) add('warning', a.id, `${label(a)} no tiene dueño (owner): nadie responde de su disponibilidad ni de sus cambios.`);
      if ((a.exposes ?? []).length === 0) add('warning', a.id, `${label(a)} no expone ningún activo.`);
      if (!a.contractId) add('warning', a.id, `${label(a)} no tiene contrato de datos (contractId): quien la consume no sabe qué esperar.`);
      if (!a.protocol) add('info', a.id, `${label(a)} no declara su protocolo.`);
      exposure(a, a.exposes, 'expone');
    } else if (a.kind === 'glossary') {
      if (!terms.some((t) => t.glossaryId === a.id)) add('info', a.id, `${label(a)} no tiene términos.`);
      if (!ownerOf(a.id)) add('info', a.id, `${label(a)} no tiene responsable (owner).`);
    }
  }

  const seen = new Map<string, GlossaryTerm>();
  for (const t of terms) {
    const status = t.status ?? 'draft';
    const linked = t.links ?? [];
    if (linked.length === 0 && status !== 'deprecated') add(approved(t) ? 'warning' : 'info', t.id, `${termLabel(t)} no está enlazado a ningún activo ni columna.`);
    if (linked.length > 0 && status === 'deprecated') add('warning', t.id, `${termLabel(t)} está ${TERM_STATUS_LABELS.deprecated} pero sigue enlazado a ${linked.length} activo(s) o columna(s).`);
    if (!t.definition?.trim()) add(approved(t) ? 'warning' : 'info', t.id, `${termLabel(t)} no tiene definición.`);
    if (!t.owner) add(approved(t) ? 'warning' : 'info', t.id, `${termLabel(t)} no tiene responsable (owner).`);
    if (t.glossaryId === undefined) add('info', t.id, `${termLabel(t)} no pertenece a ningún glosario.`);
    const key = `${t.glossaryId ?? ''}|${t.name.trim().toLowerCase()}`;
    const first = seen.get(key);
    if (first) add('warning', t.id, `${termLabel(t)} está definido dos veces${t.glossaryId ? ` en el glosario «${assets.get(t.glossaryId)?.name ?? t.glossaryId}»` : ''} (también como «${first.id}»).`);
    else seen.set(key, t);
    for (const l of linked) {
      const asset = assets.get(l.assetId);
      if (asset && l.column && (asset.columns?.length ?? 0) > 0 && !asset.columns!.some((c) => c.name === l.column)) {
        add('warning', t.id, `${termLabel(t)} enlaza la columna «${l.column}», que ${label(asset)} no declara.`);
      }
    }
  }

  for (const p of doc.pipelines) {
    for (const [verb, ids] of [['lee', p.inputs], ['escribe', p.outputs]] as const) {
      for (const id of ids) {
        const asset = assets.get(id);
        if (asset?.kind === 'glossary') add('warning', p.id, `El pipeline «${p.name}» ${verb} ${label(asset)}, que define términos y no guarda datos.`);
      }
    }
  }
  return issues;
}
