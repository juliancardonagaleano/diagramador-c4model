import { readFileSync } from 'node:fs';
import { importText, ModuleRegistry, ModuleError } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { toMermaid } from '../export/mermaid';
import { buildMatrix } from '../matrix';
import { enterpriseModule } from '../module';
import { formatEnterpriseIssues, validateEnterpriseDocument } from '../schema';
import type { EnterpriseDocument } from '../types';
import { findView } from '../views';
import { looksLikeArchimate } from './fromArchimate';
import { EnterpriseImportError, fromMermaid, looksLikeMatrixBlock } from './fromMermaid';

const parse = (input: unknown): EnterpriseDocument => {
  const r = validateEnterpriseDocument(input);
  if (!r.ok) throw new Error(formatEnterpriseIssues(r.issues));
  return r.document;
};
const example = parse(JSON.parse(readFileSync('examples/empresa-arquitectura.json', 'utf8')));
const archimate = readFileSync('tests/fixtures/importar/archimate/comercio-andino.xml', 'utf8');

/** Un documento con cada caso de celda: directa, por un proceso (○), heredada (·), vacía; tres niveles de jerarquía y nombres repetidos. */
const grid = parse({
  version: '1.0',
  workspace: { name: 'Rejilla' },
  capabilities: [
    { id: 'ventas', name: 'Ventas' },
    { id: 'online', name: 'Ventas online', parentId: 'ventas' },
    { id: 'carrito', name: 'Carrito', parentId: 'online' },
    { id: 'pagos-online', name: 'Pagos', parentId: 'online' },
    { id: 'tiendas', name: 'Tiendas físicas', parentId: 'ventas' },
    { id: 'finanzas', name: 'Finanzas' },
    { id: 'cobros', name: 'Cobros', parentId: 'finanzas' },
    { id: 'archivo', name: 'Archivo' },
  ],
  processes: [{ id: 'alta', name: 'Alta de pedido' }],
  applications: [
    { id: 'web', name: 'Tienda web', criticality: 'critical' },
    { id: 'erp', name: 'ERP', criticality: 'high', lifecycle: 'sunset', technology: 'SAP' },
    { id: 'pagos', name: 'Pagos', criticality: 'low' },
    { id: 'suelta', name: 'Suelta' },
  ],
  relations: [
    { id: 'a', kind: 'supports', sourceId: 'web', targetId: 'carrito' },
    { id: 'b', kind: 'supports', sourceId: 'pagos', targetId: 'pagos-online', description: 'tarjetas' },
    { id: 'c', kind: 'supports', sourceId: 'web', targetId: 'tiendas' },
    { id: 'd', kind: 'supports', sourceId: 'erp', targetId: 'tiendas' },
    { id: 'e', kind: 'supports', sourceId: 'erp', targetId: 'alta' },
    { id: 'f', kind: 'realizes', sourceId: 'alta', targetId: 'cobros' },
    { id: 'g', kind: 'supports', sourceId: 'erp', targetId: 'finanzas' },
  ],
});

/** Lo que la matriz conserva, comparable entre documentos: por nombres, no por ids. */
function byNames(doc: EnterpriseDocument): { capabilities: Array<[string, string | undefined]>; applications: string[]; supports: string[] } {
  const capabilityName = new Map(doc.capabilities.map((c) => [c.id, c.name]));
  const applicationName = new Map(doc.applications.map((a) => [a.id, a.name]));
  return {
    capabilities: doc.capabilities.map((c) => [c.name, c.parentId ? capabilityName.get(c.parentId) : undefined]),
    applications: doc.applications.map((a) => a.name),
    supports: doc.relations
      .filter((r) => r.kind === 'supports' && capabilityName.has(r.targetId))
      .map((r) => `${applicationName.get(r.sourceId)} → ${capabilityName.get(r.targetId)}`)
      .sort(),
  };
}

/** El orden en que el export coloca las capacidades: el del árbol, cada una tras su padre. */
const inTreeOrder = (doc: EnterpriseDocument): EnterpriseDocument => ({ ...doc, capabilities: buildMatrix(doc).rows.map((r) => r.capability) });

const matrixText = (doc: EnterpriseDocument): string => toMermaid(doc, { viewId: 'matrix' });
const direct = (doc: EnterpriseDocument): number => [...buildMatrix(doc).cells.values()].filter((c) => c.support === 'direct').length;
const count = (doc: EnterpriseDocument, support: 'process' | 'inherited'): number => [...buildMatrix(doc).cells.values()].filter((c) => c.support === support).length;

