import { GenerationError, generateStructured, type AiProvider, type Effort, type StructuredOptions } from '@iark/kernel';
import { autoLayoutDocument } from '../layout/elkLayout';
import type { C4Document, LayoutDensity, LayoutDirectionOption, LayoutDistribution } from '../model/types';
import { c4AiSpec } from './spec';

export { GenerationError };
export type { Effort };

export const DEFAULT_AI_MODEL = 'claude-opus-5';

export interface GenerateOptions extends Omit<StructuredOptions<C4Document>, 'defaultModel'> {
  /** Dirección del autolayout. */
  direction?: LayoutDirectionOption;
  /** Densidad del autolayout. */
  density?: LayoutDensity;
  /** Distribución del autolayout. */
  distribution?: LayoutDistribution;
  /** Desactivar el autolayout posterior (devuelve el modelo sin coordenadas). */
  skipLayout?: boolean;
}

export interface GenerateResult {
  document: C4Document;
  model: string;
  provider: AiProvider;
  attempts: number;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Genera (o refina) un documento C4 a partir de una instrucción con Claude (salida estructurada) o con cualquier
 * modelo de Foundry (JSON validado aquí), valida el resultado y aplica autolayout.
 */
export async function generateDocument(options: GenerateOptions): Promise<GenerateResult> {
  const result = await generateStructured(c4AiSpec, { ...options, defaultModel: DEFAULT_AI_MODEL });
  const progress = options.onProgress ?? (() => {});
  if (options.skipLayout) return result;
  progress('Aplicando autolayout…');
  const document = await autoLayoutDocument(result.document, { direction: options.direction, density: options.density, distribution: options.distribution, force: true });
  return { ...result, document };
}
