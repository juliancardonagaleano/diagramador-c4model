import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { describe, expect, it } from 'vitest';

const cli = ['node_modules/.bin/tsx', 'src/cli/index.ts'];
const example = 'examples/banca.json';

function run(args: string[], input?: string) {
  return spawnSync(cli[0], [cli[1], ...args], { input, encoding: 'utf8' });
}

describe('c4diagram (CLI)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c4cli-'));

  it('layout escribe coordenadas en todas las vistas', () => {
    const out = join(dir, 'laid.json');
    const r = run(['layout', example, '--out', out, '--direction', 'right']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(readFileSync(out, 'utf8'));
    for (const v of doc.views) for (const e of v.elements) expect(typeof e.x).toBe('number');
  });

  it('convert produce un .drawio válido con una página por vista (desde stdin, con bloque de código)', () => {
    const input = '```json\n' + readFileSync(example, 'utf8') + '\n```';
    const r = run(['convert', '--stdin', '--locale', 'en'], input);
    expect(r.status).toBe(0);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(r.stdout);
    expect([].concat(parsed.mxfile.diagram)).toHaveLength(3);
    expect(r.stdout).toContain('System Scope Boundary');
  });

  it('validate devuelve código 2 con un documento inválido y 0 con uno válido', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ model: { elements: [{ id: 'a', type: 'component', name: 'A' }], relationships: [{ id: 'r', sourceId: 'a', targetId: 'b' }] } }));
    const r = run(['validate', bad]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/destino inexistente/);
    const ok = run(['validate', example]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Documento válido/);
  });

  it('schema, prompt y example imprimen contenido útil', () => {
    expect(JSON.parse(execFileSync(cli[0], [cli[1], 'schema'], { encoding: 'utf8' })).type).toBe('object');
    expect(JSON.parse(execFileSync(cli[0], [cli[1], 'schema', '--generation'], { encoding: 'utf8' })).properties.views).toBeDefined();
    const prompt = execFileSync(cli[0], [cli[1], 'prompt', 'Un sistema de reservas', '--from', example], { encoding: 'utf8' });
    expect(prompt).toContain('Un sistema de reservas');
    expect(prompt).toContain('"cliente"');
    expect(JSON.parse(execFileSync(cli[0], [cli[1], 'example'], { encoding: 'utf8' })).views).toHaveLength(3);
  });

  it('errores conocidos (vista inexistente, sin vistas) terminan en un mensaje de una línea, sin stack', () => {
    const r1 = run(['convert', example, '--view', 'no-existe']);
    expect(r1.status).toBe(3);
    expect(r1.stderr).not.toMatch(/\n\s+at /); // sin stack trace
    expect(r1.stderr.trim().split('\n').at(-1)).toBe('El documento no tiene vistas que exportar');

    const r2 = run(['layout', example, '--view', 'no-existe']);
    expect(r2.status).not.toBe(0);
    expect(r2.stderr).toMatch(/no existe/);
    expect(r2.stderr).not.toMatch(/\n\s+at /);

    const empty = join(dir, 'empty.json');
    writeFileSync(empty, JSON.stringify({ version: '1.0', workspace: { name: 'x' }, model: { elements: [], relationships: [] }, views: [] }));
    const r3 = run(['convert', empty]);
    expect(r3.status).not.toBe(0);
    expect(r3.stderr).toMatch(/no tiene vistas/);
    expect(r3.stderr).not.toMatch(/\n\s+at /);
  });

  it('--spacing, --layer-spacing y --retries rechazan valores inválidos con un mensaje claro', () => {
    const bad1 = run(['layout', example, '--spacing', 'abc']);
    expect(bad1.status).not.toBe(0);
    expect(bad1.stderr).toMatch(/separación/i);

    const bad2 = run(['layout', example, '--spacing', '-5']);
    expect(bad2.status).not.toBe(0);
    expect(bad2.stderr).toMatch(/separación/i);

    const bad3 = run(['layout', example, '--layer-spacing', 'NaN']);
    expect(bad3.status).not.toBe(0);
    expect(bad3.stderr).toMatch(/separación/i);

    const bad4 = run(['generate', 'algo', '--retries', '-1']);
    expect(bad4.status).not.toBe(0);
    expect(bad4.stderr).toMatch(/reintentos/i);

    const ok = run(['layout', example, '--spacing', '80', '--layer-spacing', '120']);
    expect(ok.status).toBe(0);
  });

  it('generate falla con un mensaje claro sin credenciales', () => {
    const r = spawnSync(cli[0], [cli[1], 'generate', 'Una tienda'], {
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_PROFILE: 'inexistente-c4-test', HOME: dir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Error generando el modelo/);
  });
});

