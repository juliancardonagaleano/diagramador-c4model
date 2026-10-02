import type { Criticality, Importance, Lifecycle, Strategy, TechnologyKind } from '../types';

/**
 * Propiedades de ArchiMate (pares nombre/valor libres) que el módulo empresarial entiende: coste anual, usuarios,
 * estrategia, fin de soporte, ciclo de vida, madurez, importancia, criticidad, responsable, proveedor, tecnología…
 * Los nombres se reconocen en español e inglés sin distinguir mayúsculas, acentos ni separadores (`Coste anual`,
 * `annual_cost`, `AnnualCost`), y los valores admiten las formas habituales de cada idioma.
 */

export type PropField =
  | 'annualCost'
  | 'users'
  | 'strategy'
  | 'endOfLife'
  | 'lifecycle'
  | 'maturity'
  | 'importance'
  | 'criticality'
  | 'owner'
  | 'vendor'
  | 'technology'
  | 'version'
  | 'external'
  | 'kind'
  | 'audience'
  | 'stakeholder'
  | 'value'
  | 'ref';

/** Minúsculas, sin acentos ni nada que no sea letra o cifra: `Fin de soporte` → `findesoporte`. */
export const normKey = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');

/** Nombres de propiedad por campo. `loose`: nombres genéricos (`estado`, `tipo`) que solo cuentan si el valor se entiende. */
const ALIASES: Record<PropField, { names: string[]; loose?: string[] }> = {
  annualCost: { names: ['cost', 'annual cost', 'yearly cost', 'annual tco', 'tco', 'coste', 'coste anual', 'costo', 'costo anual', 'coste total', 'costo total', 'coste anual eur', 'annual cost eur', 'annual cost usd'] },
  users: { names: ['users', 'number of users', 'user count', 'active users', 'usuarios', 'numero de usuarios', 'usuarios activos', 'n usuarios', 'num usuarios'] },
  strategy: { names: ['strategy', 'estrategia', 'tmodel', 'time', 'treatment', 'tratamiento', 'disposition', 'disposicion', 'migration strategy', 'estrategia de migracion', 'modernization strategy', 'estrategia de modernizacion', 'rationalization', 'racionalizacion', '6r', '4r', 'it strategy', 'estrategia ti'] },
  endOfLife: { names: ['end of life', 'eol', 'end of support', 'eos', 'end of support date', 'support end', 'support end date', 'retirement date', 'sunset date', 'vendor support end', 'fin de soporte', 'fin soporte', 'fin de vida', 'fecha fin de soporte', 'fecha de fin de soporte', 'fecha de retirada', 'fecha fin de vida', 'fecha eol', 'fecha de obsolescencia', 'fin de soporte del fabricante'] },
  lifecycle: { names: ['lifecycle', 'lifecycle status', 'lifecycle stage', 'lifecycle phase', 'ciclo de vida', 'estado del ciclo de vida', 'estado ciclo de vida'], loose: ['estado', 'status', 'fase', 'phase', 'situacion'] },
  maturity: { names: ['maturity', 'maturity level', 'maturity score', 'maturity rating', 'capability maturity', 'cmmi', 'cmmi level', 'madurez', 'nivel de madurez', 'nivel madurez', 'madurez de la capacidad'] },
  importance: { names: ['importance', 'strategic importance', 'strategic value', 'capability importance', 'strategic classification', 'importancia', 'importancia estrategica', 'valor estrategico', 'tipo de capacidad', 'clasificacion estrategica'] },
  criticality: { names: ['criticality', 'business criticality', 'criticidad', 'criticalidad', 'criticitud', 'criticidad de negocio', 'criticidad del negocio'] },
  owner: { names: ['owner', 'business owner', 'owning unit', 'owner unit', 'propietario', 'propietaria', 'responsable', 'dueno', 'dueno de negocio', 'propietario de negocio', 'responsable de negocio', 'unidad responsable', 'unidad propietaria'] },
  vendor: { names: ['vendor', 'supplier', 'manufacturer', 'publisher', 'proveedor', 'fabricante'] },
  technology: { names: ['technology', 'tech stack', 'stack', 'product', 'tecnologia', 'pila', 'pila tecnologica', 'producto'] },
  version: { names: ['version', 'release', 'current version', 'version actual'] },
  external: { names: ['external', 'is external', 'saas', 'third party', 'externo', 'externa', 'tercero', 'es externo', 'es externa'] },
  kind: { names: ['technology kind', 'technology type', 'tech type', 'tipo de tecnologia'], loose: ['kind', 'type', 'tipo'] },
  audience: { names: ['audience', 'target audience', 'customers', 'publico', 'publico objetivo', 'destinatarios', 'clientes', 'segmento', 'segment'] },
  stakeholder: { names: ['stakeholder', 'value recipient', 'beneficiario', 'receptor del valor', 'parte interesada'] },
  value: { names: ['value', 'value proposition', 'valor', 'propuesta de valor', 'valor entregado'] },
  ref: { names: ['ref', 'urn', 'referencia', 'iark ref'] },
};

