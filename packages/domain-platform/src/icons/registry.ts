import type { PlatformDocument } from '../types';
import { awsIconPack } from './aws';
import { azureIconPack } from './azure';
import { iconPackSchema } from './schema';
import type { IconDef, IconKind, IconPack } from './types';

/** Un paquete de iconos que no es válido (o un archivo que no es JSON): el mensaje lista cada problema. */
export class IconPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IconPackError';
  }
}

/**
 * Valida un paquete de iconos: un objeto o el texto JSON de un archivo. Es la entrada común de `registerIconPack`, del campo
 * `workspace.iconPacks` de un documento y del comando `icons --pack`.
 */
export function parseIconPack(input: unknown): IconPack {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch (error) {
      throw new IconPackError(`El paquete de iconos no es JSON válido: ${(error as Error).message}`);
    }
  }
  const result = iconPackSchema.safeParse(value);
  if (!result.success) {
    throw new IconPackError(`Paquete de iconos inválido:\n${result.error.issues.map((i) => `- ${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`).join('\n')}`);
  }
  return result.data as IconPack;
}

// --- Registro --------------------------------------------------------------------------------------------------------------

const registry = new Map<string, IconPack>();

/**
 * Registra un paquete de iconos (con el mismo `id` sustituye al anterior). Los paquetes del mismo proveedor se superponen en el
 * orden en que se registran: para sustituir los iconos propios de AWS por los oficiales basta registrar un paquete `provider: 'aws'`.
 * Lanza `IconPackError` si no es válido.
 */
export function registerIconPack(pack: IconPack): IconPack {
  const valid = parseIconPack(pack);
  registry.set(valid.id, valid);
  return valid;
}

/** Quita un paquete registrado; `false` si no existía. */
export function unregisterIconPack(id: string): boolean {
  return registry.delete(id);
}

export const getIconPack = (id: string): IconPack | undefined => registry.get(id);
export const listIconPacks = (): IconPack[] => [...registry.values()];

registerIconPack(awsIconPack);
registerIconPack(azureIconPack);

/**
 * Los paquetes que valen para un documento, de más antiguo a más reciente: los registrados (salvo los que el documento redefine
 * con el mismo `id`), los de su `workspace.iconPacks` y, al final, los que se pasen aparte (p. ej. un archivo `--pack`).
 */
export function packsFor(doc: Pick<PlatformDocument, 'workspace'> | undefined, extra: IconPack[] = []): IconPack[] {
  const own = doc?.workspace.iconPacks ?? [];
  const redefined = new Set([...own, ...extra].map((p) => p.id));
  return [...listIconPacks().filter((p) => !redefined.has(p.id)), ...own, ...extra];
}

// --- Catálogo por proveedor --------------------------------------------------------------------------------------------------

/** Los iconos de un proveedor tras superponer sus paquetes: el último paquete manda, servicio a servicio. */
export interface ProviderIcons {
  provider: string;
  name: string;
  color: string;
  aliases: string[];
  icons: Record<string, IconDef>;
  /** Paquetes que lo componen, de más antiguo a más reciente. */
  packIds: string[];
}

export interface IconCatalog {
  providers: ProviderIcons[];
  /** El proveedor que nombra un texto (su clave, un alias o el nombre del paquete, sin distinguir mayúsculas, acentos ni espacios). */
  find(text: string | undefined): ProviderIcons | undefined;
}

const normalize = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
/** Palabras de un texto sin acentos ni signos, para buscar frases enteras («sql server») dentro de una tecnología. */
const words = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ');

/** Superpone los iconos de un paquete a los anteriores: el glifo y el nombre son los del último, y lo que no diga de sus clases y palabras clave lo hereda del que sustituye (un paquete solo de glifos oficiales sigue sugiriendo). */
function mergeIcons(before: Record<string, IconDef>, over: Record<string, IconDef>): Record<string, IconDef> {
  const merged = { ...before };
  for (const [key, def] of Object.entries(over)) {
    const previous = before[key];
    merged[key] = previous ? { ...def, ...(def.kinds || !previous.kinds ? {} : { kinds: previous.kinds }), ...(def.keywords || !previous.keywords ? {} : { keywords: previous.keywords }) } : def;
  }
  return merged;
}

