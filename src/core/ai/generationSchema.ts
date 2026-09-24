import { z } from 'zod';
import { validateDocument, type ValidationResult } from '../model/schema';
import { DOCUMENT_VERSION, type C4Document, type C4Element, type C4Relationship, type C4View } from '../model/types';

/**
 * Esquema de lo que produce la IA: el modelo C4 SIN coordenadas. El autolayout
 * calcula la geometría después. Los campos opcionales se declaran `nullable`
 * porque las salidas estructuradas exigen que todas las propiedades existan.
 */
export const generatedElementSchema = z.object({
  id: z.string().describe('Identificador estable en kebab-case ASCII, p. ej. "api-pagos"'),
  type: z.enum(['person', 'softwareSystem', 'container', 'component']),
  name: z.string(),
  description: z.string().nullable().describe('Una o dos frases: responsabilidad del elemento'),
  technology: z.string().nullable().describe('Solo para container/component, p. ej. "Node.js, Express"'),
  external: z.boolean().describe('true si está fuera del alcance del equipo (sistemas de terceros)'),
  parentId: z.string().nullable().describe('container → id de su softwareSystem; component → id de su container; null en otro caso'),
  shape: z.enum(['default', 'database', 'queue', 'browser', 'mobile']).nullable(),
});

export const generatedRelationshipSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  targetId: z.string(),
  description: z.string().nullable().describe('Verbo en presente: "Consulta", "Envía pagos a"'),
  technology: z.string().nullable().describe('Protocolo o tecnología: "HTTPS/JSON", "gRPC", "SQL"'),
});

export const generatedViewSchema = z.object({
  id: z.string(),
  type: z.enum(['systemContext', 'container', 'component']),
  scopeId: z.string().nullable().describe('softwareSystem para systemContext/container; container para component'),
  title: z.string().nullable(),
  elementIds: z.array(z.string()).describe('Ids de los elementos visibles en la vista (sin incluir el scope de vistas container/component)'),
});

export const generatedDocumentSchema = z.object({
  workspace: z.object({ name: z.string(), description: z.string().nullable() }),
  elements: z.array(generatedElementSchema),
  relationships: z.array(generatedRelationshipSchema),
  views: z.array(generatedViewSchema),
});

export type GeneratedDocument = z.infer<typeof generatedDocumentSchema>;

/** Convierte la salida de la IA en un documento C4 (sin coordenadas) y lo valida. */
export function generatedToDocument(gen: GeneratedDocument): ValidationResult {
  const elements: C4Element[] = gen.elements.map((e) => {
    const el: C4Element = { id: e.id, type: e.type, name: e.name };
    if (e.description) el.description = e.description;
    if (e.technology && (e.type === 'container' || e.type === 'component')) el.technology = e.technology;
    if (e.external) el.external = true;
    if (e.parentId) el.parentId = e.parentId;
    if (e.shape && e.shape !== 'default') el.shape = e.shape;
    return el;
  });
  const relationships: C4Relationship[] = gen.relationships.map((r) => {
    const rel: C4Relationship = { id: r.id, sourceId: r.sourceId, targetId: r.targetId };
    if (r.description) rel.description = r.description;
    if (r.technology) rel.technology = r.technology;
    return rel;
  });
  const views: C4View[] = gen.views.map((v) => {
    const view: C4View = {
      id: v.id,
      type: v.type,
      title: v.title ?? undefined,
      elements: v.elementIds.filter((id, i, arr) => arr.indexOf(id) === i && id !== v.scopeId).map((id) => ({ id })),
    };
    if (v.scopeId) view.scopeId = v.scopeId;
    return view;
  });
  const doc: C4Document = {
    version: DOCUMENT_VERSION,
    workspace: { name: gen.workspace.name, ...(gen.workspace.description ? { description: gen.workspace.description } : {}) },
    model: { elements, relationships },
    views,
  };
  return validateDocument(doc);
}

/** Convierte un documento existente al formato de generación (para refinamientos). */
export function documentToGenerated(doc: C4Document): GeneratedDocument {
  return {
    workspace: { name: doc.workspace.name, description: doc.workspace.description ?? null },
    elements: doc.model.elements.map((e) => ({
      id: e.id,
      type: e.type,
      name: e.name,
      description: e.description ?? null,
      technology: e.technology ?? null,
      external: e.external ?? false,
      parentId: e.parentId ?? null,
      shape: e.shape ?? null,
    })),
    relationships: doc.model.relationships.map((r) => ({
      id: r.id,
      sourceId: r.sourceId,
      targetId: r.targetId,
      description: r.description ?? null,
      technology: r.technology ?? null,
    })),
    views: doc.views.map((v) => ({
      id: v.id,
      type: v.type,
      scopeId: v.scopeId ?? null,
      title: v.title ?? null,
      elementIds: v.elements.map((e) => e.id),
    })),
  };
}

/** JSON Schema del formato de generación (para prompts con cualquier IA). */
export function generationJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(generatedDocumentSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}
