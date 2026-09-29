// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import { useDocumentStore } from '../../src/app/store/documentStore';
import { autoLayoutDocument } from '@core/layout/elkLayout';
import { toDrawio } from '@core/export/drawio/toDrawio';
import { validateDocument, formatIssues } from '@core/model/schema';
import { PARENT_TYPE, type ElementType, type ViewType } from '@core/model/types';

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const TYPES: ElementType[] = ['person', 'softwareSystem', 'container', 'component'];
const VTYPES: ViewType[] = ['systemContext', 'container', 'component'];
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const arr = (x: unknown) => (x === undefined ? [] : ([] as unknown[]).concat(x)) as any[];

function structural(xml: string): string[] {
  const out: string[] = [];
  const p = parser.parse(xml);
  for (const d of arr(p.mxfile?.diagram)) {
    const root = d.mxGraphModel.root;
    const byId = new Map<string, any>();
    const ids: string[] = [];
    for (const c of [...arr(root.mxCell), ...arr(root.object)]) { ids.push(c['@_id']); byId.set(c['@_id'], c); }
    if (new Set(ids).size !== ids.length) out.push(`[${d['@_name']}] ids duplicados`);
    for (const c of [...arr(root.mxCell), ...arr(root.object)]) {
      const cell = c.mxCell ?? c;
      if (c['@_id'] === '0') continue;
      if (cell['@_parent'] !== undefined && !byId.has(cell['@_parent'])) out.push(`[${d['@_name']}] parent ${cell['@_parent']} inexistente`);
      for (const k of ['@_source', '@_target']) if (cell[k] !== undefined && !byId.has(cell[k])) out.push(`[${d['@_name']}] ${k} ${cell[k]} inexistente`);
      const g = cell.mxGeometry;
      if (cell['@_vertex'] === '1' && (!g || ['@_x', '@_y', '@_width', '@_height'].some((k) => Number.isNaN(Number(g[k])) || g[k] === undefined))) out.push(`[${d['@_name']}] geometría inválida en ${c['@_id']}`);
    }
  }
  return out;
}

// Recorrido aleatorio reproducible (semillas fijas) sobre el store: aplica mezclas de acciones que la
// interfaz permite (añadir, borrar, cambiar tipo, mover/reparentar, crear vistas, deshacer…) y comprueba
// tras cada paso que el documento sigue siendo válido según el esquema y que autolayout + exportación a
// .drawio no fallan y producen un XML coherente. Por defecto es ligero; para una pasada profunda:
//   SEEDS=300 STEPS=40 npx vitest run tests/fuzz
/** Reconstruye las posiciones absolutas desde el XML y las compara con las de la vista (geometría relativa al padre). */
function geometryMismatches(xml: string, laid: import('@core/model/types').C4Document): string[] {
  const out: string[] = [];
  const p = parser.parse(xml);
  for (const d of arr(p.mxfile?.diagram)) {
    const view = laid.views.find((v) => v.id === d['@_id']);
    if (!view) { out.push(`página ${d['@_id']} sin vista`); continue; }
    const root = d.mxGraphModel.root;
    const cells = new Map<string, any>();
    for (const c of [...arr(root.mxCell), ...arr(root.object)]) cells.set(c['@_id'], c.mxCell ?? c);
    const abs = (id: string): { x: number; y: number } => {
      const c = cells.get(id);
      if (!c || !c.mxGeometry) return { x: 0, y: 0 };
      const parent = c['@_parent'] && c['@_parent'] !== '1' && c['@_parent'] !== '0' ? abs(c['@_parent']) : { x: 0, y: 0 };
      return { x: parent.x + Number(c.mxGeometry['@_x']), y: parent.y + Number(c.mxGeometry['@_y']) };
    };
    for (const ve of view.elements) {
      const cell = cells.get('el-' + ve.id);
      if (!cell) continue; // boundary del alcance o elemento no dibujado como nodo
      const isBoundary = cell['@_style']?.includes('dashed=1');
      if (isBoundary) continue;
      const a = abs('el-' + ve.id);
      if (Math.abs(a.x - ve.x!) > 0.5 || Math.abs(a.y - ve.y!) > 0.5) out.push(`[${view.id}] ${ve.id}: XML (${a.x},${a.y}) ≠ vista (${ve.x},${ve.y})`);
    }
  }
  return out;
}

