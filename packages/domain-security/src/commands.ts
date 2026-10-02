import type { CommandSpec } from '@iark/kernel';
import { HEAT_ROWS, heatContents, heatNote } from './export/render';
import { attackPaths, entryPoints } from './graph';
import { fromIntegrationJson } from './import/fromIntegration';
import { SecurityImportError } from './import/fromMermaid';
import { fromPlatformJson } from './import/fromPlatform';
import { applicableCategories } from './issues';
import { COVERAGE_LABELS, threatCoverage, type Coverage } from './modeling';
import { formatSecurityIssues, validateSecurityDocument } from './schema';
import {
  ASSET_LABELS,
  AUTHENTICATION_LABELS,
  CONTROL_LABELS,
  CONTROL_STANDARDS,
  CONTROL_STATUS_LABELS,
  DATA_LABELS,
  IMPACTS,
  LIKELIHOOD_LABELS,
  RATING_LABELS,
  RISK_RATINGS,
  STANDARD_LABELS,
  STATUS_LABELS,
  STRIDE,
  STRIDE_LABELS,
  THREAT_STATUSES,
  TRUST_LABELS,
  cellRating,
  cellScore,
  controlStatusOf,
  heatCellId,
  indexElements,
  residualOf,
  riskOf,
  sensitive,
  statusOf,
  trustOf,
  type Asset,
  type Control,
  type ControlStandard,
  type Element,
  type RiskRating,
  type SecurityDocument,
  type Stride,
  type Threat,
  type ThreatStatus,
} from './types';
import { findView, standardsInUse, type SecurityView } from './views';

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
/** «alto (6)»: la valoración y la puntuación (probabilidad × impacto) de un riesgo. */
const riskLabel = (r: { rating: RiskRating; score: number }): string => `${RATING_LABELS[r.rating]} (${r.score})`;
/** «1 crítico, 2 alto, 1 medio, 0 bajo»: cuántas valoraciones hay de cada una, de mayor a menor. */
const ratingSummary = (ratings: RiskRating[]): string => [...RISK_RATINGS].reverse().map((r) => `${ratings.filter((x) => x === r).length} ${RATING_LABELS[r]}`).join(', ');
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const controlLabel = (c: Control): string => `${c.name}${controlStatusOf(c) === 'planned' ? ' (prevista)' : ''}`;
/** De mayor a menor riesgo inherente; a igualdad, en el orden del documento. */
const byRisk = (threats: Threat[]): Threat[] => [...threats].sort((a, b) => riskOf(b).score - riskOf(a).score);
const STRIDE_LETTERS: Record<Stride, string> = { spoofing: 'S', tampering: 'T', repudiation: 'R', 'information-disclosure': 'I', 'denial-of-service': 'D', 'elevation-of-privilege': 'E' };

