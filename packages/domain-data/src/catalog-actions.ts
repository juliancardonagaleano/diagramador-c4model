import { uniqueId, type EditorAction } from '@iark/kernel';
import { inheritance } from './inherit';
import { termLinkViolation } from './links';
import { isCatalogKind, type DataAsset, type DataDocument, type GlossaryTerm } from './types';

/** Operaciones del catálogo sobre la selección del lienzo: agrupar activos en un producto de datos y enlazar términos con activos. */

const allIds = (doc: DataDocument): string[] => [
  ...doc.assets.map((a) => a.id),
  ...doc.pipelines.map((p) => p.id),
  ...doc.domains.map((d) => d.id),
  ...(doc.contracts ?? []).map((c) => c.id),
  ...(doc.terms ?? []).map((t) => t.id),
];

const unique = (ids: string[]): string[] => [...new Set(ids)];

/** Activos de la selección que puede publicar un producto (cualquiera salvo glosarios y otros productos), en el orden del documento. */
function publishable(doc: DataDocument, ids: string[]): DataAsset[] {
  const picked = new Set(ids);
  return doc.assets.filter((a) => picked.has(a.id) && a.kind !== 'glossary' && a.kind !== 'data-product');
}

/** El valor que más se repite (el primero si hay empate), o `undefined` si no hay ninguno. */
function mostCommon(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

const GROUP_PRODUCT: EditorAction<DataDocument> = {
  id: 'group-product',
  label: 'Agrupar en producto…',
  hint: 'Crea un producto de datos que publica los activos seleccionados (o los añade a uno existente), con su dominio y responsable',
  needs: 'many',
  prompt: {
    label: 'Nombre del producto de datos',
    placeholder: 'Ventas 360',
    initial: () => '',
    suggestions: (doc) => doc.assets.filter((a) => a.kind === 'data-product').map((a) => a.name),
  },
  disabled: (doc, ids) => (publishable(doc, ids).length === 0 ? 'Selecciona uno o varios activos de datos para publicarlos en un producto.' : undefined),
  run(doc, ids, input) {
    const name = (input ?? '').trim();
    if (!name) return { ok: false, reason: 'Indica el nombre del producto de datos.' };
    const chosen = publishable(doc, ids);
    if (chosen.length === 0) return { ok: false, reason: 'Selecciona uno o varios activos de datos para publicarlos en un producto.' };
    const known = doc.assets.find((a) => a.kind === 'data-product' && (a.name.toLowerCase() === name.toLowerCase() || a.id === name));
    if (known) {
      const ports = unique([...(known.outputPorts ?? []), ...chosen.filter((a) => !(known.inputPorts ?? []).includes(a.id)).map((a) => a.id)]);
      return { ok: true, id: known.id, document: { ...doc, assets: doc.assets.map((a) => (a.id === known.id ? { ...a, outputPorts: ports } : a)) } };
    }
    const { ownerOf, domainOf } = inheritance(doc);
    const domainId = mostCommon(chosen.map((a) => domainOf(a.id)));
    const owner = mostCommon(chosen.map((a) => ownerOf(a.id)));
    const product: DataAsset = { id: uniqueId(name, allIds(doc)), kind: 'data-product', name, ...(domainId ? { domainId } : {}), ...(owner ? { owner } : {}), outputPorts: chosen.map((a) => a.id) };
    return { ok: true, id: product.id, document: { ...doc, assets: [...doc.assets, product] } };
  },
};

/** Términos y activos de la selección, y los enlaces que faltan entre ellos. */
function linkPlan(doc: DataDocument, ids: string[]): { terms: GlossaryTerm[]; assets: DataAsset[]; missing: Array<{ term: GlossaryTerm; asset: DataAsset }> } {
  const picked = new Set(ids);
  const terms = (doc.terms ?? []).filter((t) => picked.has(t.id));
  const assets = doc.assets.filter((a) => picked.has(a.id) && !isCatalogKind(a.kind) && !termLinkViolation(a));
  const missing = terms.flatMap((term) => assets.filter((asset) => !(term.links ?? []).some((l) => l.assetId === asset.id)).map((asset) => ({ term, asset })));
  return { terms, assets, missing };
}

const LINK_TERM: EditorAction<DataDocument> = {
  id: 'link-term',
  label: 'Enlazar término',
  hint: 'Enlaza los términos seleccionados con los activos seleccionados (la columna se indica después en el enlace)',
  needs: 'many',
  disabled(doc, ids) {
    const { terms, assets, missing } = linkPlan(doc, ids);
    if (terms.length === 0) return 'Selecciona uno o varios términos del glosario y los activos que los implementan.';
    if (assets.length === 0) return 'Selecciona también los activos con los que se enlazan los términos.';
    return missing.length === 0 ? 'Los términos seleccionados ya están enlazados a esos activos.' : undefined;
  },
  run(doc, ids) {
    const { missing } = linkPlan(doc, ids);
    if (missing.length === 0) return { ok: false, reason: 'No hay nada que enlazar: los términos ya apuntan a esos activos.' };
    const added = new Map<string, string[]>();
    for (const { term, asset } of missing) added.set(term.id, [...(added.get(term.id) ?? []), asset.id]);
    return {
      ok: true,
      document: { ...doc, terms: (doc.terms ?? []).map((t) => (added.has(t.id) ? { ...t, links: [...(t.links ?? []), ...added.get(t.id)!.map((assetId) => ({ assetId }))] } : t)) },
    };
  },
};

export const CATALOG_ACTIONS: Array<EditorAction<DataDocument>> = [GROUP_PRODUCT, LINK_TERM];
