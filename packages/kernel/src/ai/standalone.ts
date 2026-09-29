import type { AiSpec } from '../module/types';

/**
 * Prompt autocontenido (sistema + esquema JSON + instrucción) para usar con cualquier IA o agente sin clave de API.
 * La respuesta esperada es un JSON que cumple el esquema de generación del módulo.
 */
export function standalonePrompt<TDoc>(spec: AiSpec<TDoc>, instruction: string, base?: TDoc): string {
  return (
    `${spec.system()}\n\n` +
    `Responde ÚNICAMENTE con un objeto JSON (sin comentarios ni texto adicional) que cumpla este JSON Schema:\n` +
    `${JSON.stringify(spec.generationJsonSchema(), null, 2)}\n\n` +
    `${spec.user(instruction, base)}\n`
  );
}
