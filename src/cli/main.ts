import { existsSync } from 'node:fs';
import { extname } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { applyLayoutToView, autoLayoutDocumentWithQuality, layoutView } from '@core/layout/elkLayout';
import { formatQuality, type LayoutQuality } from '@core/layout/quality';
import { sampleDocument } from '@core/model/sample';
import { toDrawio, DrawioExportError, type DrawioNotation } from '@core/export/drawio/toDrawio';
import { DrawioImportError } from '@core/import/drawio/fromDrawio';
import { DslImportError } from '@core/import/structurizr/fromStructurizrDsl';
import { MermaidImportError } from '@core/import/mermaid/fromMermaid';
import { toMermaid, MermaidExportError, type MermaidFormat } from '@core/export/mermaid/toMermaid';
import { documentJsonSchema, DocumentValidationError, formatIssues, validateDocument } from '@core/model/schema';
import type { LayoutDensity, LayoutDirectionOption, LayoutDistribution } from '@core/model/types';
import { generationJsonSchema } from '@core/ai/generationSchema';
import { standalonePrompt } from '@core/ai/prompt';
import { DEFAULT_AI_MODEL, generateDocument, GenerationError, type Effort } from '@core/ai/generate';
import { analyzeDocument } from '@core/model/issues';
import { buildManifest, ModuleError, type ModuleRegistry, UnknownModuleError } from '@iark/kernel';
import { createDefaultRegistry, DEFAULT_MODULE } from './registry';
import { createSuiteServer } from './serve';
import { registerTrace } from './trace';
import { registerDiff } from './diff';
import { genericExport, genericGenerate, genericPrompt, genericSchema, genericValidate, readModuleDocument } from './generic';
import { CliError, dslIncludeOptions, extractJson, fallbackDocumentName, info, readDocument, readInput, writeOutput } from './io';
import { assertRepoFlags, DRY_RUN_HELP, FROM_REPO_HELP, FROM_REPO_PROMPT_HELP, parseRepoBudget, parseRepoRef, prepareRepo, REPO_BUDGET_HELP, REPO_PRIVACY_HELP, REPO_PROMPT_HELP, REPO_REF_HELP, reportRepoFiles, reportRepoSummary } from './repo';

const CLI_VERSION = '0.1.0';

const DIRECTIONS: LayoutDirectionOption[] = ['auto', 'DOWN', 'RIGHT', 'LEFT', 'UP'];
const DISTRIBUTIONS: LayoutDistribution[] = ['auto', 'centered', 'elk'];
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseDirection(value: string): LayoutDirectionOption {
  const v = (value.toLowerCase() === 'auto' ? 'auto' : value.toUpperCase()) as LayoutDirectionOption;
  if (!DIRECTIONS.includes(v)) throw new InvalidArgumentError(`Dirección inválida. Use: ${DIRECTIONS.join(', ')}`);
  return v;
}

function parseDistribution(value: string): LayoutDistribution {
  const v = value.toLowerCase() as LayoutDistribution;
  if (!DISTRIBUTIONS.includes(v)) throw new InvalidArgumentError(`Distribución inválida. Use: ${DISTRIBUTIONS.join(', ')}`);
  return v;
}

function parseEffort(value: string): Effort {
  const v = value.toLowerCase() as Effort;
  if (!EFFORTS.includes(v)) throw new InvalidArgumentError(`Esfuerzo inválido. Use: ${EFFORTS.join(', ')}`);
  return v;
}

const PROVIDERS = ['auto', 'anthropic', 'foundry', 'openai'] as const;

function parseProvider(value: string): (typeof PROVIDERS)[number] {
  const v = value.toLowerCase() as (typeof PROVIDERS)[number];
  if (!PROVIDERS.includes(v)) throw new InvalidArgumentError(`Plataforma inválida. Use: ${PROVIDERS.join(', ')}`);
  return v;
}

const DENSITIES: LayoutDensity[] = ['auto', 'compact', 'spacious'];

