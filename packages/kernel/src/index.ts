export * from './module/types';
export { ModuleRegistry, UnknownModuleError } from './module/registry';
export { formatUrn, parseUrn, type ParsedUrn } from './module/urn';
export {
  buildManifest,
  manifestSchema,
  moduleManifestSchema,
  MANIFEST_SCHEMA_ID,
  type ManifestOptions,
  type ModuleManifest,
  type SuiteManifest,
} from './module/manifest';

export { extractJson } from './util/extractJson';
export { MAX_ID_LENGTH, pickId } from './import/ids';
export { Warnings } from './import/warnings';
export { createAiClient, credentialsHint, openaiSettings, resolveModel, resolveProvider, type AiProvider, type Env } from './ai/client';
export {
  chatCompletion,
  HttpError,
  initialCompatState,
  stripReasoning,
  type ChatCompletionOptions,
  type ChatCompletionResult,
  type ChatMessage,
  type CompatState,
  type ResponseFormatMode,
} from './ai/openaiCompat';
