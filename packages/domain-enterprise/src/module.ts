import type { DomainModule, EntityRef, Exporter, Importer, ModuleIssue, ViewRef } from '@iark/kernel';
import { looksLikeMermaid } from '@iark/kernel';
import { enterpriseAiSpec } from './ai/generation';
import { enterpriseCommands } from './commands';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { toSvg } from './export/render';
import { fromMermaid } from './import/fromMermaid';
import { analyzeEnterprise } from './issues';
import { enterpriseDocumentSchema, enterpriseJsonSchema } from './schema';
import { ENTERPRISE_DOCUMENT_VERSION, type EnterpriseDocument } from './types';
import { listViews } from './views';

const mermaidImporter: Importer<EnterpriseDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extensions: ['.mmd', '.mermaid', '.md'],
  detect: looksLikeMermaid,
  import: (text, ctx) => fromMermaid(text, { name: ctx.name, fallbackName: ctx.fallbackName }),
};

const mermaidExporter: Exporter<EnterpriseDocument> = {
  id: 'mermaid',
  label: 'Mermaid',
  extension: '.mmd',
  mime: 'text/plain',
  export: (doc, ctx) => toMermaid(doc, { viewId: ctx.viewId }),
};

const svgExporter: Exporter<EnterpriseDocument> = {
  id: 'svg',
  label: 'SVG',
  extension: '.svg',
  mime: 'image/svg+xml',
  export: (doc, ctx) => toSvg(doc, ctx.viewId),
};

const drawioExporter: Exporter<EnterpriseDocument> = {
  id: 'drawio',
  label: 'draw.io',
  extension: '.drawio',
  mime: 'application/xml',
  export: (doc) => toDrawio(doc),
};

/**
 * Módulo de arquitectura empresarial (subconjunto de ArchiMate/TOGAF): unidades, capacidades de negocio, procesos,
 * aplicaciones y tecnología, con su ciclo de vida. Ofrece el mapa de capacidades, el paisaje capacidad → aplicación →
 * tecnología y el análisis de impacto y obsolescencia. Sus aplicaciones y tecnologías pueden apuntar a elementos de otros
 * módulos por URN (`ref`), p. ej. un sistema del mapa de integración.
 */
export const enterpriseModule: DomainModule<EnterpriseDocument> = {
  id: 'enterprise',
  name: 'Arquitectura empresarial',
  version: '0.1.0',
  description: 'Mapa de capacidades, aplicaciones y tecnología con ciclo de vida, impacto y obsolescencia; exporta a Mermaid, SVG y draw.io.',
  documentVersion: ENTERPRISE_DOCUMENT_VERSION,
  schema: enterpriseDocumentSchema as unknown as DomainModule<EnterpriseDocument>['schema'],
  jsonSchema: enterpriseJsonSchema,
  validate: (doc): ModuleIssue[] => analyzeEnterprise(doc),
  importers: [mermaidImporter],
  exporters: [mermaidExporter, svgExporter, drawioExporter],
  ai: enterpriseAiSpec,
  entities: (doc): EntityRef[] => [
    ...doc.units.map((u) => ({ id: u.id, name: u.name, kind: 'unit' })),
    ...doc.capabilities.map((c) => ({ id: c.id, name: c.name, kind: 'capability' })),
    ...doc.processes.map((p) => ({ id: p.id, name: p.name, kind: 'process' })),
    ...doc.applications.map((a) => ({ id: a.id, name: a.name, kind: 'application' })),
    ...doc.technologies.map((t) => ({ id: t.id, name: t.name, kind: 'technology' })),
  ],
  views: (doc): ViewRef[] => listViews(doc).map((v) => ({ id: v.id, title: v.title })),
  traceViews: [
    { prefix: 'impact', label: 'Impacto', applies: (e) => e.kind !== 'unit' },
    { prefix: 'depends', label: 'Dependencias', applies: (e) => e.kind !== 'unit' },
    { prefix: 'focus', label: 'Entorno', applies: (e) => e.kind !== 'unit' },
  ],
  cliCommands: enterpriseCommands,
};
