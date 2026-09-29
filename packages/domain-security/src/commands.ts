import type { CommandSpec } from '@iark/kernel';
import { attackPaths, entryPoints } from './graph';
import { fromIntegrationJson } from './import/fromIntegration';
import { SecurityImportError } from './import/fromMermaid';
import { fromPlatformJson } from './import/fromPlatform';
import { applicableCategories } from './issues';
import { formatSecurityIssues, validateSecurityDocument } from './schema';
import {
  ASSET_LABELS,
  AUTHENTICATION_LABELS,
  DATA_LABELS,
  RATING_LABELS,
  STATUS_LABELS,
  STRIDE,
  STRIDE_LABELS,
  THREAT_STATUSES,
  TRUST_LABELS,
  controlStatusOf,
  indexElements,
  riskOf,
  sensitive,
  statusOf,
  trustOf,
  type Asset,
  type Element,
  type SecurityDocument,
  type Stride,
  type ThreatStatus,
} from './types';

function parseJson(text: string | undefined, what: string): unknown {
  if (!text) throw new SecurityImportError(`Falta la entrada: indica un archivo JSON o usa --stdin (${what}).`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SecurityImportError(`La entrada no es JSON válido: ${(error as Error).message}`);
  }
}

function readSecurity(text: string | undefined): SecurityDocument {
  const result = validateSecurityDocument(parseJson(text, 'documento de seguridad'));
  if (!result.ok) throw new SecurityImportError(`Documento de seguridad inválido:\n${formatSecurityIssues(result.issues)}`);
  return result.document;
}

const cell = (s: string | undefined): string => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const STRIDE_LETTERS: Record<Stride, string> = { spoofing: 'S', tampering: 'T', repudiation: 'R', 'information-disclosure': 'I', 'denial-of-service': 'D', 'elevation-of-privilege': 'E' };

