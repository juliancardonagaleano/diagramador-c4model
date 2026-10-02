import { describe, expect, it } from 'vitest';
import example from '../../../examples/seguridad-ejemplo.json';
import { securityCommands } from './commands';
import { securityEditor } from './editor';
import { toDrawio } from './export/drawio';
import { toMermaid } from './export/mermaid';
import { heatLayout, toSvg } from './export/render';
import { analyzeSecurity } from './issues';
import { securityModule } from './module';
import { threatCoverage } from './modeling';
import { findView, listViews, standardsInUse, surfaceDepths, viewRefs } from './views';
import { IMPACTS, LIKELIHOODS, LIKELIHOOD_LABELS, RATING_LABELS, heatCellId, residualOf, type SecurityDocument } from './types';

const doc = securityModule.schema.parse(example) as SecurityDocument;
const valid = (d: SecurityDocument): boolean => securityModule.schema.safeParse(d).success;
const messages = (d: SecurityDocument): string[] => analyzeSecurity(d).map((i) => i.message);
/** El ejemplo con estándares en algunos controles. */
const withStandards: SecurityDocument = {
  ...doc,
  controls: doc.controls.map((c) => (c.id === 'mfa' || c.id === 'tls-borde' ? { ...c, standard: 'asvs' as const } : c.id === 'cifrado-reposo' ? { ...c, standard: 'nist-800-53' as const } : c)),
};

/** Ejecuta un comando del CLI sobre un documento y devuelve su salida. */
const run = (name: string, input: unknown, options: Record<string, unknown> = {}): string =>
  securityCommands.find((c) => c.name === name)!.run({ args: [], options, input: typeof input === 'string' ? input : JSON.stringify(input) }) as string;

describe('riesgo residual', () => {
  const threat = (id: string) => doc.threats.find((t) => t.id === id)!;
  it('un control implementado baja la probabilidad; dos o más, también el impacto; los previstos no cuentan', () => {
    // inyección-sql: media × crítico con dos controles implementados -> baja × alto.
    expect(residualOf(doc, threat('inyeccion-sql'))).toMatchObject({ likelihood: 'low', impact: 'high', score: 3, rating: 'medium', implemented: 2, reduced: true });
    // robo-credenciales: alta × alta con mfa (prevista) y limitación (implementada) -> media × alta.
    expect(residualOf(doc, threat('robo-credenciales'))).toMatchObject({ likelihood: 'medium', impact: 'high', implemented: 1 });
    // idor-pedidos: su único control está previsto -> sin cambios.
    expect(residualOf(doc, threat('idor-pedidos'))).toMatchObject({ likelihood: 'medium', impact: 'high', implemented: 0, reduced: false });
    // Sin controles no cambia; y nunca baja de «baja» / «bajo».
    expect(residualOf(doc, threat('correo-en-claro')).reduced).toBe(false);
    expect(residualOf(doc, threat('repudio-pedido'))).toMatchObject({ likelihood: 'low', impact: 'medium' });
  });
});

