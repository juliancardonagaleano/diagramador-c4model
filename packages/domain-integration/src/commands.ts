import type { CommandSpec } from '@iark/kernel';
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
];
