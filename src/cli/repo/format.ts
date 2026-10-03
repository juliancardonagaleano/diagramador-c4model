import { CATEGORY_LABEL } from './rules';
import { OMIT_LABEL, type OmitReason, type RepoDigest } from './scan';

const kb = (bytes: number): string => (bytes / 1024).toFixed(1).replace('.', ',');

/** Una línea para decir al usuario qué se va a enviar (a stderr, antes de llamar al modelo). */
export function formatSummary(digest: RepoDigest): string {
  const omitted = Object.values(digest.omittedCounts).reduce((a, b) => a + (b ?? 0), 0);
  const secrets = digest.omittedCounts.secreto ?? 0;
  return (
    `Repositorio «${digest.name}»: el resumen lleva el árbol de carpetas y ${digest.included.length} archivo(s) clave (${kb(digest.bytes)} KB de ${kb(digest.budget)} KB); ` +
    `${digest.redactions} valor(es) redactado(s); ${digest.filesSeen} archivos de texto vistos, ${omitted} entrada(s) omitida(s)` +
    `${secrets ? ` (${secrets} por parecer secretos: no se leen)` : ''}.`
  );
}

const MAX_NAMES_PER_REASON = 15;

/** Qué archivos entran y cuáles se quedan fuera (con su motivo): lo que imprime `--dry-run` para auditar el envío. */
export function formatReport(digest: RepoDigest): string {
  const lines: string[] = [];
  lines.push(`Incluidos con contenido (${digest.included.length}):`);
  const width = Math.min(60, Math.max(10, ...digest.included.map((f) => f.path.length)));
  for (const f of digest.included) {
    const flags = [f.truncated ? `recortado de ${kb(f.originalBytes)} KB` : undefined, f.redactions ? `${f.redactions} redactado(s)` : undefined, f.note].filter(Boolean).join('; ');
    lines.push(`  ${f.path.padEnd(width)}  ${CATEGORY_LABEL[f.category].padEnd(34)} ${kb(f.bytes).padStart(6)} KB${flags ? `  (${flags})` : ''}`);
  }
  if (digest.included.length === 0) lines.push('  (ninguno: el modelo solo recibe el árbol de carpetas)');

  const byReason = new Map<OmitReason, string[]>();
  for (const o of digest.omitted) {
    const list = byReason.get(o.reason) ?? [];
    list.push(`${o.path}${o.detail ? ` (${o.detail})` : ''}`);
    byReason.set(o.reason, list);
  }
  const reasons = [...new Set([...(Object.keys(digest.omittedCounts) as OmitReason[])])];
  lines.push('');
  lines.push('Omitidos, por motivo:');
  if (reasons.length === 0) lines.push('  (ninguno)');
  for (const reason of reasons) {
    const listed = byReason.get(reason) ?? [];
    const total = digest.omittedCounts[reason] ?? listed.length;
    const shown = listed.slice(0, MAX_NAMES_PER_REASON).join('; ');
    const more = total - Math.min(listed.length, MAX_NAMES_PER_REASON);
    lines.push(`  ${OMIT_LABEL[reason]} (${total}): ${shown}${more > 0 ? `; … y ${more} más` : ''}`);
  }
  if (digest.walkTruncated) lines.push('', 'Aviso: el repositorio es muy grande y el recorrido se cortó por el tope de entradas; el árbol y la selección son parciales.');
  return lines.join('\n');
}