describe('matriz de calor', () => {
  it('es una vista con variante residual y sus doce celdas, cada amenaza en la suya', () => {
    expect(listViews(doc).map((v) => v.id)).toContain('heatmap');
    expect(viewRefs(doc).filter((v) => v.variantOf === 'heatmap')).toMatchObject([{ id: 'heatmap:residual', variantLabel: 'Residual' }]);
    const g = securityEditor.project(doc, 'heatmap');
    expect(g.nodes.filter((n) => n.kind === 'cell')).toHaveLength(12);
    expect(g.nodes.find((n) => n.id === 'inyeccion-sql')).toMatchObject({ parentId: 'cell:medium:critical' });
    expect(g.nodes.find((n) => n.id === 'robo-credenciales')).toMatchObject({ parentId: 'cell:high:high' });
    expect(g.nodes.find((n) => n.id === 'inyeccion-sql')?.badges?.join(' ')).toContain('residual');
    const residual = securityEditor.project(doc, 'heatmap:residual');
    expect(residual.nodes.find((n) => n.id === 'inyeccion-sql')).toMatchObject({ parentId: 'cell:low:high', dashed: true });
    expect(residual.nodes.filter((n) => n.kind === 'threat')).toHaveLength(doc.threats.length);
  });

  it('el layout propio coloca 3 filas × 4 columnas con cada amenaza dentro de su celda', () => {
    const layout = heatLayout(doc, findView(doc, 'heatmap'));
    expect(layout.groups).toHaveLength(12);
    expect(layout.nodes).toHaveLength(doc.threats.length);
    const cell = (id: string) => layout.groups.find((g) => g.id === id)!;
    expect(cell('cell:high:low').y).toBe(0);
    expect(cell('cell:low:critical').x).toBeGreaterThan(cell('cell:low:low').x);
    for (const n of layout.nodes) {
      const g = layout.groups.find((x) => x.x <= n.x && n.x + n.width <= x.x + x.width && x.y <= n.y && n.y + n.height <= x.y + x.height);
      expect(g).toBeDefined();
    }
  });

  it('arrastrar una amenaza a otra celda (o sobre otra amenaza) cambia su probabilidad e impacto', () => {
    const moved = securityEditor.drop!(doc, 'idor-pedidos', 'cell:low:low', 'heatmap');
    if (!moved?.ok) throw new Error('drop');
    expect(moved.document.threats.find((t) => t.id === 'idor-pedidos')).toMatchObject({ likelihood: 'low', impact: 'low' });
    expect(valid(moved.document)).toBe(true);
    const onThreat = securityEditor.drop!(doc, 'idor-pedidos', 'robo-credenciales', 'heatmap');
    if (!onThreat?.ok) throw new Error('drop');
    expect(onThreat.document.threats.find((t) => t.id === 'idor-pedidos')).toMatchObject({ likelihood: 'high', impact: 'high' });
    // Misma celda, otra vista o algo que no es una amenaza: no significa nada.
    expect(securityEditor.drop!(doc, 'idor-pedidos', 'cell:medium:high', 'heatmap')).toBeUndefined();
    expect(securityEditor.drop!(doc, 'idor-pedidos', 'cell:low:low', 'threats')).toBeUndefined();
    expect(securityEditor.drop!(doc, 'cell:low:low', 'cell:low:high', 'heatmap')).toBeUndefined();
  });

  it('en la matriz residual no se arrastra: se explica por qué', () => {
    const result = securityEditor.drop!(doc, 'inyeccion-sql', 'cell:high:high', 'heatmap:residual');
    expect(result).toMatchObject({ ok: false });
    expect(result && !result.ok && result.reason).toMatch(/residual/);
  });

  it('las celdas se leen, no tienen campos y no se borran', () => {
    expect(securityEditor.read(doc, 'cell:high:high')).toMatchObject({ type: 'node', kind: 'cell' });
    expect(securityEditor.fields({ type: 'node', kind: 'cell' }, doc)).toEqual([]);
    expect(securityEditor.remove(doc, 'cell:high:high')).toMatchObject({ ok: false });
    expect(securityEditor.nodeKinds.find((k) => k.kind === 'cell')).toMatchObject({ container: true, addable: false });
  });

  it('se exporta a SVG, Mermaid y draw.io (las celdas vacías no entran en Mermaid)', async () => {
    for (const id of ['heatmap', 'heatmap:residual']) {
      const svg = await toSvg(doc, id);
      expect(svg).toContain('<svg');
      expect(svg).toContain('prob. alta × impacto alto');
    }
    const mermaid = toMermaid(doc, { viewId: 'heatmap' });
    expect(mermaid).toContain('subgraph');
    expect(mermaid).not.toMatch(/subgraph [^\n]+\n\s*end/);
    expect(await toDrawio(doc)).toContain('Matriz de calor');
  });

  it('avisa si el riesgo residual sigue siendo alto o crítico pese a los controles implementados', () => {
    expect(messages(doc).filter((m) => /riesgo residual/.test(m))).toHaveLength(1);
    expect(messages(doc).some((m) => /Inyección|inyección/.test(m) && /riesgo residual/.test(m))).toBe(false);
    const worse: SecurityDocument = { ...doc, threats: doc.threats.map((t) => (t.id === 'inyeccion-sql' ? { ...t, likelihood: 'high', impact: 'critical', controlIds: ['waf-owasp'] } : t)) };
    expect(messages(worse).some((m) => /mantiene riesgo residual crítico \(8\) pese a 1 control implementado/.test(m))).toBe(true);
  });
});

