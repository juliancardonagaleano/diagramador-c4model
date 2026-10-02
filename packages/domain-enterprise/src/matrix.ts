import { capabilityChildren } from './graph';
import { lifecycleOf, type Application, type Capability, type EnterpriseDocument, type Relation } from './types';

/**
 * Matriz capacidad × aplicación: qué aplicación soporta qué capacidad, con los huecos y los solapamientos a la vista.
 *
 * Regla de soporte. Una aplicación soporta una capacidad de dos maneras, y la celda las distingue:
 * - **directa**: hay una relación `supports` de la aplicación a la capacidad;
 * - **por un proceso**: la aplicación soporta (`supports`) un proceso que realiza (`realizes`) la capacidad.
 * Una capacidad con hijas (una agrupación) muestra además, como **heredadas**, las aplicaciones de sus descendientes; esas
 * celdas no se editan (se editan las de la capacidad hija) y no cuentan como soporte propio ni en el total de la columna.
 * Es la misma regla que `applicationsByCapability`, que sigue siendo la fuente de las vistas de cobertura.
 *
 * Avisos por fila (solo en lo que soporta cada capacidad por sí misma, no en lo heredado):
 * - **hueco**: una capacidad sin hijas que ninguna aplicación soporta (coincide con «Sin cobertura» de `iark enterprise coverage`);
 * - **solapamiento**: soportada por {@link MATRIX_OVERLAP_MIN} aplicaciones o más que no están retiradas y sin un criterio que lo explique;
 * - la convivencia tiene criterio si es **transición** (alguna de ellas está prevista o en retirada, o su estrategia es migrar, reemplazar
 *   o retirar: un reemplazo en curso) o si todas menos como mucho una (la principal) **declaran su criterio** en la descripción de la
 *   relación `supports` que las une a la capacidad (o al proceso que la realiza): «canal web», «contingencia», «mayoristas».
 */
export const MATRIX_OVERLAP_MIN = 2;

/** Cómo soporta una aplicación una capacidad: directamente, por un proceso o, en una agrupación, por una capacidad hija. */
export type SupportKind = 'direct' | 'process' | 'inherited';

export interface MatrixCell {
  capabilityId: string;
  applicationId: string;
  /** Relación `supports` directa de la aplicación a la capacidad, si la hay (es la que la celda crea o quita). */
  direct?: Relation;
  /** Procesos que la aplicación soporta y que realizan la capacidad. */
  processIds: string[];
  /** Lo que predomina: directa, si la hay; si no, por un proceso; si no, heredada de una capacidad hija. */
  support: SupportKind;
  /** Criterio declarado para esta aplicación en esta capacidad (descripción de su relación `supports`). */
  criterion?: string;
}

/** `gap`: sin aplicación. `overlap`: varias sin criterio. `transition` y `criterion`: varias con una razón. `single`: una. `none`: una agrupación sin soporte propio. */
export type RowStatus = 'gap' | 'overlap' | 'transition' | 'criterion' | 'single' | 'none';

export const ROW_STATUS_LABELS: Record<RowStatus, string> = {
  gap: 'hueco',
  overlap: 'solapamiento',
  transition: 'transición',
  criterion: 'con criterio',
  single: '',
  none: '',
};

export interface MatrixRow {
  capability: Capability;
  /** Nivel en el árbol de capacidades (0 = raíz). */
  depth: number;
  /** Tiene capacidades hijas: sus aplicaciones heredadas se muestran como `inherited`. */
  group: boolean;
  /** Aplicaciones que la soportan por sí misma (directa o por un proceso), en el orden del documento. */
  own: string[];
  /** Las propias y, en una agrupación, las heredadas de sus descendientes. */
  all: string[];
  /** Aplicaciones propias que no están retiradas: las que pueden solaparse. */
  inForce: string[];
  status: RowStatus;
}

export interface MatrixColumn {
  application: Application;
  /** Capacidades que soporta por sí misma (filas con una celda directa o por un proceso). */
  capabilities: number;
}

export interface MatrixSummary {
  /** Capacidades sin hijas y las que tienen al menos una aplicación. */
  leaves: number;
  covered: number;
  gaps: number;
  overlaps: number;
  /** Convivencias con una razón (transición o criterio declarado). */
  explained: number;
  /** Aplicaciones que no soportan ninguna capacidad. */
  idleApplications: number;
}

export interface Matrix {
  rows: MatrixRow[];
  columns: MatrixColumn[];
  /** Celdas con soporte, por `capabilityId` y `applicationId`. */
  cells: Map<string, MatrixCell>;
  summary: MatrixSummary;
}

const NO_CRITERION = '';
const TRANSITION_STRATEGIES = new Set<string>(['migrate', 'replace', 'retire']);

/** Clave de una celda en `Matrix.cells`. */
export const cellKey = (capabilityId: string, applicationId: string): string => `${capabilityId}\u0000${applicationId}`;

/** Capacidades en el orden del árbol (cada una antes que sus hijas, las raíces y las hijas en el orden del documento), con su nivel. */
export function capabilityRows(doc: EnterpriseDocument): Array<{ capability: Capability; depth: number }> {
  const children = capabilityChildren(doc);
  const rows: Array<{ capability: Capability; depth: number }> = [];
  const seen = new Set<string>();
  const walk = (list: Capability[] | undefined, depth: number): void => {
    for (const capability of list ?? []) {
      if (seen.has(capability.id)) continue;
      seen.add(capability.id);
      rows.push({ capability, depth });
      walk(children.get(capability.id), depth + 1);
    }
  };
  walk(children.get(undefined), 0);
  return rows;
}