export function buildCatalog(packs: IconPack[]): IconCatalog {
  const byProvider = new Map<string, ProviderIcons>();
  for (const pack of packs) {
    const key = normalize(pack.provider);
    const previous = byProvider.get(key);
    byProvider.set(key, {
      provider: previous?.provider ?? pack.provider,
      name: pack.name,
      color: pack.color,
      aliases: [...new Set([...(previous?.aliases ?? []), pack.name, pack.id, ...(pack.aliases ?? [])])],
      icons: mergeIcons(previous?.icons ?? {}, pack.icons),
      packIds: [...(previous?.packIds ?? []), pack.id],
    });
  }
  const providers = [...byProvider.values()];
  const names = new Map<string, ProviderIcons>();
  for (const p of providers) for (const name of [p.provider, ...p.aliases]) if (!names.has(normalize(name))) names.set(normalize(name), p);
  // Un proveedor se llama primero por su clave: «aws» es siempre AWS, aunque otro paquete lo tenga como alias.
  for (const p of providers) names.set(normalize(p.provider), p);
  return { providers, find: (text) => (text && normalize(text) ? names.get(normalize(text)) : undefined) };
}

/** El catálogo de un documento: sus paquetes registrados, los suyos propios y los que se pasen aparte. */
export const iconCatalog = (doc: Pick<PlatformDocument, 'workspace'> | undefined, extra: IconPack[] = []): IconCatalog => buildCatalog(packsFor(doc, extra));

// --- Resolución y sugerencia -------------------------------------------------------------------------------------------------

/** Lo que dice un elemento para elegir su icono. */
export interface IconSubject {
  provider?: string;
  service?: string;
  /** Tipo del recurso (o `network` para una red de nivel superior): para sugerir el servicio cuando no se indica. */
  kind?: IconKind;
  technology?: string;
}

export interface ResolvedIcon {
  provider: string;
  service: string;
  label: string;
  paths: string[];
  color: string;
  /** El servicio no lo indicaba el elemento: se dedujo de su tipo y su tecnología. */
  suggested: boolean;
}

/** La clave de un servicio dentro de un proveedor, aunque se haya escrito con otras mayúsculas o separadores («SQL Database» → `sql-database`). */
export function findService(provider: ProviderIcons, text: string): string | undefined {
  if (text in provider.icons) return text;
  const wanted = normalize(text);
  if (!wanted) return undefined;
  return Object.keys(provider.icons).find((key) => normalize(key) === wanted || normalize(provider.icons[key].label) === wanted);
}

/**
 * El servicio de un proveedor que encaja con un recurso, solo si es inequívoco. Con tecnología, es el único cuyas palabras clave
 * aparecen en ella («PostgreSQL» → RDS) y que además admite el tipo del recurso; sin tecnología, el único que admite su tipo (una
 * caché en AWS → ElastiCache). Si encajan varios o ninguno no se adivina: una cola puede ser SQS o SNS.
 */
export function suggestService(provider: ProviderIcons, subject: Pick<IconSubject, 'kind' | 'technology'>): string | undefined {
  const technology = words(subject.technology ?? '');
  const candidates = Object.entries(provider.icons).filter(([, def]) => {
    const kinds = def.kinds ?? [];
    if (subject.kind && kinds.length > 0 && !kinds.includes(subject.kind)) return false;
    if (technology) return (def.keywords ?? []).some((k) => ` ${technology} `.includes(` ${words(k)} `));
    return subject.kind !== undefined && kinds.includes(subject.kind);
  });
  return candidates.length === 1 ? candidates[0][0] : undefined;
}

/**
 * El icono que se dibuja para un elemento: el del servicio que indica o, si solo indica el proveedor, el que se sugiere de su
 * tipo y su tecnología. Sin proveedor, con un proveedor sin paquete o con un servicio que el paquete no tiene, no hay icono
 * (el elemento se dibuja como siempre).
 */
export function resolveIcon(catalog: IconCatalog, subject: IconSubject): ResolvedIcon | undefined {
  const provider = catalog.find(subject.provider);
  if (!provider) return undefined;
  const explicit = subject.service?.trim();
  const key = explicit ? findService(provider, explicit) : suggestService(provider, subject);
  const def = key ? provider.icons[key] : undefined;
  if (!key || !def) return undefined;
  return { provider: provider.provider, service: key, label: def.label, paths: def.paths, color: provider.color, suggested: !explicit };
}
