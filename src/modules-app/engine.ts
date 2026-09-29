import type { CommandOption, CommandSpec, DomainModule, EntityRef, ExportContext, ImportContext, ModuleIssue, ViewRef } from '@iark/kernel';
import { extractJson } from '@iark/kernel';

/**
 * Lógica pura del banco de trabajo de módulos: todo lo que la interfaz y el puente `postMessage` hacen con un módulo lo
 * hacen a través del contrato de `DomainModule` (esquema, validación, vistas, exportadores, importadores y comandos), sin
 * conocer la especialidad. Un módulo nuevo aparece aquí sin tocar este archivo.
 */

/** El banco de trabajo opera con cualquier módulo: el tipo del documento solo lo conoce el propio módulo. */
export type AnyModule = DomainModule<any>;

export interface FieldIssue {
  path: string;
  message: string;
}

export type Analysis =
  | { status: 'empty' }
  | { status: 'syntax'; error: string }
  | { status: 'schema'; issues: FieldIssue[] }
  | { status: 'ok'; document: unknown; issues: ModuleIssue[] };

/** Interpreta el texto del editor: JSON → esquema del módulo → reglas semánticas del dominio. */
export function analyzeText(module: AnyModule, text: string): Analysis {
  if (!text.trim()) return { status: 'empty' };
  let json: unknown;
  try {
    json = JSON.parse(extractJson(text));
  } catch (error) {
    return { status: 'syntax', error: (error as Error).message };
  }
  return analyzeValue(module, json);
}

export function analyzeValue(module: AnyModule, value: unknown): Analysis {
  const parsed = module.schema.safeParse(value);
  if (!parsed.success) {
    return { status: 'schema', issues: parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(raíz)', message: i.message })) };
  }
  try {
    return { status: 'ok', document: parsed.data, issues: module.validate(parsed.data) };
  } catch (error) {
    return { status: 'ok', document: parsed.data, issues: [{ severity: 'error', message: `No se pudo analizar el documento: ${(error as Error).message}` }] };
  }
}

export const pretty = (document: unknown): string => JSON.stringify(document, null, 2);

export function countBySeverity(issues: ModuleIssue[]): Record<ModuleIssue['severity'], number> {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const issue of issues) counts[issue.severity] += 1;
  return counts;
}

// ───────────── vistas ─────────────

export interface TraceChoice {
  prefix: string;
  label: string;
  entities: EntityRef[];
}

export interface ViewChoices {
  views: ViewRef[];
  traces: TraceChoice[];
}

/** Las vistas derivadas del documento y las vistas bajo demanda de sus elementos (`<prefijo>:<id>`). */
export function viewChoices(module: AnyModule, document: unknown): ViewChoices {
  const entities = module.entities?.(document) ?? [];
  return {
    views: module.views?.(document) ?? [],
    traces: (module.traceViews ?? [])
      .map((spec) => ({ prefix: spec.prefix, label: spec.label, entities: entities.filter((e) => spec.applies?.(e) ?? true) }))
      .filter((trace) => trace.entities.length > 0),
  };
}

export function traceViewId(prefix: string, entityId: string): string {
  return `${prefix}:${entityId}`;
}

/** `blast:pedidos` → `{ prefix: 'blast', entityId: 'pedidos' }`; `undefined` si no es una vista de traza. */
export function splitTraceView(viewId: string): { prefix: string; entityId: string } | undefined {
  const at = viewId.indexOf(':');
  return at > 0 ? { prefix: viewId.slice(0, at), entityId: viewId.slice(at + 1) } : undefined;
}

export function isKnownView(choices: ViewChoices, viewId: string): boolean {
  if (choices.views.some((v) => v.id === viewId)) return true;
  const trace = splitTraceView(viewId);
  return !!trace && choices.traces.some((t) => t.prefix === trace.prefix && t.entities.some((e) => e.id === trace.entityId));
}