describe('cobertura de estándares', () => {
  it('solo es una vista si algún control remite a un estándar', () => {
    expect(listViews(doc).map((v) => v.id)).not.toContain('standards');
    expect(() => findView(doc, 'standards:asvs')).toThrow(/No existe la vista/);
    expect(listViews(withStandards).map((v) => v.id)).toContain('standards');
    expect(standardsInUse(withStandards)).toEqual(['asvs', 'nist-800-53']);
    expect(viewRefs(withStandards).filter((v) => v.variantOf === 'standards').map((v) => v.id)).toEqual(['standards:asvs', 'standards:nist-800-53']);
  });

  it('agrupa los controles por catálogo y marca las amenazas cubiertas, con cobertura prevista y sin cobertura', () => {
    const g = securityEditor.project(withStandards, 'standards');
    expect(g.nodes.filter((n) => n.kind === 'catalog').map((n) => n.id)).toEqual(['std:asvs', 'std:nist-800-53']);
    expect(g.nodes.find((n) => n.id === 'mfa')).toMatchObject({ parentId: 'std:asvs' });
    const note = (id: string) => g.nodes.find((n) => n.id === id)?.badges?.join(' ');
    expect(note('interceptacion')).toContain('cubierta');
    expect(note('robo-credenciales')).toContain('cobertura prevista');
    expect(note('correo-en-claro')).toContain('sin cobertura');
    const asvs = securityEditor.project(withStandards, 'standards:asvs');
    expect(asvs.nodes.find((n) => n.id === 'exfiltracion-db')?.badges?.join(' ')).toContain('sin cobertura en OWASP ASVS');
    expect(asvs.nodes.some((n) => n.id === 'cifrado-reposo')).toBe(false);
  });

  it('se exporta y avisa de las amenazas sin estándar', async () => {
    expect(await toSvg(withStandards, 'standards')).toContain('OWASP ASVS');
    expect(toMermaid(withStandards, { viewId: 'standards:asvs' })).toContain('subgraph');
    expect(await toDrawio(withStandards)).toContain('Cobertura de estándares');
    expect(messages(withStandards).some((m) => /no está cubierta por ningún control que remita a un estándar/.test(m))).toBe(true);
    expect(messages(doc).some((m) => /no está cubierta por ningún control que remita/.test(m))).toBe(false);
  });
});

describe('superficie de ataque', () => {
  it('muestra los activos expuestos a una zona no confiable, el radio de alcance y los flujos de entrada', () => {
    expect(listViews(doc).map((v) => v.id)).toContain('surface');
    expect(surfaceDepths(doc)).toMatchObject({ cliente: 0, 'waf-lb': 1, 'tienda-web': 2, pedidos: 3 });
    const g = securityEditor.project(doc, 'surface');
    expect(g.nodes.find((n) => n.id === 'waf-lb')?.badges?.join(' ')).toContain('expuesto');
    expect(g.nodes.find((n) => n.id === 'pedidos')?.badges?.join(' ')).toMatch(/2 saltos.*a proteger/);
    expect(g.edges.find((e) => e.id === 'cliente-navega')).toMatchObject({ width: 3.5 });
  });

  it('se exporta y avisa de lo que se alcanza desde fuera', async () => {
    expect(await toSvg(doc, 'surface')).toContain('expuesto: entrada directa');
    expect(toMermaid(doc, { viewId: 'surface' })).toContain('flowchart');
    const direct: SecurityDocument = { ...doc, flows: [...doc.flows, { id: 'directo', sourceId: 'cliente', targetId: 'pedidos', encrypted: true, authentication: 'token' }] };
    expect(messages(direct).some((m) => /a proteger y recibe flujos directamente desde una zona no confiable/.test(m))).toBe(true);
  });
});

