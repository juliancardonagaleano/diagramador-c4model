import type { CommandSpec } from '@iark/kernel';
import { checkContract, reformatContract, summarizeContract } from './contracts';
import { fromC4Json } from './import/fromC4';
import { IntegrationImportError } from './import/fromMermaid';
import { formatIntegrationIssues, validateIntegrationDocument } from './schema';
import type { IntegrationDocument } from './types';

function parseJson(text: string | undefined, what: string): unknown {
  if (!text) throw new IntegrationImportError(`Falta la entrada: indica un archivo JSON o usa --stdin (${what}).`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new IntegrationImportError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
}

function readIntegration(text: string | undefined): IntegrationDocument {
  const result = validateIntegrationDocument(parseJson(text, 'documento de integración'));
  if (!result.ok) throw new IntegrationImportError(`Documento de integración inválido:\n${formatIntegrationIssues(result.issues)}`);
  return result.document;
}

const cell = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'evento';

export const integrationCommands: CommandSpec[] = [
  {
    name: 'from-c4',
    kind: 'convert',
    description: 'Convierte un documento C4 (JSON) en un mapa de integración: sistemas y contenedores pasan a nodos con referencia urn:iark:c4:<id>',
    input: { description: 'documento C4 en JSON' },
    options: [{ flags: '--name <nombre>', description: 'nombre del mapa de integración' }],
    run: ({ input, options, warn }) => {
      const { document, warnings } = fromC4Json(parseJson(input, 'documento C4'), { name: options.name as string | undefined });
      for (const w of warnings) warn?.(`aviso: ${w}`);
      warn?.(`Convertido "${document.workspace.name}": ${document.nodes.length} nodos, ${document.interactions.length} interacciones.`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
  {
    name: 'catalog',
    description: 'Catálogo de contratos (tabla Markdown): formato, versión y qué interacciones los usan',
    input: { description: 'documento de integración en JSON' },
    run: ({ input }) => {
      const doc = readIntegration(input);
      const name = new Map(doc.nodes.map((n) => [n.id, n.name]));
      const rows = doc.contracts.map((c) => {
        const uses = doc.interactions.filter((i) => i.contractId === c.id).map((i) => `${name.get(i.sourceId)} → ${name.get(i.targetId)}`);
        return `| ${cell(c.name)} | ${c.format} | ${c.version ?? '—'} | ${cell(uses.join('; ')) || '—'} |`;
      });
      return ['| Contrato | Formato | Versión | Usado en |', '|---|---|---|---|', ...rows].join('\n');
    },
  },
  {
    name: 'matrix',
    description: 'Matriz de integración (tabla Markdown): quién habla con quién y con qué estilo',
    input: { description: 'documento de integración en JSON' },
    run: ({ input }) => {
      const doc = readIntegration(input);
      const nodes = doc.nodes.filter((n) => doc.interactions.some((i) => i.sourceId === n.id || i.targetId === n.id));
      const short: Record<string, string> = { 'request-response': 'sync', 'async-message': 'async', event: 'evento', batch: 'lote', stream: 'stream' };
      const header = `| Origen \\ Destino | ${nodes.map((n) => cell(n.name)).join(' | ')} |`;
      const rows = nodes.map((s) => {
        const cells = nodes.map((t) => {
          const styles = [...new Set(doc.interactions.filter((i) => i.sourceId === s.id && i.targetId === t.id).map((i) => short[i.style]))];
          return styles.join(', ') || '';
        });
        return `| ${cell(s.name)} | ${cells.join(' | ')} |`;
      });
      return [header, `|---|${nodes.map(() => '---').join('|')}|`, ...rows].join('\n');
    },
  },
  {
    name: 'contracts',
    description: 'Informe de contratos: valida el contenido de cada uno según su formato (OpenAPI, .proto, CloudEvents, MCP…) y lo resume',
    input: { description: 'documento de integración en JSON' },
    run: ({ input }) => {
      const doc = readIntegration(input);
      const lines: string[] = ['| Contrato | Formato | Versión | Estado | Contenido |', '|---|---|---|---|---|'];
      const details: string[] = [];
      for (const c of doc.contracts) {
        if (!c.content) {
          lines.push(`| ${cell(c.name)} | ${c.format} | ${c.version ?? '—'} | sin contenido | ${c.url ? cell(c.url) : '—'} |`);
          continue;
        }
        const diagnostics = checkContract(c.format, c.content);
        const problems = diagnostics.filter((d) => d.severity !== 'info');
        const summary = summarizeContract(c.format, c.content);
        lines.push(`| ${cell(c.name)} | ${c.format} | ${c.version ?? '—'} | ${problems.length === 0 ? 'válido' : `${problems.length} problema(s)`} | ${cell(summary.slice(0, 4).join('; ')) || '—'}${summary.length > 4 ? ` (+${summary.length - 4})` : ''} |`);
        for (const d of problems) details.push(`- **${c.name}**${d.line ? ` (línea ${d.line})` : ''}: ${d.message}`);
      }
      return details.length > 0 ? [...lines, '', '### Problemas', '', ...details].join('\n') : lines.join('\n');
    },
  },
  {
    name: 'contract-export',
    description: 'Escribe el contenido de un contrato tal cual (el .proto, la OpenAPI, el JSON de CloudEvents o de MCP), listo para guardarlo en su archivo',
    input: { description: 'documento de integración en JSON' },
    args: [{ name: 'id', description: 'id del contrato', required: true }],
    run: ({ input, args }) => {
      const doc = readIntegration(input);
      const contract = doc.contracts.find((c) => c.id === args[0]);
      if (!contract) throw new IntegrationImportError(`No existe el contrato «${args[0]}». Contratos: ${doc.contracts.map((c) => c.id).join(', ') || 'ninguno'}.`);
      if (!contract.content) throw new IntegrationImportError(`El contrato «${contract.id}» no tiene contenido${contract.url ? ` (está en ${contract.url})` : ''}.`);
      return contract.content.endsWith('\n') ? contract.content : `${contract.content}\n`;
    },
  },
  {
    name: 'cloudevents',
    description: 'Formatea un JSON como evento CloudEvents 1.0 en estructura canónica: envuelve un payload suelto o completa un envoltorio incompleto',
    input: { description: 'payload o evento CloudEvents en JSON' },
    options: [
      { flags: '--type <tipo>', description: 'atributo type (p. ej. com.empresa.pedido.creado)' },
      { flags: '--source <uri>', description: 'atributo source (p. ej. /pedidos)' },
      { flags: '--subject <sujeto>', description: 'atributo subject' },
      { flags: '--id <id>', description: 'atributo id' },
    ],
    run: ({ input, options, warn }) => {
      const parsed = parseJson(input, 'payload o evento CloudEvents');
      const given = Object.fromEntries((['type', 'source', 'subject', 'id'] as const).filter((k) => typeof options[k] === 'string').map((k) => [k, options[k]]));
      const isEnvelope = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ['specversion', 'type', 'source'].some((k) => k in parsed);
      const envelope = isEnvelope ? { ...(parsed as Record<string, unknown>), ...given } : Object.keys(given).length > 0 ? { ...given, data: parsed } : parsed;
      const name = typeof options.type === 'string' ? slug(options.type.split('.').pop() ?? options.type) : 'evento';
      const result = reformatContract('cloudevents', JSON.stringify(envelope), { name });
      if (!result.ok) throw new IntegrationImportError(result.reason);
      for (const d of checkContract('cloudevents', result.text)) if (d.severity !== 'info') warn?.(`aviso: ${d.message}`);
      return result.text;
    },
  },
];