export function viewTitle(choices: ViewChoices, viewId: string): string {
  const view = choices.views.find((v) => v.id === viewId);
  if (view) return view.title;
  const trace = splitTraceView(viewId);
  const spec = trace && choices.traces.find((t) => t.prefix === trace.prefix);
  const entity = spec?.entities.find((e) => e.id === trace!.entityId);
  return spec && entity ? `${spec.label}: ${entity.name}` : viewId;
}

// ───────────── SVG, exportación e importación ─────────────

export function canRender(module: AnyModule): boolean {
  return module.exporters.some((e) => e.id === 'svg');
}

export async function renderSvg(module: AnyModule, document: unknown, viewId?: string): Promise<string> {
  const exporter = module.exporters.find((e) => e.id === 'svg');
  if (!exporter) throw new Error(`El módulo «${module.name}» no ofrece vista de diagrama.`);
  return exporter.export(document, { viewId });
}

export interface ExportedFile {
  format: string;
  data: string;
  mime: string;
  extension: string;
}

export interface ExportFormatInfo {
  id: string;
  label: string;
  extension: string;
  mime: string;
}

/** `json` (el documento tal cual) siempre está; el resto son los exportadores del módulo. */
export function exportFormats(module: AnyModule): ExportFormatInfo[] {
  return [
    { id: 'json', label: 'JSON', extension: '.json', mime: 'application/json' },
    ...module.exporters.map((e) => ({ id: e.id, label: e.label, extension: e.extension, mime: e.mime })),
  ];
}

export async function exportDocument(module: AnyModule, document: unknown, format: string, context: ExportContext = {}): Promise<ExportedFile> {
  if (format === 'json') return { format, data: pretty(document), mime: 'application/json', extension: '.json' };
  const exporter = module.exporters.find((e) => e.id === format);
  if (!exporter) {
    const available = exportFormats(module).map((f) => f.id).join(', ');
    throw new Error(`El módulo «${module.id}» no exporta a «${format}». Formatos: ${available}.`);
  }
  return { format, data: await exporter.export(document, context), mime: exporter.mime, extension: exporter.extension };
}

export interface ImportResult {
  document: unknown;
  warnings: string[];
  importer: string;
}

/** Importa texto de otro formato; sin `importerId` se reconoce por el contenido. */
export async function importText(module: AnyModule, text: string, importerId?: string, context: ImportContext = {}): Promise<ImportResult> {
  const importer = importerId ? module.importers.find((i) => i.id === importerId) : module.importers.find((i) => i.detect?.(text));
  if (!importer) {
    const known = module.importers.map((i) => i.id).join(', ') || 'ninguno';
    throw new Error(importerId ? `El módulo «${module.id}» no importa «${importerId}». Formatos: ${known}.` : `No se reconoce el formato del texto. Formatos que importa «${module.id}»: ${known}.`);
  }
  const outcome = await importer.import(text, context);
  return { document: outcome.document, warnings: outcome.warnings, importer: importer.id };
}

// ───────────── comandos (informes y conversiones) ─────────────

export interface OptionInfo {
  /** Clave en `options` (camelCase, como la entrega commander). */
  key: string;
  flags: string;
  takesValue: boolean;
  description: string;
  default?: string | boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  kind: 'report' | 'convert';
  /** Si el comando lee un documento (el del editor, o el de otro módulo si es una conversión). */
  needsInput: boolean;
  inputDescription?: string;
  args: NonNullable<CommandSpec['args']>;
  options: OptionInfo[];
}

const camel = (name: string): string => name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export function optionInfo(option: CommandOption): OptionInfo {
  const long = /--([a-z0-9][a-z0-9-]*)/i.exec(option.flags);
  if (!long) throw new Error(`Opción de comando sin nombre largo: «${option.flags}».`);
  return {
    key: camel(long[1]),
    flags: option.flags,
    takesValue: /[<[][^>\]]+[>\]]/.test(option.flags),
    description: option.description,
    default: option.default,
  };
}

