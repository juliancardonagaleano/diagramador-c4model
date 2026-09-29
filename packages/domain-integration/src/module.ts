import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { looksLikeMermaid } from '@iark/kernel';
import { integrationAiSpec } from './ai/generation';
import { integrationCommands } from './commands';
import { integrationEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid, type IntegrationMermaidFormat } from './export/mermaid';
import { toSvg } from './export/render';
import { fromMermaid } from './import/fromMermaid';
import { analyzeIntegration } from './issues';
import { integrationDocumentSchema, integrationJsonSchema } from './schema';
import { INTEGRATION_DOCUMENT_VERSION, type IntegrationDocument } from './types';
import { listViews } from './views';

const mermaidImporter: Importer<IntegrationDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const mermaidExporter: Exporter<IntegrationDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId, format: ctx.options?.format as IntegrationMermaidFormat | undefined }),
};

const svgExporter: Exporter<IntegrationDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<IntegrationDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc) => toDrawio(doc),
};

/**
 * Módulo de arquitectura de integraciones: sistemas, APIs, pasarelas, brokers, colas y tópicos, con las interacciones
 * entre ellos (estilo, protocolo, patrón, contrato) y los flujos que las recorren. Sus nodos pueden apuntar a
 * elementos de otros módulos por URN (`ref`), p. ej. un contenedor del modelo C4.
 */
export const integrationModule: DomainModule<IntegrationDocument> = {
  id: 'integration',
  name: 'Arquitectura de integraciones',
  version: '0.1.0',
  description: 'Mapa de integración y flujos: sistemas, APIs, brokers, colas, contratos, patrones EIP; exporta a Mermaid, SVG y draw.io.',
  documentVersion: INTEGRATION_DOCUMENT_VERSION,
  schema: integrationDocumentSchema as unknown as DomainModule<IntegrationDocument>['schema'],
  jsonSchema: integrationJsonSchema,
  validate: (doc): ModuleIssue[] => analyzeIntegration(doc),
  importers: [mermaidImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter],
  ai: integrationAiSpec,
  entities: (doc): EntityRef[] => doc.nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })),
  views: (doc): ViewRef[] => listViews(doc).map((v) => ({ id: v.id, title: v.title })),
  cliCommands: integrationCommands,
  editor: integrationEditor,
};
