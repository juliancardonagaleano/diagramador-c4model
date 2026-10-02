import type { AttachmentDiagnostic, AttachmentTextResult } from '@iark/kernel';
import { LineCounter, isMap, isScalar, parseDocument, stringify, type Document, type Node, type YAMLParseError } from 'yaml';
import { checkType, listEngines, resolveEngine, suggestTypes, type EngineDef } from './engines';
import { inheritance } from './inherit';
import { CLASSIFICATIONS, hasPii, type Column, type DataAsset, type DataDocument } from './types';

/**
 * Contrato de datos al estilo Open Data Contract Standard (YAML): identidad y versión, esquema (tablas y propiedades con tipo
 * lógico, claves, obligatoriedad, clasificación y datos personales) y acuerdos de servicio. Aquí solo se valida lo esencial
 * del estándar y se genera un borrador a partir de las columnas del activo. Si el contrato declara su servidor
 * (`servers[].type`: `postgres`, `mongodb`, `snowflake`…), los tipos físicos de sus propiedades se validan contra el catálogo del
 * motor (ver `engines.ts`).
 */

export const ODCS_VERSION = 'v3.0.2';
export const ODCS_STATUSES = ['proposed', 'draft', 'active', 'deprecated', 'retired'] as const;
export const ODCS_LOGICAL_TYPES = ['string', 'date', 'number', 'integer', 'object', 'array', 'boolean'] as const;
const OUTPUT = { indent: 2, lineWidth: 0 } as const;

type Path = ReadonlyArray<string | number>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

const slug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'contrato';

/** Tipo lógico de ODCS que mejor describe el tipo físico declarado en una columna. */
export function logicalTypeOf(type: string | undefined): (typeof ODCS_LOGICAL_TYPES)[number] {
  const t = (type ?? '').toLowerCase();
  if (/^(bool|bit)/.test(t)) return 'boolean';
  if (/^(int|bigint|smallint|serial|long|tinyint)/.test(t)) return 'integer';
  if (/^(dec|num|float|double|real|money)/.test(t)) return 'number';
  if (/^(date|time)/.test(t)) return 'date';
  if (/^(json|object|struct|map)/.test(t)) return 'object';
  if (/(\[\]|^array|^list)/.test(t)) return 'array';
  return 'string';
}

/** Borrador de contrato para un activo: su identidad, su gobierno y una propiedad por columna. */
export function contractFromAsset(doc: DataDocument, asset: DataAsset, name: string, version = '1.0.0'): string {
  const domain = doc.domains.find((d) => d.id === asset.domainId);
  const properties = (asset.columns ?? []).map((c: Column) => ({
    name: c.name,
    logicalType: logicalTypeOf(c.type),
    ...(c.type ? { physicalType: c.type } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.keys?.includes('pk') ? { primaryKey: true } : {}),
    ...(c.keys?.includes('uk') ? { unique: true } : {}),
    required: c.keys?.includes('pk') ? true : !c.nullable,
    ...(c.pii ? { classification: 'restricted', tags: ['pii'] } : {}),
  }));
  const tags = [...(asset.classification ? [`clasificacion:${asset.classification}`] : []), ...(hasPii(asset) ? ['pii'] : [])];
  const engine = resolveEngine(inheritance(doc).engineOf(asset.id));
  const host = asset.parentId ? doc.assets.find((a) => a.id === asset.parentId) : undefined;
  const body: Record<string, unknown> = {
    apiVersion: ODCS_VERSION,
    kind: 'DataContract',
    id: asset.id,
    name,
    version,
    status: 'draft',
    ...(domain ? { domain: domain.name } : {}),
    ...(asset.description ? { description: { purpose: asset.description } } : {}),
    ...(asset.owner ? { team: { name: asset.owner } } : {}),
    ...(tags.length ? { tags } : {}),
    ...(engine ? { servers: [{ server: (host ?? asset).id, type: engine.serverType ?? engine.id }] } : {}),
    schema: [
      {
        name: asset.name,
        physicalType: asset.kind === 'view' ? 'view' : 'table',
        ...(asset.description ? { description: asset.description } : {}),
        properties: properties.length ? properties : [{ name: 'id', logicalType: 'string', primaryKey: true, required: true }],
      },
    ],
    ...(asset.retention ? { slaProperties: [{ property: 'retention', value: asset.retention }] } : {}),
  };
  return stringify(body, OUTPUT);
}