const LOOKUP = new Map<string, { field: PropField; loose: boolean }>();
for (const [field, { names, loose }] of Object.entries(ALIASES) as Array<[PropField, (typeof ALIASES)[PropField]]>) {
  for (const n of names) LOOKUP.set(normKey(n), { field, loose: false });
  for (const n of loose ?? []) LOOKUP.set(normKey(n), { field, loose: true });
}

/** Campo del módulo al que corresponde una propiedad por su nombre, si es uno que se conoce. */
export function propertyField(key: string): { field: PropField; loose: boolean } | undefined {
  return LOOKUP.get(normKey(key));
}

// ───────────── valores ─────────────

const table = <T extends string>(entries: Record<T, string[]>): Map<string, T> => {
  const map = new Map<string, T>();
  for (const [value, words] of Object.entries(entries) as Array<[T, string[]]>) for (const w of words) map.set(normKey(w), value);
  return map;
};

const LIFECYCLE_WORDS = table<Lifecycle>({
  planned: ['planned', 'planificado', 'planificada', 'prevista', 'previsto', 'planeado', 'proposed', 'propuesto', 'target', 'to be', 'tobe', 'futuro', 'futura', 'en desarrollo', 'in development', 'en proyecto'],
  active: ['active', 'activo', 'activa', 'en produccion', 'produccion', 'production', 'live', 'operativo', 'operativa', 'operational', 'vigente', 'en uso', 'in use', 'current', 'actual', 'as is', 'asis', 'en servicio'],
  sunset: ['sunset', 'en retirada', 'phase out', 'phasing out', 'retiring', 'obsoleto', 'obsoleta', 'deprecated', 'deprecado', 'deprecada', 'en declive', 'declining', 'en desuso', 'en extincion'],
  retired: ['retired', 'retirado', 'retirada', 'decommissioned', 'desmantelado', 'desmantelada', 'dado de baja', 'dada de baja', 'baja', 'eliminado', 'eliminada', 'descontinuado', 'descontinuada', 'discontinued', 'apagado'],
});

const CRITICALITY_WORDS = table<Criticality>({
  low: ['low', 'baja', 'bajo', 'minor', 'menor'],
  medium: ['medium', 'media', 'medio', 'moderate', 'moderada', 'moderado', 'normal'],
  high: ['high', 'alta', 'alto', 'important', 'importante'],
  critical: ['critical', 'critica', 'critico', 'mission critical', 'mision critica', 'business critical', 'vital', 'crucial'],
});

const STRATEGY_WORDS = table<Strategy>({
  keep: ['keep', 'conservar', 'mantener', 'retain', 'retener', 'invest', 'invertir', 'tolerate', 'tolerar', 'sostener'],
  migrate: ['migrate', 'migrar', 'rehost', 'replatform', 'refactor', 'relocate', 'rearchitect', 'modernize', 'modernizar', 'rearquitectar'],
  replace: ['replace', 'reemplazar', 'sustituir', 'repurchase', 'recomprar', 'reemplazo', 'sustitucion', 'sustituir por otra'],
  retire: ['retire', 'retirar', 'eliminate', 'eliminar', 'decommission', 'desmantelar', 'dar de baja', 'baja'],
});