/** Calcula la matriz capacidad × aplicación del documento (ver la regla de soporte arriba). */
export function buildMatrix(doc: EnterpriseDocument): Matrix {
  const capabilities = new Set(doc.capabilities.map((c) => c.id));
  const applications = new Map(doc.applications.map((a) => [a.id, a]));
  const processSupport = new Map<string, Map<string, Relation>>(); // proceso → aplicación → relación
  const direct = new Map<string, Relation>();
  for (const r of doc.relations) {
    if (r.kind !== 'supports' || !applications.has(r.sourceId)) continue;
    if (capabilities.has(r.targetId)) direct.set(cellKey(r.targetId, r.sourceId), r);
    else processSupport.set(r.targetId, (processSupport.get(r.targetId) ?? new Map()).set(r.sourceId, r));
  }
  const processes = new Map<string, Map<string, string[]>>(); // capacidad → aplicación → procesos
  const processRelation = new Map<string, Relation>(); // celda → relación del primer proceso
  for (const r of doc.relations) {
    if (r.kind !== 'realizes' || !capabilities.has(r.targetId)) continue;
    for (const [appId, relation] of processSupport.get(r.sourceId) ?? []) {
      const apps = processes.get(r.targetId) ?? new Map<string, string[]>();
      apps.set(appId, [...(apps.get(appId) ?? []), r.sourceId]);
      processes.set(r.targetId, apps);
      if (!processRelation.has(cellKey(r.targetId, appId))) processRelation.set(cellKey(r.targetId, appId), relation);
    }
  }

  const order = new Map(doc.applications.map((a, i) => [a.id, i]));
  const inDocumentOrder = (ids: Iterable<string>): string[] => [...new Set(ids)].sort((a, b) => order.get(a)! - order.get(b)!);
  const cells = new Map<string, MatrixCell>();
  const ownOf = new Map<string, string[]>();
  for (const capability of doc.capabilities) {
    const own = inDocumentOrder([
      ...doc.applications.filter((a) => direct.has(cellKey(capability.id, a.id))).map((a) => a.id),
      ...(processes.get(capability.id)?.keys() ?? []),
    ]);
    ownOf.set(capability.id, own);
    for (const appId of own) {
      const key = cellKey(capability.id, appId);
      const relation = direct.get(key);
      const criterion = (relation?.description ?? processRelation.get(key)?.description ?? NO_CRITERION).trim();
      cells.set(key, {
        capabilityId: capability.id,
        applicationId: appId,
        ...(relation ? { direct: relation } : {}),
        processIds: processes.get(capability.id)?.get(appId) ?? [],
        support: relation ? 'direct' : 'process',
        ...(criterion ? { criterion } : {}),
      });
    }
  }

  const children = capabilityChildren(doc);
  const below = (id: string): Set<string> => {
    const apps = new Set<string>();
    const walk = (cid: string): void => {
      for (const child of children.get(cid) ?? []) {
        for (const a of ownOf.get(child.id) ?? []) apps.add(a);
        walk(child.id);
      }
    };
    walk(id);
    return apps;
  };

  const rows: MatrixRow[] = capabilityRows(doc).map(({ capability, depth }) => {
    const group = children.has(capability.id);
    const own = ownOf.get(capability.id) ?? [];
    const inherited = group ? below(capability.id) : new Set<string>();
    for (const appId of inherited) {
      const key = cellKey(capability.id, appId);
      if (!cells.has(key)) cells.set(key, { capabilityId: capability.id, applicationId: appId, processIds: [], support: 'inherited' });
    }
    const inForce = own.filter((id) => lifecycleOf(applications.get(id)!) !== 'retired');
    return { capability, depth, group, own, all: inDocumentOrder([...own, ...inherited]), inForce, status: statusOf(doc, cells, capability, group, own, inForce) };
  });

  const columns: MatrixColumn[] = doc.applications.map((application) => ({ application, capabilities: rows.filter((r) => r.own.includes(application.id)).length }));
  const leaves = rows.filter((r) => !r.group);
  const summary: MatrixSummary = {
    leaves: leaves.length,
    covered: leaves.filter((r) => r.own.length > 0).length,
    gaps: rows.filter((r) => r.status === 'gap').length,
    overlaps: rows.filter((r) => r.status === 'overlap').length,
    explained: rows.filter((r) => r.status === 'transition' || r.status === 'criterion').length,
    idleApplications: columns.filter((c) => c.capabilities === 0).length,
  };
  return { rows, columns, cells, summary };
}

function statusOf(doc: EnterpriseDocument, cells: Map<string, MatrixCell>, capability: Capability, group: boolean, own: string[], inForce: string[]): RowStatus {
  if (own.length === 0) return group ? 'none' : 'gap';
  if (inForce.length < MATRIX_OVERLAP_MIN) return 'single';
  const byId = new Map(doc.applications.map((a) => [a.id, a]));
  const apps = inForce.map((id) => byId.get(id)!);
  if (apps.some((a) => lifecycleOf(a) !== 'active' || (a.strategy !== undefined && TRANSITION_STRATEGIES.has(a.strategy)))) return 'transition';
  const undescribed = inForce.filter((id) => !cells.get(cellKey(capability.id, id))?.criterion);
  return undescribed.length <= 1 ? 'criterion' : 'overlap';
}
