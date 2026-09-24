import { Command, InvalidArgumentError } from 'commander';
import { autoLayoutDocument, autoLayoutView } from '../core/layout/elkLayout';
import { sampleDocument } from '../core/model/sample';
import { toDrawio } from '../core/export/drawio/toDrawio';
import { documentJsonSchema, DocumentValidationError, formatIssues, validateDocument } from '../core/model/schema';
import type { LayoutDirection } from '../core/model/types';
import { generationJsonSchema } from '../core/ai/generationSchema';
import { standalonePrompt } from '../core/ai/prompt';
import { DEFAULT_AI_MODEL, generateDocument, GenerationError, type Effort } from '../core/ai/generate';
import { analyzeDocument } from '../core/model/issues';
import { CliError, extractJson, info, readDocument, readInput, writeOutput } from './io';

const DIRECTIONS: LayoutDirection[] = ['DOWN', 'RIGHT', 'UP', 'LEFT'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseDirection(value: string): LayoutDirection {
  const v = value.toUpperCase() as LayoutDirection;
  if (!DIRECTIONS.includes(v)) throw new InvalidArgumentError(`Dirección inválida. Use: ${DIRECTIONS.join(', ')}`);
  return v;
}

function parseEffort(value: string): Effort {
  const v = value.toLowerCase() as Effort;
  if (!EFFORTS.includes(v)) throw new InvalidArgumentError(`Esfuerzo inválido. Use: ${EFFORTS.join(', ')}`);
  return v;
}

function jsonOut(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('c4diagram')
    .description('Diagramador C4: genera modelos con IA, aplica autolayout y exporta a .drawio, sin navegador.')
    .version('0.1.0')
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  program
    .command('generate')
    .description('Genera (o refina con --from) un modelo C4 a partir de una instrucción en lenguaje natural usando Claude')
    .argument('<instrucción>', 'descripción del sistema o instrucción de refinamiento')
    .option('-o, --out <archivo.drawio>', 'archivo .drawio de salida')
    .option('-j, --json <archivo.json>', 'archivo JSON de salida (documento C4 con coordenadas)')
    .option('-f, --from <archivo.json>', 'documento existente a refinar')
    .option('-m, --model <modelo>', 'modelo de Claude', DEFAULT_AI_MODEL)
    .option('-e, --effort <nivel>', `esfuerzo de razonamiento (${EFFORTS.join('|')})`, parseEffort)
    .option('-d, --direction <dir>', `dirección del autolayout (${DIRECTIONS.join('|')})`, parseDirection)
    .option('--retries <n>', 'reintentos si el modelo devuelve un documento inválido', (v) => Number.parseInt(v, 10), 1)
    .option('--locale <es|en>', 'idioma de las etiquetas de tipo en el .drawio', 'es')
    .action(async (instruction: string, opts) => {
      const base = opts.from ? readDocument(opts.from, false) : undefined;
      const result = await generateDocument({
        instruction,
        base,
        model: opts.model,
        effort: opts.effort,
        direction: opts.direction,
        maxRetries: opts.retries,
        onProgress: info,
      });
      const { document } = result;
      info(
        `Modelo generado con ${result.model} en ${result.attempts} intento(s): ${document.model.elements.length} elementos, ` +
          `${document.model.relationships.length} relaciones, ${document.views.length} vistas ` +
          `(${result.usage.inputTokens} tokens de entrada, ${result.usage.outputTokens} de salida).`,
      );
      if (opts.json) {
        writeOutput(opts.json, jsonOut(document));
        info(`JSON escrito en ${opts.json}`);
      }
      if (opts.out) {
        writeOutput(opts.out, toDrawio(document, { locale: opts.locale }));
        info(`Diagrama .drawio escrito en ${opts.out}`);
      }
      if (!opts.json && !opts.out) process.stdout.write(jsonOut(document));
    });

  program
    .command('layout')
    .description('Aplica autolayout (ELK) a un documento C4 en JSON; acepta la salida de cualquier IA por stdin')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('-o, --out <archivo.json>', 'archivo de salida (por defecto stdout)')
    .option('-d, --direction <dir>', `dirección (${DIRECTIONS.join('|')})`, parseDirection)
    .option('--spacing <px>', 'separación entre nodos', (v) => Number.parseFloat(v))
    .option('--layer-spacing <px>', 'separación entre capas', (v) => Number.parseFloat(v))
    .option('--force', 'recalcular aunque ya haya coordenadas', false)
    .option('--view <id>', 'solo esta vista')
    .action(async (file: string | undefined, opts) => {
      const doc = readDocument(file, opts.stdin);
      const layoutOpts = { direction: opts.direction, spacing: opts.spacing, layerSpacing: opts.layerSpacing, force: opts.force };
      const result = opts.view ? await autoLayoutView(doc, opts.view, layoutOpts) : await autoLayoutDocument(doc, layoutOpts);
      writeOutput(opts.out, jsonOut(result));
      if (opts.out) info(`Documento con autolayout escrito en ${opts.out}`);
    });

  program
    .command('convert')
    .description('Convierte un documento C4 en JSON a .drawio (aplica autolayout si faltan coordenadas)')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('-o, --out <archivo.drawio>', 'archivo de salida (por defecto stdout)')
    .option('-d, --direction <dir>', `dirección del autolayout (${DIRECTIONS.join('|')})`, parseDirection)
    .option('--force-layout', 'recalcular el layout aunque ya haya coordenadas', false)
    .option('--locale <es|en>', 'idioma de las etiquetas de tipo', 'es')
    .option('--view <id...>', 'solo estas vistas')
    .action(async (file: string | undefined, opts) => {
      const doc = readDocument(file, opts.stdin);
      const laid = await autoLayoutDocument(doc, { direction: opts.direction, force: opts.forceLayout });
      const xml = toDrawio(laid, { locale: opts.locale, viewIds: opts.view });
      writeOutput(opts.out, xml);
      if (opts.out) info(`Diagrama .drawio escrito en ${opts.out} (${laid.views.length} página(s))`);
    });

  program
    .command('validate')
    .description('Valida un documento C4 y muestra avisos de calidad del modelo')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('--strict', 'fallar también con avisos (warnings)', false)
    .action((file: string | undefined, opts) => {
      const raw = readInput(file, opts.stdin);
      let json: unknown;
      try {
        json = JSON.parse(extractJson(raw));
      } catch (error) {
        throw new CliError(`La entrada no es JSON válido: ${(error as Error).message}`);
      }
      const result = validateDocument(json);
      if (!result.ok) {
        throw new CliError(`Documento inválido:\n${formatIssues(result.issues)}`, 2);
      }
      const issues = analyzeDocument(result.document);
      const errors = issues.filter((i) => i.severity === 'error');
      const warnings = issues.filter((i) => i.severity === 'warning');
      for (const i of errors) process.stdout.write(`error    ${i.message}\n`);
      for (const i of warnings) process.stdout.write(`aviso    ${i.message}\n`);
      process.stdout.write(
        `Documento válido: ${result.document.model.elements.length} elementos, ${result.document.model.relationships.length} relaciones, ${result.document.views.length} vistas. ` +
          `${errors.length} error(es), ${warnings.length} aviso(s).\n`,
      );
      if (errors.length > 0 || (opts.strict && warnings.length > 0)) process.exitCode = 3;
    });

  program
    .command('schema')
    .description('Imprime el JSON Schema del documento (o del formato de generación de IA con --generation)')
    .option('--generation', 'esquema del modelo sin coordenadas que produce la IA', false)
    .action((opts) => {
      process.stdout.write(jsonOut(opts.generation ? generationJsonSchema() : documentJsonSchema()));
    });

  program
    .command('prompt')
    .description('Imprime un prompt autocontenido para generar el modelo con cualquier IA/agente (sin clave de API)')
    .argument('<instrucción>', 'descripción del sistema o instrucción de refinamiento')
    .option('-f, --from <archivo.json>', 'documento existente a refinar')
    .action((instruction: string, opts) => {
      const base = opts.from ? readDocument(opts.from, false) : undefined;
      process.stdout.write(standalonePrompt(instruction, base));
    });

  program
    .command('example')
    .description('Imprime el documento de ejemplo (banca en línea) para probar los demás comandos')
    .action(() => {
      process.stdout.write(jsonOut(sampleDocument));
    });

  return program;
}

export async function run(argv = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof DocumentValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof GenerationError) {
      process.stderr.write(`Error generando el modelo: ${error.message}\n`);
      process.exitCode = 4;
      return;
    }
    if (error && typeof error === 'object' && 'code' in error && String((error as { code: string }).code).startsWith('commander.')) {
      const code = (error as { exitCode?: number }).exitCode ?? 1;
      process.exitCode = code;
      return;
    }
    process.stderr.write(`Error inesperado: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
}
