/**
 * API pública del núcleo (sin DOM): válida en navegador y Node.
 *
 *   import { generateDocument, autoLayoutDocument, toDrawio, validateDocument } from 'diagramador-c4model/core';
 */
export * from './model/types';
export {
  documentSchema,
  elementSchema,
  relationshipSchema,
  viewSchema,
  validateDocument,
  parseDocument,
  formatIssues,
  documentJsonSchema,
  DocumentValidationError,
  type ValidationIssue,
  type ValidationResult,
} from './model/schema';
export * from './model/factories';
export { sampleDocument } from './model/sample';
export { deriveView, viewBounds, type DerivedView, type DerivedNode, type DerivedBoundary, type DerivedEdge } from './model/viewDerivation';
export {
  layoutView,
  layoutDerivedView,
  autoLayoutView,
  autoLayoutDocument,
  applyLayoutToView,
  type LayoutOptions,
  type LayoutResult,
  type PositionedElement,
} from './layout/elkLayout';
export { toDrawio, DrawioExportError, type DrawioOptions } from './export/drawio/toDrawio';
export type { DrawioLocale } from './export/drawio/styles';
export {
  generatedDocumentSchema,
  generatedToDocument,
  documentToGenerated,
  generationJsonSchema,
  type GeneratedDocument,
} from './ai/generationSchema';
export { systemPrompt, userPrompt, standalonePrompt } from './ai/prompt';
export { generateDocument, GenerationError, DEFAULT_AI_MODEL, type GenerateOptions, type GenerateResult, type Effort } from './ai/generate';
export { analyzeDocument, type DocumentIssue } from './model/issues';
