import { analyzeText, countBySeverity, type AnyModule } from '../module/operations';
import { buildTraceGraph, type TraceGraph, type TraceInput } from '../module/trace';
import { formatUrn } from '../module/urn';
import type { DiagramMeta, ProjectSnapshot } from './types';

/** Lo único que hace falta saber de los módulos: buscar uno por id (es el `ModuleRegistry` del núcleo). */
export interface ModuleLookup {
  get(id: string): AnyModule | undefined;
}

export type DiagramStatus = 'ok' | 'empty' | 'syntax' | 'schema' | 'unknown-module';

export interface DiagramCheck {
  id: string;
  name: string;
  module: string;
  status: DiagramStatus;
  /** Para `syntax`, `schema` y `unknown-module`: qué falla, en una línea. */
  detail?: string;
  /** Reglas del módulo (solo con `status: 'ok'`). */
  errors: number;
  warnings: number;
  infos: number;
}

export interface ProjectTrace {
  /** Grafo de los diagramas válidos del proyecto, con varios documentos por módulo. */
  graph: TraceGraph;
  /** Qué diagramas definen cada URN (normalmente uno; más de uno es ambigüedad). */
  owners: Map<string, DiagramMeta[]>;
  /** Los diagramas que no se pudieron leer y se dejaron fuera, con el motivo. */
  skipped: DiagramCheck[];
}

function readDiagrams(snapshot: ProjectSnapshot, modules: ModuleLookup): { inputs: Array<TraceInput & { diagram: DiagramMeta }>; checks: DiagramCheck[] } {
  const inputs: Array<TraceInput & { diagram: DiagramMeta }> = [];
  const checks: DiagramCheck[] = [];
  for (const diagram of snapshot.diagrams) {
    const { id, name, module: moduleId } = diagram;
    const base = { id, name, module: moduleId, errors: 0, warnings: 0, infos: 0 };
    const module = modules.get(moduleId);
    if (!module) {
      checks.push({ ...base, status: 'unknown-module', detail: `Esta instalación no tiene el módulo «${moduleId}».` });
      continue;
    }
    const analysis = analyzeText(module, diagram.text);
    if (analysis.status === 'empty') checks.push({ ...base, status: 'empty', detail: 'El documento está vacío.' });
    else if (analysis.status === 'syntax') checks.push({ ...base, status: 'syntax', detail: `No es JSON válido: ${analysis.error}` });
    else if (analysis.status === 'schema') {
      const first = analysis.issues[0];
      checks.push({ ...base, status: 'schema', detail: `${analysis.issues.length} error(es) de esquema; el primero: ${first.path}: ${first.message}` });
    } else {
      const counts = countBySeverity(analysis.issues);
      checks.push({ ...base, status: 'ok', errors: counts.error, warnings: counts.warning, infos: counts.info });
      inputs.push({ module, document: analysis.document, source: name, diagram });
    }
  }
  return { inputs, checks };
}

/**
 * La trazabilidad dentro de un proyecto: todos sus diagramas válidos en un solo grafo. La URN de un elemento
 * (`urn:iark:<módulo>:<id>`) no dice en qué diagrama está; se resuelve en todo el proyecto, y si dos diagramas del mismo
 * módulo definen el mismo id se avisa como ambigua.
 */
export function projectTrace(snapshot: ProjectSnapshot, modules: ModuleLookup): ProjectTrace {
  const { inputs, checks } = readDiagrams(snapshot, modules);
  const owners = new Map<string, DiagramMeta[]>();
  for (const { module, document, diagram } of inputs) {
    for (const entity of module.entities?.(document) ?? []) {
      const urn = formatUrn(module.id, entity.id);
      const list = owners.get(urn) ?? [];
      if (!list.some((d) => d.id === diagram.id)) list.push(diagram);
      owners.set(urn, list);
    }
  }
  return { graph: buildTraceGraph(inputs, { allowRepeatedModules: true }), owners, skipped: checks.filter((c) => c.status !== 'ok') };
}

export interface ProjectCheck {
  project: { id: string; name: string };
  diagrams: DiagramCheck[];
  graph: TraceGraph;
  /** Sin diagramas inválidos y sin referencias rotas o ambiguas. Las que apuntan a un módulo sin ningún diagrama en el proyecto son avisos. */
  ok: boolean;
  /** Referencias que rompen la integridad del proyecto: mal formadas, a elementos que no existen o ambiguas. */
  brokenRefs: number;
}

/** Comprueba un proyecto entero: cada diagrama contra el esquema de su módulo y las referencias entre ellos. */
export function checkProject(snapshot: ProjectSnapshot, modules: ModuleLookup): ProjectCheck {
  const { inputs, checks } = readDiagrams(snapshot, modules);
  const graph = buildTraceGraph(inputs, { allowRepeatedModules: true });
  const brokenRefs = graph.problems.filter((p) => p.reason !== 'unresolved').length;
  return {
    project: { id: snapshot.id, name: snapshot.name },
    diagrams: checks,
    graph,
    brokenRefs,
    ok: checks.every((c) => c.status === 'ok') && brokenRefs === 0,
  };
}
