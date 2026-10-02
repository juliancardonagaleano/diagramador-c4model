import { KIND_LABELS, type DataAsset, type DataDocument, type GlossaryTerm } from './types';

/**
 * Enlaces del catálogo: lo que conecta un producto de datos, una API de datos o un término del glosario con los activos.
 * No son pipelines (no mueven datos): el producto consume y publica activos por sus puertos, la API sirve activos y el
 * término se materializa en un activo o en una de sus columnas. Se derivan del documento; no se guardan aparte.
 */
export type LinkKind = 'consumes' | 'publishes' | 'exposes' | 'defines';

export interface DataLink {
  /** Identificador estable de la arista: `tipo:origen>destino` (más `#2`, `#3`… para el segundo enlace de un término al mismo activo, que no cambia al editar su columna). */
  id: string;
  kind: LinkKind;
  /** Activo (o término) del que sale la flecha: el dato fluye de origen a destino. */
  source: string;
  target: string;
  /** Término enlazado a una columna concreta. */
  column?: string;
}

export const LINK_LABELS: Record<LinkKind, string> = { consumes: 'entrada', publishes: 'salida', exposes: 'expuesto en', defines: 'define' };

export const linkId = (kind: LinkKind, source: string, target: string, nth = 1): string => `${kind}:${source}>${target}${nth > 1 ? `#${nth}` : ''}`;

/** Texto de la etiqueta de un enlace: la columna enlazada en un término, el nombre del puerto en los demás. */
export const linkLabel = (l: Pick<DataLink, 'kind' | 'column'>): string => (l.kind === 'defines' && l.column ? l.column : LINK_LABELS[l.kind]);

/**
 * Todos los enlaces del documento, en orden: los puertos de entrada y salida de cada producto, lo que sirve cada API y los
 * términos enlazados. Un puerto, una exposición o un enlace que apunta a un activo inexistente se omite.
 */
export function listLinks(doc: DataDocument): DataLink[] {
  const assets = new Set(doc.assets.map((a) => a.id));
  const links: DataLink[] = [];
  for (const a of doc.assets) {
    for (const id of a.inputPorts ?? []) if (assets.has(id)) links.push({ id: linkId('consumes', id, a.id), kind: 'consumes', source: id, target: a.id });
    for (const id of a.outputPorts ?? []) if (assets.has(id)) links.push({ id: linkId('publishes', a.id, id), kind: 'publishes', source: a.id, target: id });
    for (const id of a.exposes ?? []) if (assets.has(id)) links.push({ id: linkId('exposes', id, a.id), kind: 'exposes', source: id, target: a.id });
  }
  for (const t of doc.terms ?? []) {
    const nth = new Map<string, number>();
    for (const l of t.links ?? []) {
      const n = (nth.get(l.assetId) ?? 0) + 1;
      nth.set(l.assetId, n);
      if (assets.has(l.assetId)) links.push({ id: linkId('defines', t.id, l.assetId, n), kind: 'defines', source: t.id, target: l.assetId, ...(l.column ? { column: l.column } : {}) });
    }
  }
  return links;
}

/** El término y la posición en `links` del enlace `id` (`defines:término>activo`), o `undefined` si no es uno. */
export function termLinkAt(doc: DataDocument, id: string): { term: GlossaryTerm; index: number } | undefined {
  for (const t of doc.terms ?? []) {
    const nth = new Map<string, number>();
    for (const [index, l] of (t.links ?? []).entries()) {
      const n = (nth.get(l.assetId) ?? 0) + 1;
      nth.set(l.assetId, n);
      if (linkId('defines', t.id, l.assetId, n) === id) return { term: t, index };
    }
  }
  return undefined;
}

const name = (a: DataAsset): string => `${KIND_LABELS[a.kind].toLowerCase()} «${a.name}»`;

/** Por qué `asset` no puede ser un puerto (de entrada o de salida) del producto `product`, o `undefined` si puede. */
export function portViolation(product: DataAsset, asset: DataAsset): string | undefined {
  if (product.kind !== 'data-product') return `Solo un producto de datos tiene puertos, no ${name(product)}.`;
  if (asset.id === product.id) return 'Un producto no puede ser puerto de sí mismo.';
  if (asset.kind === 'glossary') return `Un glosario no es un puerto de producto: ${name(asset)} define términos, no datos.`;
  return undefined;
}

/** Por qué `asset` no puede ser servido por la API `api`, o `undefined` si puede. */
export function exposeViolation(api: DataAsset, asset: DataAsset): string | undefined {
  if (api.kind !== 'data-api') return `Solo una API de datos expone activos, no ${name(api)}.`;
  if (asset.kind === 'glossary') return `Una API no expone un glosario: ${name(asset)} define términos, no datos.`;
  if (asset.kind === 'data-api') return `Una API no expone a otra API: ${name(asset)}.`;
  return undefined;
}

/** Por qué un término no puede enlazarse con `asset`, o `undefined` si puede. */
export function termLinkViolation(asset: DataAsset): string | undefined {
  if (asset.kind === 'glossary') return `Un término se enlaza con activos de datos, no con ${name(asset)}.`;
  return undefined;
}

/** Por qué `glossary` no puede ser el glosario de un término, o `undefined` si puede. */
export function glossaryViolation(glossary: DataAsset): string | undefined {
  return glossary.kind === 'glossary' ? undefined : `Un término solo pertenece a un glosario, no a ${name(glossary)}.`;
}

/** Elimina de los puertos, las exposiciones y los términos lo que apunta a los activos `gone` (que se borran) y los términos de los glosarios borrados. */
export function pruneCatalog(doc: DataDocument, gone: ReadonlySet<string>): DataDocument {
  const keep = (ids: string[] | undefined): string[] | undefined => {
    const kept = (ids ?? []).filter((id) => !gone.has(id));
    return kept.length > 0 ? kept : undefined;
  };
  const assets = doc.assets.map((a) => {
    if (!a.inputPorts && !a.outputPorts && !a.exposes) return a;
    const { inputPorts, outputPorts, exposes, ...rest } = a;
    const [input, output, exposed] = [keep(inputPorts), keep(outputPorts), keep(exposes)];
    return { ...rest, ...(input ? { inputPorts: input } : {}), ...(output ? { outputPorts: output } : {}), ...(exposed ? { exposes: exposed } : {}) };
  });
  const terms = (doc.terms ?? [])
    .filter((t) => !(t.glossaryId !== undefined && gone.has(t.glossaryId)))
    .map((t): GlossaryTerm => {
      if (!t.links) return t;
      const { links, ...rest } = t;
      const kept = links.filter((l) => !gone.has(l.assetId));
      return kept.length > 0 ? { ...rest, links: kept } : rest;
    });
  const { terms: _terms, ...rest } = doc;
  return { ...rest, assets, ...(doc.terms ? { terms } : {}) };
}
