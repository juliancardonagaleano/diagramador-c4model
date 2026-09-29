import { analyzeText, buildTraceGraph, type AnyModule, type TraceGraph } from '@iark/kernel';
import type { ModuleSource } from '../modules-app/controller';

/** Un documento de un módulo reunido en el tablero de trazabilidad. */
export interface BoardDocument {
  module: AnyModule;
  document: unknown;
  /** De dónde viene (nombre del archivo, «ejemplo» o «pegado»). */
  source: string;
  entities: number;
  /** Errores de esquema no hay (se rechazan al cargar); aquí van los avisos y errores de las reglas del dominio. */
  issues: number;
}

export type LoadResult = { ok: true; entities: number; issues: number } | { ok: false; message: string };

/**
 * Estado de la vista de trazabilidad: los documentos de varios módulos y el grafo que forman. No toca el DOM. Un documento
 * que no se puede leer no sustituye al que ya había (como en el banco de trabajo): el error se devuelve y todo sigue igual.
 */
export class TraceBoard {
  readonly documents = new Map<string, BoardDocument>();

  constructor(readonly sources: ModuleSource[]) {}

  private source(moduleId: string): ModuleSource {
    const source = this.sources.find((s) => s.id === moduleId);
    if (!source) throw new Error(`Este tablero no ofrece el módulo «${moduleId}». Módulos: ${this.sources.map((s) => s.id).join(', ')}.`);
    return source;
  }

  label(moduleId: string): string {
    return this.sources.find((s) => s.id === moduleId)?.label ?? moduleId;
  }

  /** Interpreta el texto (JSON del módulo), lo valida y lo incorpora. */
  async load(moduleId: string, text: string, origin: string): Promise<LoadResult> {
    const module = await this.source(moduleId).load();
    const analysis = analyzeText(module, text);
    switch (analysis.status) {
      case 'empty':
        return { ok: false, message: 'El documento está vacío.' };
      case 'syntax':
        return { ok: false, message: `No es JSON válido: ${analysis.error}` };
      case 'schema': {
        const shown = analysis.issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ');
        const more = analysis.issues.length > 3 ? ` (y ${analysis.issues.length - 3} más)` : '';
        return { ok: false, message: `No cumple el esquema del módulo: ${shown}${more}` };
      }
      case 'ok': {
        const entities = module.entities?.(analysis.document).length ?? 0;
        const issues = analysis.issues.filter((i) => i.severity !== 'info').length;
        this.documents.set(moduleId, { module, document: analysis.document, source: origin, entities, issues });
        return { ok: true, entities, issues };
      }
    }
  }

  async loadExample(moduleId: string): Promise<LoadResult> {
    const example = this.source(moduleId).example;
    if (!example) return { ok: false, message: 'Este módulo no trae ejemplo.' };
    return this.load(moduleId, await example(), 'ejemplo');
  }

  /** Carga el ejemplo de cada módulo que lo tenga. */
  async loadExamples(): Promise<Record<string, LoadResult>> {
    const results: Record<string, LoadResult> = {};
    for (const source of this.sources) results[source.id] = await this.loadExample(source.id);
    return results;
  }

  remove(moduleId: string): void {
    this.documents.delete(moduleId);
  }

  clear(): void {
    this.documents.clear();
  }

  /** El grafo de los documentos reunidos, en el orden de los módulos del tablero. */
  graph(): TraceGraph {
    const order = this.sources.map((s) => s.id);
    const inputs = [...this.documents.entries()]
      .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
      .map(([, d]) => ({ module: d.module, document: d.document, source: d.source }));
    return buildTraceGraph(inputs);
  }

  moduleLabels(): Record<string, string> {
    return Object.fromEntries(this.sources.map((s) => [s.id, s.label]));
  }
}