describe('importar la matriz capacidad × aplicación (block-beta)', () => {
  it('ida y vuelta: las mismas capacidades (con su jerarquía), aplicaciones y relaciones «soporta» directas, comparadas por nombre', () => {
    for (const original of [grid, example]) {
      const { document, warnings } = fromMermaid(matrixText(original));
      const expected = byNames(inTreeOrder(original));
      expect(byNames(document)).toEqual(expected);
      expect(document.relations).toHaveLength(direct(original));
      expect(document.relations.every((r) => r.kind === 'supports')).toBe(true);
      expect(expected.supports.length).toBeGreaterThan(0);
      // Lo que el formato no lleva se cuenta en los avisos: no hay más que las celdas derivadas y el resumen.
      expect(warnings).toHaveLength(1 + (count(original, 'process') > 0 ? 1 : 0) + (count(original, 'inherited') > 0 ? 1 : 0));
    }
  });

  it('ida y vuelta de un documento con la jerarquía a tres niveles: el padre es la capacidad anterior de un nivel menos', () => {
    const { document } = fromMermaid(matrixText(grid));
    const parentOf = (name: string): string | undefined => {
      const c = document.capabilities.find((x) => x.name === name)!;
      return document.capabilities.find((x) => x.id === c.parentId)?.name;
    };
    expect(parentOf('Ventas')).toBeUndefined();
    expect(parentOf('Ventas online')).toBe('Ventas');
    expect(parentOf('Carrito')).toBe('Ventas online');
    expect(parentOf('Pagos')).toBe('Ventas online');
    expect(parentOf('Tiendas físicas')).toBe('Ventas');
    expect(parentOf('Finanzas')).toBeUndefined();
    expect(parentOf('Cobros')).toBe('Finanzas');
    expect(document.capabilities.map((c) => c.name)).toEqual(['Ventas', 'Ventas online', 'Carrito', 'Pagos', 'Tiendas físicas', 'Finanzas', 'Cobros', 'Archivo']);
  });

  it('cada ● es una relación «soporta» de la aplicación de su columna a la capacidad de su fila, y los ids salen del nombre', () => {
    const { document } = fromMermaid(matrixText(grid));
    // «Pagos» es a la vez una capacidad y una aplicación: los ids son únicos entre tipos, como en los demás importadores
    // (las aplicaciones van en la primera fila del texto, así que se quedan con el id libre).
    expect(document.applications.map((a) => a.id)).toEqual(['tienda-web', 'erp', 'pagos', 'suelta']);
    expect(document.capabilities.map((c) => c.id)).toEqual(['ventas', 'ventas-online', 'carrito', 'pagos-2', 'tiendas-fisicas', 'finanzas', 'cobros', 'archivo']);
    expect(document.relations).toEqual([
      { id: 'tienda-web--supports--carrito', kind: 'supports', sourceId: 'tienda-web', targetId: 'carrito' },
      { id: 'pagos--supports--pagos-2', kind: 'supports', sourceId: 'pagos', targetId: 'pagos-2' },
      { id: 'tienda-web--supports--tiendas-fisicas', kind: 'supports', sourceId: 'tienda-web', targetId: 'tiendas-fisicas' },
      { id: 'erp--supports--tiendas-fisicas', kind: 'supports', sourceId: 'erp', targetId: 'tiendas-fisicas' },
      { id: 'erp--supports--finanzas', kind: 'supports', sourceId: 'erp', targetId: 'finanzas' },
    ]);
    // Importar dos veces el mismo texto da el mismo documento.
    expect(fromMermaid(matrixText(grid)).document).toEqual(document);
  });

  it('las celdas ○ y · no son relaciones y se avisa de ellas, con el recuento', () => {
    const { document, warnings } = fromMermaid(matrixText(grid));
    // «ERP» soporta «Alta de pedido», que realiza «Cobros»: ○ en Cobros × ERP. Las agrupaciones heredan de sus hijas: · en las filas con hijas.
    expect(count(grid, 'process')).toBe(1);
    expect(count(grid, 'inherited')).toBeGreaterThan(1);
    expect(warnings).toContain('1 celda ○ (soporte por un proceso que realiza la capacidad) no se importan como relaciones: la matriz no dice qué proceso es («Cobros» × «ERP»).');
    expect(warnings).toContain(`${count(grid, 'inherited')} celdas · (soporte heredado de una capacidad hija) no se importan: se derivan de las celdas de sus hijas.`);
    expect(document.relations.some((r) => r.targetId === 'cobros')).toBe(false);
    expect(document.processes).toEqual([]);
    // Y lo que el formato no puede llevar se dice una vez.
    expect(warnings.at(-1)).toMatch(/^Solo se importan los nombres, la jerarquía de capacidades y el soporte directo \(●\): .*la criticidad, el ciclo de vida/);
  });

  it('con muchas celdas ○ el aviso enseña unas pocas', () => {
    const wide = parse({
      capabilities: [{ id: 'c', name: 'C' }, ...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, name: `Real ${i}` }))],
      processes: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })),
      applications: [{ id: 'app', name: 'App' }],
      relations: Array.from({ length: 5 }, (_, i) => [
        { id: `s${i}`, kind: 'supports', sourceId: 'app', targetId: `p${i}` },
        { id: `z${i}`, kind: 'realizes', sourceId: `p${i}`, targetId: `r${i}` },
      ]).flat(),
    });
    const { warnings } = fromMermaid(matrixText(wide));
    expect(warnings.find((w) => w.includes('celdas ○'))).toBe('5 celdas ○ (soporte por un proceso que realiza la capacidad) no se importan como relaciones: la matriz no dice qué proceso es («Real 0» × «App»; «Real 1» × «App»; «Real 2» × «App»…).');
  });

  it('lo que el formato pierde no se recupera, y se dice: ids, criticidad, ciclo de vida, pila y criterios; el resto del modelo no aparece', () => {
    const { document } = fromMermaid(matrixText(grid));
    expect(document.applications.find((a) => a.name === 'ERP')).toEqual({ id: 'erp', name: 'ERP' });
    expect(document.relations.find((r) => r.targetId === 'pagos-2')).not.toHaveProperty('description');
    expect(document.capabilities.find((c) => c.name === 'Ventas')).toEqual({ id: 'ventas', name: 'Ventas' });
    expect(document.units).toEqual([]);
    expect(document.technologies).toEqual([]);
    // Los ids ya no son los del original (salen del nombre).
    expect(document.applications.map((a) => a.id)).not.toEqual(grid.applications.map((a) => a.id));
  });

  it('el nombre sale de la opción, del título del frontmatter o del archivo, y si no, el de siempre', () => {
    const text = matrixText(grid);
    expect(fromMermaid(`---\ntitle: Mi matriz\n---\n${text}`).document.workspace.name).toBe('Mi matriz');
    expect(fromMermaid(`---\ntitle: Mi matriz\n---\n${text}`, { name: ' Otro ' }).document.workspace.name).toBe('Otro');
    expect(fromMermaid(text, { fallbackName: 'matriz' }).document.workspace.name).toBe('matriz');
    expect(fromMermaid(text).document.workspace.name).toBe('Arquitectura empresarial');
    // También dentro de un bloque de Markdown.
    expect(byNames(fromMermaid(`\`\`\`mermaid\n${text}\`\`\`\n`).document)).toEqual(byNames(inTreeOrder(grid)));
  });

  it('lee las entradas en el orden del texto, como Mermaid: el salto de línea no importa', () => {
    const text = matrixText(grid);
    const [head, columns, ...rest] = text.split('\n');
    expect(head).toBe('block-beta');
    const entries = rest.filter((l) => !/^\s*(classDef|class|%%)/.test(l) && l.trim());
    const oneLine = [head, columns, `    ${entries.map((l) => l.trim()).join(' ')}`].join('\n');
    expect(byNames(fromMermaid(oneLine).document)).toEqual(byNames(fromMermaid(text).document));
    // También con el nombre nuevo de Mermaid y sin estilos.
    expect(byNames(fromMermaid(oneLine.replace('block-beta', 'block')).document)).toEqual(byNames(fromMermaid(text).document));
  });

  it('un nombre con comillas pierde el tipo de comilla en el export, y lo que se escribe a mano se lee igual', () => {
    const quoted = parse({ capabilities: [{ id: 'a', name: 'Ventas "premium"' }], applications: [{ id: 'b', name: 'App "uno"' }], relations: [{ id: 'r', kind: 'supports', sourceId: 'b', targetId: 'a' }] });
    const { document } = fromMermaid(matrixText(quoted));
    expect(document.capabilities[0].name).toBe("Ventas 'premium'");
    expect(document.applications[0].name).toBe("App 'uno'");
    expect(document.relations).toHaveLength(1);
  });

  it('un bloque escrito a mano: marcas desconocidas, sangría que salta un nivel y líneas que no se entienden van a los avisos', () => {
    const { document, warnings } = fromMermaid(`block-beta
      columns 4
      space:1 a["CRM"] b["ERP"] total["Total"]
      r1["Ventas"] c1["●"] c2["x"] t1["1"]
      r2["›› Nieto"] d1[" "] d2["●"] t2["1"]
      r3["› Hijo"] e1["●"] e2[""] t3["1"]
      block:grupo
      a --> b
      totals["Total"] f1["1"] f2["2"] all["3"]
    `);
    expect(document.capabilities).toEqual([
      { id: 'ventas', name: 'Ventas' },
      { id: 'nieto', name: 'Nieto', parentId: 'ventas' },
      { id: 'hijo', name: 'Hijo', parentId: 'ventas' },
    ]);
    expect(document.relations.map((r) => `${r.sourceId} → ${r.targetId}`)).toEqual(['crm → ventas', 'erp → nieto', 'crm → hijo']);
    expect(warnings).toContain('línea 4: la marca «x» de «Ventas» × «ERP» no es ●, ○ ni ·; se omite.');
    expect(warnings).toContain('línea 5: «Nieto» tiene sangría de nivel 2 pero no cuelga de una capacidad de nivel 1; se importa como hija de «Ventas».');
    expect(warnings).toContain('línea 7: no se entiende «block:grupo»; se omite.');
    expect(warnings).toContain('línea 8: no se entiende «a --> b»; se omite.');
  });

  it('una sangría sin capacidad padre se importa en la raíz con aviso', () => {
    const { document, warnings } = fromMermaid('block-beta\n columns 3\n space:1 a["A"] total["Total"]\n r["› Huérfana"] c["●"] t["1"]\n totals["Total"] f["1"] all["1"]');
    expect(document.capabilities).toEqual([{ id: 'huerfana', name: 'Huérfana' }]);
    expect(warnings).toContain('línea 4: «Huérfana» tiene sangría de nivel 1 pero no cuelga de una capacidad de nivel 0; se importa sin capacidad padre.');
  });

  it('una columna o una fila sin nombre se omiten con sus marcas y se avisa', () => {
    const { document, warnings } = fromMermaid('block-beta\n columns 4\n space:1 a[""] b["B"] total["Total"]\n r1["R1"] c["●"] d["●"] t["2"]\n r2[""] e["●"] f["●"] u["2"]\n totals["Total"] x["1"] y["2"] all["3"]');
    expect(document.applications.map((a) => a.name)).toEqual(['B']);
    expect(document.capabilities.map((c) => c.name)).toEqual(['R1']);
    expect(document.relations).toHaveLength(1);
    expect(warnings).toContain('línea 3: la columna 1 no tiene el nombre de una aplicación; se omite con sus marcas.');
    expect(warnings).toContain('línea 5: la fila no tiene el nombre de una capacidad; se omite con sus marcas.');
  });

  it('una matriz sin la fila de totales también se lee', () => {
    const { document } = fromMermaid('block-beta\n columns 3\n space:1 a["A"] total["Total"]\n r["R"] c["●"] t["1"]\n s["S"] d[" "] u["0"]');
    expect(document.capabilities.map((c) => c.name)).toEqual(['R', 'S']);
    expect(document.relations).toHaveLength(1);
  });

  describe('lo roto lanza el error del módulo', () => {
    const broken: Array<[string, string, RegExp]> = [
      ['sin «columns»', 'block-beta\n space:1 a["A"] total["Total"]\n r["R"] c["●"] t["1"]', /falta «columns N»/],
      ['«columns» que no es un número', 'block-beta\n columns tres\n space:1 a["A"] total["Total"]', /línea 2: «columns tres» no indica un número de columnas/],
      ['con menos de tres columnas', 'block-beta\n columns 2\n space:1 a["A"]\n r["R"] c["●"]', /al menos tres columnas.*declara 2/],
      ['con una cuadrícula que no es rectangular', 'block-beta\n columns 3\n space:1 a["A"] total["Total"]\n r["R"] c["●"]', /Las 5 entradas del diagrama no forman filas de 3 columnas/],
      ['sin la fila de capacidades', 'block-beta\n columns 3\n space:1 a["A"] total["Total"]', /no tiene filas de capacidades/],
      ['sin hueco en la esquina', 'block-beta\n columns 3\n x["X"] a["A"] total["Total"]\n r["R"] c["●"] t["1"]', /línea 3: la primera fila de la matriz empieza con un hueco/],
      ['con bloques de varias columnas', 'block-beta\n columns 3\n space:1 a["A"]:2\n r["R"] c["●"] t["1"]', /línea 3: un bloque que ocupa varias columnas \(«:2»\)/],
      ['sin nada que importar', 'block-beta\n columns 3\n space:1 a[""] total["Total"]\n r[""] c["●"] t["1"]', /no define ninguna capacidad ni aplicación/],
      ['vacío', 'block-beta', /no tiene filas de capacidades|falta «columns N»/],
    ];
    for (const [name, text, message] of broken) {
      it(name, () => {
        expect(() => fromMermaid(text)).toThrow(EnterpriseImportError);
        expect(() => fromMermaid(text)).toThrow(message);
      });
    }

    it('es un error de módulo, como el de los demás importadores', () => {
      expect(new EnterpriseImportError('x')).toBeInstanceOf(ModuleError);
    });
  });
});