describe('recorrido aleatorio del store', () => {
  it('cualquier secuencia de acciones deja un documento válido y exportable', async () => {
    const failures = new Map<string, { seed: number; step: number; action: string; detail: string }>();
    const SEEDS = Number(process.env.SEEDS ?? 8), STEPS = Number(process.env.STEPS ?? 24);
    for (let seed = Number(process.env.SEED_FROM ?? 1); seed <= SEEDS; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: T[]): T | undefined => xs[Math.floor(rnd() * xs.length)];
      const s = () => useDocumentStore.getState();
      s().loadSample(); let invalidSeen = false;
      useDocumentStore.temporal.getState().clear();
      for (let step = 0; step < STEPS; step++) {
        const doc = s().doc;
        const els = doc.model.elements, rels = doc.model.relationships, views = doc.views;
        const r = rnd();
        let action = '';
        try {
          if (r < 0.14) { const t = pick(TYPES)!; action = `addElement ${t}`; s().addElement(t, rnd() < 0.7 ? { x: Math.round(rnd() * 800), y: Math.round(rnd() * 600) } : undefined); }
          else if (r < 0.24) { const a = pick(els), b = pick(els); action = `addRelationship ${a?.id}->${b?.id}`; if (a && b) s().addRelationship(a.id, b.id); }
          else if (r < 0.34) { const e = pick(els), t = pick(TYPES); action = `type ${e?.id}->${t}`; if (e && t) s().updateElement(e.id, { type: t }); }
          else if (r < 0.40) { const e = pick(els); const req = e ? PARENT_TYPE[e.type] : undefined; const p = pick(els.filter((x) => x.type === req)); action = `parent ${e?.id}->${p?.id}`; if (e && p) s().updateElement(e.id, { parentId: p.id }); }
          else if (r < 0.48) { const e = pick(els); action = `removeElement ${e?.id}`; if (e) s().removeElement(e.id); }
          else if (r < 0.52) { const x = pick(rels); action = `removeRelationship ${x?.id}`; if (x) s().removeRelationship(x.id); }
          else if (r < 0.60) { const t = pick(VTYPES)!, sc = pick(els); action = `addView ${t} scope ${sc?.id}`; s().addView(t, sc?.id); }
          else if (r < 0.63) { const v = pick(views); action = `removeView ${v?.id}`; if (v) s().removeView(v.id); }
          else if (r < 0.70) { const v = pick(views), e = pick(els); action = `addElementToView ${v?.id} ${e?.id}`; if (v && e) s().addElementToView(v.id, e.id); }
          else if (r < 0.74) { const v = pick(views), e = pick(v?.elements ?? []); action = `removeElementFromView ${v?.id} ${e?.id}`; if (v && e) s().removeElementFromView(v.id, e.id); }
          else if (r < 0.82) { const v = s().doc.views.find((x) => x.id === s().activeViewId), e = pick(v?.elements ?? []); const el = els.find((x) => x.id === e?.id); const req = el ? PARENT_TYPE[el.type] : undefined; const p = pick(els.filter((x) => x.type === req)); action = `moveElements ${e?.id} reparent ${p?.id}`; if (v && e) s().moveElements(v.id, [{ id: e.id, x: Math.round(rnd() * 900), y: Math.round(rnd() * 700) }], rnd() < 0.5 ? { id: e.id, parentId: rnd() < 0.3 || !p ? undefined : p.id } : undefined); }
          else if (r < 0.86) { const v = pick(views); action = `setActiveView ${v?.id}`; if (v) s().setActiveView(v.id); }
          else if (r < 0.90) { const e = pick(els); action = `drillDown ${e?.id}`; if (e) s().drillDown(e.id); }
          else if (r < 0.92) { action = 'drillUp'; s().drillUp(); }
          else if (r < 0.96) { action = 'undo'; useDocumentStore.temporal.getState().undo(); }
          else if (r < 0.98) { action = 'redo'; useDocumentStore.temporal.getState().redo(); }
          else { const x = pick(rels); action = `updateRelationship ${x?.id}`; if (x) s().updateRelationship(x.id, { targetId: pick(els)!.id }); }
        } catch (e) { failures.set('EXCEPCIÓN en ' + action.split(' ')[0], { seed, step, action, detail: String((e as Error).stack).split('\n').slice(0, 3).join(' | ') }); continue; }

        const d = s().doc;
        const v = validateDocument(JSON.parse(JSON.stringify(d)));
        if (!v.ok && !invalidSeen) { invalidSeen = true; const key = 'DOC INVÁLIDO tras ' + action.split(' ')[0]; if (!failures.has(key)) failures.set(key, { seed, step, action, detail: formatIssues(v.issues).replace(/\n/g, ' ').slice(0, 220) }); }
        if (step % 2 === 1) {
          try {
            const laid = await autoLayoutDocument(structuredClone(d));
            if (laid.views.length) { const xml = toDrawio(laid); const st = [...structural(xml), ...geometryMismatches(xml, laid)]; if (st.length) { const key = 'ESTRUCTURA ' + st[0].replace(/\[[^\]]*\]/, '').replace(/"[^"]*"/g, '"…"').slice(0, 70); if (!failures.has(key)) failures.set(key, { seed, step, action, detail: st.slice(0, 3).join(' | ') }); } }
          } catch (e) { const key = 'EXPORT FALLA: ' + String((e as Error).message).replace(/"[^"]*"/g, '"…"').replace(/\([^)]*\)/g, '(…)').slice(0, 90); if (!failures.has(key)) { failures.set(key, { seed, step, action, detail: String((e as Error).message).slice(0, 220) }); } }
        }
      }
    }
    console.log('\n=== FALLOS DISTINTOS: ' + failures.size + ' ===');
    for (const [k, f] of failures) console.log(`- ${k}\n    seed=${f.seed} paso=${f.step} acción=${f.action}\n    ${f.detail}`);
    expect([...failures.keys()]).toEqual([]);
  }, 600_000);
});