function parseDensity(value: string): LayoutDensity {
  const v = value.toLowerCase() as LayoutDensity;
  if (!DENSITIES.includes(v)) throw new InvalidArgumentError(`Densidad inválida. Use: ${DENSITIES.join(', ')}`);
  return v;
}

/**
 * Importa una fuente con un importador del módulo: el indicado con `--format` o, si es `auto`, el que se deduce de la
 * extensión o del contenido.
 */
async function importSource(
  registry: ModuleRegistry,
  moduleId: string,
  input: { file?: string; raw: string; format?: string; name?: string; fromFile: boolean },
): Promise<{ format: string; document: any; warnings: string[] }> {
  const module = registry.require(moduleId);
  const ids = module.importers.map((i) => i.id).sort();
  const requested = (input.format ?? 'auto').toLowerCase();
  if (requested !== 'auto' && !ids.includes(requested)) {
    throw new CliError(`Formato inválido «${input.format}». Use: auto, ${ids.join(', ')}.`, 2);
  }
  const importer =
    requested === 'auto'
      ? registry.detectImporter<unknown>(moduleId, input.fromFile ? input.file : undefined, input.raw)
      : module.importers.find((i) => i.id === requested);
  if (!importer) {
    const list = ids.length > 1 ? `${ids.slice(0, -1).join(', ')} o ${ids[ids.length - 1]}` : ids.join(', ');
    throw new CliError(`No se reconoce el formato${input.fromFile ? ` de "${input.file}"` : ' de la entrada'}: use --format ${list}.`, 2);
  }
  const fallbackName = input.fromFile && input.file ? fallbackDocumentName(input.file, module.importers.flatMap((i) => i.extensions)) : undefined;
  const outcome = await importer.import(input.raw, {
    name: input.name,
    fallbackName,
    file: input.fromFile ? input.file : undefined,
    // Solo el DSL de Structurizr lo usa (resolver `!include` sin salir de la carpeta del archivo).
    extra: input.fromFile && input.file ? dslIncludeOptions(input.file) : undefined,
  });
  return { format: importer.id, document: outcome.document, warnings: outcome.warnings };
}

/** Documento base de `generate`/`prompt --from`: un JSON del modelo o cualquier fuente importable (.drawio, .dsl, .mmd). */
async function readBaseDocument(registry: ModuleRegistry, file: string, moduleId = DEFAULT_MODULE): Promise<any> {
  const raw = readInput(file, false);
  if (extname(file).toLowerCase() === '.json' || raw.trimStart().startsWith('{')) {
    return moduleId === DEFAULT_MODULE ? readDocument(file, false) : readModuleDocument(registry.require(moduleId), file, false);
  }
  const imported = await importSource(registry, moduleId, { file, raw, fromFile: true });
  for (const warning of imported.warnings) info(`aviso: ${warning}`);
  info(`Documento base importado de ${imported.format}.`);
  return imported.document;
}

/** Imprime el prompt autocontenido del módulo (sin llamar a ningún modelo): `prompt` y `generate --from-repo --dry-run`. */
async function emitPrompt(registry: ModuleRegistry, moduleId: string, instruction: string, base: any): Promise<void> {
  if (moduleId !== DEFAULT_MODULE) return genericPrompt(registry.require(moduleId), instruction, base);
  process.stdout.write(standalonePrompt(instruction, base));
}

function parseTarget(value: string): 'drawio' | 'mermaid' {
  const v = value.toLowerCase();
  if (v !== 'drawio' && v !== 'mermaid') throw new InvalidArgumentError('Formato de salida inválido. Use: drawio, mermaid');
  return v;
}

function parseMermaidFormat(value: string): MermaidFormat {
  const v = value.toLowerCase();
  if (v !== 'c4' && v !== 'flowchart') throw new InvalidArgumentError('Formato de Mermaid inválido. Use: c4, flowchart');
  return v;
}

function parseNotation(value: string): DrawioNotation {
  const v = value.toLowerCase();
  if (v !== 'c4' && v !== 'card') throw new InvalidArgumentError('Notación inválida. Use: c4, card');
  return v;
}