describe('el importador de Mermaid reconoce el block-beta sin confundirlo', () => {
  const importer = enterpriseModule.importers.find((i) => i.id === 'mermaid')!;
  const text = matrixText(grid);
  const flowchart = toMermaid(example, { viewId: 'landscape' });
  const capabilities = toMermaid(example, { viewId: 'capabilities' });

  it('el bloque lo reconoce `detect` del importador de Mermaid, y no el detector común de la suite ni el de ArchiMate', () => {
    expect(looksLikeMatrixBlock(text)).toBe(true);
    expect(importer.detect!(text)).toBe(true);
    expect(importer.detect!(`---\ntitle: Matriz\n---\n${text}`)).toBe(true);
    expect(importer.detect!(`\`\`\`mermaid\n${text}\`\`\``)).toBe(true);
    expect(looksLikeArchimate(text)).toBe(false);
    expect(enterpriseModule.importers.find((i) => i.id === 'archimate')!.detect!(text)).toBe(false);
  });

  it('un flowchart no es una matriz, ni el de la matriz un flowchart', () => {
    for (const flow of [flowchart, capabilities, 'graph TD\n a --> b', 'flowchart LR\n a[A]']) {
      expect(looksLikeMatrixBlock(flow)).toBe(false);
      expect(importer.detect!(flow)).toBe(true);
    }
    expect(fromMermaid(flowchart).document.technologies.length).toBeGreaterThan(0);
    expect(fromMermaid(capabilities).document.applications).toEqual([]);
    expect(fromMermaid(text).document.technologies).toEqual([]);
  });

  it('un modelo de ArchiMate no es Mermaid y lo reconoce su importador', () => {
    expect(importer.detect!(archimate)).toBe(false);
    expect(looksLikeMatrixBlock(archimate)).toBe(false);
    expect(enterpriseModule.importers.find((i) => i.detect!(archimate))?.id).toBe('archimate');
    expect(enterpriseModule.importers.find((i) => i.detect!(text))?.id).toBe('mermaid');
    expect(enterpriseModule.importers.find((i) => i.detect!(flowchart))?.id).toBe('mermaid');
  });

  it('otros textos no son un bloque', () => {
    for (const other of ['', '   ', 'sequenceDiagram\n A->>B: hola', 'erDiagram\n A ||--o{ B : x', '{"version":"1.0"}', 'blocks\n x', 'blockchain\n x']) expect(looksLikeMatrixBlock(other)).toBe(false);
  });

  it('el registro del módulo la elige por la extensión y por el contenido, y `importText` la importa', async () => {
    const registry = new ModuleRegistry().register(enterpriseModule);
    expect(registry.detectImporter('enterprise', 'matriz.mmd', text)?.id).toBe('mermaid');
    expect(registry.detectImporter('enterprise', undefined, text)?.id).toBe('mermaid');
    expect(registry.detectImporter('enterprise', 'modelo.xml', archimate)?.id).toBe('archimate');
    const imported = await importText(enterpriseModule as never, text, undefined, { fallbackName: 'matriz' });
    expect(imported.importer).toBe('mermaid');
    expect(byNames(imported.document as EnterpriseDocument)).toEqual(byNames(inTreeOrder(grid)));
    expect(imported.warnings.length).toBeGreaterThan(0);
  });

  it('un block-beta que no es la matriz da el error del módulo, no «formato desconocido»', async () => {
    await expect(importText(enterpriseModule as never, 'block-beta\n  columns 1\n  a["A"]')).rejects.toThrow(EnterpriseImportError);
  });

  it('los demás tipos de diagrama siguen sin importarse, y el mensaje cuenta ahora qué se admite', () => {
    expect(() => fromMermaid('erDiagram\n A ||--o{ B : x')).toThrow(/Se admiten flowchart\/graph y el block-beta de la matriz capacidad × aplicación/);
    expect(() => fromMermaid('pie title x\n "a": 1')).toThrow(/block-beta \(matriz capacidad × aplicación\)/);
  });

  it('la vista de la matriz sigue siendo la que se exporta', () => {
    expect(findView(grid, 'matrix').type).toBe('matrix');
    expect(text.split('\n')[0]).toBe('block-beta');
  });
});