const IMPORTANCE_WORDS = table<Importance>({
  differentiating: ['differentiating', 'differentiator', 'differential', 'diferenciadora', 'diferenciador', 'diferencial', 'distintiva', 'estrategica', 'estrategico', 'strategic', 'competitive advantage', 'ventaja competitiva'],
  core: ['core', 'esencial', 'essential', 'nucleo', 'principal', 'basica', 'basico'],
  supporting: ['supporting', 'support', 'apoyo', 'de apoyo', 'soporte', 'commodity', 'utility', 'secundaria', 'secundario', 'complementaria', 'generica', 'generic'],
});

const KIND_WORDS = table<TechnologyKind>({
  platform: ['platform', 'plataforma'],
  infrastructure: ['infrastructure', 'infraestructura', 'hardware', 'servidor', 'server'],
  database: ['database', 'base de datos', 'bd', 'db', 'datastore'],
  runtime: ['runtime', 'entorno de ejecucion', 'ejecucion', 'entorno de ejecución'],
  middleware: ['middleware', 'mensajeria', 'messaging', 'broker', 'integracion'],
  service: ['service', 'servicio'],
});

const MATURITY_WORDS = new Map<string, number>(
  Object.entries({
    1: ['initial', 'inicial', 'ad hoc', 'adhoc'],
    2: ['repeatable', 'repetible', 'managed', 'gestionado', 'gestionada'],
    3: ['defined', 'definido', 'definida'],
    4: ['quantitatively managed', 'cuantitativamente gestionado', 'cuantitativamente gestionada', 'measured', 'medido', 'medida', 'predictable', 'predecible'],
    5: ['optimizing', 'optimizado', 'optimizada', 'optimising', 'optimized', 'optimised'],
  }).flatMap(([level, words]) => words.map((w) => [normKey(w), Number(level)] as const)),
);

export const parseLifecycle = (text: string): Lifecycle | undefined => LIFECYCLE_WORDS.get(normKey(text));
export const parseCriticality = (text: string): Criticality | undefined => CRITICALITY_WORDS.get(normKey(text));
export const parseStrategy = (text: string): Strategy | undefined => STRATEGY_WORDS.get(normKey(text));
export const parseImportance = (text: string): Importance | undefined => IMPORTANCE_WORDS.get(normKey(text));
export const parseTechnologyKind = (text: string): TechnologyKind | undefined => KIND_WORDS.get(normKey(text));

