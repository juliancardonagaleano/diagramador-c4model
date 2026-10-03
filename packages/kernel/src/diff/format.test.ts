import { describe, expect, it } from 'vitest';
import { diffDocuments } from './diff';
import { diffSummaryLine, formatDiffJson, formatDiffMarkdown, formatDiffText, formatValue } from './format';

const before = {
  version: '1.0',
  workspace: { name: 'Tienda' },
  nodes: [
    { id: 'web', kind: 'system', name: 'Web', tags: ['a', 'b'] },
    { id: 'api', kind: 'service', name: 'API' },
    { id: 'db', kind: 'database', name: 'Base de datos' },
  ],
};

const after = (): typeof before => {
  const b = structuredClone(before);
  b.workspace.name = 'Tienda 2';
  b.nodes[0].tags = ['b', 'c'];
  b.nodes[1].name = 'API pública';
  b.nodes.pop();
  b.nodes.push({ id: 'cache', kind: 'database', name: 'Caché' } as never);
  return b;
};

describe('formatDiffText', () => {
  it('lista por colección lo añadido (+), quitado (−) y modificado (~) con sus campos antes → después', () => {
    const text = formatDiffText(diffDocuments(before, after()), { subtitle: 'v1.json → v2.json' });
    expect(text).toBe(
      [
        'v1.json → v2.json',
        '1 añadido, 1 quitado, 3 modificados (3 campos).',
        '',
        'documento',
        '  ~ workspace.name: "Tienda" → "Tienda 2"',
        '',
        'nodes',
        '  + Caché (cache) · database',
        '  − Base de datos (db) · database',
        '  ~ Web (web) · system',
        '      tags: +c −a',
        '  ~ API pública (api) · service',
        '      name: "API" → "API pública"',
        '',
      ].join('\n'),
    );
  });

  it('sin cambios dice «Sin cambios.»', () => {
    expect(formatDiffText(diffDocuments(before, structuredClone(before)))).toBe('Sin cambios.\n');
  });

  it('los reordenamientos se resumen en una línea por lista y avisan de que no cuentan', () => {
    const reordered = structuredClone(before);
    reordered.nodes.reverse();
    const d = diffDocuments(before, reordered);
    expect(diffSummaryLine(d)).toBe('Sin cambios de contenido (2 elementos reordenados).');
    expect(formatDiffText(d)).toContain('↕ 2 elementos reordenados (solo cambia el orden');
  });

  it('recorta los valores largos y resume las listas', () => {
    expect(formatValue(undefined)).toBe('(sin valor)');
    expect(formatValue('x'.repeat(200)).length).toBe(80);
    expect(formatValue('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(formatValue([1, 2, 3, 4, 5, 6, 7, 8])).toBe('[1, 2, 3, 4, 5, 6, … (+2)]');
    expect(formatValue([{ id: 'a', name: 'Uno' }])).toBe('[Uno]');
    expect(formatValue(null)).toBe('null');
  });
});

describe('formatDiffMarkdown', () => {
  it('da Markdown listo para una PR: apartado por lista, código en línea y escapes', () => {
    const b = after();
    b.nodes[1].name = 'API *pública* [v2]';
    const md = formatDiffMarkdown(diffDocuments(before, b), { subtitle: '`v1.json` → `v2.json`' });
    expect(md).toContain('## Cambios entre versiones');
    expect(md).toContain('`v1.json` → `v2.json`');
    expect(md).toContain('**1 añadido, 1 quitado, 3 modificados (3 campos).**');
    expect(md).toContain('### `nodes`');
    expect(md).toContain('- **Añadido:** Caché (`cache`) · database');
    expect(md).toContain('- **Quitado:** Base de datos (`db`) · database');
    expect(md).toContain('- **Modificado:** Web (`web`) · system\n  - `tags`: +`c` −`a`');
    expect(md).toContain('  - `name`: `"API"` → `"API *pública* [v2]"`');
    expect(md).toContain('- **Modificado:** API \\*pública\\* \\[v2\\] (`api`) · service');
    expect(md).toContain('### `documento`\n\n- **Modificado:** `workspace.name`: `"Tienda"` → `"Tienda 2"`');
  });

  it('sin cambios, un apartado vacío con el resumen', () => {
    expect(formatDiffMarkdown(diffDocuments(before, before), { title: 'Diferencias' })).toBe('## Diferencias\n\n**Sin cambios.**\n');
  });
});

describe('formatDiffJson', () => {
  it('es el DocumentDiff tal cual, con salto de línea final', () => {
    const d = diffDocuments(before, after());
    const json = formatDiffJson(d);
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(d)));
  });
});