/** Contrato en blanco para un nombre. */
export function contractTemplate(name: string): string {
  return stringify(
    {
      apiVersion: ODCS_VERSION,
      kind: 'DataContract',
      id: slug(name),
      name,
      version: '1.0.0',
      status: 'draft',
      description: { purpose: '' },
      schema: [{ name: 'tabla', physicalType: 'table', properties: [{ name: 'id', logicalType: 'string', primaryKey: true, required: true }] }],
    },
    OUTPUT,
  );
}

interface Parsed {
  doc: Document.Parsed;
  value: unknown;
  lines: LineCounter;
}

function parse(source: string): { ok: true; parsed: Parsed } | { ok: false; diagnostics: AttachmentDiagnostic[] } {
  const lines = new LineCounter();
  const doc = parseDocument(source.replace(/^﻿/, ''), { lineCounter: lines, prettyErrors: false });
  const fatal = doc.errors.map((e: YAMLParseError) => {
    const at = lines.linePos(e.pos[0]);
    return { severity: 'error' as const, message: `YAML no válido: ${e.message.split('\n')[0]}`, line: at.line, column: at.col };
  });
  if (fatal.length > 0) return { ok: false, diagnostics: fatal };
  return { ok: true, parsed: { doc, value: doc.toJS(), lines } };
}

/** Servidor del contrato: `servers[].type` (o el `server.type` de las versiones anteriores del estándar), con la ruta de su `type`. */
function serverTypes(value: Record<string, unknown>): Array<{ type: string; path: Path }> {
  const found: Array<{ type: string; path: Path }> = [];
  const read = (server: unknown, path: Path): void => {
    if (isRecord(server) && typeof server.type === 'string' && server.type.trim()) found.push({ type: server.type.trim(), path: [...path, 'type'] });
  };
  if (Array.isArray(value.servers)) value.servers.forEach((server, i) => read(server, ['servers', i]));
  if (isRecord(value.server)) {
    if (typeof value.server.type === 'string') read(value.server, ['server']);
    else for (const [name, server] of Object.entries(value.server)) read(server, ['server', name]);
  }
  return found;
}

/** Motor que declara el contrato en su servidor (el primero), o `undefined` si no lo declara o no está registrado. */
export function contractEngine(source: string): EngineDef | undefined {
  const result = parse(source);
  if (!result.ok || !isRecord(result.parsed.value)) return undefined;
  for (const { type } of serverTypes(result.parsed.value)) {
    const engine = resolveEngine(type);
    if (engine) return engine;
  }
  return undefined;
}

export interface CheckOptions {
  /** Motor con el que se validan los tipos cuando el contrato no declara su servidor (el del activo que lo usa). */
  engine?: string;
}

