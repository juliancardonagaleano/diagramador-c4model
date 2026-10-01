import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { describeJsonError, isRecord, parseJson, prettyJson } from './json';
import { Reporter, checkLocalRefs, failureDiagnostic, parseStructured, slugify, type Path } from './shared';

const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const SUBSCHEMA_MAPS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'] as const;
const SUBSCHEMA_LISTS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
const SUBSCHEMAS = ['not', 'if', 'then', 'else', 'additionalProperties', 'unevaluatedProperties', 'items', 'additionalItems', 'contains', 'propertyNames'] as const;

export function checkJsonSchema(text: string): AttachmentDiagnostic[] {
  const parsed = parseStructured(text, false);
  if (!parsed.ok) return failureDiagnostic(parsed);
  const report = new Reporter(parsed.locate);
  const schema = parsed.value;
  if (typeof schema !== 'boolean' && !isRecord(schema)) {
    report.error('Un JSON Schema debe ser un objeto o un booleano (true o false).', []);
    return report.diagnostics;
  }
  if (isRecord(schema) && schema.$schema !== undefined && typeof schema.$schema !== 'string') report.error('«$schema» debe ser una URI (texto).', ['$schema']);
  visit(schema, [], report);
  checkLocalRefs(schema, report);
  return report.diagnostics;
}

function visit(schema: unknown, path: Path, report: Reporter): void {
  if (typeof schema === 'boolean') return;
  if (!isRecord(schema)) {
    report.error('Un subesquema debe ser un objeto o un booleano.', path);
    return;
  }

  const { type } = schema;
  if (type !== undefined) {
    const names = Array.isArray(type) ? type : [type];
    const invalid = names.filter((name) => typeof name !== 'string' || !TYPES.has(name));
    if (invalid.length > 0 || names.length === 0) {
      report.error(`«type» debe ser uno de ${[...TYPES].join(', ')} (o una lista de ellos); no es válido: ${JSON.stringify(type)}.`, [...path, 'type']);
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== 'string'))) {
    report.error('«required» debe ser un array de nombres de propiedad.', [...path, 'required']);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    report.error('«enum» debe ser un array con al menos un valor.', [...path, 'enum']);
  }
  if (typeof schema.pattern === 'string') {
    try {
      new RegExp(schema.pattern, 'u');
    } catch {
      report.warning(`«pattern» no es una expresión regular válida: ${JSON.stringify(schema.pattern)}.`, [...path, 'pattern']);
    }
  }

  for (const key of SUBSCHEMA_MAPS) {
    const value = schema[key];
    if (value === undefined) continue;
    if (!isRecord(value)) report.error(`«${key}» debe ser un objeto cuyas claves son nombres y cuyos valores son esquemas.`, [...path, key]);
    else for (const [name, child] of Object.entries(value)) visit(child, [...path, key, name], report);
  }
  for (const key of SUBSCHEMA_LISTS) {
    const value = schema[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length === 0) report.error(`«${key}» debe ser un array con al menos un esquema.`, [...path, key]);
    else value.forEach((child, index) => visit(child, [...path, key, index], report));
  }
  for (const key of SUBSCHEMAS) {
    const value = schema[key];
    if (value === undefined) continue;
    if (Array.isArray(value) && (key === 'items' || key === 'additionalItems')) value.forEach((child, index) => visit(child, [...path, key, index], report));
    else visit(value, [...path, key], report);
  }
}

export function reformatJsonSchema(text: string): AttachmentTextResult {
  const parsed = parseJson(text);
  return parsed.ok ? { ok: true, text: prettyJson(parsed.value) } : { ok: false, reason: describeJsonError(parsed) };
}

export function summarizeJsonSchema(text: string): string[] {
  const parsed = parseJson(text);
  if (!parsed.ok || !isRecord(parsed.value)) return [];
  const schema = parsed.value;
  const lines: string[] = [];
  if (typeof schema.title === 'string') lines.push(`Título: ${schema.title}`);
  if (typeof schema.type === 'string') lines.push(`Tipo: ${schema.type}`);
  else if (Array.isArray(schema.type)) lines.push(`Tipo: ${schema.type.join(' | ')}`);
  if (isRecord(schema.properties)) lines.push(`Propiedades: ${Object.keys(schema.properties).join(', ')}`);
  if (Array.isArray(schema.required) && schema.required.length > 0) lines.push(`Obligatorias: ${schema.required.join(', ')}`);
  return lines;
}

export function jsonSchemaTemplate(name: string): string {
  return prettyJson({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://example.com/schemas/${slugify(name, 'esquema')}.json`,
    title: name.trim() || 'Esquema',
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Identificador único' },
      nombre: { type: 'string' },
      creado: { type: 'string', format: 'date-time' },
    },
    required: ['id'],
    additionalProperties: false,
  });
}
