import { analyzeText, buildTraceGraph, formatUrn, parseUrn, type AnyModule, type EntityRef, type TraceGraph, type TraceInput } from '@iark/kernel';
import type { WorkbenchController } from './controller';

/**
 * Enlaces entre diagramas de distintos módulos. Los documentos solo guardan URN (`urn:iark:<módulo>:<id>`); ningún
 * módulo conoce a otro. El banco de trabajo reúne el documento activo y los borradores (o ejemplos) de los demás módulos,
 * construye el grafo de trazabilidad del núcleo y con él resuelve a dónde lleva un enlace y quién apunta a un elemento.
 */

export interface ResolvedRef {
  moduleId: string;
  elementId: string;
  urn: string;
}

export interface Backlink {
  urn: string;
  moduleId: string;
  moduleLabel: string;
  elementId: string;
  name: string;
  kind: string;
}

export function resolveRef(urn: string): ResolvedRef | undefined {
  const parsed = parseUrn(urn);
  return parsed ? { moduleId: parsed.module, elementId: parsed.id, urn } : undefined;
}

export class SuiteLinks {
  private graph: TraceGraph | undefined;
  private signature = '';

  constructor(private readonly controller: WorkbenchController) {}

  /** Grafo de trazabilidad con todos los documentos disponibles; se reconstruye solo si algún texto cambió. */
  async graphOf(): Promise<TraceGraph> {
    const texts = new Map<string, string>();
    for (const id of this.controller.moduleIds) {
      const text = await this.controller.draftText(id);
      if (text?.trim()) texts.set(id, text);
    }
    const signature = [...texts].map(([id, text]) => `${id}:${text.length}:${hash(text)}`).join('|');
    if (this.graph && signature === this.signature) return this.graph;
    const inputs: TraceInput[] = [];
    for (const [id, text] of texts) {
      let module: AnyModule;
      try {
        module = await this.controller.loadModule(id);
      } catch {
        continue;
      }
      const analysis = analyzeText(module, text);
      if (analysis.status === 'ok') inputs.push({ module, document: analysis.document, source: id });
    }
    this.graph = buildTraceGraph(inputs);
    this.signature = signature;
    return this.graph;
  }

  /** Quién apunta al elemento `elementId` del módulo `moduleId`. */
  async backlinks(moduleId: string, elementId: string): Promise<Backlink[]> {
    const graph = await this.graphOf();
    const urn = formatUrn(moduleId, elementId);
    const byUrn = new Map(graph.nodes.map((n) => [n.urn, n]));
    return graph.links
      .filter((l) => l.to === urn)
      .flatMap((l) => {
        const n = byUrn.get(l.from);
        return n ? [{ urn: n.urn, moduleId: n.module, moduleLabel: this.label(n.module), elementId: n.id, name: n.name, kind: n.kind }] : [];
      });
  }

  /** Elementos referenciables de un módulo, para elegir el destino de un enlace sin escribir la URN. */
  async entities(moduleId: string): Promise<EntityRef[]> {
    const text = await this.controller.draftText(moduleId);
    if (!text?.trim()) return [];
    const module = await this.controller.loadModule(moduleId);
    const analysis = analyzeText(module, text);
    return analysis.status === 'ok' ? (module.entities?.(analysis.document) ?? []) : [];
  }

  /** ¿Existe el destino de esta URN en los documentos disponibles? `undefined` si el módulo no se conoce. */
  async exists(urn: string): Promise<boolean | undefined> {
    const ref = resolveRef(urn);
    if (!ref || !this.controller.moduleIds.includes(ref.moduleId)) return undefined;
    const graph = await this.graphOf();
    return graph.nodes.some((n) => n.urn === urn);
  }

  label(moduleId: string): string {
    return this.controller.sources.find((s) => s.id === moduleId)?.label ?? moduleId;
  }
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i += 7) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