/** Problemas del contrato: sintaxis YAML y reglas esenciales de Open Data Contract, y los tipos físicos contra el catálogo del motor. */
export function checkContract(source: string, options: CheckOptions = {}): AttachmentDiagnostic[] {
  if (!source.trim()) return [{ severity: 'error', message: 'El contrato está vacío.' }];
  const result = parse(source);
  if (!result.ok) return result.diagnostics;
  const { doc, value, lines } = result.parsed;
  const out: AttachmentDiagnostic[] = [];
  /** Posición de una ruta: la de su clave si el padre es un mapa, o la del propio nodo. */
  const at = (path: Path): { line?: number; column?: number } => {
    const node = doc.getIn(path, true) as Node | undefined;
    let range = node && 'range' in node ? node.range : undefined;
    const parent = path.length > 0 ? (doc.getIn(path.slice(0, -1), true) as Node | undefined) : undefined;
    const last = path[path.length - 1];
    if (isMap(parent) && typeof last === 'string') {
      const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === last);
      if (pair && isScalar(pair.key) && pair.key.range) range = pair.key.range;
    }
    const pos = range ? lines.linePos(range[0]) : undefined;
    return pos ? { line: pos.line, column: pos.col } : {};
  };
  const add = (severity: AttachmentDiagnostic['severity'], message: string, path: Path = []): void => void out.push({ severity, message, ...at(path) });

  if (!isRecord(value)) return [{ severity: 'error', message: 'El contrato debe ser un objeto YAML con apiVersion, kind, id, version, status y schema.', line: 1, column: 1 }];
  if (!value.apiVersion) add('error', 'Falta «apiVersion» (por ejemplo v3.0.2).');
  if (value.kind !== 'DataContract') add('error', `«kind» debe ser «DataContract»${value.kind ? ` y es «${text(value.kind)}»` : ''}.`, value.kind ? ['kind'] : []);
  for (const key of ['id', 'version'] as const) if (!text(value[key]).trim()) add('error', `Falta «${key}».`);
  if (!text(value.status)) add('error', `Falta «status» (${ODCS_STATUSES.join(', ')}).`);
  else if (!(ODCS_STATUSES as readonly string[]).includes(text(value.status))) add('error', `«status» desconocido: «${text(value.status)}». Usa ${ODCS_STATUSES.join(', ')}.`, ['status']);
  if (!text(value.name).trim()) add('warning', 'Falta «name».');
  if (!value.team && !value.support) add('info', 'No declara responsable (team): quien consume el dato no sabe a quién preguntar.');

  // Motor de la base de datos: el del primer servidor que se reconoce o, si no declara ninguno, el del activo que usa el contrato.
  const servers = serverTypes(value);
  let engine: EngineDef | undefined;
  let engineFrom = '';
  for (const server of servers) {
    const known = resolveEngine(server.type);
    if (known) {
      engine ??= known;
      engineFrom ||= `según ${server.path.join('.').replace(/\.(\d+)/g, '[$1]')}`;
    } else add('info', `El motor «${server.type}» del servidor no está en el registro (${listEngines().map((e) => e.id).join(', ')}): no se validan los tipos físicos.`, server.path);
  }
  if (!engine && servers.length === 0 && options.engine) {
    engine = resolveEngine(options.engine);
    engineFrom = 'el del activo que usa el contrato';
  }

  if (!Array.isArray(value.schema) || value.schema.length === 0) {
    add('error', 'Falta «schema»: una lista con al menos una tabla u objeto.', value.schema === undefined ? [] : ['schema']);
    return out;
  }
  const tables = new Set<string>();
  value.schema.forEach((table: unknown, i: number) => {
    if (!isRecord(table)) return add('error', 'Cada elemento de «schema» es un objeto con «name» y «properties».', ['schema', i]);
    const tname = text(table.name).trim();
    if (!tname) add('error', 'Una tabla del esquema no tiene «name».', ['schema', i]);
    else if (tables.has(tname)) add('error', `Tabla duplicada en el esquema: «${tname}».`, ['schema', i, 'name']);
    tables.add(tname);
    if (!Array.isArray(table.properties) || table.properties.length === 0) return add('warning', `La tabla «${tname}» no declara propiedades (columnas).`, ['schema', i]);
    const names = new Set<string>();
    let primaryKeys = 0;
    table.properties.forEach((prop: unknown, j: number) => {
      const path = ['schema', i, 'properties', j];
      if (!isRecord(prop)) return add('error', 'Cada propiedad es un objeto con «name».', path);
      const pname = text(prop.name).trim();
      if (!pname) add('error', `Una propiedad de «${tname}» no tiene «name».`, path);
      else if (names.has(pname)) add('error', `Propiedad duplicada en «${tname}»: «${pname}».`, [...path, 'name']);
      names.add(pname);
      const lt = text(prop.logicalType);
      if (lt && !(ODCS_LOGICAL_TYPES as readonly string[]).includes(lt)) add('error', `Tipo lógico desconocido en «${tname}.${pname}»: «${lt}». Usa ${ODCS_LOGICAL_TYPES.join(', ')}.`, [...path, 'logicalType']);
      else if (!lt && !prop.physicalType) add('warning', `«${tname}.${pname}» no declara tipo (logicalType).`, path);
      const physical = text(prop.physicalType).trim();
      if (engine && physical) {
        const known = checkType(engine, physical);
        if (!known.ok) {
          const alternatives = suggestTypes(engine, physical);
          add(
            engine.lenient ? 'info' : 'warning',
            `El tipo «${physical}» de «${tname}.${pname}» no existe en ${engine.label} (${engineFrom})${alternatives.length ? `. ¿Quisiste decir ${alternatives.map((t) => `«${t}»`).join(', ')}?` : ''}`,
            [...path, 'physicalType'],
          );
        }
      }
      if (prop.primaryKey === true) primaryKeys += 1;
      const cls = text(prop.classification);
      if (cls && !(CLASSIFICATIONS as readonly string[]).includes(cls)) add('warning', `Clasificación no reconocida en «${tname}.${pname}»: «${cls}» (${CLASSIFICATIONS.join(', ')}).`, [...path, 'classification']);
    });
    if (primaryKeys === 0) add('info', `La tabla «${tname}» no declara clave primaria (primaryKey).`, ['schema', i]);
  });
  if (value.slaProperties !== undefined && !Array.isArray(value.slaProperties)) add('error', '«slaProperties» es una lista de { property, value, unit }.', ['slaProperties']);
  return out;
}

