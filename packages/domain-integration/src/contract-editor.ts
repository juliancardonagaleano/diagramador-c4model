import { uniqueId, type AttachmentSpec, type EditResult } from '@iark/kernel';
import { CONTRACT_FORMAT_INFO, CONTRACT_TRANSFORMS, checkContract, contractTemplate, reformatContract, summarizeContract } from './contracts';
import { CONTRACT_FORMATS, type Contract, type ContractFormat, type IntegrationDocument } from './types';

const isFormat = (value: string): value is ContractFormat => (CONTRACT_FORMATS as readonly string[]).includes(value);

const fail = <T>(reason: string): EditResult<T> => ({ ok: false, reason });

/** Formato de contrato que mejor encaja con un nodo o una interacción: el que su gente espera encontrar. */
export function suggestContractFormat(doc: IntegrationDocument, targetId: string): ContractFormat | undefined {
  const node = doc.nodes.find((n) => n.id === targetId);
  if (node) {
    if (node.kind === 'mcp') return 'mcp';
    if (node.kind === 'queue' || node.kind === 'topic') return 'cloudevents';
    if (node.kind === 'broker') return 'asyncapi';
    if (node.kind === 'api' || node.kind === 'gateway' || node.kind === 'system') return /grpc/i.test(node.technology ?? '') ? 'protobuf' : 'openapi';
    return undefined;
  }
  const it = doc.interactions.find((i) => i.id === targetId);
  if (!it) return undefined;
  const protocol = it.protocol ?? '';
  if (/grpc/i.test(protocol)) return 'protobuf';
  if (/mcp/i.test(protocol)) return 'mcp';
  if (it.style === 'batch') return 'json-schema';
  if (it.style !== 'request-response') return 'cloudevents';
  return 'openapi';
}

const interactionName = (doc: IntegrationDocument, id: string): string => {
  const it = doc.interactions.find((i) => i.id === id);
  const names = new Map(doc.nodes.map((n) => [n.id, n.name]));
  return it ? `${names.get(it.sourceId) ?? it.sourceId} → ${names.get(it.targetId) ?? it.targetId}` : id;
};

const withoutKey = <T extends object>(value: T, key: string): T => {
  const { [key]: _removed, ...rest } = value as Record<string, unknown>;
  return rest as T;
};

/** Los contratos del documento como adjuntos con editor propio: la metadata de las figuras (OpenAPI, .proto, CloudEvents, MCP…). */
export const contractAttachments: AttachmentSpec<IntegrationDocument> = {
  label: 'Contratos',
  singular: 'contrato',
  formats: CONTRACT_FORMATS.map((f) => CONTRACT_FORMAT_INFO[f]),

  list: (doc) =>
    doc.contracts.map((c) => ({
      id: c.id,
      name: c.name,
      format: c.format,
      version: c.version,
      uses: doc.nodes.filter((n) => n.contractId === c.id).length + doc.interactions.filter((i) => i.contractId === c.id).length,
    })),

  read(doc, id) {
    const c = doc.contracts.find((x) => x.id === id);
    if (!c) return undefined;
    const nodes = doc.nodes.filter((n) => n.contractId === id);
    const interactions = doc.interactions.filter((i) => i.contractId === id);
    return {
      id: c.id,
      name: c.name,
      format: c.format,
      version: c.version,
      description: c.description,
      url: c.url,
      text: c.content ?? '',
      uses: nodes.length + interactions.length,
      usedBy: [...nodes.map((n) => ({ id: n.id, name: n.name, kind: n.kind })), ...interactions.map((i) => ({ id: i.id, name: interactionName(doc, i.id), kind: i.style }))],
    };
  },

  check: (format, text) => (isFormat(format) ? checkContract(format, text) : []),

  reformat: (format, text, context) => (isFormat(format) ? reformatContract(format, text, context) : { ok: false, reason: `Formato desconocido: ${format}` }),

  template: (format, name) => (isFormat(format) ? contractTemplate(format, name) : ''),

  summary: (format, text) => (isFormat(format) ? summarizeContract(format, text) : []),

  transforms: CONTRACT_TRANSFORMS.map((t) => ({
    id: t.id,
    label: t.label,
    formats: t.formats,
    run: (text, context) => (isFormat(context.format) ? t.run(text, { name: context.name, format: context.format }) : { ok: false, reason: `Formato desconocido: ${context.format}` }),
  })),

  add(doc, format, name) {
    if (!isFormat(format)) return fail(`Formato de contrato desconocido: ${format}`);
    const title = name.trim();
    if (!title) return fail('El nombre del contrato no puede estar vacío.');
    const id = uniqueId(title, doc.contracts.map((c) => c.id));
    const created: Contract = { id, name: title, format, version: '1.0.0', content: contractTemplate(format, title) };
    return { ok: true, id, document: { ...doc, contracts: [...doc.contracts, created] } };
  },

  update(doc, id, patch) {
    const current = doc.contracts.find((c) => c.id === id);
    if (!current) return fail(`No existe el contrato «${id}».`);
    let next: Contract = { ...current };
    if (patch.name !== undefined) {
      if (!patch.name.trim()) return fail('El nombre del contrato no puede estar vacío.');
      next.name = patch.name.trim();
    }
    if (patch.format !== undefined) {
      if (!isFormat(patch.format)) return fail(`Formato de contrato desconocido: ${patch.format}`);
      next.format = patch.format;
    }
    for (const key of ['version', 'description', 'url'] as const) {
      if (patch[key] === undefined) continue;
      const value = patch[key]!.trim();
      next = value ? { ...next, [key]: value } : withoutKey(next, key);
    }
    if (patch.text !== undefined) next = patch.text ? { ...next, content: patch.text } : withoutKey(next, 'content');
    return { ok: true, id, document: { ...doc, contracts: doc.contracts.map((c) => (c.id === id ? next : c)) } };
  },

  remove(doc, id) {
    if (!doc.contracts.some((c) => c.id === id)) return fail(`No existe el contrato «${id}».`);
    return {
      ok: true,
      document: {
        ...doc,
        contracts: doc.contracts.filter((c) => c.id !== id),
        nodes: doc.nodes.map((n) => (n.contractId === id ? withoutKey(n, 'contractId') : n)),
        interactions: doc.interactions.map((i) => (i.contractId === id ? withoutKey(i, 'contractId') : i)),
      },
    };
  },

  suggestFormat: (doc, targetId) => suggestContractFormat(doc, targetId),

  createFor(doc, targetId) {
    const node = doc.nodes.find((n) => n.id === targetId);
    const interaction = doc.interactions.find((i) => i.id === targetId);
    if (!node && !interaction) return fail(`No existe «${targetId}».`);
    const format = suggestContractFormat(doc, targetId) ?? 'other';
    const title = `${node ? node.name : interactionName(doc, targetId)} (${CONTRACT_FORMAT_INFO[format].label})`;
    const id = uniqueId(title, doc.contracts.map((c) => c.id));
    const created: Contract = { id, name: title, format, version: '1.0.0', content: contractTemplate(format, node?.name ?? title) };
    return {
      ok: true,
      id,
      document: {
        ...doc,
        contracts: [...doc.contracts, created],
        nodes: doc.nodes.map((n) => (n.id === targetId ? { ...n, contractId: id } : n)),
        interactions: doc.interactions.map((i) => (i.id === targetId ? { ...i, contractId: id } : i)),
      },
    };
  },
};