export const securityCommands: CommandSpec[] = [
  {
    name: 'risks',
    description: 'Registro de riesgos (tabla Markdown): las amenazas ordenadas por riesgo (probabilidad × impacto) con su estado y los controles que las mitigan, y el resumen de las abiertas',
    input: { description: 'documento de seguridad en JSON' },
    options: [{ flags: '--status <estado>', description: `solo las amenazas en ese estado (${THREAT_STATUSES.join(' | ')})` }],
    run: ({ options, input }) => {
      const doc = readSecurity(input);
      const status = options.status === undefined ? undefined : String(options.status);
      if (status !== undefined && !THREAT_STATUSES.includes(status as ThreatStatus)) throw new SecurityImportError(`Estado inválido «${status}». Use: ${THREAT_STATUSES.join(', ')}.`);
      if (doc.threats.length === 0) return 'El documento no define amenazas.';
      const elements = indexElements(doc);
      const controls = new Map(doc.controls.map((c) => [c.id, c]));
      const rows = doc.threats
        .map((t, index) => ({ t, risk: riskOf(t), index }))
        .filter(({ t }) => status === undefined || statusOf(t) === status)
        .sort((a, b) => b.risk.score - a.risk.score || a.index - b.index);
      const out = ['| Riesgo | Amenaza | STRIDE | Sobre | Estado | Controles |', '|---|---|---|---|---|---|'];
      for (const { t, risk } of rows) {
        const linked = (t.controlIds ?? []).map((id) => `${controls.get(id)!.name}${controlStatusOf(controls.get(id)!) === 'planned' ? ' (prevista)' : ''}`);
        out.push(`| ${RATING_LABELS[risk.rating]} (${risk.score}) | ${cell(t.title)} | ${STRIDE_LABELS[t.category]} | ${cell(elements.get(t.targetId)!.name)} | ${STATUS_LABELS[statusOf(t)]} | ${cell(linked.join('; ')) || '—'} |`);
      }
      const count = (s: ThreatStatus): number => doc.threats.filter((t) => statusOf(t) === s).length;
      const open = doc.threats.filter((t) => statusOf(t) === 'open');
      const byRating = (r: string): number => open.filter((t) => riskOf(t).rating === r).length;
      out.push('', `Amenazas: ${doc.threats.length} · abiertas: ${count('open')} · mitigadas: ${count('mitigated')} · aceptadas: ${count('accepted')}`);
      out.push(`Abiertas por riesgo: ${byRating('critical')} crítico, ${byRating('high')} alto, ${byRating('medium')} medio, ${byRating('low')} bajo`);
      return out.join('\n');
    },
  },
  {
    name: 'stride',
    description: 'Cobertura STRIDE (tabla Markdown): para cada activo y flujo, qué categorías de amenaza le aplican y cuáles ya están analizadas (con amenazas abiertas o resueltas) o siguen sin analizar',
    input: { description: 'documento de seguridad en JSON' },
    options: [{ flags: '--gaps', description: 'solo los elementos con categorías sin analizar' }],
    run: ({ options, input }) => {
      const doc = readSecurity(input);
      const elements = [...indexElements(doc).values()].filter((e): e is Element => e.kind === 'asset' || e.kind === 'flow');
      if (elements.length === 0) return 'El documento no define activos ni flujos.';
      const out = [`| Elemento | Tipo | ${STRIDE.map((c) => STRIDE_LETTERS[c]).join(' | ')} |`, `|---|---|${STRIDE.map(() => ':-:').join('|')}|`];
      let gaps = 0;
      let analyzed = 0;
      for (const e of elements) {
        const applicable = applicableCategories(e);
        const cells = STRIDE.map((c) => {
          if (!applicable.includes(c)) return '—';
          const threats = doc.threats.filter((t) => t.targetId === e.id && t.category === c);
          if (threats.length === 0) return '○';
          return `${threats.some((t) => statusOf(t) === 'open') ? '●' : '✓'}${threats.length}`;
        });
        const missing = cells.filter((x) => x === '○').length;
        gaps += missing;
        analyzed += cells.filter((x) => x !== '—' && x !== '○').length;
        if (options.gaps && missing === 0) continue;
        out.push(`| ${cell(e.name)} | ${e.kind === 'flow' ? 'Flujo' : ASSET_LABELS[(e.item as Asset).kind]} | ${cells.join(' | ')} |`);
      }
      out.push('', 'S = Suplantación · T = Manipulación · R = Repudio · I = Divulgación de información · D = Denegación de servicio · E = Elevación de privilegios');
      out.push('— no aplica · ○ sin analizar · ●n con n amenaza(s), alguna abierta · ✓n con n amenaza(s), todas mitigadas o aceptadas');
      out.push(`Analizadas: ${analyzed} · Sin analizar: ${gaps}`);
      return out.join('\n');
    },
  },
  {
    name: 'exposure',
    description: 'Superficie de ataque: los flujos que entran desde zonas no confiables y los caminos más cortos desde ellas hasta los activos que interesa proteger (datos sensibles o zona restringida), con las fronteras que cruzan y los tramos sin cifrar o sin autenticar',
    input: { description: 'documento de seguridad en JSON' },
    run: ({ input }) => {
      const doc = readSecurity(input);
      const assets = new Map(doc.assets.map((a) => [a.id, a]));
      const flows = new Map(doc.flows.map((f) => [f.id, f]));
      const name = (id: string): string => assets.get(id)?.name ?? id;
      const describe = (id: string): string => {
        const f = flows.get(id)!;
        const parts = [f.protocol, f.encrypted === true ? 'cifrado' : f.encrypted === false ? 'sin cifrar' : 'cifrado desconocido', f.authentication ? (f.authentication === 'none' ? 'sin autenticación' : `autenticación ${AUTHENTICATION_LABELS[f.authentication]}`) : 'autenticación desconocida'];
        return parts.filter(Boolean).join(' · ');
      };
      const entries = entryPoints(doc);
      const out = [`Superficie de ataque de «${doc.workspace.name}»`, '', `Puntos de entrada desde zonas no confiables: ${entries.length === 0 ? 'ninguno' : entries.length}`];
      for (const c of entries) out.push(`- ${name(c.flow.sourceId)} → ${name(c.flow.targetId)} (${describe(c.flow.id)}); de «${c.from.name}» a la zona ${TRUST_LABELS[trustOf(c.to)]} «${c.to.name}»`);
      const paths = attackPaths(doc);
      out.push('', `Caminos hasta los activos que interesa proteger: ${paths.length === 0 ? 'ninguno' : paths.length}`);
      for (const p of paths) {
        const target = assets.get(p.targetId) as Asset;
        const data = target.classification && sensitive(target.classification) ? `datos ${DATA_LABELS[target.classification]}` : 'zona restringida';
        out.push(`- ${name(p.targetId)} (${data}): ${p.assetIds.map(name).join(' → ')} · ${p.flowIds.length} flujo(s), ${p.boundaries} frontera(s)`);
        const weak = p.flowIds.map((id) => flows.get(id)!).filter((f) => f.encrypted !== true || f.authentication === 'none' || f.authentication === undefined);
        for (const f of weak) {
          const problems = [f.encrypted !== true ? (f.encrypted === false ? 'sin cifrar' : 'cifrado desconocido') : '', f.authentication === 'none' ? 'sin autenticación' : f.authentication === undefined ? 'autenticación desconocida' : ''].filter(Boolean);
          out.push(`    · ${name(f.sourceId)} → ${name(f.targetId)}: ${problems.join(', ')}`);
        }
      }
      return out.join('\n');
    },
  },
  {
    name: 'from-integration',
    description: 'Crea el modelo de seguridad a partir de un mapa de integración: sistemas → procesos o entidades externas, almacenes → almacenes de datos, interacciones → flujos, con zonas propuestas por heurística y referencia urn:iark:integration:<id>',
    input: { description: 'documento de integración en JSON' },
    options: [{ flags: '--name <nombre>', description: 'nombre del documento de seguridad' }],
    run: ({ input, options }) => {
      const { document, warnings } = fromIntegrationJson(parseJson(input, 'documento de integración'), { name: options.name as string | undefined });
      for (const w of warnings) process.stderr.write(`aviso: ${w}\n`);
      process.stderr.write(`Convertido "${document.workspace.name}": ${document.zones.length} zonas, ${document.assets.length} activos, ${document.flows.length} flujos.\n`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
  {
    name: 'from-platform',
    description: 'Crea el modelo de seguridad de un entorno a partir de un documento de plataforma: redes → zonas de confianza (según su exposición), servicios y recursos → activos, dependencias → flujos, con referencia urn:iark:platform:<id>',
    input: { description: 'documento de plataforma en JSON' },
    options: [
      { flags: '--env <entorno>', description: 'entorno a modelar (por defecto, el de producción)' },
      { flags: '--name <nombre>', description: 'nombre del documento de seguridad' },
    ],
    run: ({ input, options }) => {
      const { document, warnings } = fromPlatformJson(parseJson(input, 'documento de plataforma'), { name: options.name as string | undefined, env: options.env as string | undefined });
      for (const w of warnings) process.stderr.write(`aviso: ${w}\n`);
      process.stderr.write(`Convertido "${document.workspace.name}": ${document.zones.length} zonas, ${document.assets.length} activos, ${document.flows.length} flujos.\n`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
];
