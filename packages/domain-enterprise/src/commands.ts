import type { CommandSpec } from '@iark/kernel';
import { EnterpriseImportError } from './import/fromMermaid';
import { fromIntegrationJson } from './import/fromIntegration';
import { applicationsByCapability, capabilityChildren, dependencyGraph, ownership, reach, type Reach, type ReachStep } from './graph';
import { MATRIX_OVERLAP_MIN, ROW_STATUS_LABELS, buildMatrix, cellKey, type Matrix, type MatrixRow } from './matrix';
import { formatEnterpriseIssues, validateEnterpriseDocument } from './schema';
import {
  IMPORTANCE_LABELS,
  KIND_LABELS,
  LIFECYCLE_LABELS,
  indexElements,
  lifecycleOf,
  type Application,
  type Capability,
  type EnterpriseDocument,
  type Technology,
} from './types';

function parseJson(text: string | undefined, what: string): unknown {
  if (!text) throw new EnterpriseImportError(`Falta la entrada: indica un archivo JSON o usa --stdin (${what}).`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new EnterpriseImportError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
}

function readEnterprise(text: string | undefined): EnterpriseDocument {
  const result = validateEnterpriseDocument(parseJson(text, 'documento empresarial'));
  if (!result.ok) throw new EnterpriseImportError(`Documento empresarial inválido:\n${formatEnterpriseIssues(result.issues)}`);
  return result.document;
}

const cell = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const REACH_OPTIONS: Record<string, Reach> = { dependents: 'dependents', dependencies: 'dependencies', both: 'both' };

/** Fecha de referencia para el fin de soporte: la indicada (`AAAA-MM-DD`) o hoy. */
function referenceDate(text: unknown): Date {
  if (text === undefined || text === '') return new Date();
  const date = new Date(`${String(text)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new EnterpriseImportError(`Fecha inválida «${String(text)}»: use AAAA-MM-DD.`);
  return date;
}

function endOfLifeDate(text: string): Date {
  const [y, m, d] = text.split('-').map(Number);
  return d ? new Date(Date.UTC(y, m - 1, d, 23, 59, 59)) : new Date(Date.UTC(y, m, 0, 23, 59, 59));
}

const MATRIX_FORMATS = ['table', 'csv'] as const;
/** Marca de cada tipo de soporte en la tabla (Markdown) y su valor en el CSV. */
const TABLE_MARKS = { direct: '●', process: '○', inherited: '·' } as const;
const CSV_VALUES = { direct: 'directa', process: 'proceso', inherited: 'heredada' } as const;
const csv = (value: string | number): string => (/[",\r\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));

/** Ruta de cada capacidad en el árbol (`Gestión comercial › Ventas online`). */
function capabilityPaths(doc: EnterpriseDocument): Map<string, string> {
  const byId = new Map(doc.capabilities.map((c) => [c.id, c]));
  const paths = new Map<string, string>();
  for (const c of doc.capabilities) {
    const names: string[] = [];
    for (let at: Capability | undefined = c; at && names.length < 50; at = at.parentId ? byId.get(at.parentId) : undefined) names.unshift(at.name);
    paths.set(c.id, names.join(' › '));
  }
  return paths;
}

/** Matriz capacidad × aplicación como tabla Markdown, con el recuento de huecos y solapamientos bajo ella. */
function matrixTable(doc: EnterpriseDocument, matrix: Matrix): string {
  const { rows, columns, summary } = matrix;
  const names = new Map(doc.applications.map((a) => [a.id, a.name]));
  const header = ['Capacidad', ...columns.map((c) => cell(c.application.name)), 'Total', 'Estado'];
  const lines = [`| ${header.join(' | ')} |`, `|---|${columns.map(() => ':-:|').join('')}--:|---|`];
  for (const row of rows) {
    const marks = columns.map((c) => {
      const found = matrix.cells.get(cellKey(row.capability.id, c.application.id));
      return found ? TABLE_MARKS[found.support] : '';
    });
    lines.push(`| ${'  '.repeat(row.depth)}${cell(row.capability.name)} | ${[...marks, row.all.length, ROW_STATUS_LABELS[row.status]].join(' | ')} |`);
  }
  lines.push(`| Total | ${[...columns.map((c) => c.capabilities), `${summary.covered}/${summary.leaves}`, ''].join(' | ')} |`);
  const list = (items: MatrixRow[], detail: (row: MatrixRow) => string): string => (items.length === 0 ? 'ninguno' : items.map((row) => `${row.capability.name}${detail(row)}`).join('; '));
  const appsOf = (row: MatrixRow): string => ` (${row.inForce.map((id) => names.get(id)).join(', ')})`;
  const idle = columns.filter((c) => c.capabilities === 0).map((c) => c.application.name);
  return [
    ...lines,
    '',
    `Leyenda: ${TABLE_MARKS.direct} soporte directo · ${TABLE_MARKS.process} por un proceso que realiza la capacidad · ${TABLE_MARKS.inherited} heredado de una capacidad hija (solo en agrupaciones; no cuenta en el total de la columna).`,
    `Cobertura: ${summary.covered} de ${summary.leaves} capacidad(es) sin hijas tienen al menos una aplicación.`,
    `Huecos (capacidad sin aplicación): ${list(rows.filter((r) => r.status === 'gap'), () => '')}`,
    `Solapamientos sin criterio (${MATRIX_OVERLAP_MIN} o más aplicaciones vigentes): ${list(rows.filter((r) => r.status === 'overlap'), appsOf)}`,
    `Convivencias con criterio (transición o descripción en la relación): ${list(rows.filter((r) => r.status === 'transition' || r.status === 'criterion'), (r) => `${appsOf(r)} · ${ROW_STATUS_LABELS[r.status]}`)}`,
    `Aplicaciones que no soportan ninguna capacidad: ${idle.length === 0 ? 'ninguna' : idle.join('; ')}`,
  ].join('\n');
}

/** Matriz capacidad × aplicación como CSV: una fila por capacidad (con su ruta y nivel), una columna por aplicación y, al final, el total y el estado. */
function matrixCsv(doc: EnterpriseDocument, matrix: Matrix): string {
  const { rows, columns } = matrix;
  const paths = capabilityPaths(doc);
  const out = [['Id', 'Capacidad', 'Ruta', 'Nivel', ...columns.map((c) => c.application.name), 'Total', 'Estado'].map(csv).join(',')];
  for (const row of rows) {
    const values = columns.map((c) => {
      const found = matrix.cells.get(cellKey(row.capability.id, c.application.id));
      return found ? CSV_VALUES[found.support] : '';
    });
    out.push([row.capability.id, row.capability.name, paths.get(row.capability.id) ?? row.capability.name, row.depth, ...values, row.all.length, ROW_STATUS_LABELS[row.status]].map(csv).join(','));
  }
  out.push(['', 'Total', '', '', ...columns.map((c) => c.capabilities), '', ''].map(csv).join(','));
  return out.join('\n');
}

export const enterpriseCommands: CommandSpec[] = [
  {
    name: 'coverage',
    description: 'Cobertura del mapa de capacidades (tabla Markdown): importancia, madurez, responsable y aplicaciones que soportan cada capacidad, con las que no tienen ninguna',
    input: { description: 'documento empresarial en JSON' },
    run: ({ input }) => {
      const doc = readEnterprise(input);
      const units = new Map(doc.units.map((u) => [u.id, u.name]));
      const names = new Map(indexElements(doc));
      const apps = applicationsByCapability(doc);
      const children = capabilityChildren(doc);
      const { ownerOf } = ownership(doc);
      const rows: string[] = [];
      let leaves = 0;
      let covered = 0;
      const walk = (c: Capability, path: string[]): void => {
        const here = [...path, c.name];
        const kids = children.get(c.id);
        const list = [...(apps.get(c.id) ?? [])].map((id) => {
          const app = names.get(id)!.item as Application;
          return `${app.name}${lifecycleOf(app) === 'active' ? '' : ` (${LIFECYCLE_LABELS[lifecycleOf(app)]})`}`;
        });
        if (!kids) {
          leaves += 1;
          if (list.length > 0) covered += 1;
        }
        const status = !kids && list.length === 0 ? 'Sin cobertura' : list.length >= 3 ? 'Posible duplicidad' : '—';
        rows.push(
          `| ${cell(here.join(' › '))} | ${c.importance ? IMPORTANCE_LABELS[c.importance] : '—'} | ${c.maturity ? `${c.maturity}/5` : '—'} | ${cell(units.get(ownerOf(c.id) ?? '')) || '—'} | ${cell(list.join('; ')) || '—'} | ${status} |`,
        );
        kids?.forEach((k) => walk(k, here));
      };
      (children.get(undefined) ?? []).forEach((c) => walk(c, []));
      if (rows.length === 0) return 'El documento no define capacidades.';
      return [
        '| Capacidad | Importancia | Madurez | Responsable | Aplicaciones | Estado |',
        '|---|---|---|---|---|---|',
        ...rows,
        '',
        `Cobertura: ${covered} de ${leaves} capacidad(es) hoja tienen al menos una aplicación.`,
      ].join('\n');
    },
  },
  {
    name: 'impact',
    description: 'Impacto de un elemento: qué se apoya en él (afectado si cambia o se retira) y/o de qué depende, con los responsables a avisar',
    input: { description: 'documento empresarial en JSON' },
    args: [{ name: 'elemento', description: 'id de una capacidad, etapa, proceso, servicio, aplicación o tecnología', required: true }],
    options: [{ flags: '--direction <sentido>', description: 'dependents (lo que se apoya en él) | dependencies (de lo que depende) | both', default: 'dependents' }],
    run: ({ args, options, input }) => {
      const doc = readEnterprise(input);
      const direction = REACH_OPTIONS[String(options.direction ?? 'dependents')];
      if (!direction) throw new EnterpriseImportError(`Sentido inválido «${String(options.direction)}». Use: ${Object.keys(REACH_OPTIONS).join(', ')}.`);
      const elements = indexElements(doc);
      const start = elements.get(args[0]);
      if (!start || start.kind === 'unit' || start.kind === 'stream') {
        const known = [...elements.values()].filter((e) => e.kind !== 'unit' && e.kind !== 'stream').map((e) => e.id);
        throw new EnterpriseImportError(`No existe el elemento «${args[0]}». Elementos: ${known.join(', ')}.`);
      }
      const graph = dependencyGraph(doc);
      const units = new Map(doc.units.map((u) => [u.id, u.name]));
      const { ownerOf } = ownership(doc);
      // Árbol: cada elemento cuelga del primero desde el que se llegó a él.
      const section = (title: string, steps: ReachStep[]): string[] => {
        const lines: string[] = [];
        const print = (parent: string, depth: number): void => {
          for (const s of steps.filter((x) => x.via === parent)) {
            const e = elements.get(s.id)!;
            const owner = units.get(ownerOf(s.id) ?? '');
            lines.push(`${'  '.repeat(depth)}- ${e.name} (${KIND_LABELS[e.kind]})${owner ? ` · ${owner}` : ''}`);
            print(s.id, depth + 1);
          }
        };
        print(start.id, 0);
        return [`${title}: ${steps.length === 0 ? 'ninguno' : `${steps.length} elemento(s)`}`, ...lines];
      };
      const out = [`Impacto de «${start.name}» (${KIND_LABELS[start.kind]})`, ''];
      let notify: string[] = [];
      if (direction !== 'dependencies') {
        const dependents = reach(graph, start.id, 'dependents');
        out.push(...section('Se apoyan en él (se ven afectados si cambia o se retira)', dependents), '');
        notify = [start.id, ...dependents.map((s) => s.id)].map((id) => units.get(ownerOf(id) ?? '') ?? '').filter(Boolean);
      }
      if (direction !== 'dependents') out.push(...section('Se apoya en (de qué depende)', reach(graph, start.id, 'dependencies')), '');
      if (direction !== 'dependencies') out.push(`Responsables a avisar: ${[...new Set(notify)].join(', ') || 'ninguno declarado'}`);
      return out.join('\n').trimEnd();
    },
  },
  {
    name: 'lifecycle',
    description: 'Obsolescencia (tabla Markdown): aplicaciones y tecnologías en retirada, retiradas o con fin de soporte, y las capacidades a las que afectan',
    input: { description: 'documento empresarial en JSON' },
    options: [{ flags: '--today <fecha>', description: 'fecha de referencia AAAA-MM-DD para el fin de soporte (por defecto, hoy)' }],
    run: ({ options, input }) => {
      const doc = readEnterprise(input);
      const today = referenceDate(options.today);
      const elements = indexElements(doc);
      const graph = dependencyGraph(doc);
      const rank = { retired: 0, sunset: 1, planned: 3, active: 2 } as const;
      const rows = [...doc.applications, ...doc.technologies]
        .map((x) => ({ x, kind: elements.get(x.id)!.kind, life: lifecycleOf(x), eol: (x as Technology).endOfLife }))
        .filter((r) => r.life === 'retired' || r.life === 'sunset' || r.eol !== undefined)
        .sort((a, b) => rank[a.life] - rank[b.life] || (a.eol ?? '9999').localeCompare(b.eol ?? '9999') || a.x.name.localeCompare(b.x.name));
      if (rows.length === 0) return 'No hay elementos en retirada ni con fin de soporte declarado.';
      const out = ['| Elemento | Tipo | Estado | Fin de soporte | Se apoyan en él | Capacidades afectadas |', '|---|---|---|---|---|---|'];
      for (const { x, kind, life, eol } of rows) {
        const dependents = reach(graph, x.id, 'dependents');
        const direct = (graph.leanedBy.get(x.id) ?? []).map((id) => elements.get(id)!.name);
        const capabilities = dependents.filter((s) => elements.get(s.id)!.kind === 'capability').map((s) => elements.get(s.id)!.name);
        const support = eol ? `${eol}${life !== 'retired' && endOfLifeDate(eol) < today ? ' (vencido)' : ''}` : '—';
        out.push(
          `| ${cell(x.name)} | ${KIND_LABELS[kind]} | ${LIFECYCLE_LABELS[life]} | ${support} | ${cell(direct.join('; ')) || '—'} | ${cell(capabilities.join('; ')) || '—'} |`,
        );
      }
      return out.join('\n');
    },
  },
  {
    name: 'matrix',
    description:
      'Matriz capacidad × aplicación (tabla Markdown o CSV): qué aplicación soporta cada capacidad, directamente (●) o por un proceso que la realiza (○), con totales por fila y columna, los huecos y los solapamientos',
    input: { description: 'documento empresarial en JSON' },
    options: [{ flags: '--format <formato>', description: 'table (tabla Markdown con el recuento de avisos) | csv (una fila por capacidad y una columna por aplicación)', default: 'table' }],
    run: ({ options, input }) => {
      const doc = readEnterprise(input);
      const format = String(options.format ?? 'table');
      if (!(MATRIX_FORMATS as readonly string[]).includes(format)) throw new EnterpriseImportError(`Formato inválido «${format}». Use: ${MATRIX_FORMATS.join(', ')}.`);
      if (doc.capabilities.length === 0) return 'El documento no define capacidades.';
      const matrix = buildMatrix(doc);
      return format === 'csv' ? matrixCsv(doc, matrix) : matrixTable(doc, matrix);
    },
  },
  {
    name: 'from-integration',
    kind: 'convert',
    description: 'Crea el inventario de aplicaciones a partir de un mapa de integración: sistemas → aplicaciones, almacenes → bases de datos, responsables → unidades, con referencia urn:iark:integration:<id>',
    input: { description: 'documento de integración en JSON' },
    options: [{ flags: '--name <nombre>', description: 'nombre del documento empresarial' }],
    run: ({ input, options, warn }) => {
      const { document, warnings } = fromIntegrationJson(parseJson(input, 'documento de integración'), { name: options.name as string | undefined });
      for (const w of warnings) warn?.(`aviso: ${w}`);
      warn?.(`Convertido "${document.workspace.name}": ${document.applications.length} aplicaciones, ${document.technologies.length} tecnologías.`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
];