describe('comando heatmap', () => {
  const lines = (text: string): string[] => text.split('\n');

  it('imprime la matriz probabilidad × impacto con el número de amenazas por celda y las de cada celda no vacía', () => {
    const text = run('heatmap', example);
    expect(lines(text)[0]).toBe('Matriz de calor - Seguridad de la tienda en línea');
    expect(lines(text).filter((l) => l.startsWith('| '))).toEqual([
      '| Probabilidad \\ Impacto | bajo | medio | alto | crítico |',
      '| alta | 0 | 1 | 1 | 0 |',
      '| media | 0 | 1 | 2 | 2 |',
      '| baja | 0 | 1 | 1 | 1 |',
    ]);
    // Solo las celdas no vacías, de mayor a menor riesgo, con sus amenazas; las reducidas por controles llevan la marca residual.
    expect(lines(text).filter((l) => l.startsWith('- '))).toEqual([
      '- prob. alta × impacto alto · riesgo crítico (9) · 1 amenaza',
      '- prob. media × impacto crítico · riesgo crítico (8) · 2 amenazas',
      '- prob. alta × impacto medio · riesgo alto (6) · 1 amenaza',
      '- prob. media × impacto alto · riesgo alto (6) · 2 amenazas',
      '- prob. media × impacto medio · riesgo medio (4) · 1 amenaza',
      '- prob. baja × impacto crítico · riesgo medio (4) · 1 amenaza',
      '- prob. baja × impacto alto · riesgo medio (3) · 1 amenaza',
      '- prob. baja × impacto medio · riesgo bajo (2) · 1 amenaza',
    ]);
    expect(text).toContain('  - Robo de credenciales de clientes (credential stuffing) · Suplantación · Cliente · abierta · residual ↓ alto (6) con 1 control');
    expect(text).toContain('  - Acceso a pedidos de otros clientes (IDOR) · Elevación de privilegios · Servicio de pedidos · abierta\n');
    expect(text).toContain('Amenazas: 10 · por riesgo: 3 crítico, 3 alto, 3 medio, 1 bajo · con riesgo residual menor que el inherente: 6');
  });

  it('con --residual coloca las amenazas donde quedan tras los controles implementados y dice de dónde vienen', () => {
    const text = run('heatmap', example, { residual: true });
    expect(lines(text)[0]).toBe('Matriz de calor (riesgo residual) - Seguridad de la tienda en línea');
    expect(lines(text).filter((l) => l.startsWith('| '))).toEqual([
      '| Probabilidad \\ Impacto | bajo | medio | alto | crítico |',
      '| alta | 0 | 0 | 0 | 0 |',
      '| media | 0 | 2 | 2 | 0 |',
      '| baja | 0 | 1 | 5 | 0 |',
    ]);
    expect(text).toContain('- prob. baja × impacto alto · riesgo medio (3) · 5 amenazas');
    expect(text).toContain('  - Inyección SQL en el servicio de pedidos · Manipulación · Servicio de pedidos · mitigada · residual ↓ desde crítico (8) · 2 controles');
    expect(text).toContain('Amenazas: 10 · por riesgo residual: 0 crítico, 2 alto, 7 medio, 1 bajo · con riesgo residual menor que el inherente: 6');
  });

  it('coloca cada amenaza en la misma celda que la vista de la matriz de calor del lienzo', () => {
    for (const [viewId, residual] of [['heatmap', false], ['heatmap:residual', true]] as const) {
      const text = run('heatmap', example, { residual });
      const canvas = securityEditor.project(doc, viewId);
      for (const l of [...LIKELIHOODS].reverse()) {
        const counts = IMPACTS.map((i) => canvas.nodes.filter((n) => n.kind === 'threat' && n.parentId === heatCellId(l, i)).length);
        expect(lines(text)).toContain(`| ${LIKELIHOOD_LABELS[l]} | ${counts.join(' | ')} |`);
      }
      for (const t of doc.threats) {
        const cell = canvas.nodes.find((n) => n.id === t.id)!.parentId!;
        const [, l, i] = cell.split(':');
        const header = lines(text).findIndex((x) => x.startsWith(`- prob. ${LIKELIHOOD_LABELS[l as (typeof LIKELIHOODS)[number]]} × impacto ${RATING_LABELS[i as (typeof IMPACTS)[number]]} `));
        expect(header).toBeGreaterThan(-1);
        const next = lines(text).findIndex((x, k) => k > header && !x.startsWith('  - '));
        expect(lines(text).slice(header + 1, next).some((x) => x.startsWith(`  - ${t.title} · `))).toBe(true);
      }
    }
  });

  it('sin amenazas lo dice y las entradas inválidas fallan con un mensaje claro', () => {
    expect(run('heatmap', { ...doc, threats: [] })).toBe('El documento no define amenazas.');
    expect(() => run('heatmap', 'no es json')).toThrow(/no es JSON válido/);
  });
});