export function commandInfos(module: AnyModule): CommandInfo[] {
  return (module.cliCommands ?? []).map((spec) => ({
    name: spec.name,
    description: spec.description,
    kind: spec.kind ?? 'report',
    needsInput: !!spec.input,
    inputDescription: spec.input?.description,
    args: spec.args ?? [],
    options: (spec.options ?? []).map(optionInfo),
  }));
}

export interface CommandRun {
  args?: string[];
  /** Valores por clave; las vacías se ignoran. */
  options?: Record<string, string | boolean | undefined>;
  input?: string;
}

export interface CommandOutput {
  command: string;
  kind: 'report' | 'convert';
  output: string;
  warnings: string[];
}

export async function runCommand(module: AnyModule, name: string, run: CommandRun): Promise<CommandOutput> {
  const spec = module.cliCommands?.find((c) => c.name === name);
  if (!spec) {
    const known = (module.cliCommands ?? []).map((c) => c.name).join(', ') || 'ninguno';
    throw new Error(`El módulo «${module.id}» no tiene el comando «${name}». Comandos: ${known}.`);
  }
  const args = run.args ?? [];
  for (const [index, arg] of (spec.args ?? []).entries()) {
    if (arg.required && !args[index]?.trim()) throw new Error(`Falta el argumento «${arg.name}» (${arg.description}).`);
  }
  const options: Record<string, unknown> = {};
  for (const option of (spec.options ?? []).map(optionInfo)) {
    const value = run.options?.[option.key];
    if (value !== undefined && value !== '' && value !== false) options[option.key] = value;
    else if (option.default !== undefined) options[option.key] = option.default;
  }
  if (spec.input && !run.input?.trim()) throw new Error(`Falta la entrada: ${spec.input.description}.`);
  const warnings: string[] = [];
  const result = await spec.run({ args: args.map((a) => a.trim()), options, input: run.input, warn: (m) => warnings.push(m.replace(/\n+$/, '')) });
  return { command: name, kind: spec.kind ?? 'report', output: result ?? '', warnings };
}

// ───────────── capacidades (handshake del protocolo embebido) ─────────────

export interface ModuleCapabilities {
  id: string;
  name: string;
  version: string;
  description?: string;
  documentVersion: string;
  /** El banco de trabajo dibuja las vistas del módulo (tiene exportador `svg`). */
  render: boolean;
  importFormats: Array<{ id: string; label: string; extensions: string[] }>;
  exportFormats: ExportFormatInfo[];
  traceViews: Array<{ prefix: string; label: string }>;
  commands: Array<{ name: string; description: string; kind: 'report' | 'convert'; needsInput: boolean; args: string[]; options: string[] }>;
  ai: boolean;
}

export function moduleCapabilities(module: AnyModule): ModuleCapabilities {
  return {
    id: module.id,
    name: module.name,
    version: module.version,
    ...(module.description ? { description: module.description } : {}),
    documentVersion: module.documentVersion,
    render: canRender(module),
    importFormats: module.importers.map((i) => ({ id: i.id, label: i.label, extensions: i.extensions })),
    exportFormats: exportFormats(module),
    traceViews: (module.traceViews ?? []).map((t) => ({ prefix: t.prefix, label: t.label })),
    commands: commandInfos(module).map((c) => ({
      name: c.name,
      description: c.description,
      kind: c.kind,
      needsInput: c.needsInput,
      args: c.args.map((a) => a.name),
      options: c.options.map((o) => o.key),
    })),
    ai: !!module.ai,
  };
}

/**
 * Posición del primer `"id": "<id>"` del texto: para llevar el cursor del editor al elemento al que se refiere un
 * problema.
 */
export function locateId(text: string, id: string): { index: number; length: number } | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`"id"\\s*:\\s*"${escaped}"`).exec(text);
  return match ? { index: match.index, length: match[0].length } : undefined;
}