export const securityCommands: CommandSpec[] = [
  {
    name: 'risks',
    description: 'Registro de riesgos (tabla Markdown): las amenazas ordenadas por riesgo inherente (probabilidad × impacto) con su estado, los controles que las mitigan y el riesgo residual que queda tras los controles implementados, y el resumen de las abiertas',
    input: { description: 'documento de seguridad en JSON' },
    options: [{ flags: '--status <estado>', description: `solo las amenazas en ese estado (${THREAT_STATUSES.join(' | ')})` }],
    run: ({ options, input }) => {
      const doc = readSecurity(input);
      const status = options.status === undefined ? undefined : String(options.status);
      if (status !== undefined && !THREAT_STATUSES.includes(status as ThreatStatus)) throw new SecurityImportError(`Estado inválido «${status}». Use: ${THREAT_STATUSES.join(', ')}.`);
      if (doc.threats.length === 0) return 'El documento no define amenazas.';
      const elements = indexElements(doc);
      const controls = new Map(doc.controls.map((c) => [c.id, c]));
      const out = ['| Riesgo | Amenaza | STRIDE | Sobre | Estado | Controles | Residual |', '|---|---|---|---|---|---|---|'];
      for (const t of byRisk(doc.threats.filter((x) => status === undefined || statusOf(x) === status))) {
        const linked = (t.controlIds ?? []).map((id) => controlLabel(controls.get(id)!));
        const residual = residualOf(doc, t);
        out.push(`| ${riskLabel(riskOf(t))} | ${cell(t.title)} | ${STRIDE_LABELS[t.category]} | ${cell(elements.get(t.targetId)!.name)} | ${STATUS_LABELS[statusOf(t)]} | ${cell(linked.join('; ')) || '—'} | ${riskLabel(residual)}${residual.reduced ? ' ↓' : ''} |`);
      }
      const count = (s: ThreatStatus): number => doc.threats.filter((t) => statusOf(t) === s).length;
      const open = doc.threats.filter((t) => statusOf(t) === 'open');
      out.push('', `Amenazas: ${doc.threats.length} · abiertas: ${count('open')} · mitigadas: ${count('mitigated')} · aceptadas: ${count('accepted')}`);
      out.push(`Abiertas por riesgo: ${ratingSummary(open.map((t) => riskOf(t).rating))}`);
      out.push(`Abiertas por riesgo residual: ${ratingSummary(open.map((t) => residualOf(doc, t).rating))}`);
      out.push('Residual: lo que queda tras los controles implementados (↓ = menor que el inherente); los controles previstos no cuentan.');
      return out.join('\n');
    },
  },
  {
    name: 'heatmap',
    description: 'Matriz de calor (tabla Markdown): probabilidad × impacto con el número de amenazas de cada celda y, debajo, qué amenazas hay en cada celda no vacía; con --residual, donde quedan tras los controles implementados',
    input: { description: 'documento de seguridad en JSON' },
    options: [{ flags: '--residual', description: 'colocar las amenazas por su riesgo residual (tras los controles implementados) en vez de por el inherente' }],
    run: ({ options, input }) => {
      const doc = readSecurity(input);
      if (doc.threats.length === 0) return 'El documento no define amenazas.';
      const view = findView(doc, options.residual ? 'heatmap:residual' : 'heatmap');
      const mode = view.mode ?? 'inherent';
      const cells = heatContents(doc, view);
      const elements = indexElements(doc);
      const out = [view.title, '', `| Probabilidad \\ Impacto | ${IMPACTS.map((i) => RATING_LABELS[i]).join(' | ')} |`, `|---|${IMPACTS.map(() => ':-:').join('|')}|`];
      for (const l of HEAT_ROWS) out.push(`| ${LIKELIHOOD_LABELS[l]} | ${IMPACTS.map((i) => cells.get(heatCellId(l, i))!.length).join(' | ')} |`);
      const occupied = HEAT_ROWS.flatMap((l) => IMPACTS.map((i) => ({ l, i, threats: cells.get(heatCellId(l, i))! })))
        .filter((c) => c.threats.length > 0)
        .sort((a, b) => cellScore(b.l, b.i) - cellScore(a.l, a.i));
      out.push('', 'Amenazas por celda, de mayor a menor riesgo:');
      for (const { l, i, threats } of occupied) {
        out.push(`- prob. ${LIKELIHOOD_LABELS[l]} × impacto ${RATING_LABELS[i]} · riesgo ${riskLabel({ rating: cellRating(l, i), score: cellScore(l, i) })} · ${plural(threats.length, 'amenaza', 'amenazas')}`);
        for (const t of threats) {
          const note = heatNote(doc, t, mode);
          out.push(`  - ${cell(t.title)} · ${STRIDE_LABELS[t.category]} · ${cell(elements.get(t.targetId)!.name)} · ${STATUS_LABELS[statusOf(t)]}${note ? ` · ${note}` : ''}`);
        }
      }
      const placed = occupied.flatMap(({ l, i, threats }) => threats.map(() => cellRating(l, i)));
      out.push('', `Amenazas: ${doc.threats.length} · por riesgo${mode === 'residual' ? ' residual' : ''}: ${ratingSummary(placed)} · con riesgo residual menor que el inherente: ${doc.threats.filter((t) => residualOf(doc, t).reduced).length}`);
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
    name: 'standards',
    description: 'Cobertura de estándares (tabla Markdown): para cada catálogo al que remiten los controles (OWASP ASVS, NIST 800-53, ISO 27001, CIS), sus controles y qué amenazas están cubiertas (control implementado), con cobertura solo prevista o sin cobertura (los huecos); con un catálogo, solo ese',
    input: { description: 'documento de seguridad en JSON' },
    options: [{ flags: '--catalogo <catálogo>', description: `solo ese catálogo (${CONTROL_STANDARDS.join(' | ')}); por defecto, todos los que usan los controles` }],
    run: ({ options, input }) => {
      const doc = readSecurity(input);
      const chosen = String(options.catalogo ?? '').trim();
      const wanted = chosen === '' ? undefined : chosen.toLowerCase();
      if (wanted !== undefined && !(CONTROL_STANDARDS as readonly string[]).includes(wanted)) throw new SecurityImportError(`Catálogo inválido «${chosen}». Use: ${CONTROL_STANDARDS.join(', ')}.`);
      const used = standardsInUse(doc);
      if (used.length === 0) return 'Ningún control remite a un estándar (campo «standard» de los controles): no hay cobertura de estándares que mostrar.';
      if (wanted !== undefined && !used.includes(wanted as ControlStandard)) return `Ningún control remite a ${STANDARD_LABELS[wanted as ControlStandard]}. Estándares en uso: ${used.map((s) => STANDARD_LABELS[s]).join(', ')}.`;
      const elements = indexElements(doc);
      const coverage = (view: SecurityView) => {
        const tally: Record<Coverage, number> = { covered: 0, planned: 0, none: 0 };
        const rows = byRisk(doc.threats.filter((t) => view.threatIds.includes(t.id))).map((t) => {
          const c = threatCoverage(doc, view.controlIds, t);
          tally[c.level]++;
          return { t, ...c };
        });
        return { rows, tally };
      };
      const standardView = (standard: ControlStandard): SecurityView => findView(doc, `standards:${standard}`);
      const section = (standard: ControlStandard, heading: boolean): string[] => {
        const view = standardView(standard);
        const controls = doc.controls.filter((c) => view.controlIds.includes(c.id));
        const { rows, tally } = coverage(view);
        const out = heading ? [`## ${STANDARD_LABELS[standard]} · ${plural(controls.length, 'control', 'controles')}`, ''] : [];
        out.push('| Control | Tipo | Estado | Mitiga |', '|---|---|---|---|');
        for (const c of controls) out.push(`| ${cell(c.name)} | ${CONTROL_LABELS[c.kind]} | ${CONTROL_STATUS_LABELS[controlStatusOf(c)]} | ${plural(doc.threats.filter((t) => (t.controlIds ?? []).includes(c.id)).length, 'amenaza', 'amenazas')} |`);
        out.push('', '| Riesgo | Amenaza | Sobre | Estado | Cobertura | Controles |', '|---|---|---|---|---|---|');
        for (const { t, level, controls: linked } of rows) {
          out.push(`| ${riskLabel(riskOf(t))} | ${cell(t.title)} | ${cell(elements.get(t.targetId)!.name)} | ${STATUS_LABELS[statusOf(t)]} | ${COVERAGE_LABELS[level]} | ${cell(linked.map(controlLabel).join('; ')) || '—'} |`);
        }
        out.push('', `Cubiertas: ${tally.covered} · Con cobertura prevista: ${tally.planned} · Sin cobertura: ${tally.none}`);
        return out;
      };
      if (wanted !== undefined) return [standardView(wanted as ControlStandard).title, '', ...section(wanted as ControlStandard, false)].join('\n');
      const overview = ['| Estándar | Controles | Cubiertas | Con cobertura prevista | Sin cobertura |', '|---|--:|--:|--:|--:|'];
      const row = (label: string, view: SecurityView): void => {
        const { tally } = coverage(view);
        overview.push(`| ${label} | ${view.controlIds.length} | ${tally.covered} | ${tally.planned} | ${tally.none} |`);
      };
      for (const standard of used) row(STANDARD_LABELS[standard], standardView(standard));
      if (used.length > 1) row('Todos los estándares', findView(doc, 'standards'));
      return [findView(doc, 'standards').title, '', ...overview, ...used.flatMap((standard) => ['', ...section(standard, true)])].join('\n');
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
    kind: 'convert',
    description: 'Crea el modelo de seguridad a partir de un mapa de integración: sistemas → procesos o entidades externas, almacenes → almacenes de datos, interacciones → flujos, con zonas propuestas por heurística y referencia urn:iark:integration:<id>',
    input: { description: 'documento de integración en JSON' },
    options: [{ flags: '--name <nombre>', description: 'nombre del documento de seguridad' }],
    run: ({ input, options, warn }) => {
      const { document, warnings } = fromIntegrationJson(parseJson(input, 'documento de integración'), { name: options.name as string | undefined });
      for (const w of warnings) warn?.(`aviso: ${w}`);
      warn?.(`Convertido "${document.workspace.name}": ${document.zones.length} zonas, ${document.assets.length} activos, ${document.flows.length} flujos.`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
  {
    name: 'from-platform',
    kind: 'convert',
    description: 'Crea el modelo de seguridad de un entorno a partir de un documento de plataforma: redes → zonas de confianza (según su exposición), servicios y recursos → activos, dependencias → flujos, con referencia urn:iark:platform:<id>',
    input: { description: 'documento de plataforma en JSON' },
    options: [
      { flags: '--env <entorno>', description: 'entorno a modelar (por defecto, el de producción)' },
      { flags: '--name <nombre>', description: 'nombre del documento de seguridad' },
    ],
    run: ({ input, options, warn }) => {
      const { document, warnings } = fromPlatformJson(parseJson(input, 'documento de plataforma'), { name: options.name as string | undefined, env: options.env as string | undefined });
      for (const w of warnings) warn?.(`aviso: ${w}`);
      warn?.(`Convertido "${document.workspace.name}": ${document.zones.length} zonas, ${document.assets.length} activos, ${document.flows.length} flujos.`);
      return `${JSON.stringify(document, null, 2)}\n`;
    },
  },
];
