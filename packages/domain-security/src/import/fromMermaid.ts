import {
  detectMermaidKind,
  MERMAID_DIAGRAM_KINDS,
  ModuleError,
  parseFlowchart,
  pickId,
  preprocessMermaid,
  splitLabel,
  Warnings,
  type FlowLineStyle,
  type FlowNodeRef,
} from '@iark/kernel';
import { formatSecurityIssues, validateSecurityDocument } from '../schema';
import {
  AUTHENTICATION_LABELS,
  AUTHENTICATIONS,
  CLASSIFICATIONS,
  DATA_LABELS,
  SECURITY_DOCUMENT_VERSION,
  TRUST_LABELS,
  TRUST_LEVELS,
  type Asset,
  type AssetKind,
  type Authentication,
  type Classification,
  type Flow,
  type SecurityDocument,
  type TrustLevel,
  type Zone,
} from '../types';

export class SecurityImportError extends ModuleError {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityImportError';
  }
}

export interface SecurityImportOptions {
  name?: string;
  fallbackName?: string;
}

export interface SecurityImportResult {
  document: SecurityDocument;
  warnings: string[];
}

export const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const normalize = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Clases (sin acentos ni separadores) con las que se reconoce el tipo de un nodo, en inglés y en español. */
const CLASS_KINDS: Record<string, AssetKind> = {
  actor: 'actor',
  usuario: 'actor',
  persona: 'actor',
  external: 'external',
  externo: 'external',
  sistemaexterno: 'external',
  tercero: 'external',
  process: 'process',
  proceso: 'process',
  servicio: 'process',
  service: 'process',
  datastore: 'datastore',
  almacen: 'datastore',
  almacendedatos: 'datastore',
  basededatos: 'datastore',
  db: 'datastore',
  bd: 'datastore',
};
/** Clases que dibuja el modelo de amenazas: no son activos. */
const THREAT_CLASSES = new Set(['threat', 'control', 'flow']);

const TRUST_BY_WORD = new Map<string, TrustLevel>([...TRUST_LEVELS.map((t) => [normalize(TRUST_LABELS[t]), t] as [string, TrustLevel]), ['noconfiable', 'untrusted'], ['untrusted', 'untrusted']]);
const CLASSIFICATION_BY_WORD = new Map<string, Classification>(CLASSIFICATIONS.flatMap((c) => [[normalize(DATA_LABELS[c]), c] as [string, Classification], [c, c] as [string, Classification]]));
const AUTHENTICATION_BY_WORD = new Map<string, Authentication>(AUTHENTICATIONS.flatMap((a) => [[normalize(AUTHENTICATION_LABELS[a]), a] as [string, Authentication], [a, a] as [string, Authentication]]));

/** Zona a partir del texto de un `subgraph`: `Zona interna: Aplicaciones` (así la escribe el exportador). */
function classifyZone(label: string): { name: string; trust?: TrustLevel } {
  const text = splitLabel(label).name;
  const m = /^zona\s+(no confiable|dmz|interna|restringida|untrusted|internal|restricted):\s*(.+)$/i.exec(text);
  if (!m) return { name: text };
  return { name: m[2].trim(), trust: TRUST_BY_WORD.get(normalize(m[1])) };
}

/** Quita del final del texto de un activo lo que añade el exportador: `datos confidenciales` y `cifrado en reposo` / `sin cifrar en reposo`. */
function stripAssetExtras(description: string | undefined): { technology?: string; classification?: Classification; encryptedAtRest?: boolean } {
  let text = description ?? '';
  let encryptedAtRest: boolean | undefined;
  const rest = /\s*(sin cifrar|cifrado) en reposo$/i.exec(text);
  if (rest) {
    encryptedAtRest = rest[1].toLowerCase() === 'cifrado';
    text = text.slice(0, rest.index);
  }
  let classification: Classification | undefined;
  const data = /(?:^|\s+)datos (públicos|publicos|internos|confidenciales|restringidos)$/i.exec(text);
  if (data) {
    classification = CLASSIFICATION_BY_WORD.get(normalize(data[1]));
    text = text.slice(0, data.index);
  }
  return { ...(text.trim() ? { technology: text.trim() } : {}), ...(classification ? { classification } : {}), ...(encryptedAtRest !== undefined ? { encryptedAtRest } : {}) };
}

const PROTOCOL = /^(https?|grpc|amqps?|mqtts?|tcp|udp|tls|mtls|ssh|sftp|ftps?|jdbc|odbc|sql|smtps?|imaps?|wss?|kafka|rest|graphql|soap|sse|dns)\b/i;