function parsePositiveNumber(value: string, label: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError(`${label} debe ser un número positivo.`);
  return n;
}

function parseSpacing(value: string): number {
  return parsePositiveNumber(value, 'La separación');
}

function parseLayerSpacing(value: string): number {
  return parsePositiveNumber(value, 'La separación entre capas');
}

function parseRetries(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('Los reintentos deben ser un entero ≥ 0.');
  return n;
}

function parsePort(value: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new InvalidArgumentError('El puerto debe ser un entero entre 0 y 65535.');
  return n;
}

function reportQuality(items: Array<{ viewId: string; quality?: LayoutQuality; direction?: string; distribution?: string }>): void {
  for (const { viewId, quality, direction, distribution } of items) {
    if (!quality) continue;
    const chosen = [direction, distribution === 'centered' ? 'centrado' : distribution === 'elk' ? 'ELK' : undefined].filter(Boolean).join(' ');
    info(`  ${viewId}: ${formatQuality(quality)}${chosen ? ` · ${chosen}` : ''}${quality.strategy ? ` (estrategia ${quality.strategy})` : ''}`);
  }
}

function jsonOut(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function buildProgram(registry: ModuleRegistry = createDefaultRegistry()): Command {
  const program = new Command();
  program
    .name('iark')
    .description('IArk - DIAgrams: genera modelos con IA, aplica autolayout y exporta a .drawio, sin navegador.')
    .version(CLI_VERSION)
    .configureOutput({ writeErr: (s) => process.stderr.write(s) });

  program
    .command('generate')
    .description('Genera (o refina con --from) un modelo C4 a partir de una instrucción en lenguaje natural usando Claude u otro modelo de Foundry')
    .argument('<instrucción>', 'descripción del sistema o instrucción de refinamiento')
    .option('-o, --out <archivo.drawio>', 'archivo .drawio de salida')
    .option('-j, --json <archivo.json>', 'archivo JSON de salida (documento C4 con coordenadas)')
    .option('-f, --from <archivo>', 'documento existente a refinar: JSON, .drawio, .dsl (Structurizr) o .mmd (Mermaid)')
    .option('-p, --provider <plataforma>', 'plataforma: auto|anthropic (API de Anthropic)|foundry (Claude en Foundry)|openai (cualquier modelo de Foundry / API compatible con OpenAI)', parseProvider, 'auto')
    .option('-m, --model <modelo>', `modelo (por defecto ${DEFAULT_AI_MODEL}; en Foundry, el nombre de tu despliegue o AI_MODEL / ANTHROPIC_FOUNDRY_MODEL)`)
    .option('-e, --effort <nivel>', `esfuerzo de razonamiento (${EFFORTS.join('|')})`, parseEffort)
    .option('-d, --direction <dir>', `dirección del autolayout (${DIRECTIONS.join('|')})`, parseDirection)
    .option('--retries <n>', 'reintentos si el modelo devuelve un documento inválido', parseRetries, 1)
    .option('--locale <es|en>', 'idioma de las etiquetas de tipo en el .drawio', 'es')
    .option('--density <auto|compact|spacious>', 'densidad del autolayout', parseDensity)
    .option('--distribution <auto|centered|elk>', 'distribución del autolayout', parseDistribution)
    .option('--notation <c4|card>', 'notación de las figuras en el .drawio', parseNotation, 'c4')
    .option('--module <id>', 'módulo de la suite (ver `iark modules`); con otro que no sea c4, --out exporta según la extensión (.svg, .mmd, .drawio…)', DEFAULT_MODULE)
    .option('--from-repo <carpeta|url>', FROM_REPO_HELP)
    .option('--repo-ref <rama|etiqueta>', REPO_REF_HELP, parseRepoRef)
    .option('--repo-budget <kb>', REPO_BUDGET_HELP, parseRepoBudget)
    .option('--dry-run', DRY_RUN_HELP, false)
    .addHelpText('after', REPO_PRIVACY_HELP)
    .action(async (instruction: string, opts) => {
      assertRepoFlags(opts);
      const base = opts.from ? await readBaseDocument(registry, opts.from, opts.module) : undefined;
      const repo = await prepareRepo(instruction, opts, opts.module);
      if (repo) {
        instruction = repo.instruction;
        if (opts.dryRun) {
          reportRepoFiles(repo.digest);
          await emitPrompt(registry, opts.module, instruction, base);
          return;
        }
        reportRepoSummary(repo.digest, true);
      }
      if (opts.module !== DEFAULT_MODULE) {
        await genericGenerate(registry.require(opts.module), instruction, { base, provider: opts.provider, model: opts.model, effort: opts.effort, retries: opts.retries, json: opts.json, out: opts.out });
        return;
      }
      const result = await generateDocument({
        instruction,
        base,
        provider: opts.provider,
        model: opts.model,
        effort: opts.effort,
        direction: opts.direction,
        distribution: opts.distribution,
        density: opts.density,
        maxRetries: opts.retries,
        onProgress: info,
      });
      const { document } = result;
      info(
        `Modelo generado con ${result.model} (${result.provider}) en ${result.attempts} intento(s): ${document.model.elements.length} elementos, ` +
          `${document.model.relationships.length} relaciones, ${document.views.length} vistas ` +
          `(${result.usage.inputTokens} tokens de entrada, ${result.usage.outputTokens} de salida).`,
      );
      if (opts.json) {
        writeOutput(opts.json, jsonOut(document));
        info(`JSON escrito en ${opts.json}`);
      }
      if (opts.out) {
        writeOutput(opts.out, toDrawio(document, { locale: opts.locale, notation: opts.notation }));
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
    .option('--spacing <px>', 'separación entre nodos', parseSpacing)
    .option('--layer-spacing <px>', 'separación entre capas', parseLayerSpacing)
    .option('--force', 'recalcular aunque ya haya coordenadas', false)
    .option('--density <auto|compact|spacious>', 'densidad del autolayout', parseDensity)
    .option('--distribution <auto|centered|elk>', 'distribución: centrada y uniforme, colocación de ELK o automática', parseDistribution)
    .option('--fast', 'una sola pasada de ELK (sin probar estrategias ni medir calidad)', false)
    .option('--view <id>', 'solo esta vista')
    .action(async (file: string | undefined, opts) => {
      const doc = readDocument(file, opts.stdin);
      const layoutOpts = {
        direction: opts.direction,
        distribution: opts.distribution,
        spacing: opts.spacing,
        layerSpacing: opts.layerSpacing,
        density: opts.density,
        force: opts.force,
        fast: opts.fast,
      };
      let result;
      if (opts.view) {
        const laid = await layoutView(doc, opts.view, layoutOpts);
        result = { ...doc, views: doc.views.map((v) => (v.id === opts.view ? applyLayoutToView(v, laid) : v)) };
        reportQuality([{ viewId: opts.view, quality: laid.quality, direction: laid.direction, distribution: laid.distribution }]);
      } else {
        const laid = await autoLayoutDocumentWithQuality(doc, layoutOpts);
        result = laid.document;
        reportQuality(laid.qualities);
      }
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
    .option('--density <auto|compact|spacious>', 'densidad del autolayout', parseDensity)
    .option('--distribution <auto|centered|elk>', 'distribución del autolayout', parseDistribution)
    .option('--fast', 'una sola pasada de ELK al aplicar autolayout', false)
    .option('--notation <c4|card>', 'notación de las figuras: librería C4 de draw.io o tarjetas', parseNotation, 'c4')
    .option('--no-waypoints', 'no incluir los quiebres de ruta del autolayout')
    .option('--view <id...>', 'solo estas vistas')
    .option('--to <formato>', 'formato de salida: drawio|mermaid (c4); con otro módulo, cualquiera de sus exportadores (ver `iark modules`)')
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', DEFAULT_MODULE)
    .option('--mermaid-format <formato>', 'con --to mermaid: c4|flowchart (módulo c4) o auto|flowchart|sequence (integración)')
    .action(async (file: string | undefined, opts) => {
      if (opts.module !== DEFAULT_MODULE) {
        const module = registry.require(opts.module);
        await genericExport(module, readModuleDocument(module, file, opts.stdin), opts.to, opts.out, opts.view?.[0], { format: opts.mermaidFormat });
        return;
      }
      const target = parseTarget(opts.to ?? 'drawio');
      const doc = readDocument(file, opts.stdin);
      if (target === 'mermaid') {
        writeOutput(opts.out, toMermaid(doc, { viewId: opts.view?.[0], format: parseMermaidFormat(opts.mermaidFormat ?? 'c4') }));
        if (opts.out) info(`Diagrama Mermaid escrito en ${opts.out}`);
        return;
      }
      const laid = await autoLayoutDocumentWithQuality(doc, {
        direction: opts.direction,
        distribution: opts.distribution,
        density: opts.density,
        force: opts.forceLayout,
        fast: opts.fast,
      });
      if (opts.forceLayout || doc.views.some((v) => v.elements.some((e) => e.x === undefined))) reportQuality(laid.qualities);
      const xml = toDrawio(laid.document, { locale: opts.locale, viewIds: opts.view, notation: opts.notation, waypoints: opts.waypoints });
      writeOutput(opts.out, xml);
      if (opts.out) info(`Diagrama .drawio escrito en ${opts.out} (${laid.document.views.length} página(s), notación ${opts.notation})`);
    });

  program
    .command('import')
    .description('Importa un diagrama o un modelo de otro formato y lo convierte en un documento JSON del módulo. En C4: draw.io (.drawio), DSL de Structurizr (.dsl) o Mermaid (.mmd); los demás módulos aceptan además sus propios formatos (ver `iark modules`)')
    .argument('[archivo]', 'archivo de entrada: .drawio, .dsl, .mmd o el de un formato del módulo (o "-" para stdin)')
    .option('--stdin', 'leer el archivo de la entrada estándar')
    .option('--format <formato>', 'formato de entrada: auto o el id de un importador del módulo (en C4: drawio, dsl, mermaid; los demás, en `iark modules`). auto lo deduce de la extensión o del contenido', 'auto')
    .option('--module <id>', 'módulo de la suite que importa el documento (ver `iark modules`)', DEFAULT_MODULE)
    .option('-o, --out <archivo.json>', 'archivo de salida (por defecto stdout)')
    .option('--name <nombre>', 'nombre del diagrama (por defecto, el del workspace del DSL o el nombre del archivo)')
    .option('--layout', 'aplica autolayout (ELK) a las vistas sin coordenadas (un DSL o Mermaid no las tienen)', false)
    .action(async (file: string | undefined, opts) => {
      const raw = readInput(file, opts.stdin);
      const fromFile = !opts.stdin && file !== undefined && file !== '-';
      const imported = await importSource(registry, opts.module, { file, raw, format: opts.format, name: opts.name, fromFile });
      let { document } = imported;
      for (const warning of imported.warnings) info(`aviso: ${warning}`);

      const generic = opts.module !== DEFAULT_MODULE;
      if (opts.layout && !generic) {
        const laid = await autoLayoutDocumentWithQuality(document, {});
        document = laid.document;
        reportQuality(laid.qualities);
      }
      const warned = imported.warnings.length > 0 ? `, ${imported.warnings.length} aviso(s)` : '';
      if (generic) {
        // Los módulos que no son C4 derivan sus vistas del modelo (no guardan coordenadas): --layout no aplica.
        if (opts.layout) info('aviso: --layout solo se aplica al módulo c4; las vistas de este módulo se colocan al exportar.');
        const entities = registry.require(opts.module).entities?.(document).length;
        info(`Importado "${document.workspace?.name ?? opts.name ?? 'sin nombre'}" en el módulo ${opts.module}${entities === undefined ? '' : `: ${entities} elementos`}${warned}.`);
      } else {
        info(
          `Importado "${document.workspace.name}": ${document.model.elements.length} elementos, ${document.model.relationships.length} relaciones, ` +
            `${document.views.length} vistas${warned}.`,
        );
      }
      writeOutput(opts.out, jsonOut(document));
      if (opts.out) info(`Documento ${generic ? `del módulo ${opts.module}` : 'C4'} escrito en ${opts.out}`);
    });

  program
    .command('validate')
    .description('Valida un documento C4 y muestra avisos de calidad del modelo')
    .argument('[archivo.json]', 'documento de entrada (o "-" para stdin)')
    .option('--stdin', 'leer el documento de la entrada estándar')
    .option('--strict', 'fallar también con avisos (warnings)', false)
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', DEFAULT_MODULE)
    .action((file: string | undefined, opts) => {
      if (opts.module !== DEFAULT_MODULE) return genericValidate(registry.require(opts.module), file, opts);
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
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', DEFAULT_MODULE)
    .action((opts) => {
      if (opts.module !== DEFAULT_MODULE) return genericSchema(registry.require(opts.module), opts.generation);
      process.stdout.write(jsonOut(opts.generation ? generationJsonSchema() : documentJsonSchema()));
    });

  program
    .command('prompt')
    .description('Imprime un prompt autocontenido para generar el modelo con cualquier IA/agente (sin clave de API)')
    .argument('<instrucción>', 'descripción del sistema o instrucción de refinamiento')
    .option('-f, --from <archivo>', 'documento existente a refinar: JSON, .drawio, .dsl (Structurizr) o .mmd (Mermaid)')
    .option('--module <id>', 'módulo de la suite (ver `iark modules`)', DEFAULT_MODULE)
    .option('--from-repo <carpeta|url>', FROM_REPO_PROMPT_HELP)
    .option('--repo-ref <rama|etiqueta>', REPO_REF_HELP, parseRepoRef)
    .option('--repo-budget <kb>', REPO_BUDGET_HELP, parseRepoBudget)
    .addHelpText('after', REPO_PROMPT_HELP)
    .action(async (instruction: string, opts) => {
      assertRepoFlags(opts);
      const base = opts.from ? await readBaseDocument(registry, opts.from, opts.module) : undefined;
      const repo = await prepareRepo(instruction, opts, opts.module);
      if (repo) reportRepoSummary(repo.digest);
      await emitPrompt(registry, opts.module, repo ? repo.instruction : instruction, base);
    });

  program
    .command('example')
    .description('Imprime el documento de ejemplo (banca en línea) para probar los demás comandos')
    .action(() => {
      process.stdout.write(jsonOut(sampleDocument));
    });

  program
    .command('modules')
    .description('Lista los módulos (especialidades) de la suite instalados; con --json, su manifiesto de federación')
    .option('--json', 'imprime el manifiesto (`iark.manifest/1`) en JSON', false)
    .action((opts) => {
      if (opts.json) {
        process.stdout.write(jsonOut(buildManifest(registry, { name: 'IArk - DIAgrams', version: CLI_VERSION })));
        return;
      }
      for (const m of registry.list()) {
        process.stdout.write(`${m.id}  ${m.name}  v${m.version}\n`);
        process.stdout.write(`    importa: ${m.importers.map((i) => i.id).join(', ') || '-'}  ·  exporta: ${m.exporters.map((e) => e.id).join(', ') || '-'}\n`);
      }
    });

  program
    .command('serve')
    .description('Servicio HTTP de la suite: API por módulo (validar, vistas, exportar, importar, informes), manifiesto de federación /.well-known/iark.json y, con --static, el sitio')
    .option('-p, --port <n>', 'puerto (0 elige uno libre)', parsePort, 8787)
    .option('--host <host>', 'dirección en la que escucha (en un contenedor, 0.0.0.0)', '127.0.0.1')
    .option('--static <carpeta>', 'sirve también el sitio compilado (p. ej. dist/app), con el editor, el banco de trabajo y el shell', process.env.IARK_STATIC)
    .option('--cors <orígenes>', 'orígenes autorizados a llamar a la API desde un navegador, separados por comas, o * (por defecto, ninguno)')
    .action(async (opts) => {
      if (opts.static && !existsSync(opts.static)) throw new CliError(`La carpeta del sitio «${opts.static}» no existe (¿falta \`npm run build\`?).`);
      const cors = typeof opts.cors === 'string' ? opts.cors.split(',').map((o: string) => o.trim()).filter(Boolean) : [];
      const server = createSuiteServer({ registry, version: CLI_VERSION, staticDir: opts.static, cors });
      await new Promise<void>((resolveListening, rejectListening) => {
        server.once('error', rejectListening);
        server.listen(opts.port, opts.host, resolveListening);
      });
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      info(`IArk - DIAgrams escuchando en http://${opts.host.includes(':') ? `[${opts.host}]` : opts.host}:${port}${opts.static ? ` (sitio: ${opts.static})` : ' (solo API)'}`);
      info(`  manifiesto: /.well-known/iark.json · módulos: /api/modules`);
      await new Promise<void>((resolveClosed) => {
        const stop = (): void => void server.close(() => resolveClosed());
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  registerTrace(program, registry);
  registerDiff(program, registry, importSource);
  registerModuleCommands(program, registry);

  return program;
}

/** Cada módulo con `cliCommands` cuelga sus subcomandos de `iark <módulo> …`: instalar un módulo extiende el CLI. */
function registerModuleCommands(program: Command, registry: ModuleRegistry): void {
  for (const module of registry.list()) {
    if (!module.cliCommands?.length) continue;
    const group = program.command(module.id).description(`${module.name}: comandos del módulo`);
    for (const spec of module.cliCommands) {
      const cmd = group.command(spec.name).description(spec.description);
      for (const arg of spec.args ?? []) cmd.argument(arg.required ? `<${arg.name}>` : `[${arg.name}]`, arg.description);
      for (const opt of spec.options ?? []) cmd.option(opt.flags, opt.description, opt.default as string | boolean | undefined);
      if (spec.input) {
        cmd.argument('[archivo]', `${spec.input.description} (o "-" para stdin)`);
        cmd.option('--stdin', 'leer la entrada estándar', false);
        cmd.option('-o, --out <archivo>', 'archivo de salida (por defecto stdout)');
      }
      cmd.action(async (...actionArgs: unknown[]) => {
        const command = actionArgs[actionArgs.length - 1] as Command;
        const options = command.opts();
        const declared = (spec.args ?? []).length;
        const args = actionArgs.slice(0, declared).map((a) => String(a ?? ''));
        const input = spec.input ? readInput(actionArgs[declared] as string | undefined, Boolean(options.stdin)) : undefined;
        const out = await spec.run({ args, options, input, warn: (message) => void process.stderr.write(message.endsWith('\n') ? message : `${message}\n`) });
        if (out) writeOutput(spec.input ? (options.out as string | undefined) : undefined, out.endsWith('\n') ? out : `${out}\n`);
      });
    }
  }
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
    if (error instanceof ModuleError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof UnknownModuleError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof DocumentValidationError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof DrawioImportError) {
      process.stderr.write(`No se pudo importar el .drawio: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof DslImportError) {
      process.stderr.write(`No se pudo importar el DSL: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof MermaidImportError) {
      process.stderr.write(`No se pudo importar el diagrama de Mermaid: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof MermaidExportError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 3;
      return;
    }
    if (error instanceof GenerationError) {
      process.stderr.write(`Error generando el modelo: ${error.message}\n`);
      process.exitCode = 4;
      return;
    }
    if (error instanceof DrawioExportError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 3;
      return;
    }
    if (error && typeof error === 'object' && 'code' in error && String((error as { code: string }).code).startsWith('commander.')) {
      const code = (error as { exitCode?: number }).exitCode ?? 1;
      process.exitCode = code;
      return;
    }
    // Cualquier otro error (p. ej. "la vista X no existe"): mensaje de una línea, nunca el stack crudo.
    process.stderr.write(`Error inesperado: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
