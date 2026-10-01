import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { describeJsonError, isRecord, parseJson, prettyJson } from './json';
import { Reporter, failureDiagnostic, parseStructured, slugify, type Path } from './shared';

const CONTEXT_ORDER = ['specversion', 'id', 'source', 'type', 'datacontenttype', 'dataschema', 'subject', 'time'] as const;
const PAYLOAD_ORDER = ['data', 'data_base64'] as const;
const REQUIRED = ['id', 'source', 'type'] as const;
const KNOWN = new Set<string>([...CONTEXT_ORDER, ...PAYLOAD_ORDER]);

const DEFAULT_ID = 'A234-1234-1234';
const URI_REFERENCE = /^(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})+$/;
const ABSOLUTE_URI = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=(?:"[^"]*"|[^\s;]+))*$/;
const RFC_3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const REVERSE_DNS = /^(?:[a-z]{2,3}|info|dev|app|cloud|tech|biz|site|shop|xyz)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

const present = (value: unknown): boolean => value !== undefined && value !== null;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function isRfc3339(value: string): boolean {
  const match = RFC_3339.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined || day < 1 || day > days) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  return match[7] === undefined || (Number(match[7]) <= 23 && Number(match[8]) <= 59);
}

export function checkCloudEvent(text: string): AttachmentDiagnostic[] {
  const parsed = parseStructured(text, false);
  if (!parsed.ok) return failureDiagnostic(parsed);
  const report = new Reporter(parsed.locate);
  if (Array.isArray(parsed.value)) {
    if (parsed.value.length === 0) report.warning('El lote de eventos está vacío.', []);
    parsed.value.forEach((event, index) => checkEvent(event, report, [index], `Evento ${index + 1}: `));
  } else {
    checkEvent(parsed.value, report, [], '');
  }
  return report.diagnostics;
}

function checkEvent(event: unknown, report: Reporter, base: Path, prefix: string): void {
  const say = (severity: AttachmentDiagnostic['severity'], message: string, key?: string): void =>
    report.add(severity, `${prefix}${message}`, key === undefined ? base : [...base, key]);

  if (!isRecord(event)) {
    say('error', 'Un evento CloudEvents debe ser un objeto JSON (o un array de eventos).');
    return;
  }

  if (!present(event.specversion)) say('error', 'Falta «specversion» (obligatorio): debe ser "1.0".');
  else if (event.specversion !== '1.0') say('error', `«specversion» debe ser "1.0" y es ${JSON.stringify(event.specversion)}.`, 'specversion');

  for (const key of REQUIRED) {
    const value = event[key];
    if (!present(value)) say('error', `Falta el atributo obligatorio «${key}».`);
    else if (typeof value !== 'string') say('error', `«${key}» debe ser una cadena de texto.`, key);
    else if (value.trim() === '') say('error', `«${key}» no puede estar vacío.`, key);
  }

  const { source, type } = event;
  if (typeof source === 'string' && source.trim() !== '' && !URI_REFERENCE.test(source)) {
    say('error', '«source» no es una URI-reference válida (RFC 3986): no admite espacios ni caracteres fuera de ASCII; codifícalos como %XX.', 'source');
  }
  if (typeof type === 'string' && type.trim() !== '' && !REVERSE_DNS.test(type)) {
    say('info', `«type» (${JSON.stringify(type)}) no parece llevar un prefijo de dominio inverso; se recomienda algo como com.empresa.pedido.creado.`, 'type');
  }

  const { datacontenttype, dataschema, subject, time } = event;
  if (present(datacontenttype) && (typeof datacontenttype !== 'string' || !MEDIA_TYPE.test(datacontenttype))) {
    say('error', '«datacontenttype» debe tener la forma tipo/subtipo (p. ej. application/json).', 'datacontenttype');
  }
  if (present(dataschema) && (typeof dataschema !== 'string' || !ABSOLUTE_URI.test(dataschema) || !URI_REFERENCE.test(dataschema))) {
    say('error', '«dataschema» debe ser una URI absoluta (p. ej. https://example.com/schemas/pedido.json).', 'dataschema');
  }
  if (present(subject) && (typeof subject !== 'string' || subject.trim() === '')) {
    say('error', '«subject» debe ser una cadena de texto no vacía.', 'subject');
  }
  if (present(time) && (typeof time !== 'string' || !isRfc3339(time))) {
    say('error', '«time» debe ser una fecha y hora RFC 3339 (p. ej. 2024-05-01T10:30:00Z).', 'time');
  }

  if (present(event.data) && present(event.data_base64)) say('error', '«data» y «data_base64» son excluyentes: usa solo uno.', 'data_base64');
  if (present(event.data_base64) && (typeof event.data_base64 !== 'string' || !BASE64.test(event.data_base64))) {
    say('error', '«data_base64» debe ser una cadena en base64 válida.', 'data_base64');
  }

  for (const [key, value] of Object.entries(event)) {
    if (KNOWN.has(key)) continue;
    if (!/^[a-z0-9]+$/.test(key)) {
      const hint = KNOWN.has(key.toLowerCase()) ? ` ¿Querías decir «${key.toLowerCase()}»?` : '';
      say('warning', `El atributo «${key}» no es válido: los nombres de atributos de contexto usan solo minúsculas y dígitos (a-z, 0-9).${hint}`, key);
    } else if (key.length > 20) {
      say('warning', `El atributo «${key}» supera los 20 caracteres recomendados para los nombres de atributos.`, key);
    }
    if (typeof value === 'object' && value !== null) {
      say('warning', `La extensión «${key}» debería ser un valor simple (texto, número o booleano), no un objeto ni un array.`, key);
    }
  }

  if (!present(datacontenttype) && typeof event.data === 'object' && event.data !== null) {
    say('info', '«data» es un objeto y no hay «datacontenttype»: se asume application/json.', 'data');
  }
}