/** Reescribe el contrato en su forma canónica (YAML con sangría de dos espacios). */
export function reformatContract(source: string): AttachmentTextResult {
  const result = parse(source);
  if (!result.ok) return { ok: false, reason: result.diagnostics[0]?.message ?? 'YAML no válido.' };
  return { ok: true, text: stringify(result.parsed.value, OUTPUT) };
}

/** Pasa el contrato a JSON (para herramientas que no leen YAML). */
export function contractToJson(source: string): AttachmentTextResult {
  const result = parse(source);
  if (!result.ok) return { ok: false, reason: result.diagnostics[0]?.message ?? 'YAML no válido.' };
  return { ok: true, text: `${JSON.stringify(result.parsed.value, null, 2)}\n` };
}

/** Resumen legible: estado y versión, cada tabla con sus propiedades y los acuerdos de servicio. */
export function summarizeContract(source: string): string[] {
  const result = parse(source);
  if (!result.ok || !isRecord(result.parsed.value)) return [];
  const v = result.parsed.value;
  const out: string[] = [];
  const head = [text(v.name), text(v.version) && `v${text(v.version)}`, text(v.status)].filter(Boolean).join(' · ');
  if (head) out.push(head);
  for (const table of Array.isArray(v.schema) ? v.schema : []) {
    if (!isRecord(table)) continue;
    const props = Array.isArray(table.properties) ? table.properties.filter(isRecord) : [];
    const pii = props.filter((p) => Array.isArray(p.tags) && p.tags.includes('pii')).length;
    out.push(`${text(table.name)}: ${props.length} propiedades${pii ? `, ${pii} con datos personales` : ''}`);
  }
  for (const sla of Array.isArray(v.slaProperties) ? v.slaProperties : []) if (isRecord(sla)) out.push(`SLA ${text(sla.property)}: ${text(sla.value)}${sla.unit ? ` ${text(sla.unit)}` : ''}`);
  return out;
}

/** Propiedad de una tabla del contrato, con lo que hace falta para escribir su DDL. */
export interface ContractColumn {
  name: string;
  /** `physicalType` o, si falta, el tipo lógico. */
  type?: string;
  /** El tipo es el lógico (`string`, `number`…) porque no declara `physicalType`: no es un tipo de ningún motor. */
  logical?: boolean;
  primaryKey: boolean;
  unique: boolean;
  required: boolean;
  pii: boolean;
  description?: string;
}

export interface ContractTable {
  name: string;
  description?: string;
  columns: ContractColumn[];
}

/** Tablas y propiedades del contrato, para generar su DDL; vacío si el YAML no es válido. */
export function contractTables(source: string): ContractTable[] {
  const result = parse(source);
  if (!result.ok || !isRecord(result.parsed.value) || !Array.isArray(result.parsed.value.schema)) return [];
  return result.parsed.value.schema.filter(isRecord).flatMap((table) => {
    const name = text(table.name).trim();
    if (!name) return [];
    const columns = (Array.isArray(table.properties) ? table.properties : []).filter(isRecord).flatMap((prop): ContractColumn[] => {
      const pname = text(prop.name).trim();
      if (!pname) return [];
      const tags = Array.isArray(prop.tags) ? prop.tags.map(String) : [];
      return [
        {
          name: pname,
          type: text(prop.physicalType).trim() || text(prop.logicalType).trim() || undefined,
          ...(!text(prop.physicalType).trim() && text(prop.logicalType).trim() ? { logical: true } : {}),
          primaryKey: prop.primaryKey === true,
          unique: prop.unique === true,
          required: prop.required === true || prop.primaryKey === true,
          pii: tags.includes('pii'),
          ...(text(prop.description).trim() ? { description: text(prop.description).trim() } : {}),
        },
      ];
    });
    return [{ name, ...(text(table.description).trim() ? { description: text(table.description).trim() } : {}), columns }];
  });
}