/** Madurez de 1 a 5: `3`, `Nivel 3`, `Level 3`, `3/5`, `3 de 5`, `Definido`, `Optimizing`… Fuera de rango no vale. */
export function parseMaturity(text: string): number | undefined {
  const named = MATURITY_WORDS.get(normKey(text));
  if (named !== undefined) return named;
  const m = /^(?:nivel|level|n|l)?\s*([0-9]+)(?:[.,]0+)?\s*(?:\/|de|of)?\s*(?:5)?$/i.exec(text.trim());
  const n = m ? Number(m[1]) : undefined;
  return n !== undefined && n >= 1 && n <= 5 ? n : undefined;
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', 'si', 's', '1', 'verdadero', 'externo', 'externa', 'external', 'saas', 'tercero', 'thirdparty', 'cloud']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'falso', 'interno', 'interna', 'internal', 'onpremise', 'onprem', 'propio', 'propia']);

export function parseBoolean(text: string): boolean | undefined {
  const k = normKey(text);
  return TRUE_WORDS.has(k) ? true : FALSE_WORDS.has(k) ? false : undefined;
}

const MULTIPLIERS: Array<[RegExp, number]> = [
  [/^(?:millones|millon|million|millions|mm|m)\b/, 1_000_000],
  [/^(?:mil|miles|thousand|k)\b/, 1_000],
];

/**
 * Cantidad con moneda y separadores de cualquier idioma: `180.000 €`, `$210,000`, `1 200 000`, `45k`, `1,2M`, `12,5`.
 * Con un solo separador seguido de exactamente tres cifras (y sin cero delante) se entiende de miles (`210.000`).
 * Los negativos no valen.
 */
export function parseAmount(text: string): number | undefined {
  const m = /(-?)\s*(\d[\d.,\s'’]*)(.*)$/.exec(text.trim());
  if (!m || m[1] === '-') return undefined;
  let digits = m[2].replace(/[\s'’]+/g, '').replace(/[.,]+$/, '');
  const dots = (digits.match(/\./g) ?? []).length;
  const commas = (digits.match(/,/g) ?? []).length;
  if (dots > 0 && commas > 0) {
    const decimal = digits.lastIndexOf('.') > digits.lastIndexOf(',') ? '.' : ',';
    const thousands = decimal === '.' ? ',' : '.';
    digits = digits.split(thousands).join('').replace(decimal, '.');
  } else if (dots + commas > 1) {
    digits = digits.replace(/[.,]/g, '');
  } else if (dots + commas === 1) {
    const [whole, fraction] = digits.split(/[.,]/);
    digits = fraction.length === 3 && !whole.startsWith('0') ? whole + fraction : `${whole}.${fraction}`;
  }
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  const suffix = m[3].trim().toLowerCase();
  const multiplier = MULTIPLIERS.find(([pattern]) => pattern.test(suffix))?.[1] ?? 1;
  return Math.round(value * multiplier * 100) / 100;
}

export const parseCount = (text: string): number | undefined => {
  const n = parseAmount(text);
  return n === undefined ? undefined : Math.round(n);
};

const MONTHS: Record<string, number> = {
  enero: 1, ene: 1, january: 1, jan: 1,
  febrero: 2, feb: 2, february: 2,
  marzo: 3, mar: 3, march: 3,
  abril: 4, abr: 4, april: 4, apr: 4,
  mayo: 5, may: 5,
  junio: 6, jun: 6, june: 6,
  julio: 7, jul: 7, july: 7,
  agosto: 8, ago: 8, august: 8, aug: 8,
  septiembre: 9, setiembre: 9, sep: 9, sept: 9, september: 9,
  octubre: 10, oct: 10, october: 10,
  noviembre: 11, nov: 11, november: 11,
  diciembre: 12, dic: 12, december: 12, dec: 12,
};

const pad = (n: number): string => String(n).padStart(2, '0');
const validDay = (y: number, m: number, d: number): boolean => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Fecha de fin de soporte como `AAAA-MM` o `AAAA-MM-DD`. Admite `2027-06`, `2027-06-30(T…)`, `30/06/2027` (día primero; si el
 * segundo número pasa de 12 se lee como mes/día), `06/2027`, `junio de 2027`, `June 2027` y un año solo (`2027` es a
 * finales de año: `2027-12`).
 */
export function parseEndOfLife(text: string): string | undefined {
  const s = text.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/.](\d{1,2})(?:[-/.](\d{1,2}))?(?:[t\s].*)?$/.exec(s))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined];
    if (d === undefined) return mo >= 1 && mo <= 12 ? `${y}-${pad(mo)}` : undefined;
    return validDay(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : undefined;
  }
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s))) {
    let [d, mo] = [Number(m[1]), Number(m[2])];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d];
    return validDay(Number(m[3]), mo, d) ? `${m[3]}-${pad(mo)}-${pad(d)}` : undefined;
  }
  if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) return Number(m[1]) >= 1 && Number(m[1]) <= 12 ? `${m[2]}-${pad(Number(m[1]))}` : undefined;
  if ((m = /^([a-z]+)\.?\s*(?:de|of|-|\/)?\s*(\d{4})$/.exec(normKeyKeepSpaces(s)))) {
    const month = Object.hasOwn(MONTHS, m[1]) ? MONTHS[m[1]] : undefined;
    return month ? `${m[2]}-${pad(month)}` : undefined;
  }
  if ((m = /^(\d{4})\s*[-/ ]?\s*([a-z]+)$/.exec(normKeyKeepSpaces(s)))) {
    const month = Object.hasOwn(MONTHS, m[2]) ? MONTHS[m[2]] : undefined;
    return month ? `${m[1]}-${pad(month)}` : undefined;
  }
  if ((m = /^(\d{4})$/.exec(s))) return `${m[1]}-12`;
  return undefined;
}

const normKeyKeepSpaces = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
