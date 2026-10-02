import { uniqueId, type AttachmentSpec, type EditResult } from '@iark/kernel';
import { checkContract, contractFromAsset, contractTemplate, contractToJson, reformatContract, summarizeContract } from './contract';
import { KIND_LABELS, type DataContract, type DataDocument } from './types';

const fail = <T>(reason: string): EditResult<T> => ({ ok: false, reason });
const contractsOf = (doc: DataDocument): DataContract[] => doc.contracts ?? [];

const withoutKey = <T extends object>(value: T, key: string): T => {
  const { [key]: _removed, ...rest } = value as Record<string, unknown>;
  return rest as T;
};

/** Los contratos de datos del documento como adjuntos con editor propio: YAML estilo Open Data Contract. */
export const contractAttachments: AttachmentSpec<DataDocument> = {
  label: 'Contratos',
  singular: 'contrato de datos',
  formats: [{ id: 'odcs', label: 'Open Data Contract (YAML)', language: 'yaml', extension: '.yaml', description: 'Esquema, claves, clasificación y acuerdos de servicio de un activo de datos.' }],

  list: (doc) => contractsOf(doc).map((c) => ({ id: c.id, name: c.name, format: c.format, version: c.version, uses: doc.assets.filter((a) => a.contractId === c.id).length })),

  read(doc, id) {
    const c = contractsOf(doc).find((x) => x.id === id);
    if (!c) return undefined;
    const users = doc.assets.filter((a) => a.contractId === id);
    return {
      id: c.id,
      name: c.name,
      format: c.format,
      version: c.version,
      description: c.description,
      url: c.url,
      text: c.content ?? '',
      uses: users.length,
      usedBy: users.map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    };
  },

  check: (_format, text) => checkContract(text),
  reformat: (_format, text) => reformatContract(text),
  template: (_format, name) => contractTemplate(name),
  summary: (_format, text) => summarizeContract(text),
  transforms: [{ id: 'to-json', label: 'Convertir a JSON', run: (text) => contractToJson(text) }],

  add(doc, format, name) {
    if (format !== 'odcs') return fail(`Formato de contrato desconocido: ${format}`);
    const title = name.trim();
    if (!title) return fail('El nombre del contrato no puede estar vacío.');
    const id = uniqueId(title, [...contractsOf(doc).map((c) => c.id), ...doc.assets.map((a) => a.id)]);
    const created: DataContract = { id, name: title, format: 'odcs', version: '1.0.0', content: contractTemplate(title) };
    return { ok: true, id, document: { ...doc, contracts: [...contractsOf(doc), created] } };
  },

  update(doc, id, patch) {
    const current = contractsOf(doc).find((c) => c.id === id);
    if (!current) return fail(`No existe el contrato «${id}».`);
    let next: DataContract = { ...current };
    if (patch.name !== undefined) {
      if (!patch.name.trim()) return fail('El nombre del contrato no puede estar vacío.');
      next.name = patch.name.trim();
    }
    if (patch.format !== undefined && patch.format !== 'odcs') return fail(`Formato de contrato desconocido: ${patch.format}`);
    for (const key of ['version', 'description', 'url'] as const) {
      if (patch[key] === undefined) continue;
      const value = patch[key]!.trim();
      next = value ? { ...next, [key]: value } : withoutKey(next, key);
    }
    if (patch.text !== undefined) next = patch.text ? { ...next, content: patch.text } : withoutKey(next, 'content');
    return { ok: true, id, document: { ...doc, contracts: contractsOf(doc).map((c) => (c.id === id ? next : c)) } };
  },

  remove(doc, id) {
    if (!contractsOf(doc).some((c) => c.id === id)) return fail(`No existe el contrato «${id}».`);
    const contracts = contractsOf(doc).filter((c) => c.id !== id);
    const { contracts: _old, ...rest } = doc;
    return { ok: true, document: { ...rest, ...(contracts.length ? { contracts } : {}), assets: doc.assets.map((a) => (a.contractId === id ? withoutKey(a, 'contractId') : a)) } };
  },

  suggestFormat: (doc, targetId) => (doc.assets.some((a) => a.id === targetId) ? 'odcs' : undefined),

  createFor(doc, targetId) {
    const asset = doc.assets.find((a) => a.id === targetId);
    if (!asset) return fail(`No existe «${targetId}».`);
    const title = `Contrato de ${asset.name}`;
    const id = uniqueId(title, [...contractsOf(doc).map((c) => c.id), ...doc.assets.map((a) => a.id)]);
    const created: DataContract = { id, name: title, format: 'odcs', version: '1.0.0', description: `${KIND_LABELS[asset.kind]} «${asset.name}»`, content: contractFromAsset(doc, asset, title) };
    return { ok: true, id, document: { ...doc, contracts: [...contractsOf(doc), created], assets: doc.assets.map((a) => (a.id === targetId ? { ...a, contractId: id } : a)) } };
  },
};