export function reformatCloudEvent(text: string, context: { name: string }): AttachmentTextResult {
  const parsed = parseJson(text);
  if (!parsed.ok) return { ok: false, reason: describeJsonError(parsed) };
  const defaults = defaultsFor(context.name);
  const { value } = parsed;
  if (Array.isArray(value) && (value.length === 0 || value.some(isEnvelope))) {
    return { ok: true, text: prettyJson(value.map((event) => normalize(event, defaults))) };
  }
  return { ok: true, text: prettyJson(normalize(value, defaults)) };
}

type Defaults = Record<'specversion' | 'id' | 'source' | 'type', string>;

function defaultsFor(name: string): Defaults {
  const slug = slugify(name, 'evento');
  return { specversion: '1.0', id: DEFAULT_ID, source: `/${slug}`, type: `com.example.${slug}` };
}

function isEnvelope(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (Object.hasOwn(value, 'type') || Object.hasOwn(value, 'source') || Object.hasOwn(value, 'specversion'));
}

function normalize(value: unknown, defaults: Defaults): Record<string, unknown> {
  if (!isEnvelope(value)) return canonical({ ...defaults, datacontenttype: 'application/json', data: value });
  const filled: Record<string, unknown> = { ...value };
  for (const key of ['specversion', ...REQUIRED] as const) if (!present(filled[key])) filled[key] = defaults[key];
  return canonical(filled);
}

function canonical(event: Record<string, unknown>): Record<string, unknown> {
  const context = CONTEXT_ORDER.filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]] as const);
  const extensions = Object.keys(event)
    .filter((key) => !KNOWN.has(key))
    .sort(compare)
    .map((key) => [key, event[key]] as const);
  const payload = PAYLOAD_ORDER.filter((key) => Object.hasOwn(event, key)).map((key) => [key, event[key]] as const);
  return Object.fromEntries([...context, ...extensions, ...payload]);
}

export function summarizeCloudEvent(text: string): string[] {
  const parsed = parseJson(text);
  if (!parsed.ok) return [];
  const events = (Array.isArray(parsed.value) ? parsed.value : [parsed.value]).filter(isRecord);
  if (events.length === 0) return [];

  const unique = (key: string): string[] => [...new Set(events.map((event) => event[key]).filter((value): value is string => typeof value === 'string' && value !== ''))];
  const lines: string[] = [];
  if (Array.isArray(parsed.value)) lines.push(`Lote de ${events.length} ${events.length === 1 ? 'evento' : 'eventos'}`);
  const types = unique('type');
  if (types.length) lines.push(`${types.length === 1 ? 'Tipo de evento' : 'Tipos de evento'}: ${types.join(', ')}`);
  const sources = unique('source');
  if (sources.length) lines.push(`${sources.length === 1 ? 'Fuente' : 'Fuentes'}: ${sources.join(', ')}`);
  const contentTypes = unique('datacontenttype');
  if (contentTypes.length) lines.push(`Tipo de contenido: ${contentTypes.join(', ')}`);
  const keys = [...new Set(events.flatMap((event) => (isRecord(event.data) ? Object.keys(event.data) : [])))];
  if (keys.length) lines.push(`Claves de data: ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}`);
  else if (events.some((event) => present(event.data_base64))) lines.push('data_base64: contenido binario');
  return lines;
}

export function cloudEventTemplate(name: string): string {
  const slug = slugify(name, 'evento');
  return prettyJson({
    specversion: '1.0',
    id: DEFAULT_ID,
    source: `/${slug}`,
    type: `com.example.${slug}`,
    datacontenttype: 'application/json',
    dataschema: `https://example.com/schemas/${slug}.json`,
    subject: '123',
    time: '2026-01-15T10:30:00Z',
    data: { id: '123', estado: 'creado' },
  });
}