describe('comando standards', () => {
  const lines = (text: string): string[] => text.split('\n');

  it('sin controles con estándar dice que no hay cobertura que mostrar', () => {
    expect(run('standards', example)).toMatch(/^Ningún control remite a un estándar/);
  });

  it('resume cada catálogo y detalla sus controles y qué amenazas cubre, con cobertura prevista o sin cobertura', () => {
    const text = run('standards', withStandards);
    expect(lines(text)[0]).toBe('Cobertura de estándares - Seguridad de la tienda en línea');
    expect(lines(text).filter((l) => /^\| (OWASP|NIST|Todos)/.test(l))).toEqual([
      '| OWASP ASVS | 2 | 1 | 1 | 8 |',
      '| NIST 800-53 | 1 | 1 | 0 | 9 |',
      '| Todos los estándares | 3 | 2 | 1 | 7 |',
    ]);
    expect(lines(text).filter((l) => l.startsWith('## '))).toEqual(['## OWASP ASVS · 2 controles', '## NIST 800-53 · 1 control']);
    expect(text).toContain('| Autenticación multifactor para clientes | Autenticación | prevista | 1 amenaza |');
    expect(text).toContain('| TLS 1.3 obligatorio en el borde | Cifrado | implementada | 1 amenaza |');
    // Cubierta por un control implementado del catálogo; con cobertura prevista (el otro control no tiene estándar); sin cobertura.
    expect(text).toMatch(/\| medio \(3\) \| Interceptación del tráfico del cliente \| Navegación y compra \| mitigada \| cubierta \| TLS 1\.3 obligatorio en el borde \|/);
    expect(text).toMatch(/\| crítico \(9\) \| Robo de credenciales de clientes \(credential stuffing\) \| Cliente \| abierta \| cobertura prevista \| Autenticación multifactor para clientes \(prevista\) \|/);
    expect(text).toContain('| medio (4) | Correos con datos del pedido en claro | Confirmación del pedido | abierta | sin cobertura | — |');
    expect(text).toContain('Cubiertas: 1 · Con cobertura prevista: 1 · Sin cobertura: 8');
  });

  it('con --catalogo solo muestra ese catálogo (sin distinguir mayúsculas), con los huecos respecto a él', () => {
    const text = run('standards', withStandards, { catalogo: 'ASVS' });
    expect(lines(text)[0]).toBe('Cobertura de estándares (OWASP ASVS) - Seguridad de la tienda en línea');
    expect(text).toContain('TLS 1.3 obligatorio en el borde');
    expect(text).not.toContain('Cifrado en reposo');
    expect(text).not.toContain('## ');
    // Una amenaza cubierta por otro catálogo sigue sin cobertura en este.
    expect(text).toContain('| crítico (8) | Exfiltración de datos personales de la base de pedidos | Base de pedidos | mitigada | sin cobertura | — |');
    expect(run('standards', withStandards, { catalogo: 'nist-800-53' })).toContain('| cubierta | Cifrado en reposo con claves gestionadas (KMS) |');
  });

  it('cuenta lo mismo que la vista de cobertura de estándares del lienzo', () => {
    for (const standard of standardsInUse(withStandards)) {
      const view = findView(withStandards, `standards:${standard}`);
      const canvas = securityEditor.project(withStandards, view.id);
      const count = (note: string): number => canvas.nodes.filter((n) => n.kind === 'threat' && n.badges?.join(' ').includes(note)).length;
      const covered = withStandards.threats.filter((t) => threatCoverage(withStandards, view.controlIds, t).level === 'covered').length;
      expect(covered).toBe(count('cubierta en'));
      const text = run('standards', withStandards, { catalogo: standard });
      expect(text).toContain(`Cubiertas: ${count('cubierta en')} · Con cobertura prevista: ${count('cobertura prevista en')} · Sin cobertura: ${count('sin cobertura en')}`);
    }
  });

  it('threatCoverage solo cuenta los controles del conjunto y distingue implementados de previstos', () => {
    const robo = withStandards.threats.find((t) => t.id === 'robo-credenciales')!;
    // mfa (prevista, ASVS) y limitación de tasa (implementada, sin estándar).
    expect(threatCoverage(withStandards, findView(withStandards, 'standards:asvs').controlIds, robo)).toMatchObject({ level: 'planned', controls: [{ id: 'mfa' }] });
    expect(threatCoverage(withStandards, [...findView(withStandards, 'standards:asvs').controlIds, 'limitacion-tasa'], robo).level).toBe('covered');
    expect(threatCoverage(withStandards, findView(withStandards, 'standards:nist-800-53').controlIds, robo)).toEqual({ level: 'none', controls: [] });
  });

  it('avisa si el catálogo no lo usa ningún control y rechaza uno desconocido', () => {
    expect(run('standards', withStandards, { catalogo: 'cis' })).toBe('Ningún control remite a CIS Controls. Estándares en uso: OWASP ASVS, NIST 800-53.');
    expect(() => run('standards', withStandards, { catalogo: 'pci' })).toThrow(/Catálogo inválido «pci». Use: asvs, nist-800-53, iso-27001, cis\./);
  });
});
