import { describe, expect, it } from 'vitest';
import { toDrawio } from '../../src/core/export/drawio/toDrawio';
import { DrawioImportError, fromDrawio } from '../../src/core/import/drawio/fromDrawio';
import { autoLayoutDocument } from '../../src/core/layout/elkLayout';
import { sampleDocument } from '../../src/core/model/sample';
import { validateDocument } from '../../src/core/model/schema';

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Entradas arbitrarias sobre el importador, con semillas fijas (reproducibles). Deben producir siempre un
// documento válido o un `DrawioImportError` con motivo; nunca una excepción cruda ni un documento que rompa
// el esquema (ese caso lo delata el mensaje "No se pudo construir un documento C4 válido"). Por defecto es ligero;
// para una pasada profunda:
//   SEEDS=3000 npx vitest run tests/fuzz/importDrawio
const SEEDS = Number(process.env.SEEDS ?? 250);

async function check(xml: string, label: string, failures: string[]): Promise<void> {
  try {
    const { document } = await fromDrawio(xml);
    const result = validateDocument(document);
    if (!result.ok) failures.push(`${label}: documento inválido ${JSON.stringify(result.issues.slice(0, 2))}`);
    for (const v of document.views) if (v.elements.length === 0 && !v.scopeId) failures.push(`${label}: vista "${v.id}" vacía y sin alcance`);
  } catch (error) {
    if (!(error instanceof DrawioImportError)) failures.push(`${label}: excepción cruda ${(error as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    else if (/No se pudo construir un documento C4 válido/.test(error.message)) failures.push(`${label}: invariante interna rota: ${error.message.slice(0, 200)}`);
  }
}

describe('importación de .drawio: entradas arbitrarias', () => {
  it('un .drawio exportado y luego mutado (atributos, líneas, truncado) nunca produce una excepción cruda', async () => {
    const laid = await autoLayoutDocument(sampleDocument);
    const base = toDrawio(laid).split('\n');
    const ATTRS = ['parent', 'source', 'target', 'vertex', 'edge', 'id', 'style', 'c4Type', 'c4Name', 'label', 'x', 'y', 'width', 'height', 'link', 'visible'];
    const GARBAGE = ['', 'NaN', '-5', '0', '1e999', '👍', '<b>x</b>', 'el-', 'rel-a@b->c', 'data:page/id,', '%c4Name%', '__proto__', 'x'.repeat(300), '1'];
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const lines = [...base];
      for (let n = 1 + Math.floor(rnd() * 6); n > 0; n -= 1) {
        const i = Math.floor(rnd() * lines.length);
        const op = Math.floor(rnd() * 6);
        if (op === 0) lines.splice(i, 1);
        else if (op === 1) lines.splice(i, 0, lines[i]);
        else if (op === 2) lines.sort(() => rnd() - 0.5);
        else if (op === 3) lines[i] = lines[i].replace(new RegExp(`\\b${pick(ATTRS)}="[^"]*"`), '');
        else if (op === 4) lines[i] = lines[i].replace(new RegExp(`\\b${pick(ATTRS)}="[^"]*"`), `${pick(ATTRS)}="${pick(GARBAGE)}"`);
        else lines[i] = lines[i].replace(/(parent|source|target)="[^"]*"/, `$1="${lines[pick([0, 1, 2, 3, 4, 5, 6, 7, 8].map((x) => x % lines.length))].match(/id="([^"]*)"/)?.[1] ?? 'x'}"`);
      }
      let xml = lines.join('\n');
      if (rnd() < 0.15) xml = xml.slice(0, Math.floor(rnd() * xml.length));
      await check(xml, `mutación semilla ${seed}`, failures);
    }
    expect(failures).toEqual([]);
  }, 120_000);

  it('diagramas de formas sueltas generados al azar (anidamiento, ciclos, ids repetidos, estilos y etiquetas raros)', async () => {
    const IDS = ['A', 'B', 'C', 'D', 'a', 'b', 'el-a', 'el-b', 'rel-r', 'x-1', 'Z9', '1', '2'];
    const STYLES = ['', 'rounded=1;html=1;', 'shape=umlActor;html=1;', 'shape=cylinder3;direction=south;html=1;', 'text;html=1;', 'group', 'edgeLabel;html=1;', 'dashed=1;container=1;html=1;', 'shape=mxgraph.c4.person2;fillColor=#08427b;html=1;', 'fillColor=#FF8800;html=1;'];
    const LABELS = ['', 'Alfa', '<b>Beta</b><br>[Container: Java]<div>desc</div>', '[External System]', 'Gamma [x]', '%c4Name%', '<<>>&amp;', 'Delta\nEpsilon'];
    const C4TYPES = [undefined, 'Person', 'Software System', 'External System', 'Container', 'Component', 'System Scope Boundary', 'Container Scope Boundary', 'Enterprise Boundary', 'Relationship', 'Raro'];
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = mulberry32(seed * 7919);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
      const pages: string[] = [];
      for (let p = 0, np = 1 + Math.floor(rnd() * 3); p < np; p += 1) {
        const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
        const count = Math.floor(rnd() * 22);
        for (let i = 0; i < count; i += 1) {
          const id = rnd() < 0.7 ? `${pick(IDS)}${rnd() < 0.5 ? i : ''}` : pick(IDS);
          const parent = rnd() < 0.5 ? '1' : `${pick(IDS)}${rnd() < 0.5 ? Math.floor(rnd() * count) : ''}`;
          const geo = rnd() < 0.85 ? `<mxGeometry x="${pick(['0', '10', '-30', 'abc', '1e9'])}" y="${Math.floor(rnd() * 500)}" width="${pick(['120', '0', '-4', ''])}" height="60" as="geometry"/>` : '';
          if (rnd() < 0.3) {
            cells.push(`<mxCell id="${id}" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="${parent}"${rnd() < 0.9 ? ` source="${pick(IDS)}${Math.floor(rnd() * count)}"` : ''}${rnd() < 0.9 ? ` target="${pick(IDS)}${Math.floor(rnd() * count)}"` : ''} value="${pick(LABELS).replace(/[<>&"]/g, '')}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
          } else {
            const t = pick(C4TYPES);
            const value = pick(LABELS).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            const inner = `<mxCell style="${pick(STYLES)}" vertex="1" parent="${parent}">${geo}</mxCell>`;
            cells.push(t ? `<object placeholders="1" c4Name="${pick(['N1', 'N2', 'N3', ''])}" c4Type="${t}" label="${value}" id="${id}">${inner}</object>` : inner.replace('<mxCell ', `<mxCell id="${id}" value="${value}" `));
          }
        }
        pages.push(`<diagram id="${pick(['pg', 'Pg-1', 'contexto', '7'])}" name="${pick(['Uno', 'Dos', '', 'Tres 3'])}"><mxGraphModel><root>${cells.join('')}</root></mxGraphModel></diagram>`);
      }
      await check(`<mxfile>${pages.join('')}</mxfile>`, `formas semilla ${seed}`, failures);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
