import type { ModuleIssue } from '@iark/kernel';
import { checkContract } from './contracts';
import { PATTERN_INFO } from './patterns';
import { connectionViolation } from './rules';
import { KIND_LABELS, type IntegrationDocument, type IntegrationNode } from './types';
import { domainOf } from './zones';

/**
 * Reglas semánticas del dominio (avisos que no invalidan el documento pero conviene corregir):
 * huérfanos, brokers sin productor o consumidor, contratos ausentes o sin versión, dependencias síncronas circulares,
 * uniones que incumplen las reglas por tipo de nodo y patrones declarados dos veces.
 */
export function analyzeIntegration(doc: IntegrationDocument): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const label = (n: IntegrationNode): string => `${KIND_LABELS[n.kind]} «${n.name}»`;

  const incoming = new Map<string, number>();
  const outgoing = new Map<string, number>();
  for (const it of doc.interactions) {
    outgoing.set(it.sourceId, (outgoing.get(it.sourceId) ?? 0) + 1);
    incoming.set(it.targetId, (incoming.get(it.targetId) ?? 0) + 1);
  }
  const children = new Map<string, number>();
  for (const n of doc.nodes) if (n.parentId) children.set(n.parentId, (children.get(n.parentId) ?? 0) + 1);

  for (const n of doc.nodes) {
    const hasEdges = (incoming.get(n.id) ?? 0) + (outgoing.get(n.id) ?? 0) > 0;
    if ((n.kind === 'queue' || n.kind === 'topic') && (incoming.get(n.id) ?? 0) === 0 && (outgoing.get(n.id) ?? 0) > 0) {
      issues.push({ severity: 'warning', elementId: n.id, message: `${label(n)} tiene consumidores pero ningún productor.` });
    } else if ((n.kind === 'queue' || n.kind === 'topic') && (outgoing.get(n.id) ?? 0) === 0 && (incoming.get(n.id) ?? 0) > 0) {
      issues.push({ severity: 'warning', elementId: n.id, message: `${label(n)} recibe mensajes pero nadie los consume.` });
    } else if (!hasEdges && !children.get(n.id)) {
      issues.push({ severity: 'warning', elementId: n.id, message: `${label(n)} no participa en ninguna interacción.` });
    }
    if (!n.owner && !n.external && (n.kind === 'system' || n.kind === 'api')) {
      issues.push({ severity: 'info', elementId: n.id, message: `${label(n)} no tiene responsable (owner).` });
    }
    if (n.kind === 'pattern') {
      const info = n.pattern ? PATTERN_INFO[n.pattern].label : 'sin patrón';
      if ((incoming.get(n.id) ?? 0) === 0 || (outgoing.get(n.id) ?? 0) === 0) {
        issues.push({ severity: 'warning', elementId: n.id, message: `${label(n)} (${info}) transforma mensajes: necesita una interacción de entrada y otra de salida.` });
      }
    }
    if ((n.kind === 'api' || n.kind === 'mcp') && !n.contractId && !doc.interactions.some((it) => it.targetId === n.id && it.contractId)) {
      issues.push({ severity: 'info', elementId: n.id, message: `${label(n)} no tiene contrato.` });
    }
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent && n.domain?.trim() && n.domain.trim() !== domainOf(parent, nodes)) {
      issues.push({ severity: 'info', elementId: n.id, message: `El dominio de ${label(n)} se ignora: va dentro de ${label(parent)} y sigue a su zona.` });
    }
  }

  for (const c of doc.contracts) {
    if (!c.version) issues.push({ severity: 'warning', elementId: c.id, message: `El contrato «${c.name}» no tiene versión.` });
    if (!doc.interactions.some((it) => it.contractId === c.id) && !doc.nodes.some((n) => n.contractId === c.id)) issues.push({ severity: 'info', elementId: c.id, message: `El contrato «${c.name}» no lo usa ninguna interacción ni ningún nodo.` });
    if (c.content) {
      for (const d of checkContract(c.format, c.content)) {
        if (d.severity === 'info') continue;
        issues.push({ severity: 'warning', elementId: c.id, message: `Contrato «${c.name}» (${c.format})${d.line ? `, línea ${d.line}` : ''}: ${d.message}` });
      }
    }
  }

  const seen = new Set<string>();
  for (const it of doc.interactions) {
    const src = nodes.get(it.sourceId);
    const tgt = nodes.get(it.targetId);
    if (!src || !tgt) continue;
    const name = `${src.name} → ${tgt.name}`;
    if (!it.contractId && !tgt.contractId && (tgt.kind === 'api' || tgt.kind === 'mcp' || tgt.kind === 'queue' || tgt.kind === 'topic' || it.criticality === 'high')) {
      issues.push({ severity: 'warning', elementId: it.id, message: `La interacción ${name} no declara contrato.` });
    }
    if (it.style === 'request-response' && (tgt.kind === 'queue' || tgt.kind === 'topic')) {
      issues.push({ severity: 'warning', elementId: it.id, message: `La interacción ${name} es petición-respuesta contra ${KIND_LABELS[tgt.kind].toLowerCase()}: lo habitual es un mensaje asíncrono.` });
    }
    const broken = connectionViolation(src, tgt, it.style);
    if (broken && !(broken.rule === 'channel-sync' && (tgt.kind === 'queue' || tgt.kind === 'topic'))) {
      issues.push({ severity: 'warning', elementId: it.id, message: `La interacción ${name} incumple las reglas de conexión: ${broken.message}` });
    }
    if (it.pattern) {
      const twin = [src, tgt].find((x) => x.kind === 'pattern' && x.pattern === it.pattern);
      if (twin) issues.push({ severity: 'info', elementId: it.id, message: `La interacción ${name} marca el patrón «${PATTERN_INFO[it.pattern].label}» y su extremo «${twin.name}» ya lo dibuja como nodo: basta uno de los dos.` });
    }
    const key = `${it.sourceId}\u0000${it.targetId}\u0000${it.style}\u0000${it.protocol ?? ''}\u0000${it.description ?? ''}`;
    if (seen.has(key)) issues.push({ severity: 'warning', elementId: it.id, message: `La interacción ${name} está duplicada.` });
    seen.add(key);
  }

  // Ciclos de dependencias síncronas: A llama a B que llama a A bloquea a ambos si uno cae o se satura.
  const sync = new Map<string, string[]>();
  for (const it of doc.interactions) if (it.style === 'request-response') sync.set(it.sourceId, [...(sync.get(it.sourceId) ?? []), it.targetId]);
  const state = new Map<string, 1 | 2>();
  const reported = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    state.set(id, 1);
    for (const next of sync.get(id) ?? []) {
      if (state.get(next) === 1) {
        const cycle = [...path.slice(path.indexOf(next)), next];
        const key = [...cycle.slice(0, -1)].sort().join('|');
        if (!reported.has(key)) {
          reported.add(key);
          issues.push({ severity: 'warning', elementId: next, message: `Dependencia síncrona circular: ${cycle.map((c) => nodes.get(c)?.name ?? c).join(' → ')}.` });
        }
      } else if (!state.has(next)) visit(next, [...path, next]);
    }
    state.set(id, 2);
  };
  for (const id of sync.keys()) if (!state.has(id)) visit(id, [id]);

  return issues;
}
