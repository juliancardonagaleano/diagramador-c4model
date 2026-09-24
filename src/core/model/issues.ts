import { elementMap } from './factories';
import type { C4Document } from './types';

export interface DocumentIssue {
  severity: 'error' | 'warning';
  message: string;
  elementId?: string;
  relationshipId?: string;
  viewId?: string;
}

/**
 * Análisis de calidad del modelo (equivalente al panel "Issues" de drawdb):
 * avisos que no invalidan el documento pero conviene corregir.
 */
export function analyzeDocument(doc: C4Document): DocumentIssue[] {
  const issues: DocumentIssue[] = [];
  const elements = elementMap(doc);

  for (const el of doc.model.elements) {
    if (!el.description?.trim()) {
      issues.push({ severity: 'warning', message: `"${el.name}" no tiene descripción`, elementId: el.id });
    }
    if ((el.type === 'container' || el.type === 'component') && !el.technology?.trim()) {
      issues.push({ severity: 'warning', message: `"${el.name}" no indica tecnología`, elementId: el.id });
    }
    if ((el.type === 'container' || el.type === 'component') && !el.parentId) {
      issues.push({ severity: 'error', message: `"${el.name}" (${el.type}) no tiene padre asignado`, elementId: el.id });
    }
    const related = doc.model.relationships.some((r) => r.sourceId === el.id || r.targetId === el.id);
    const hasChildren = doc.model.elements.some((e) => e.parentId === el.id);
    if (!related && !hasChildren) {
      issues.push({ severity: 'warning', message: `"${el.name}" no participa en ninguna relación`, elementId: el.id });
    }
  }

  const names = new Map<string, string[]>();
  for (const el of doc.model.elements) {
    const key = el.name.trim().toLowerCase();
    names.set(key, [...(names.get(key) ?? []), el.id]);
  }
  for (const [name, ids] of names) {
    if (ids.length > 1) issues.push({ severity: 'warning', message: `Nombre repetido "${name}" (${ids.join(', ')})` });
  }

  for (const rel of doc.model.relationships) {
    if (!rel.description?.trim()) {
      const s = elements.get(rel.sourceId)?.name ?? rel.sourceId;
      const t = elements.get(rel.targetId)?.name ?? rel.targetId;
      issues.push({ severity: 'warning', message: `La relación ${s} → ${t} no tiene descripción`, relationshipId: rel.id });
    }
  }

  const inAnyView = new Set(doc.views.flatMap((v) => [...v.elements.map((e) => e.id), ...(v.scopeId ? [v.scopeId] : [])]));
  for (const el of doc.model.elements) {
    if (!inAnyView.has(el.id)) {
      issues.push({ severity: 'warning', message: `"${el.name}" no aparece en ninguna vista`, elementId: el.id });
    }
  }
  for (const v of doc.views) {
    if (v.elements.length === 0) issues.push({ severity: 'warning', message: `La vista "${v.title ?? v.id}" está vacía`, viewId: v.id });
    if (v.type !== 'systemContext' && !v.scopeId) {
      issues.push({ severity: 'error', message: `La vista "${v.title ?? v.id}" (${v.type}) necesita un alcance`, viewId: v.id });
    }
  }
  return issues;
}