/** Etiqueta de una flecha: `protocolo · descripción · datos … · autenticación …`. */
function edgeDetails(label: string | undefined): { protocol?: string; description?: string; classification?: Classification; authentication?: Authentication } {
  if (!label) return {};
  const parts = splitLabel(label).name.split(' · ').map((p) => p.trim()).filter(Boolean);
  let classification: Classification | undefined;
  let authentication: Authentication | undefined;
  const plain: string[] = [];
  for (const part of parts) {
    const data = /^datos (públicos|publicos|internos|confidenciales|restringidos)$/i.exec(part);
    const auth = /^(?:sin autenticaci[oó]n|autenticaci[oó]n (.+))$/i.exec(part);
    if (data) classification = CLASSIFICATION_BY_WORD.get(normalize(data[1]));
    else if (auth) authentication = auth[1] === undefined ? 'none' : AUTHENTICATION_BY_WORD.get(normalize(auth[1]));
    else plain.push(part);
  }
  const [first, ...rest] = plain;
  const single = plain.length === 1;
  return {
    ...(first && (!single || PROTOCOL.test(first)) ? { protocol: first } : {}),
    ...(first && single && !PROTOCOL.test(first) ? { description: first } : {}),
    ...(rest.length > 0 ? { description: rest.join(' · ') } : {}),
    ...(classification ? { classification } : {}),
    ...(authentication ? { authentication } : {}),
  };
}

interface Group {
  alias: string;
  label: string;
  seq: number;
  parent?: string;
  name: string;
  trust?: TrustLevel;
}

/**
 * Importa un `flowchart` de Mermaid como documento de seguridad. Cada `subgraph` es una zona de confianza (con el prefijo
 * `Zona interna|DMZ|restringida|no confiable: …` que pone el exportador se conoce su nivel; sin él se importa como interna
 * y se avisa) y cada nodo, un activo cuyo tipo sale de su clase (`:::actor`, `:::external`, `:::process`, `:::datastore`, en
 * inglés o en español) o, si no, de su forma (`[( )]` = almacén de datos, `([ ])` = actor). Al final del texto del nodo se
 * leen la clasificación de los datos (`datos confidenciales`) y el cifrado en reposo. Las flechas son flujos de datos:
 * gruesa `==>` = cifrado, punteada `-.->` = sin cifrar, continua = no se sabe; la etiqueta es `protocolo · descripción ·
 * datos … · autenticación …`. Las amenazas y los controles se describen en el JSON, no en Mermaid.
 */
