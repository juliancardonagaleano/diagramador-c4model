import type { ZodType } from 'zod';

/**
 * Contrato que cumple cada especialidad de la suite (C4 hoy; integraciones, datos, empresarial, plataforma…).
 * Un módulo no conoce a los demás: la app, el CLI y el widget embebible lo descubren a través del
 * `ModuleRegistry` y de su manifiesto, y se relacionan entre sí solo por referencias URN (ver `urn.ts`).
 */

export type IssueSeverity = 'error' | 'warning' | 'info';

/** Problema semántico de un documento (más allá de que cumpla el esquema). */
export interface ModuleIssue {
  severity: IssueSeverity;
  message: string;
  /** Elemento del documento al que se refiere, si aplica. */
  elementId?: string;
}

export interface ImportContext {
  /** Nombre del documento: sustituye al que declare la fuente. */
  name?: string;
  /** Nombre a usar si la fuente no declara ninguno (p. ej. el del archivo). */
  fallbackName?: string;
  /** Ruta del archivo de origen, si lo hay. */
  file?: string;
  /** Opciones propias de cada importador (p. ej. cómo resolver los `!include` del DSL de Structurizr). */
  extra?: Record<string, unknown>;
}

export interface ImportOutcome<TDoc> {
  document: TDoc;
  /** Lo que no se pudo importar tal cual. Vacío si todo encajó. */
  warnings: string[];
}

/** Convierte una fuente externa (draw.io, Structurizr, Mermaid…) en un documento del módulo. */
export interface Importer<TDoc> {
  /** Identificador estable del formato (`drawio`, `dsl`, `mermaid`). */
  id: string;
  label: string;
  /** Extensiones en minúsculas con punto (`.drawio`). */
  extensions: string[];
  /** Reconoce el formato por el contenido (para stdin o extensiones desconocidas). */
  detect?(text: string): boolean;
  import(text: string, context: ImportContext): Promise<ImportOutcome<TDoc>> | ImportOutcome<TDoc>;
}

export interface ExportContext {
  /** Vista a exportar, para los formatos que exportan una sola. */
  viewId?: string;
  /** Opciones propias de cada exportador (notación, idioma…). */
  options?: Record<string, unknown>;
}

/** Convierte un documento del módulo a un formato de texto. */
export interface Exporter<TDoc> {
  id: string;
  label: string;
  /** Extensión sugerida con punto (`.drawio`). */
  extension: string;
  mime: string;
  export(document: TDoc, context: ExportContext): Promise<string> | string;
}

/**
 * Cómo se genera o refina un documento del módulo con una IA (o con un agente sin clave de API, usando solo los
 * prompts y el JSON Schema). El kernel aporta el proveedor, los reintentos y la salida estructurada.
 */
export interface AiSpec<TDoc> {
  /** Esquema zod de lo que produce el modelo (normalmente el documento sin coordenadas ni datos derivados). */
  generationSchema: ZodType<unknown>;
  generationJsonSchema(): unknown;
  system(): string;
  /** Mensaje de usuario: la instrucción y, si se refina, el documento base. */
  user(instruction: string, base?: TDoc): string;
  /** Mensaje con el que se le devuelven al modelo los problemas de su intento anterior. */
  retry(issues: string): string;
  /** Convierte lo generado en documento del módulo; si no es válido, devuelve los motivos para el reintento. */
  toDocument(generated: unknown): { ok: true; document: TDoc } | { ok: false; issues: string };
  /** Acabado del documento generado (p. ej. autolayout). Opcional. */
  finish?(document: TDoc): Promise<TDoc> | TDoc;
}

/** Elemento del documento al que otros módulos pueden apuntar. */
export interface EntityRef {
  /** Id dentro del documento. */
  id: string;
  name: string;
  /** Tipo propio del módulo (`softwareSystem`, `queue`, `table`…). */
  kind: string;
}

export interface CommandOption {
  /** Como en commander: `-o, --out <archivo>`. */
  flags: string;
  description: string;
  default?: string | boolean;
}

export interface CommandContext {
  args: string[];
  options: Record<string, unknown>;
  /** Contenido del archivo o de la entrada estándar, si el comando declara `input`. */
  input?: string;
}

/** Subcomando que el módulo aporta al CLI (`iark <módulo> <nombre>`). Devuelve el texto que se escribe en stdout. */
export interface CommandSpec {
  name: string;
  description: string;
  /** Si el comando lee un documento: el CLI añade `[archivo]`, `--stdin` y `--out`, lee la entrada y la pasa en `context.input`. */
  input?: { description: string };
  args?: Array<{ name: string; description: string; required?: boolean }>;
  options?: CommandOption[];
  run(context: CommandContext): Promise<string | void> | string | void;
}

export interface DomainModule<TDoc = unknown> {
  /** Identificador estable en minúsculas (`c4`, `integration`, `data`…): forma parte de las URN. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Versión del formato de documento que produce y acepta. */
  documentVersion: string;
  /** Esquema del documento, para validarlo antes de operar con él. */
  schema: ZodType<TDoc>;
  /** JSON Schema del documento, para agentes de IA y editores. */
  jsonSchema(): unknown;
  /** Reglas semánticas del dominio (más allá del esquema). */
  validate(document: TDoc): ModuleIssue[];
  importers: Importer<TDoc>[];
  exporters: Exporter<TDoc>[];
  ai?: AiSpec<TDoc>;
  /** Elementos referenciables desde otros módulos por URN. */
  entities?(document: TDoc): EntityRef[];
  cliCommands?: CommandSpec[];
}
