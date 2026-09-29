import { InvalidArgumentError, type Command } from 'commander';
import { buildTraceGraph, formatUrn, parseUrn, traceMermaid, traceReach, traceReachReport, traceReport, traceSvg, type ModuleRegistry, type TraceDirection, type TraceInput } from '@iark/kernel';
import { readModuleDocument, requireModule } from './generic';
import { CliError, writeOutput } from './io';

const DIRECTIONS: TraceDirection[] = ['refs', 'referrers', 'both'];
const FORMATS = ['markdown', 'mermaid', 'svg', 'json'] as const;
type Format = (typeof FORMATS)[number];

function parseDirection(value: string): TraceDirection {
  if (!DIRECTIONS.includes(value as TraceDirection)) throw new InvalidArgumentError(`Sentido inválido «${value}». Use: ${DIRECTIONS.join(', ')}.`);
  return value as TraceDirection;
}
function parseFormat(value: string): Format {
  if (!FORMATS.includes(value as Format)) throw new InvalidArgumentError(`Formato inválido «${value}». Use: ${FORMATS.join(', ')}.`);
  return value as Format;
}
function parseDepth(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('La profundidad debe ser un entero ≥ 1.');
  return n;
}

/** `security:pedidos` o `urn:iark:security:pedidos` → la URN completa. */
function toUrn(value: string): string {
  if (parseUrn(value)) return value;
  const at = value.indexOf(':');
  if (at <= 0) throw new CliError(`«${value}» no es una URN. Use urn:iark:<módulo>:<id> o <módulo>:<id>.`, 2);
  try {
    return formatUrn(value.slice(0, at), value.slice(at + 1));
  } catch (error) {
    throw new CliError((error as Error).message, 2);
  }
}

/**
 * `iark trace módulo=archivo…`: reúne los documentos de varios módulos y sigue las referencias URN (`ref`) entre ellos.
 * Es la vista transversal de la suite: no pertenece a ningún módulo, por eso cuelga del CLI y no de `cliCommands`.
 */
export function registerTrace(program: Command, registry: ModuleRegistry): void {
  program
    .command('trace')
    .description('Trazabilidad entre módulos: enlaces por URN (`ref`) entre los documentos aportados, referencias sin resolver y, con --from, qué alcanza un elemento')
    .argument('<documentos...>', 'documentos como módulo=archivo, uno por módulo (p. ej. security=seguridad.json platform=plataforma.json)')
    .option('--from <urn>', 'elemento de partida: urn:iark:<módulo>:<id> o <módulo>:<id>')
    .option('--direction <sentido>', `con --from: ${DIRECTIONS.join(' | ')} (refs = de qué se apoya; referrers = quién se apoya en él)`, parseDirection, 'both')
    .option('--depth <n>', 'con --from: saltos máximos', parseDepth)
    .option('--format <formato>', `salida: ${FORMATS.join(' | ')}`, parseFormat, 'markdown')
    .option('--strict', 'termina con código 3 si hay referencias mal formadas o a elementos que no existen', false)
    .option('-o, --out <archivo>', 'archivo de salida (por defecto stdout)')
    .action(async (specs: string[], opts: { from?: string; direction: TraceDirection; depth?: number; format: Format; strict: boolean; out?: string }) => {
      const inputs: TraceInput[] = specs.map((spec) => {
        const eq = spec.indexOf('=');
        if (eq <= 0) throw new CliError(`«${spec}» no tiene la forma módulo=archivo (módulos: ${registry.ids().join(', ')}).`, 2);
        const module = requireModule(registry, spec.slice(0, eq));
        const file = spec.slice(eq + 1);
        return { module, document: readModuleDocument(module, file, false), source: file };
      });
      let graph;
      try {
        graph = buildTraceGraph(inputs);
      } catch (error) {
        throw new CliError((error as Error).message, 2);
      }
      let reached;
      if (opts.from) {
        try {
          reached = traceReach(graph, toUrn(opts.from), { direction: opts.direction, depth: opts.depth });
        } catch (error) {
          if (error instanceof CliError) throw error;
          throw new CliError((error as Error).message, 2);
        }
      }
      let text: string;
      if (opts.format === 'json') text = `${JSON.stringify({ graph, ...(reached ? { from: reached[0].node.urn, reached } : {}) }, null, 2)}\n`;
      else if (opts.format === 'svg') text = await traceSvg(graph, { reached });
      else if (opts.format === 'mermaid') text = `${traceMermaid(graph, reached ? new Set(reached.map((r) => r.node.urn)) : undefined)}\n`;
      else text = `${reached ? traceReachReport(reached, opts.direction) : traceReport(graph)}\n`;
      writeOutput(opts.out, text);
      const broken = graph.problems.filter((p) => p.reason !== 'unresolved');
      if (opts.strict && broken.length > 0) {
        process.stderr.write(`${broken.length} referencia(s) sin resolver.\n`);
        process.exitCode = 3;
      }
    });
}