export function fromMermaid(source: string, options: SecurityImportOptions = {}): SecurityImportResult {
  const { lines, title } = preprocessMermaid(source);
  if (lines.length === 0) throw new SecurityImportError('El texto de Mermaid está vacío.');
  const kind = detectMermaidKind(lines[0].text);
  if (kind !== 'flowchart') {
    throw new SecurityImportError(
      kind
        ? `Un diagrama de Mermaid «${lines[0].text.split(/\s+/)[0]}» no se puede importar como seguridad. Se admite flowchart/graph.`
        : `No se reconoce el tipo de diagrama de Mermaid («${lines[0].text.split(/\s+/)[0]}»). Se admiten: ${MERMAID_DIAGRAM_KINDS.join(', ')}.`,
    );
  }
  const warnings = new Warnings();
  const groups = new Map<string, Group>();
  const nodes = new Map<string, { ref: FlowNodeRef; classes: Set<string>; group?: string; seq: number }>();
  const edges: Array<{ from: string[]; to: string[]; label?: string; line: FlowLineStyle; where: string }> = [];
  const stack: string[] = [];
  let seq = 0;

  for (const ev of parseFlowchart(lines.slice(1))) {
    if (ev.type === 'warning') warnings.add(ev.message);
    else if (ev.type === 'subgraph-start') {
      groups.set(ev.alias, { alias: ev.alias, label: ev.label, seq: seq++, parent: stack[stack.length - 1], ...classifyZone(ev.label) });
      stack.push(ev.alias);
    } else if (ev.type === 'subgraph-end') stack.pop();
    else if (ev.type === 'node') {
      const known = nodes.get(ev.node.alias);
      if (!known) nodes.set(ev.node.alias, { ref: { ...ev.node }, classes: new Set(ev.node.classes), group: stack[stack.length - 1], seq: seq++ });
      else {
        for (const c of ev.node.classes ?? []) known.classes.add(c);
        if (ev.node.label !== undefined) known.ref = { ...known.ref, label: ev.node.label, shape: ev.node.shape ?? known.ref.shape };
        if (known.group === undefined && stack.length > 0) known.group = stack[stack.length - 1];
      }
    } else {
      const from = ev.from.map((n) => n.alias);
      const to = ev.to.map((n) => n.alias);
      edges.push({ from, to, label: ev.label, line: ev.line, where: ev.where });
      if (ev.bidirectional) edges.push({ from: to, to: from, label: ev.label, line: ev.line, where: ev.where });
    }
  }

  const ids = new Set<string>();
  const zones: Zone[] = [];
  const assets: Asset[] = [];
  const zoneOf = new Map<string, string>(); // alias del grupo → id de la zona
  const assetOf = new Map<string, string>(); // alias del nodo → id del activo
  let fallbackZone: string | undefined;

  const zoneFor = (group: string | undefined, name: string): string => {
    if (group !== undefined && zoneOf.has(group)) return zoneOf.get(group)!;
    if (!fallbackZone) {
      fallbackZone = pickId('sin-zona', ids);
      zones.push({ id: fallbackZone, name: 'Sin zona asignada' });
      warnings.add(`«${name}» no está dentro de ninguna zona («Zona …: …»): se crea la zona «Sin zona asignada» con confianza interna.`);
    }
    return fallbackZone;
  };

  // Todo se crea en el orden en que aparece en el texto (las zonas antes que lo que contienen).
  const entries = [
    ...[...groups.values()].map((g) => ({ seq: g.seq, group: g })),
    ...[...nodes.values()].filter((n) => !groups.has(n.ref.alias)).map((n) => ({ seq: n.seq, node: n })),
  ].sort((a, b) => a.seq - b.seq);
  let ignored = 0;

  for (const entry of entries) {
    if ('group' in entry) {
      const { alias, name, trust, parent, label } = entry.group;
      const id = pickId(slug(alias) || slug(name) || 'zona', ids);
      zoneOf.set(alias, id);
      if (trust === undefined) warnings.add(`El subgraph «${splitLabel(label).name}» no indica su nivel de confianza («Zona interna: …»): se importa como zona interna.`);
      zones.push({ id, name: name || alias, trust: trust ?? 'internal', ...(parent && zoneOf.has(parent) ? { parentId: zoneOf.get(parent)! } : {}) });
      continue;
    }
    const { ref, classes, group } = entry.node;
    if ([...classes].some((c) => THREAT_CLASSES.has(normalize(c)))) {
      ignored += 1;
      continue;
    }
    const label = splitLabel(ref.label ?? ref.alias);
    const name = label.name || ref.alias;
    const extras = stripAssetExtras(label.description);
    const found = [...classes].map((c) => CLASS_KINDS[normalize(c)]).find((k) => k !== undefined);
    const assetKind: AssetKind = found ?? (ref.shape === 'cylinder' ? 'datastore' : ref.shape === 'stadium' ? 'actor' : 'process');
    const id = pickId(slug(ref.alias) || slug(name) || assetKind, ids);
    assetOf.set(ref.alias, id);
    assets.push({
      id,
      name,
      kind: assetKind,
      zoneId: zoneFor(group, name),
      ...(extras.technology ? { technology: extras.technology } : {}),
      ...(extras.classification ? { classification: extras.classification } : {}),
      ...(extras.encryptedAtRest !== undefined && assetKind === 'datastore' ? { encryptedAtRest: extras.encryptedAtRest } : {}),
    });
  }
  if (ignored > 0) warnings.add(`Se ignoraron ${ignored} nodo(s) del modelo de amenazas (amenazas, controles y flujos): se describen en el JSON, no en Mermaid.`);

  const flows: Flow[] = [];
  const signatures = new Set<string>();
  for (const e of edges) {
    const details = edgeDetails(e.label);
    for (const a of e.from) {
      for (const b of e.to) {
        const [source, target] = [assetOf.get(a), assetOf.get(b)];
        if (!source || !target) {
          const skip = [a, b].some((x) => nodes.has(x) && [...nodes.get(x)!.classes].some((c) => THREAT_CLASSES.has(normalize(c))));
          if (!skip) warnings.add(`${e.where}: la arista ${a} → ${b} no se puede importar; se omite.`);
          continue;
        }
        if (source === target) {
          warnings.add(`${e.where}: «${a}» envía datos a sí mismo; se omite.`);
          continue;
        }
        const signature = `${source}|${target}|${e.label ?? ''}|${e.line}`;
        if (signatures.has(signature)) continue;
        signatures.add(signature);
        flows.push({
          id: pickId(`${source}--${target}`, ids),
          sourceId: source,
          targetId: target,
          ...(details.protocol ? { protocol: details.protocol } : {}),
          ...(details.description ? { description: details.description } : {}),
          ...(details.classification ? { classification: details.classification } : {}),
          ...(e.line === 'thick' ? { encrypted: true } : e.line === 'dotted' ? { encrypted: false } : {}),
          ...(details.authentication ? { authentication: details.authentication } : {}),
        });
      }
    }
  }

  if (assets.length === 0) throw new SecurityImportError('El diagrama de Mermaid no define ningún activo que se pueda importar.');
  const name = options.name?.trim() || title?.trim() || options.fallbackName?.trim() || 'Arquitectura de seguridad';
  const result = validateSecurityDocument({ version: SECURITY_DOCUMENT_VERSION, workspace: { name }, zones, assets, flows, threats: [], controls: [] });
  if (!result.ok) throw new SecurityImportError(`No se pudo construir un documento válido a partir de Mermaid:\n${formatSecurityIssues(result.issues)}`);
  return { document: result.document, warnings: warnings.result() };
}