describe('c4diagram import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c4import-'));
  const ids = (items: Array<{ id: string }>) => items.map((i) => i.id).sort();

  it('importa un .drawio a JSON válido (stdout limpio, resumen por stderr) con el nombre del archivo', () => {
    const r = run(['import', 'examples/banca-c4.drawio']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.workspace.name).toBe('banca-c4');
    expect(doc.model.elements).toHaveLength(13);
    expect(doc.model.relationships).toHaveLength(19);
    expect(doc.views.map((v: { id: string; type: string; scopeId: string }) => [v.id, v.type, v.scopeId])).toEqual([
      ['contexto', 'systemContext', 'banca'],
      ['contenedores', 'container', 'banca'],
      ['componentes-api', 'component', 'api'],
    ]);
    expect(r.stderr).toMatch(/Importado "banca-c4": 13 elementos, 19 relaciones, 3 vistas\./);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('--out escribe el archivo y --name fija el nombre del diagrama', () => {
    const out = join(dir, 'nested', 'banca.json');
    const r = run(['import', 'examples/banca-tarjetas.drawio', '--out', out, '--name', 'Mi banca']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8')).workspace.name).toBe('Mi banca');
    expect(r.stderr).toContain(`Documento C4 escrito en ${out}`);
  });

  it('convert → import recupera los ids del documento original (ida y vuelta por el CLI)', () => {
    const drawio = run(['convert', example]);
    expect(drawio.status).toBe(0);
    const r = run(['import', '--stdin'], drawio.stdout);
    expect(r.status).toBe(0);
    const original = JSON.parse(readFileSync(example, 'utf8'));
    const imported = JSON.parse(r.stdout);
    expect(ids(imported.model.elements)).toEqual(ids(original.model.elements));
    expect(ids(imported.model.relationships)).toEqual(ids(original.model.relationships));
    expect(imported.views.map((v: { id: string }) => v.id)).toEqual(original.views.map((v: { id: string }) => v.id));
    // Y el resultado se valida y se encadena con el resto de comandos.
    expect(run(['validate', '--stdin'], r.stdout).status).toBe(0);
  });

  it('avisa por stderr de lo que no puede importar sin ensuciar el JSON de stdout', () => {
    const xml =
      '<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="A" value="Alfa" style="html=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>' +
      '<mxCell id="N" value="Una nota" style="text;html=1;" vertex="1" parent="1"><mxGeometry x="0" y="200" width="120" height="30" as="geometry"/></mxCell>' +
      '</root></mxGraphModel></diagram></mxfile>';
    const r = run(['import', '--stdin'], xml);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).model.elements).toHaveLength(1);
    expect(r.stderr).toMatch(/aviso: Página «P»: se omitieron 1 nota\(s\) de texto suelto\./);
    expect(r.stderr).toMatch(/1 vistas, 1 aviso\(s\)|1 vistas, 1 aviso/);
  });

  it('lee un stdin grande que llega despacio y por trozos (un pipe con productor lento no falla con EAGAIN)', async () => {
    let cells = '';
    for (let i = 0; i < 1500; i += 1) {
      cells += `<mxCell id="C${i}" value="Elemento ${i}" style="html=1;" vertex="1" parent="1"><mxGeometry x="${(i % 30) * 150}" y="${Math.floor(i / 30) * 90}" width="120" height="60" as="geometry"/></mxCell>`;
    }
    const xml = `<mxfile><diagram id="p" name="Grande"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells}</root></mxGraphModel></diagram></mxfile>`;
    expect(xml.length).toBeGreaterThan(200 * 1024); // varios bloques de lectura de 64 KB
    const child = spawn(cli[0], [cli[1], 'import', '--stdin']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const exit = new Promise<number | null>((resolve) => child.on('close', resolve));
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    await pause(1500); // el lector ya está esperando datos cuando empieza a llegar la entrada
    const half = Math.floor(xml.length / 2);
    child.stdin.write(xml.slice(0, half));
    await pause(400);
    child.stdin.end(xml.slice(half));
    expect(await exit, stderr).toBe(0);
    expect(JSON.parse(stdout).model.elements).toHaveLength(1500);
  }, 60000);

  it('los errores son mensajes de una línea con código 2 (no un stack), y un archivo inexistente, código 1', () => {
    const notDrawio = join(dir, 'no-drawio.drawio');
    writeFileSync(notDrawio, '<html><body>hola</body></html>');
    const r1 = run(['import', notDrawio]);
    expect(r1.status).toBe(2);
    expect(r1.stderr.trim()).toMatch(/^No se pudo importar el \.drawio: No parece un archivo de draw\.io/);
    expect(r1.stderr).not.toMatch(/\n\s+at /);

    const empty = join(dir, 'vacio.drawio');
    writeFileSync(empty, '');
    const r2 = run(['import', empty]);
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/El archivo está vacío/);

    const r3 = run(['import', join(dir, 'no-existe.drawio')]);
    expect(r3.status).toBe(1);
    expect(r3.stderr).toMatch(/No se pudo leer/);
    expect(r3.stderr).not.toMatch(/\n\s+at /);
  });
});
