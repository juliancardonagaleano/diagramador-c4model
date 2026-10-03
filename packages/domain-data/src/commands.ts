import type { CommandSpec } from '@iark/kernel';
import { toDdl, DEFAULT_ENGINE } from './ddl';
import { TYPE_CONCEPTS, listEngines, resolveEngine } from './engines';
import { DataImportError } from './import/fromMermaid';
import { fromIntegrationJson } from './import/fromIntegration';
import { inheritance } from './inherit';
import { columnImpact, parseColumnRef, traceLineage, type ColumnStep, type LineageDirection, type LineageStep } from './lineage';
import { formatDataIssues, validateDataDocument } from './schema';
import { API_PROTOCOL_LABELS, CLASSIFICATION_LABELS, KIND_LABELS, TERM_STATUS_LABELS, hasPii, type DataDocument } from './types';

function parseJson(text: string | undefined, what: string): unknown {
  if (!text) throw new DataImportError(`Falta la entrada: indica un archivo JSON o usa --stdin (${what}).`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DataImportError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
}

function readData(text: string | undefined): DataDocument {
  const result = validateDataDocument(parseJson(text, 'documento de datos'));
  if (!result.ok) throw new DataImportError(`Documento de datos inválido:\n${formatDataIssues(result.issues)}`);
  return result.document;
}

const cell = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const DIRECTIONS: LineageDirection[] = ['both', 'upstream', 'downstream'];

export const dataCommands: CommandSpec[] = [
  {
    name: 'lineage',
    description: 'Linaje de un activo: de dónde vienen sus datos (aguas arriba) y qué se ve afectado si cambia (aguas abajo), con los responsables a avisar',
    input: { description: 'documento de datos en JSON' },
    args: [{ name: 'activo', description: 'id del activo', required: true }],
    options: [{ flags: '--direction <sentido>', description: 'both | upstream | downstream', default: 'both' }],
    run: ({ args, options, input }) => {
      const doc = readData(input);
      const direction = String(options.direction ?? 'both') as LineageDirection;
      if (!DIRECTIONS.includes(direction)) throw new DataImportError(`Sentido inválido «${direction}». Use: ${DIRECTIONS.join(', ')}.`);
      const start = doc.assets.find((a) => a.id === args[0]);
      if (!start) throw new DataImportError(`No existe el activo «${args[0]}». Activos: ${doc.assets.map((a) => a.id).join(', ')}.`);
      const assets = new Map(doc.assets.map((a) => [a.id, a]));
      const pipelines = new Map(doc.pipelines.map((p) => [p.id, p]));
      const { ownerOf } = inheritance(doc);
      const { upstream, downstream } = traceLineage(doc, start.id, direction);

      const section = (title: string, steps: LineageStep[]): string[] => [
        `${title}: ${steps.length === 0 ? 'ninguno' : `${steps.length} activo(s)`}`,
        ...steps.map((s) => {
          const a = assets.get(s.assetId)!;
          const p = pipelines.get(s.pipelineId)!;
          return `${'  '.repeat(s.depth)}- ${a.name} (${KIND_LABELS[a.kind]}) · pipeline «${p.name}» [${p.kind}]`;
        }),
      ];
      const out = [`Linaje de «${start.name}» (${KIND_LABELS[start.kind]})`, ''];
      if (direction !== 'downstream') out.push(...section('Aguas arriba (de dónde vienen sus datos)', upstream), '');
      if (direction !== 'upstream') {
        out.push(...section('Aguas abajo (se ve afectado si cambia)', downstream), '');
        const owners = [...new Set([start.id, ...downstream.map((s) => s.assetId)].map((id) => ownerOf(id)).filter(Boolean))];
        out.push(`Responsables a avisar: ${owners.length > 0 ? owners.join(', ') : 'ninguno declarado'}`);
      }
      return out.join('\n').trimEnd();
    },
  },
  {
    name: 'column-impact',
    description: 'Impacto de una columna: de qué columnas sale (aguas arriba) y qué columnas, activos, informes y modelos dependen de ella (aguas abajo), según los mapeos de los pipelines',
    input: { description: 'documento de datos en JSON' },
    args: [{ name: 'columna', description: 'activo.columna (id del activo, punto y nombre de la columna)', required: true }],
    run: ({ args, input }) => {
      const doc = readData(input);
      const ref = parseColumnRef(args[0], doc.assets.map((a) => a.id));
      if (!ref) throw new DataImportError(`«${args[0]}» no es un activo y una columna: usa «<activo>.<columna>». Activos: ${doc.assets.map((a) => a.id).join(', ')}.`);
      const assets = new Map(doc.assets.map((a) => [a.id, a]));
      const pipelines = new Map(doc.pipelines.map((p) => [p.id, p]));
      const { ownerOf } = inheritance(doc);
      const { upstream, downstream, assetIds, consumerIds } = columnImpact(doc, ref);
      const section = (title: string, steps: ColumnStep[]): string[] => [
        `${title}: ${steps.length === 0 ? 'ninguna' : `${steps.length} columna(s)`}`,
        ...steps.map((s) => `${'  '.repeat(s.depth)}- ${assets.get(s.assetId)?.name ?? s.assetId}.${s.column} · pipeline «${pipelines.get(s.pipelineId)?.name ?? s.pipelineId}»${s.transform ? ` · ${s.transform}` : ''}`),
      ];
      const out = [`Impacto de la columna ${assets.get(ref.assetId)!.name}.${ref.column}`, '', ...section('Aguas arriba (de qué columnas sale)', upstream), '', ...section('Aguas abajo (se ve afectada si cambia)', downstream), ''];
      out.push(`Informes y modelos afectados: ${consumerIds.length > 0 ? consumerIds.map((id) => assets.get(id)!.name).join(', ') : 'ninguno'}`);
      const owners = [...new Set(assetIds.map((id) => ownerOf(id)).filter(Boolean))];
      out.push(`Responsables a avisar: ${owners.length > 0 ? owners.join(', ') : 'ninguno declarado'}`);
      return out.join('\n').trimEnd();
    },
  },
  {
    name: 'catalog',
    description: 'Catálogo de activos (tabla Markdown): tipo, contenedor, dominio, responsable, clasificación, datos personales y pipelines que lo escriben',
    input: { description: 'documento de datos en JSON' },
    run: ({ input }) => {
      const doc = readData(input);
      const assets = new Map(doc.assets.map((a) => [a.id, a]));
      const domains = new Map(doc.domains.map((d) => [d.id, d.name]));
      const { ownerOf, domainOf } = inheritance(doc);
      const rows = doc.assets.map((a) => {
        const producers = doc.pipelines.filter((p) => p.outputs.includes(a.id)).map((p) => p.name);
        return (
          `| ${cell(a.name)} | ${KIND_LABELS[a.kind]} | ${cell(assets.get(a.parentId ?? '')?.name) || '—'} | ${cell(domains.get(domainOf(a.id) ?? '')) || '—'} | ` +
          `${cell(ownerOf(a.id)) || '—'} | ${a.classification ? CLASSIFICATION_LABELS[a.classification] : '—'} | ${hasPii(a) ? 'Sí' : 'No'} | ${cell(producers.join('; ')) || '—'} |`
        );
      });
      return ['| Activo | Tipo | Contenedor | Dominio | Responsable | Clasificación | Datos personales | Lo escriben |', '|---|---|---|---|---|---|---|---|', ...rows].join('\n');
    },
  },
  {
    name: 'pii',
    description: 'Informe de datos personales (Markdown): qué activos los contienen y adónde llegan por el linaje sin anonimizarse',
    input: { description: 'documento de datos en JSON' },
    run: ({ input }) => {
      const doc = readData(input);
      const withPii = doc.assets.filter(hasPii);
      if (withPii.length === 0) return 'No hay activos con datos personales.';
      const { ownerOf } = inheritance(doc);
      const names = new Map(doc.assets.map((a) => [a.id, a.name]));
      const out = ['| Activo | Tipo | Clasificación | Retención | Responsable | Columnas con PII |', '|---|---|---|---|---|---|'];
      for (const a of withPii) {
        const columns = (a.columns ?? []).filter((c) => c.pii).map((c) => c.name);
        out.push(
          `| ${cell(a.name)} | ${KIND_LABELS[a.kind]} | ${a.classification ? CLASSIFICATION_LABELS[a.classification] : '—'} | ${cell(a.retention) || '—'} | ${cell(ownerOf(a.id)) || '—'} | ${cell(columns.join(', ')) || '—'} |`,
        );
      }
      const spread = withPii.map((a) => ({ a, reach: traceLineage(doc, a.id, 'downstream', { stopAtAnonymizing: true }).downstream })).filter((x) => x.reach.length > 0);
      out.push('', '**Adónde llegan sin anonimizarse (linaje aguas abajo)**', '');
      if (spread.length === 0) out.push('En ningún sitio: todos los pipelines que los leen anonimizan o no hay pipelines.');
      for (const { a, reach } of spread) out.push(`- ${a.name} → ${reach.map((s) => names.get(s.assetId)).join(', ')}`);
      return out.join('\n');
    },
  },
  {
    name: 'products',
    description: 'Productos y APIs de datos (tablas Markdown): dominio, dueño, frescura, SLA, puertos de entrada y salida, activos que sirve cada API, protocolo y contrato',
    input: { description: 'documento de datos en JSON' },
    run: ({ input }) => {
      const doc = readData(input);
      const assets = new Map(doc.assets.map((a) => [a.id, a]));
      const domains = new Map(doc.domains.map((d) => [d.id, d.name]));
      const contracts = new Map((doc.contracts ?? []).map((c) => [c.id, c.name]));
      const { ownerOf, domainOf } = inheritance(doc);
      const names = (ids: string[] | undefined): string => cell((ids ?? []).map((id) => assets.get(id)?.name ?? id).join('; ')) || '—';
      const products = doc.assets.filter((a) => a.kind === 'data-product');
      const apis = doc.assets.filter((a) => a.kind === 'data-api');
      if (products.length === 0 && apis.length === 0) return 'No hay productos ni APIs de datos.';
      const out: string[] = [];
      if (products.length > 0) {
        out.push('**Productos de datos**', '', '| Producto | Dominio | Dueño | Frescura | SLA | Entradas | Salidas | APIs | Contrato |', '|---|---|---|---|---|---|---|---|---|');
        for (const p of products) {
          const served = apis.filter((api) => (api.exposes ?? []).some((id) => id === p.id || (p.outputPorts ?? []).includes(id))).map((api) => api.id);
          out.push(
            `| ${cell(p.name)} | ${cell(domains.get(domainOf(p.id) ?? '')) || '—'} | ${cell(ownerOf(p.id)) || '—'} | ${cell(p.freshness) || '—'} | ${cell(p.sla) || '—'} | ${names(p.inputPorts)} | ${names(p.outputPorts)} | ${names(served)} | ${cell(contracts.get(p.contractId ?? '')) || '—'} |`,
          );
        }
      }
      if (apis.length > 0) {
        if (out.length > 0) out.push('');
        out.push('**APIs de datos**', '', '| API | Protocolo | Dirección | Dueño | Expone | Contrato |', '|---|---|---|---|---|---|');
        for (const a of apis) {
          out.push(`| ${cell(a.name)} | ${a.protocol ? API_PROTOCOL_LABELS[a.protocol] : '—'} | ${cell(a.endpoint) || '—'} | ${cell(ownerOf(a.id)) || '—'} | ${names(a.exposes)} | ${cell(contracts.get(a.contractId ?? '')) || '—'} |`);
        }
      }
      return out.join('\n');
    },
  },
  {
    name: 'glossary',
    description: 'Glosario de negocio (tabla Markdown): cada término con su definición, estado, responsable y los activos y columnas en los que se materializa',
    input: { description: 'documento de datos en JSON' },
    run: ({ input }) => {
      const doc = readData(input);
      const terms = doc.terms ?? [];
      if (terms.length === 0) return 'No hay términos en el glosario.';
      const assets = new Map(doc.assets.map((a) => [a.id, a]));
      const rows = terms.map((t) => {
        const links = (t.links ?? []).map((l) => `${assets.get(l.assetId)?.name ?? l.assetId}${l.column ? `.${l.column}` : ''}`);
        return `| ${cell(t.name)} | ${cell(assets.get(t.glossaryId ?? '')?.name) || '—'} | ${cell(t.definition) || '—'} | ${TERM_STATUS_LABELS[t.status ?? 'draft']} | ${cell(t.owner) || '—'} | ${cell(links.join('; ')) || '—'} |`;
      });
      return ['| Término | Glosario | Definición | Estado | Responsable | Enlazado a |', '|---|---|---|---|---|---|', ...rows].join('\n');
    },
  },
  {
    name: 'ddl',
    description:
      'Esquema físico de las tablas en el dialecto de su motor de base de datos (engine): CREATE TABLE de PostgreSQL, MySQL, SQL Server, Oracle, SQLite, BigQuery, Snowflake, Redshift y Databricks y de CQL (Cassandra), validador $jsonSchema de MongoDB, CreateTable de DynamoDB y esquema Avro de Kafka. Una clave primaria o única de un tipo que el motor no admite como clave (text o json en MySQL, clob en Oracle, varchar(max) en SQL Server, json o xml en PostgreSQL) se deja tal cual, con un comentario -- AVISO: sobre la tabla y el arreglo propuesto, y se suma a los avisos',
    input: { description: 'documento de datos en JSON' },
    options: [
      { flags: '--engine <motor>', description: `fuerza el motor de todas las tablas (por defecto, el de cada una; ${DEFAULT_ENGINE} si no lo declara). Ver «iark data engines»` },
      {
        flags: '--asset <activo>',
        description:
          'solo esta tabla o las de esta base, almacén, lago o fuente; con un producto de datos, las de los activos de sus puertos de entrada y de salida; con una API de datos, las de los activos que expone; con un glosario, las de los activos con términos enlazados (el producto o la API que aparezca entre ellos se sustituye por lo que enlaza)',
      },
      { flags: '--contract <contrato>', description: 'genera el esquema del contrato de datos (su servers[].type fija el motor) en lugar del de las columnas de los activos' },
      { flags: '--schema <nombre>', description: 'esquema (o keyspace, o conjunto de datos) que califica el nombre de las tablas' },
      { flags: '--format <formato>', description: 'script (por defecto) o json (solo el validador de MongoDB)', default: 'script' },
    ],
    run: ({ options, input, warn }) => {
      const doc = readData(input);
      const format = String(options.format ?? 'script');
      if (format !== 'script' && format !== 'json') throw new DataImportError(`Formato inválido «${format}». Use: script, json.`);
      try {
        const { text, warnings } = toDdl(doc, {
          engine: options.engine as string | undefined,
          assetId: options.asset as string | undefined,
          contractId: options.contract as string | undefined,
          schema: options.schema as string | undefined,
          format,
        });
        for (const w of warnings) warn?.(`aviso: ${w}`);
        return text || '-- No hay tablas con columnas de las que generar un esquema.';
      } catch (error) {
        throw new DataImportError((error as Error).message);
      }
    },
  },
  {
    name: 'engines',
    description: 'Motores de base de datos del registro (para `engine`, `servers[].type` de un contrato y `iark data ddl`); con un motor, su catálogo de tipos y el tipo que usa para cada concepto',
    args: [{ name: 'motor', description: 'id del motor (postgresql, mongodb…)' }],
    run: ({ args }) => {
      if (!args[0]) {
        return ['| Motor | Nombre | Familia | Otros nombres | Tipos |', '|---|---|---|---|---|', ...listEngines().map((e) => `| ${e.id} | ${e.label} | ${e.family} | ${(e.aliases ?? []).join(', ') || '—'} | ${e.types.length} |`)].join('\n');
      }
      const engine = resolveEngine(args[0]);
      if (!engine) throw new DataImportError(`Motor desconocido «${args[0]}». Motores: ${listEngines().map((e) => e.id).join(', ')}.`);
      return [
        `${engine.label} (${engine.id}) · ${engine.family}${engine.lenient ? ' · acepta cualquier nombre de tipo' : ''}`,
        '',
        `Tipos: ${engine.types.join(', ')}`,
        '',
        'Tipo que usa para cada concepto:',
        ...TYPE_CONCEPTS.map((c) => `- ${c}: ${engine.concepts[c]}`),
      ].join('\n');
    },
  },
  {
    name: 'from-integration',
    kind: 'convert',
    description: 'Crea el inventario de datos a partir de un mapa de integración: almacenes → bases de datos y colas/tópicos → streams, con referencia urn:iark:integration:<id>',
    input: { description: 'documento de integración en JSON' },
    options: [{ flags: '--name <nombre>', description: 'nombre del documento de datos' }],
    run: ({ input, options, warn }) => {
      const { document, warnings } = fromIntegrationJson(parseJson(input, 'documento de integración'), { name: options.name as string | undefined });
      for (const w of warnings) warn?.(`aviso: ${w}`);
      warn?.(`Convertido "${document.workspace.name}": ${document.assets.length} activos.`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
];
