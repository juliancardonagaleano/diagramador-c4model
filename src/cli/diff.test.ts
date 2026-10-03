import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from '../../tests/helpers/cliBundle';

// `iark diff` como proceso: se empaqueta el CLI una vez (como se publica) y se ejecuta con `node`.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

let bundle: CliBundle;
beforeAll(async () => {
  bundle = await buildCliBundle('diff');
});
afterAll(() => bundle?.dispose());

const example = (file: string): string => readFileSync(`examples/${file}`, 'utf8');
const run = (args: string[], options: { input?: string; cwd?: string } = {}) => spawnSync(process.execPath, [bundle.cli, ...args], { encoding: 'utf8', input: options.input, cwd: options.cwd });

const tmp = mkdtempSync(join(tmpdir(), 'iark-diff-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const write = (name: string, content: string | object): string => {
  const file = join(tmp, name);
  writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  return file;
};

/** La versión nueva de la banca: un elemento renombrado y con campo nuevo, uno añadido, una relación quitada, coordenadas movidas. */
function bancaV2(): Record<string, any> {
  const doc = JSON.parse(example('banca.json'));
  doc.model.elements.find((e: { id: string }) => e.id === 'cliente').name = 'Cliente particular';
  doc.model.elements.push({ id: 'auditoria', type: 'container', name: 'Auditoría', parentId: 'banca', technology: 'Kafka' });
  doc.model.relationships.shift();
  doc.views[0].layout = { direction: 'RIGHT' };
  for (const view of doc.views) for (const e of view.elements) Object.assign(e, { x: 5, y: 5, width: 300, height: 140 });
  return doc;
}

describe('iark diff: dos archivos', () => {
  it('muestra lo añadido, quitado y modificado de un documento C4, y la maquetación no cuenta', () => {
    const r = run(['diff', 'examples/banca.json', write('banca-v2.json', bancaV2())]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('examples/banca.json → ');
    expect(r.stdout).toContain('1 añadido, 1 quitado, 1 modificado (1 campo).');
    expect(r.stdout).toContain('model.elements\n  + Auditoría (auditoria) · container\n  ~ Cliente particular (cliente) · person\n      name: "Cliente personal" → "Cliente particular"');
    expect(r.stdout).toMatch(/model\.relationships\n {2}− .* → .* \(r1\)/);
    expect(r.stdout).not.toContain('layout');
    expect(r.stdout).not.toMatch(/\bx\b/);
  });

  it('con documentos iguales dice «Sin cambios.» y sale con 0 incluso con --exit-code', () => {
    const r = run(['diff', 'examples/banca.json', 'examples/banca.json', '--exit-code']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n').at(-1)).toBe('Sin cambios.');
  });

  it('sale con 0 aunque haya cambios, y con 1 solo con --exit-code (como git diff)', () => {
    const v2 = write('banca-exit.json', bancaV2());
    expect(run(['diff', 'examples/banca.json', v2]).status).toBe(0);
    const r = run(['diff', 'examples/banca.json', v2, '--exit-code']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('modificado');
  });

  it('--format markdown da Markdown para una PR y --format json, el DocumentDiff', () => {
    const v2 = write('banca-fmt.json', bancaV2());
    const md = run(['diff', 'examples/banca.json', v2, '--format', 'markdown']);
    expect(md.status).toBe(0);
    expect(md.stdout).toContain('## Cambios entre versiones');
    expect(md.stdout).toContain('### `model.elements`');
    expect(md.stdout).toContain('- **Añadido:** Auditoría (`auditoria`) · container');
    expect(md.stdout).toContain('  - `name`: `"Cliente personal"` → `"Cliente particular"`');

    const json = JSON.parse(run(['diff', 'examples/banca.json', v2, '--format', 'json']).stdout);
    expect(json.summary).toMatchObject({ added: 1, removed: 1, changed: 1, total: 3 });
    expect(json.added).toEqual([{ collection: 'model.elements', id: 'auditoria', label: 'Auditoría', kind: 'container' }]);
    expect(json.changed[0].fields).toEqual([{ path: 'name', before: 'Cliente personal', after: 'Cliente particular' }]);
    expect(Object.keys(json)).toEqual(['added', 'removed', 'changed', 'moved', 'summary']);
  });

  it('--out escribe el resultado en un archivo en lugar de stdout', () => {
    const out = join(tmp, 'cambios.md');
    const r = run(['diff', 'examples/banca.json', write('banca-out.json', bancaV2()), '--format', 'markdown', '--out', out]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(readFileSync(out, 'utf8')).toContain('### `model.elements`');
  });

  it('--module compara los documentos de otro módulo (con lo que el módulo declara: los pasos de un flujo son una secuencia)', () => {
    const v2 = JSON.parse(example('pedidos-integracion.json'));
    v2.nodes[0].technology = 'Vue';
    v2.flows[0].steps.reverse();
    const r = run(['diff', 'examples/pedidos-integracion.json', write('pedidos-v2.json', v2), '--module', 'integration']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('2 modificados (2 campos).');
    expect(r.stdout).toMatch(/nodes\n {2}~ Tienda web \(tienda-web\) · system\n {6}technology: .* → "Vue"/);
    expect(r.stdout).toContain('flows\n  ~ Crear un pedido (crear-pedido)\n      steps: [web-gw, gw-api,');
    for (const [module, file] of [['security', 'seguridad-ejemplo.json'], ['data', 'ventas-datos.json'], ['enterprise', 'empresa-arquitectura.json'], ['platform', 'plataforma-ejemplo.json']]) {
      const same = run(['diff', `examples/${file}`, `examples/${file}`, '--module', module, '--exit-code']);
      expect(same.status, `${module}: ${same.stderr}`).toBe(0);
      expect(same.stdout).toContain('Sin cambios.');
    }
  });

  it('acepta los formatos de entrada que importa el módulo (Mermaid) y la entrada estándar (-)', () => {
    const edited = example('banca.mmd').replace('"API", "Node.js"', '"API", "Go"');
    const r = run(['diff', 'examples/banca.mmd', write('banca-v2.mmd', edited)]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('technology: "Node.js" → "Go"');

    const fromStdin = run(['diff', '-', 'examples/banca.json', '--exit-code'], { input: '```json\n' + example('banca.json') + '\n```' });
    expect(fromStdin.status).toBe(0);
    expect(fromStdin.stdout).toContain('entrada estándar → examples/banca.json');
    expect(run(['diff', '-', '-'], { input: '{}' }).stderr).toContain('Solo uno de los dos');
  });

  it('un documento inválido termina con 2 diciendo cuál de los dos es; también si no es JSON o no se puede leer', () => {
    const bad = write('malo.json', { version: '1.0', workspace: { name: 'X' }, model: { elements: [{ id: 'a', type: 'component', name: 'A' }], relationships: [{ id: 'r', sourceId: 'a', targetId: 'b' }] }, views: [] });
    const first = run(['diff', bad, 'examples/banca.json']);
    expect(first.status).toBe(2);
    expect(first.stderr).toContain('La versión anterior (');
    expect(first.stderr).toMatch(/destino inexistente/);
    const second = run(['diff', 'examples/banca.json', bad, '--exit-code']);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain('La versión nueva (');

    const other = run(['diff', 'examples/seguridad-ejemplo.json', write('roto.json', '{ no es json'), '--module', 'security']);
    expect(other.status).toBe(2);
    expect(other.stderr).toContain('no es JSON válido');
    const wrongModule = run(['diff', 'examples/seguridad-ejemplo.json', write('seg-malo.json', { zones: [{ id: 'z', name: 'Z', trust: 'x' }] }), '--module', 'security']);
    expect(wrongModule.status).toBe(2);
    expect(wrongModule.stderr).toContain('no es un documento válido para el módulo «security»');
    const missing = run(['diff', 'examples/banca.json', join(tmp, 'no-existe.json'), '--exit-code']);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('No se pudo leer');
  });

  it('pide los dos documentos o --rev, y rechaza un módulo y un formato desconocidos', () => {
    expect(run(['diff', 'examples/banca.json'])).toMatchObject({ status: 2 });
    expect(run(['diff', 'examples/banca.json']).stderr).toContain('Indique los dos documentos');
    expect(run(['diff', 'examples/banca.json', 'examples/banca.json', '--module', 'nada']).status).toBe(2);
    const format = run(['diff', 'examples/banca.json', 'examples/banca.json', '--format', 'xml']);
    expect(format.status).not.toBe(0);
    expect(format.stderr).toContain('Formato inválido «xml». Use: text, markdown, json.');
  });

  it('documenta lo visible en --help', () => {
    const help = run(['diff', '--help']).stdout;
    for (const text of ['--rev <revisión>', '--module <id>', '--format <formato>', '--exit-code', 'maquetación', 'revisión de git']) expect(help).toContain(text);
    expect(run(['--help']).stdout).toContain('diff [options] <antes> [después]');
  });
});

describe('iark diff --rev: un archivo contra su versión en git', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  /** Un repositorio temporal con dos commits de `banca.json` (el segundo renombra el cliente) y una copia de trabajo con más cambios. */
  function repo(): string {
    const dir = mkdtempSync(join(tmp, 'repo-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'banca.json'), example('banca.json'));
    git(dir, 'add', 'banca.json');
    git(dir, 'commit', '-q', '-m', 'v1');
    git(dir, 'tag', 'v1');
    const second = JSON.parse(example('banca.json'));
    second.model.elements.find((e: { id: string }) => e.id === 'cliente').name = 'Cliente particular';
    writeFileSync(join(dir, 'banca.json'), `${JSON.stringify(second, null, 2)}\n`);
    git(dir, 'commit', '-q', '-am', 'v2');
    const working = structuredClone(second);
    working.model.elements.push({ id: 'auditoria', type: 'container', name: 'Auditoría', parentId: 'banca' });
    writeFileSync(join(dir, 'banca.json'), `${JSON.stringify(working, null, 2)}\n`);
    return dir;
  }

  it('compara la copia de trabajo con HEAD, con una etiqueta y con HEAD~1; el archivo se da relativo al directorio actual', () => {
    const dir = repo();
    const head = run(['diff', 'banca.json', '--rev', 'HEAD', '--exit-code'], { cwd: dir });
    expect(head.status).toBe(1);
    expect(head.stdout).toContain('banca.json @ HEAD → banca.json, copia de trabajo');
    expect(head.stdout).toContain('1 añadido.');
    expect(head.stdout).toContain('+ Auditoría (auditoria) · container');
    expect(head.stdout).not.toContain('Cliente');

    const tag = run(['diff', 'banca.json', '--rev', 'v1', '--format', 'json'], { cwd: dir });
    expect(tag.status).toBe(0);
    const json = JSON.parse(tag.stdout);
    expect(json.added.map((e: { id: string }) => e.id)).toEqual(['auditoria']);
    expect(json.changed[0].fields).toEqual([{ path: 'name', before: 'Cliente personal', after: 'Cliente particular' }]);

    expect(run(['diff', 'banca.json', '--rev', 'HEAD~1'], { cwd: dir }).stdout).toContain('1 añadido, 1 modificado (1 campo).');
    // También con la ruta del archivo desde fuera del repositorio.
    expect(run(['diff', join(dir, 'banca.json'), '--rev', 'v1', '--exit-code']).status).toBe(1);
  });

  it('sin cambios respecto a la revisión, no hay diferencias', () => {
    const dir = repo();
    git(dir, 'commit', '-q', '-am', 'v3');
    const r = run(['diff', 'banca.json', '--rev', 'HEAD', '--exit-code'], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Sin cambios.');
  });

  it('errores claros con código 2: no es un repositorio, la revisión no existe, el archivo no estaba en ella', () => {
    const dir = repo();
    const outside = mkdtempSync(join(tmpdir(), 'iark-diff-sin-git-'));
    try {
      writeFileSync(join(outside, 'banca.json'), example('banca.json'));
      const notRepo = run(['diff', 'banca.json', '--rev', 'HEAD', '--exit-code'], { cwd: outside });
      expect(notRepo.status).toBe(2);
      expect(notRepo.stderr).toContain('no está dentro de un repositorio de git');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }

    const unknown = run(['diff', 'banca.json', '--rev', 'no-existe', '--exit-code'], { cwd: dir });
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toBe('La revisión «no-existe» no existe en este repositorio.\n');

    writeFileSync(join(dir, 'nuevo.json'), example('banca.json'));
    const absent = run(['diff', 'nuevo.json', '--rev', 'v1', '--exit-code'], { cwd: dir });
    expect(absent.status).toBe(2);
    expect(absent.stderr).toBe('«nuevo.json» no estaba en la revisión «v1».\n');

    expect(run(['diff', 'banca.json', '--rev', '--exit-code'], { cwd: dir }).status).not.toBe(0);
    const option = run(['diff', 'banca.json', '--rev=--output=x', '--exit-code'], { cwd: dir });
    expect(option.status).toBe(2);
    expect(option.stderr).toContain('no es válida');

    const gone = run(['diff', 'borrado.json', '--rev', 'HEAD', '--exit-code'], { cwd: dir });
    expect(gone.status).toBe(2);
    expect(gone.stderr).toContain('No se pudo leer');
  });

  it('--rev compara UN archivo: con dos, o con la entrada estándar, es un error de uso', () => {
    const dir = repo();
    const two = run(['diff', 'banca.json', 'banca.json', '--rev', 'HEAD'], { cwd: dir });
    expect(two.status).toBe(2);
    expect(two.stderr).toContain('Con --rev se compara un solo archivo');
    expect(run(['diff', '-', '--rev', 'HEAD'], { cwd: dir, input: '{}' }).status).toBe(2);
  });

  it('funciona con el resto de módulos', () => {
    const dir = mkdtempSync(join(tmp, 'repo-seg-'));
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'seguridad.json'), example('seguridad-ejemplo.json'));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'seguridad');
    const doc = JSON.parse(example('seguridad-ejemplo.json'));
    doc.threats[0].status = 'mitigated';
    writeFileSync(join(dir, 'seguridad.json'), JSON.stringify(doc));
    const r = run(['diff', 'seguridad.json', '--rev', 'HEAD', '--module', 'security', '--format', 'markdown', '--exit-code'], { cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('### `threats`');
    expect(r.stdout).toContain('`status`');
  });
});
