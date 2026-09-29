import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { looksLikeMermaid } from '@iark/kernel';
import { dataAiSpec } from './ai/generation';
import { dataCommands } from './commands';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromMermaid } from './import/fromMermaid';
import { analyzeData } from './issues';
import { dataDocumentSchema, dataJsonSchema } from './schema';
import { DATA_DOCUMENT_VERSION, type DataDocument } from './types';
import { listViews } from './views';
import { dataEditor } from './editor';

const mermaidImporter: Importer<DataDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const mermaidExporter: Exporter<DataDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId }),
};

const svgExporter: Exporter<DataDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<DataDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc) => toDrawio(doc),
};

/**
 * Módulo de arquitectura de datos: activos (fuentes, bases, almacenes, lagos, streams, tablas, informes, modelos)
 * agrupados en dominios, el linaje entre ellos por pipelines, el modelo entidad-relación y el gobierno del dato
 * (responsables, clasificación, datos personales, retención). Sus activos pueden apuntar a elementos de otros módulos
 * por URN (`ref`), p. ej. un almacén del mapa de integración.
 */
export const dataModule: DomainModule<DataDocument> = {
  id: 'data',
  name: 'Arquitectura de datos',
  version: '0.1.0',
  description: 'Linaje, modelo entidad-relación y gobierno del dato: dominios, pipelines, clasificación y datos personales; exporta a Mermaid, SVG y draw.io.',
  documentVersion: DATA_DOCUMENT_VERSION,
  schema: dataDocumentSchema as unknown as DomainModule<DataDocument>['schema'],
  jsonSchema: dataJsonSchema,
  validate: (doc): ModuleIssue[] => analyzeData(doc),
  importers: [mermaidImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter],
  ai: dataAiSpec,
  entities: (doc): EntityRef[] => [
    ...doc.domains.map((d) => ({ id: d.id, name: d.name, kind: 'domain' })),
    ...doc.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    ...doc.pipelines.map((p) => ({ id: p.id, name: p.name, kind: 'pipeline' })),
  ],
  views: (doc): ViewRef[] => listViews(doc).map((v) => ({ id: v.id, title: v.title })),
  traceViews: [
    { prefix: 'lineage', label: 'Linaje completo', applies: (e) => e.kind !== 'domain' && e.kind !== 'pipeline' },
    { prefix: 'upstream', label: 'Origen (aguas arriba)', applies: (e) => e.kind !== 'domain' && e.kind !== 'pipeline' },
    { prefix: 'downstream', label: 'Impacto (aguas abajo)', applies: (e) => e.kind !== 'domain' && e.kind !== 'pipeline' },
  ],
  cliCommands: dataCommands,
  editor: dataEditor,
};
