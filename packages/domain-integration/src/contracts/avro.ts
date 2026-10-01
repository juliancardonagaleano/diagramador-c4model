import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { describeJsonError, isRecord, parseJson, prettyJson } from './json';
import { Reporter, failureDiagnostic, pascalCase, parseStructured, type Path } from './shared';

const PRIMITIVES = new Set(['null', 'boolean', 'int', 'long', 'float', 'double', 'bytes', 'string']);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FULL_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function checkAvro(text: string): AttachmentDiagnostic[] {
  const parsed = parseStructured(text, false);
  if (!parsed.ok) return failureDiagnostic(parsed);
  const report = new Reporter(parsed.locate);
  const declared = new Set<string>();
  visitType(parsed.value, '', [], declared, report);
  return report.diagnostics;
}

function qualify(name: string, namespace: string): string {
  return name.includes('.') || !namespace ? name : `${namespace}.${name}`;
}

function declare(schema: Record<string, unknown>, namespace: string, path: Path, declared: Set<string>, report: Reporter): string {
  const { name } = schema;
  if (typeof name !== 'string' || name === '') {
    report.error(`El tipo «${String(schema.type)}» necesita un «name».`, path);
    return namespace;
  }
  if (!FULL_NAME.test(name)) report.error(`El nombre «${name}» no es válido: debe empezar por letra o «_» y usar solo letras, dígitos y «_».`, [...path, 'name']);
  const own = typeof schema.namespace === 'string' ? schema.namespace : namespace;
  const full = qualify(name, own);
  if (declared.has(full)) report.error(`El tipo «${full}» ya está definido.`, [...path, 'name']);
  declared.add(full);
  const cut = full.lastIndexOf('.');
  return cut === -1 ? '' : full.slice(0, cut);
}

function visitType(type: unknown, namespace: string, path: Path, declared: Set<string>, report: Reporter): void {
  if (typeof type === 'string') {
    if (PRIMITIVES.has(type) || declared.has(qualify(type, namespace)) || declared.has(type)) return;
    report.error(`El tipo «${type}» no está definido (si es un tipo con nombre, debe declararse antes de usarlo).`, path);
    return;
  }
  if (Array.isArray(type)) {
    if (type.length === 0) report.error('Una unión no puede estar vacía.', path);
    const seen = new Set<string>();
    type.forEach((member, index) => {
      if (Array.isArray(member)) report.error('Una unión no puede contener otra unión.', [...path, index]);
      if (typeof member === 'string' && seen.has(member)) report.error(`La unión repite el tipo «${member}».`, [...path, index]);
      if (typeof member === 'string') seen.add(member);
      visitType(member, namespace, [...path, index], declared, report);
    });
    return;
  }
  if (!isRecord(type)) {
    report.error('Un esquema Avro debe ser un nombre de tipo, una unión (array) o un objeto con «type».', path);
    return;
  }

  const kind = type.type;
  if (kind === undefined) {
    report.error('Falta «type» en el esquema.', path);
    return;
  }
  if (typeof kind !== 'string') {
    visitType(kind, namespace, [...path, 'type'], declared, report);
    return;
  }

  switch (kind) {
    case 'record':
    case 'error': {
      const inner = declare(type, namespace, path, declared, report);
      if (!Array.isArray(type.fields)) {
        report.error(`El ${kind} «${String(type.name ?? '')}» necesita «fields» (un array).`, path);
        return;
      }
      const names = new Set<string>();
      type.fields.forEach((field: unknown, index) => {
        const where: Path = [...path, 'fields', index];
        if (!isRecord(field)) {
          report.error('Cada campo debe ser un objeto con «name» y «type».', where);
          return;
        }
        if (typeof field.name !== 'string' || !NAME.test(field.name)) {
          report.error(`El nombre de campo ${JSON.stringify(field.name)} no es válido: debe empezar por letra o «_» y usar solo letras, dígitos y «_».`, [...where, 'name']);
        } else if (names.has(field.name)) {
          report.error(`El campo «${field.name}» está repetido.`, [...where, 'name']);
        } else {
          names.add(field.name);
        }
        if (field.type === undefined) report.error(`Falta «type» en el campo ${JSON.stringify(field.name)}.`, where);
        else visitType(field.type, inner, [...where, 'type'], declared, report);
      });
      return;
    }
    case 'enum': {
      declare(type, namespace, path, declared, report);
      const { symbols } = type;
      if (!Array.isArray(symbols) || symbols.length === 0) {
        report.error('Un enum necesita «symbols» (un array no vacío).', path);
        return;
      }
      const seen = new Set<string>();
      symbols.forEach((symbol: unknown, index) => {
        if (typeof symbol !== 'string' || !NAME.test(symbol)) report.error(`El símbolo ${JSON.stringify(symbol)} no es válido.`, [...path, 'symbols', index]);
        else if (seen.has(symbol)) report.error(`El símbolo «${symbol}» está repetido.`, [...path, 'symbols', index]);
        else seen.add(symbol);
      });
      return;
    }
    case 'fixed':
      declare(type, namespace, path, declared, report);
      if (!Number.isInteger(type.size) || (type.size as number) < 0) report.error('Un fixed necesita «size» (un entero no negativo).', path);
      return;
    case 'array':
      if (type.items === undefined) report.error('Un array necesita «items».', path);
      else visitType(type.items, namespace, [...path, 'items'], declared, report);
      return;
    case 'map':
      if (type.values === undefined) report.error('Un map necesita «values».', path);
      else visitType(type.values, namespace, [...path, 'values'], declared, report);
      return;
    default:
      visitType(kind, namespace, [...path, 'type'], declared, report);
  }
}

export function reformatAvro(text: string): AttachmentTextResult {
  const parsed = parseJson(text);
  return parsed.ok ? { ok: true, text: prettyJson(parsed.value) } : { ok: false, reason: describeJsonError(parsed) };
}

export function summarizeAvro(text: string): string[] {
  const parsed = parseJson(text);
  if (!parsed.ok) return [];
  const schemas = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const lines: string[] = [];
  for (const schema of schemas) {
    if (typeof schema === 'string') {
      lines.push(schema);
    } else if (isRecord(schema) && typeof schema.type === 'string') {
      const fields = Array.isArray(schema.fields) ? schema.fields.filter(isRecord).map((field) => String(field.name)) : [];
      const name = typeof schema.name === 'string' ? ` ${schema.name}` : '';
      lines.push(fields.length > 0 ? `${schema.type}${name} (${fields.join(', ')})` : `${schema.type}${name}`);
    }
  }
  return lines;
}

export function avroTemplate(name: string): string {
  return prettyJson({
    type: 'record',
    name: pascalCase(name, 'Registro'),
    namespace: 'com.example',
    doc: `Registro de ${name.replace(/\s+/g, ' ').trim() || 'ejemplo'}.`,
    fields: [
      { name: 'id', type: 'string' },
      { name: 'total', type: 'double' },
      { name: 'creado', type: { type: 'long', logicalType: 'timestamp-millis' } },
      { name: 'nota', type: ['null', 'string'], default: null },
    ],
  });
}
