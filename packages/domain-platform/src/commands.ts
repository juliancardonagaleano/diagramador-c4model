import type { CommandSpec } from '@iark/kernel';
import { dependencyGraph, reach, scopeEnvironment, type Reach, type ReachStep } from './graph';
import { fromIntegrationJson } from './import/fromIntegration';
import { PlatformImportError } from './import/fromMermaid';
import { formatPlatformIssues, validatePlatformDocument } from './schema';
import { CRITICALITY_LABELS, RESOURCE_LABELS, SERVICE_LABELS, indexElements, serviceKindOf, type Element, type PlatformDocument, type Resource, type Service } from './types';

function parseJson(text: string | undefined, what: string): unknown {
  if (!text) throw new PlatformImportError(`Falta la entrada: indica un archivo JSON o usa --stdin (${what}).`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PlatformImportError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
}

function readPlatform(text: string | undefined): PlatformDocument {
  const result = validatePlatformDocument(parseJson(text, 'documento de plataforma'));
  if (!result.ok) throw new PlatformImportError(`Documento de plataforma inválido:\n${formatPlatformIssues(result.issues)}`);
  return result.document;
}

const cell = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const REACH_OPTIONS: Record<string, Reach> = { dependents: 'dependents', dependencies: 'dependencies', both: 'both' };

const typeLabel = (e: Element): string => {
  if (e.kind === 'resource') return RESOURCE_LABELS[(e.item as Resource).kind];
  if (e.kind === 'service') return SERVICE_LABELS[serviceKindOf(e.item as Service)];
  return e.kind;
};
const ownerOf = (e: Element): string | undefined => (e.kind === 'service' || e.kind === 'resource' ? (e.item as Service | Resource).owner : undefined);

export const platformCommands: CommandSpec[] = [
  {
    name: 'deployments',
    description: 'Matriz de despliegues (tabla Markdown): dónde corre cada servicio en cada entorno (anfitrión, réplicas, versión), los que no se despliegan en ningún sitio y las diferencias de versión entre entornos',
    input: { description: 'documento de plataforma en JSON' },
    run: ({ input }) => {
      const doc = readPlatform(input);
      const hosts = new Map(doc.resources.map((r) => [r.id, r.name]));
      const services = doc.services.filter((s) => !s.external);
      if (services.length === 0) return 'El documento no define servicios propios.';
      const out = [`| Servicio | Criticidad | ${doc.environments.map((e) => cell(e.name)).join(' | ')} |`, `|---|---|${doc.environments.map(() => '---').join('|')}|`];
      const unplaced: string[] = [];
      const drift: string[] = [];
      for (const s of services) {
        const mine = doc.deployments.filter((d) => d.serviceId === s.id);
        if (mine.length === 0) unplaced.push(s.name);
        const cells = doc.environments.map((e) => {
          const here = mine.filter((d) => d.environmentId === e.id);
          return here.length === 0 ? '—' : cell(here.map((d) => [hosts.get(d.hostId), d.replicas ? `×${d.replicas}` : '', d.version ? `v${d.version}` : ''].filter(Boolean).join(' ')).join('; '));
        });
        out.push(`| ${cell(s.name)} | ${s.criticality ? CRITICALITY_LABELS[s.criticality] : '—'} | ${cells.join(' | ')} |`);
        const versions = new Map<string, string[]>();
        for (const d of mine.filter((x) => x.version)) versions.set(d.version!, [...(versions.get(d.version!) ?? []), doc.environments.find((e) => e.id === d.environmentId)?.name ?? d.environmentId]);
        if (versions.size > 1) drift.push(`${s.name} (${[...versions].map(([v, envs]) => `${envs.join(', ')}: v${v}`).join('; ')})`);
      }
      out.push('');
      out.push(unplaced.length > 0 ? `Sin despliegue en ningún entorno: ${unplaced.join(', ')}` : 'Todos los servicios se despliegan en algún entorno.');
      if (drift.length > 0) out.push(`Versiones distintas entre entornos: ${drift.join(' · ')}`);
      return out.join('\n');
    },
  },
  {
    name: 'impact',
    description: 'Impacto de un servicio o recurso: qué depende de él (afectado si cae o cambia) y/o de qué depende, con los responsables a avisar',
    input: { description: 'documento de plataforma en JSON' },
    args: [{ name: 'elemento', description: 'id de un servicio o un recurso', required: true }],
    options: [
      { flags: '--direction <sentido>', description: 'dependents (lo que depende de él) | dependencies (de lo que depende) | both', default: 'dependents' },
      { flags: '--env <entorno>', description: 'entorno al que acotar el análisis (por defecto, el del recurso o el único donde corre el servicio)' },
    ],
    run: ({ args, options, input }) => {
      const doc = readPlatform(input);
      const direction = REACH_OPTIONS[String(options.direction ?? 'dependents')];
      if (!direction) throw new PlatformImportError(`Sentido inválido «${String(options.direction)}». Use: ${Object.keys(REACH_OPTIONS).join(', ')}.`);
      const elements = indexElements(doc);
      const start = elements.get(args[0]);
      if (!start || (start.kind !== 'service' && start.kind !== 'resource')) {
        const known = [...elements.values()].filter((e) => e.kind === 'service' || e.kind === 'resource').map((e) => e.id);
        throw new PlatformImportError(`No existe el servicio ni el recurso «${args[0]}». Elementos: ${known.join(', ')}.`);
      }
      const environments = new Map(doc.environments.map((e) => [e.id, e.name]));
      const requested = options.env === undefined ? undefined : String(options.env);
      if (requested !== undefined && !environments.has(requested)) throw new PlatformImportError(`No existe el entorno «${requested}». Entornos: ${[...environments.keys()].join(', ')}.`);
      const scope = requested ?? scopeEnvironment(doc, start);
      const graph = dependencyGraph(doc, scope);
      // Árbol: cada elemento cuelga del primero desde el que se llegó a él.
      const section = (title: string, steps: ReachStep[]): string[] => {
        const lines: string[] = [];
        const print = (parent: string, depth: number): void => {
          for (const s of steps.filter((x) => x.via === parent)) {
            const e = elements.get(s.id)!;
            const criticality = e.kind === 'service' && (e.item as Service).criticality ? ` · criticidad ${CRITICALITY_LABELS[(e.item as Service).criticality!]}` : '';
            lines.push(`${'  '.repeat(depth)}- ${e.name} (${typeLabel(e)})${ownerOf(e) ? ` · ${ownerOf(e)}` : ''}${criticality}`);
            print(s.id, depth + 1);
          }
        };
        print(start.id, 0);
        return [`${title}: ${steps.length === 0 ? 'ninguno' : `${steps.length} elemento(s)`}`, ...lines];
      };
      const out = [`Impacto de «${start.name}» (${typeLabel(start)})${scope ? ` en el entorno «${environments.get(scope)}»` : ''}`, ''];
      let notify: string[] = [];
      if (direction !== 'dependencies') {
        const dependents = reach(graph, start.id, 'dependents');
        out.push(...section('Dependen de él (se ven afectados si cae o cambia)', dependents), '');
        notify = [start, ...dependents.map((s) => elements.get(s.id)!)].map((e) => ownerOf(e) ?? '').filter(Boolean);
      }
      if (direction !== 'dependents') out.push(...section('Depende de (lo que necesita para funcionar)', reach(graph, start.id, 'dependencies')), '');
      if (direction !== 'dependencies') out.push(`Responsables a avisar: ${[...new Set(notify)].join(', ') || 'ninguno declarado'}`);
      return out.join('\n').trimEnd();
    },
  },
  {
    name: 'from-integration',
    description: 'Crea el inventario de la plataforma a partir de un mapa de integración: sistemas → servicios, almacenes/brokers/pasarelas → recursos y sus interacciones → dependencias, con referencia urn:iark:integration:<id>',
    input: { description: 'documento de integración en JSON' },
    options: [{ flags: '--name <nombre>', description: 'nombre del documento de plataforma' }],
    run: ({ input, options }) => {
      const { document, warnings } = fromIntegrationJson(parseJson(input, 'documento de integración'), { name: options.name as string | undefined });
      for (const w of warnings) process.stderr.write(`aviso: ${w}\n`);
      process.stderr.write(`Convertido "${document.workspace.name}": ${document.services.length} servicios, ${document.resources.length} recursos.\n`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
];
