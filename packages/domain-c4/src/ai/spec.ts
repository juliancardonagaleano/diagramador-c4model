import type { AiSpec } from '@iark/kernel';
import { autoLayoutDocument } from '../layout/elkLayout';
import { formatIssues } from '../model/schema';
import type { C4Document } from '../model/types';
import { generatedDocumentSchema, generatedToDocument, generationJsonSchema, type GeneratedDocument } from './generationSchema';
import { retryPrompt, systemPrompt, userPrompt } from './prompt';

/** Cómo genera el módulo C4 con IA: prompts, esquema de salida sin coordenadas y autolayout final. */
export const c4AiSpec: AiSpec<C4Document> = {
  generationSchema: generatedDocumentSchema,
  generationJsonSchema,
  system: systemPrompt,
  user: userPrompt,
  retry: retryPrompt,
  toDocument(generated) {
    const result = generatedToDocument(generated as GeneratedDocument);
    return result.ok ? { ok: true, document: result.document } : { ok: false, issues: formatIssues(result.issues) };
  },
  finish: (document) => autoLayoutDocument(document, { force: true }),
};
