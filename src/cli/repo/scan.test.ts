import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { ALL_FAKE_VALUES, copyFixtureRepo, FAKE, makeRepo, plantSecrets, removeRepo } from '../../../tests/helpers/repoFixture';
import { CliError } from '../io';
import { formatReport, formatSummary } from './format';
import { redactSecrets } from './redact';
import { scanRepo, type RepoDigest } from './scan';

const dirs: string[] = [];
function repo(files: Record<string, string | Buffer>): string {
  const dir = makeRepo(files);
  dirs.push(dir);
  return dir;
}
afterAll(() => dirs.forEach(removeRepo));

const omittedPaths = (d: RepoDigest, reason: string): string[] => d.omitted.filter((o) => o.reason === reason).map((o) => o.path);
const paths = (d: RepoDigest): string[] => d.included.map((f) => f.path);
/** El texto de un archivo dentro del resumen (sin su cabecera). */
function blockOf(d: RepoDigest, path: string): string {
  const start = d.text.indexOf(`===== ${path} [`);
  expect(start, `${path} no está en el resumen`).toBeGreaterThanOrEqual(0);
  const body = d.text.slice(d.text.indexOf('] =====\n', start) + '] =====\n'.length);
  const end = body.search(/\n===== |\n<<<|$/);
  return body.slice(0, end);
}

describe('scanRepo: qué se recorre y qué no', () => {
  const dir = repo({
    'README.md': '# Proyecto\nUsa Postgres.\n',
    'package.json': '{"name":"x","dependencies":{"express":"4"}}',
    'src/index.ts': 'console.log(1);\n',
    'node_modules/dep/index.js': 'MARCA_NODE_MODULES\n',
    'node_modules/dep/package.json': '{"name":"MARCA_NODE_MODULES"}',
    'dist/app.js': 'MARCA_DIST\n',
    'build/out.js': 'MARCA_BUILD\n',
    'target/classes/A.txt': 'MARCA_TARGET\n',
    'vendor/lib/x.go': 'MARCA_VENDOR\n',
    '__pycache__/m.pyc.txt': 'MARCA_PYCACHE\n',
    '.venv/lib/x.py': 'MARCA_VENV\n',
    'coverage/lcov.info': 'MARCA_COVERAGE\n',
    '.git/HEAD': 'ref: refs/heads/main\n',
    'package-lock.json': '{"lockfileVersion":3,"MARCA_LOCK":1}',
    'yarn.lock': '# MARCA_YARN\n',
    'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
    'docs/diagrama.svg': '<svg>MARCA_SVG</svg>',
    'datos.bin': Buffer.from([1, 2, 0, 3]),
  });
  const digest = scanRepo(dir);

  it('no entra en dependencias, compilaciones, cachés ni .git, y lo dice', () => {
    for (const marker of ['MARCA_NODE_MODULES', 'MARCA_DIST', 'MARCA_BUILD', 'MARCA_TARGET', 'MARCA_VENDOR', 'MARCA_PYCACHE', 'MARCA_VENV', 'MARCA_COVERAGE', 'MARCA_LOCK', 'MARCA_YARN', 'MARCA_SVG']) {
      expect(digest.text).not.toContain(marker);
    }
    expect(omittedPaths(digest, 'excluida').sort()).toEqual(['.git/', '__pycache__/', '.venv/', 'build/', 'coverage/', 'dist/', 'node_modules/', 'target/', 'vendor/'].sort());
  });

  it('omite lockfiles, imágenes y binarios con su motivo', () => {
    expect(omittedPaths(digest, 'lockfile').sort()).toEqual(['package-lock.json', 'yarn.lock']);
    expect(omittedPaths(digest, 'imagen').sort()).toEqual(['docs/diagrama.svg', 'logo.png']);
    expect(omittedPaths(digest, 'binario')).toEqual(['datos.bin']);
  });

  it('incluye lo que revela la arquitectura y no pasa de ahí', () => {
    expect(paths(digest)).toEqual(['README.md', 'package.json', 'src/index.ts']);
    expect(digest.text).toContain('Usa Postgres.');
    expect(digest.text).toContain('"express":"4"');
    expect(digest.omittedCounts.excluida).toBe(9);
  });

  it('no incluye la ruta absoluta del equipo (solo el nombre de la carpeta)', () => {
    expect(digest.text).not.toContain(dir);
    expect(digest.text).not.toContain(tmpdir());
    expect(digest.name).toBe(dir.split('/').pop());
  });

  it('es determinista', () => {
    expect(scanRepo(dir).text).toBe(digest.text);
  });

  it('también se ve el árbol de carpetas con el número de archivos y los lenguajes', () => {
    expect(digest.text).toContain('## Árbol de carpetas');
    expect(digest.text).toMatch(/src\/ — 1 archivos \(1 \.ts\)/);
    expect(digest.text).toContain('Lenguajes y formatos');
    expect(digest.text).toContain('TypeScript 1');
  });
});

describe('scanRepo: prioridad, topes y presupuesto', () => {
  const files: Record<string, string> = {
    'README.md': '# Sistema\n',
    'package.json': '{"name":"raiz"}',
    'services/a/package.json': '{"name":"a"}',
    'Dockerfile': 'FROM node:20\n',
    'docker-compose.yml': 'services:\n  web:\n    image: x\n',
    'api/openapi.yaml': 'openapi: 3.0.0\ninfo:\n  title: X\n',
    'k8s/deploy.yaml': 'apiVersion: apps/v1\nkind: Deployment\n',
    'infra/main.tf': 'resource "aws_s3_bucket" "b" {}\n',
    '.github/workflows/ci.yml': 'name: ci\non: push\n',
    'db/migrations/001.sql': 'CREATE TABLE t (id int);\n',
    'src/main.ts': 'import x from "x";\n',
    'workspace.dsl': 'workspace {}\n',
    'tests/fixtures/k8s/otro.yaml': 'apiVersion: v1\nkind: Pod\n',
    'docs/architecture.md': '# Arquitectura\n',
    'docs/notas-varias.md': '# Notas\n',
  };

  it('ordena por lo que más revela la arquitectura, lo cercano a la raíz antes y las pruebas al final', () => {
    const d = scanRepo(repo(files));
    const order = paths(d);
    const at = (p: string): number => order.indexOf(p);
    // Documentación y diagramas existentes, luego manifiestos, contenedores, contratos, despliegue, datos, entradas, CI.
    expect(at('README.md')).toBeLessThan(at('package.json'));
    expect(at('docs/architecture.md')).toBeLessThan(at('package.json'));
    expect(at('workspace.dsl')).toBeLessThan(at('package.json'));
    expect(at('package.json')).toBeLessThan(at('services/a/package.json'));
    expect(at('services/a/package.json')).toBeLessThan(at('Dockerfile'));
    expect(at('docker-compose.yml')).toBeLessThan(at('api/openapi.yaml'));
    expect(at('api/openapi.yaml')).toBeLessThan(at('k8s/deploy.yaml'));
    expect(at('k8s/deploy.yaml')).toBeLessThan(at('db/migrations/001.sql'));
    expect(at('db/migrations/001.sql')).toBeLessThan(at('src/main.ts'));
    expect(at('src/main.ts')).toBeLessThan(at('.github/workflows/ci.yml'));
    expect(at('docs/notas-varias.md')).toBeGreaterThan(at('.github/workflows/ci.yml'));
    expect(at('tests/fixtures/k8s/otro.yaml')).toBe(order.length - 1);
    const categories = new Map(d.included.map((f) => [f.path, f.category]));
    expect(categories.get('infra/main.tf')).toBe('despliegue');
    expect(categories.get('workspace.dsl')).toBe('diagramas');
    expect(categories.get('.github/workflows/ci.yml')).toBe('ci');
  });

  it('lo de las carpetas de pruebas solo entra con lo que sobra: no le quita sitio a lo que describe el sistema', () => {
    const f: Record<string, string> = { 'README.md': '# x\n'.repeat(200), 'src/main.ts': 'import x from "x";\n'.repeat(80) };
    for (let i = 0; i < 12; i += 1) f[`tests/fixtures/k8s/p${i}.yaml`] = `apiVersion: v1\nkind: Pod\nmetadata:\n  name: p${i}\n${'# relleno de linea para ocupar sitio\n'.repeat(60)}`;
    const chico = scanRepo(repo(f), { budgetBytes: 6 * 1024 });
    expect(paths(chico)).toContain('src/main.ts');
    expect(paths(chico).filter((p) => p.startsWith('tests/')).length).toBeLessThan(12);
    // Con presupuesto de sobra, las de pruebas también entran (después).
    const grande = scanRepo(repo(f), { budgetBytes: 200 * 1024 });
    expect(paths(grande).filter((p) => p.startsWith('tests/'))).toHaveLength(12);
    expect(paths(grande).indexOf('src/main.ts')).toBeLessThan(paths(grande).indexOf('tests/fixtures/k8s/p0.yaml'));
  });

  it('reconoce un YAML de Kubernetes por su cabecera aunque la ruta no lo diga', () => {
    const d = scanRepo(repo({ 'README.md': '# x\n', 'cosas/algo.yaml': 'apiVersion: v1\nkind: Service\nmetadata:\n  name: x\n', 'cosas/otro.yaml': 'solo: datos\n' }));
    expect(paths(d)).toContain('cosas/algo.yaml');
    expect(paths(d)).not.toContain('cosas/otro.yaml');
  });

  it('recorta cada archivo a su tope y lo dice', () => {
    const readme = `${'línea de README con texto de relleno\n'.repeat(1000)}`; // ≈ 37 KB, tope de README 8 KB
    const d = scanRepo(repo({ 'README.md': readme }));
    const f = d.included[0];
    expect(f.truncated).toBe(true);
    expect(f.bytes).toBeLessThanOrEqual(8 * 1024);
    expect(f.originalBytes).toBe(Buffer.byteLength(readme));
    expect(d.text).toMatch(/README\.md \[documentación; recortado: se muestran \d+ de \d+ bytes\]/);
  });

  it('no abre archivos enormes y los lista como omitidos', () => {
    const d = scanRepo(repo({ 'README.md': '# x\n', 'db/dump.sql': `INSERT INTO t VALUES (1);\n${'-- relleno\n'.repeat(120_000)}` }));
    expect(paths(d)).toEqual(['README.md']);
    expect(omittedPaths(d, 'grande')).toEqual(['db/dump.sql']);
  });

  it('omite lo minificado o generado (líneas enormes)', () => {
    const d = scanRepo(repo({ 'README.md': '# x\n', 'api/openapi.json': `{"openapi":"3.0.0","x":"${'a'.repeat(9000)}"}` }));
    expect(omittedPaths(d, 'generado')).toEqual(['api/openapi.json']);
  });

  it('respeta el presupuesto total: el resumen nunca lo supera y lo que sobra se anota como «presupuesto»', () => {
    const many: Record<string, string> = { 'README.md': '# Sistema\n'.repeat(400) };
    for (let i = 0; i < 40; i += 1) many[`k8s/svc-${String(i).padStart(2, '0')}.yaml`] = `apiVersion: v1\nkind: Service\nmetadata:\n  name: svc-${i}\n${'  # relleno de línea larga para ocupar espacio\n'.repeat(60)}`;
    const dir = repo(many);
    for (const budget of [4 * 1024, 12 * 1024, 30 * 1024]) {
      const d = scanRepo(dir, { budgetBytes: budget });
      expect(d.bytes).toBeLessThanOrEqual(budget);
      expect(Buffer.byteLength(d.text)).toBe(d.bytes);
    }
    const small = scanRepo(dir, { budgetBytes: 12 * 1024 });
    expect(small.included.length).toBeLessThan(41);
    expect(omittedPaths(small, 'presupuesto').length).toBeGreaterThan(0);
    expect(paths(small)).toContain('README.md');
    const big = scanRepo(dir, { budgetBytes: 200 * 1024 });
    expect(big.included.length).toBeGreaterThan(small.included.length);
  });

  it('con el presupuesto por defecto (60 KB) cabe todo lo razonable', () => {
    const d = scanRepo(repo(files));
    expect(d.budget).toBe(60 * 1024);
    expect(d.bytes).toBeLessThan(d.budget);
    expect(d.omittedCounts.presupuesto ?? 0).toBe(0);
  });

  it('respeta el tope de archivos con contenido', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) many[`k8s/svc-${i}.yaml`] = `apiVersion: v1\nkind: Service\nmetadata:\n  name: svc-${i}\n`;
    const d = scanRepo(repo(many), { maxFiles: 5 });
    expect(d.included).toHaveLength(5);
    expect(d.omittedCounts.tope).toBe(25);
  });

  it('corta el recorrido en un repositorio enorme (tope de entradas) y lo avisa', () => {
    const many: Record<string, string> = { 'README.md': '# x\n' };
    for (let i = 0; i < 50; i += 1) many[`src/f${i}.ts`] = 'x\n';
    const d = scanRepo(repo(many), { maxEntries: 20 });
    expect(d.walkTruncated).toBe(true);
    expect(d.text).toContain('recorrido parcial');
    expect(formatReport(d)).toContain('el recorrido se cortó');
  });

  it('limita la profundidad del árbol y reparte las rutas de componentes sin invadir el presupuesto', () => {
    const f: Record<string, string> = { 'README.md': '# x\n' };
    f['a/b/c/d/e/pedidos.controller.ts'] = 'x';
    f['a/b/c/d/e/pedidos.repository.ts'] = 'x';
    f['a/b/c/d/e/pedidos.controller.test.ts'] = 'x';
    f['tests/clientes.controller.ts'] = 'x';
    const d = scanRepo(repo(f));
    expect(d.text).toMatch(/^ {2}a\/ — 3 archivos/m);
    expect(d.text).toMatch(/^ {6}c\/ — 3 archivos/m);
    expect(d.text).not.toMatch(/^ {8}d\/ — /m);
    const section = d.text.split('## Archivos de código cuyo nombre sugiere un componente')[1].split('## Archivos clave')[0];
    expect(section).toContain('a/b/c/d/e/pedidos.controller.ts');
    expect(section).toContain('a/b/c/d/e/pedidos.repository.ts');
    expect(section).not.toContain('.test.ts');
    expect(section).not.toContain('tests/clientes');
  });
});

describe('scanRepo: .gitignore', () => {
  it('respeta .gitignore en la raíz, anidados, con negaciones y anclajes', () => {
    const dir = repo({
      '.gitignore': '*.log\n/generado/\nsecretos-locales/\n!importante.log\n',
      'README.md': '# x\n',
      'app.log': 'MARCA_LOG\n',
      'importante.log': 'x\n',
      'generado/api.yaml': 'openapi: 3.0.0\n# MARCA_GENERADO\n',
      'src/generado/api.yaml': 'openapi: 3.0.0\n# MARCA_SRC_GENERADO\n',
      'secretos-locales/notas.md': 'MARCA_LOCAL\n',
      'modulo/.gitignore': 'interno.md\n',
      'modulo/interno.md': 'MARCA_INTERNO\n',
      'modulo/README.md': '# modulo\n',
      'otro/interno.md': '# otro\n',
    });
    const d = scanRepo(dir);
    expect(d.text).not.toContain('MARCA_LOG');
    expect(d.text).not.toContain('MARCA_GENERADO');
    expect(d.text).not.toContain('MARCA_LOCAL');
    expect(d.text).not.toContain('MARCA_INTERNO');
    expect(d.text).toContain('MARCA_SRC_GENERADO'); // `/generado/` solo ancla a la raíz
    expect(omittedPaths(d, 'ignorado').sort()).toEqual(['app.log', 'generado/', 'modulo/interno.md', 'secretos-locales/']);
    expect(paths(d)).toContain('modulo/README.md');
  });

  it('si la carpeta es una subcarpeta de un repositorio git, también valen los .gitignore de arriba y .git/info/exclude', () => {
    const top = repo({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/info/exclude': 'excluido-local.md\n',
      '.gitignore': 'ignorado-arriba.md\n',
      'servicio/.gitignore': '',
      'servicio/README.md': '# servicio\n',
      'servicio/ignorado-arriba.md': 'MARCA_ARRIBA\n',
      'servicio/excluido-local.md': 'MARCA_EXCLUDE\n',
    });
    const d = scanRepo(join(top, 'servicio'));
    expect(d.text).not.toContain('MARCA_ARRIBA');
    expect(d.text).not.toContain('MARCA_EXCLUDE');
    expect(paths(d)).toEqual(['README.md']);
  });

  it('aunque un .gitignore no ignore un .env, sigue sin leerse', () => {
    const dir = repo({ 'README.md': '# x\n', '.env': `X=${FAKE.envValue}\n` });
    const d = scanRepo(dir);
    expect(d.text).not.toContain(FAKE.envValue);
    expect(omittedPaths(d, 'secreto')).toEqual(['.env']);
  });
});

describe('scanRepo: enlaces simbólicos', () => {
  it('no sigue enlaces fuera de la carpeta (ni a archivos ni a carpetas), ni dentro de ella', () => {
    const outside = mkdtempSync(join(tmpdir(), 'iark-fuera-'));
    dirs.push(outside);
    writeFileSync(join(outside, 'secreto.md'), `# FUERA\n${FAKE.github}\nMARCA_FUERA\n`);
    mkdirSync(join(outside, 'carpeta'));
    writeFileSync(join(outside, 'carpeta', 'README.md'), 'MARCA_CARPETA_FUERA\n');
    const dir = repo({ 'README.md': '# x\n', '.env': `X=${FAKE.envValue}\n`, 'docs/real.md': '# real MARCA_REAL\n' });
    symlinkSync(join(outside, 'secreto.md'), join(dir, 'ARCHITECTURE.md'));
    symlinkSync(join(outside, 'carpeta'), join(dir, 'docs-externos'));
    symlinkSync(join(dir, '.env'), join(dir, 'config-entorno.md')); // dentro de la carpeta, pero apunta a un .env
    symlinkSync(join(dir, 'docs'), join(dir, 'docs-enlace')); // a una carpeta de dentro: tampoco se sigue (evita ciclos)
    symlinkSync(join(dir, 'no-existe'), join(dir, 'roto.md'));
    const d = scanRepo(dir);
    for (const marker of ['MARCA_FUERA', 'MARCA_CARPETA_FUERA', FAKE.github, FAKE.envValue]) expect(d.text).not.toContain(marker);
    expect(omittedPaths(d, 'enlace').sort()).toEqual(['ARCHITECTURE.md', 'config-entorno.md', 'docs-enlace', 'docs-externos', 'roto.md']);
    expect(d.text.match(/MARCA_REAL/g)).toHaveLength(1);
  });
});

describe('scanRepo: secretos', () => {
  const dir = copyFixtureRepo();
  dirs.push(dir);
  plantSecrets(dir);
  const digest = scanRepo(dir);

  it('no deja pasar ni un solo valor secreto al resumen', () => {
    for (const value of ALL_FAKE_VALUES) expect(digest.text, `se coló: ${value.slice(0, 12)}…`).not.toContain(value);
  });

  it('no lee los archivos que se llaman como un secreto y los lista como tales', () => {
    expect(omittedPaths(digest, 'secreto').sort()).toEqual(
      ['.env', '.env.production', '.npmrc', 'config/id_rsa', 'config/server.pem', 'credentials.json', 'infra/terraform.tfstate', 'infra/terraform.tfvars', 'secrets.yaml'].sort(),
    );
    for (const p of omittedPaths(digest, 'secreto')) expect(paths(digest)).not.toContain(p);
  });

  it('ni siquiera pone los NOMBRES de las variables de un .env real', () => {
    expect(digest.text).not.toContain('VARIABLE_SOLO_EN_ENV');
    expect(digest.text).not.toContain('JWT_SECRET');
    expect(digest.text).not.toContain('STRIPE_SECRET');
  });

  it('de un .env.example solo da los nombres de las variables, nunca los valores ni los comentarios', () => {
    const f = digest.included.find((i) => i.path === '.env.example');
    expect(f).toBeDefined();
    expect(f!.category).toBe('env');
    expect(f!.note).toMatch(/solo los nombres/);
    const block = blockOf(digest, '.env.example');
    expect(block).toContain('DATABASE_URL');
    expect(block).toContain('AMQP_URL');
    expect(block).toContain('PUERTO');
    expect(block).not.toContain('postgres://');
    expect(block).not.toContain('guest');
    expect(block).not.toContain('SOLO_COMENTARIO');
    expect(block).not.toContain('3000');
  });

  it('quita los documentos Secret de un YAML de Kubernetes de varios documentos y conserva los demás', () => {
    const block = blockOf(digest, 'k8s/secretos.yaml');
    expect(block).toContain('kind: Deployment');
    expect(block).toContain('kind: Service');
    expect(block).not.toContain('kind: Secret');
    expect(block).not.toContain(FAKE.base64Secret);
    expect(block).toMatch(/1 documento\(s\) de tipo Secret omitido/);
  });

  it('redacta los secretos de los archivos que sí se incluyen y lo cuenta', () => {
    expect(digest.text).toContain('[REDACTADO]');
    expect(digest.redactions).toBeGreaterThanOrEqual(10);
    const readme = digest.included.find((f) => f.path === 'README.md')!;
    expect(readme.redactions).toBeGreaterThanOrEqual(4);
    // La clave sigue ahí (el modelo ve que hay una contraseña); el valor, no.
    expect(digest.text).toMatch(/DB_PASSWORD: \[REDACTADO\]/);
    expect(digest.text).toContain('Authorization: Bearer [REDACTADO]');
    expect(digest.text).toMatch(/postgres:\/\/app:\[REDACTADO\]@db:5432\/pedidos/);
    expect(digest.text).toMatch(/PASSWORD '\[REDACTADO\]'/);
  });

  it('redacta ANTES de recortar: un token cortado por el tope no deja un trozo a la vista', () => {
    // El tope de un compose es 8 KB y el token empieza 20 caracteres antes del corte: sin la redacción previa, el trozo que
    // queda tras cortar («ghp_» + 16 caracteres) ya no parecería un token.
    const token = FAKE.github;
    const raw = `${'# relleno\n'.repeat(817)}# ${token}\n# fin del archivo\n`;
    expect(raw.indexOf(token)).toBe(8172);
    expect(redactSecrets(raw.slice(0, 8192)).text).toContain(token.slice(0, 12)); // la premisa: cortar primero SÍ filtraría
    const d = scanRepo(repo({ 'README.md': '# x\n', 'docker-compose.yml': raw }), { budgetBytes: 200 * 1024 });
    const f = d.included.find((i) => i.path === 'docker-compose.yml')!;
    expect(f.truncated).toBe(true);
    expect(f.redactions).toBe(1);
    expect(d.text).not.toContain(token.slice(0, 8));
    expect(d.text).not.toContain('ghp_');
  });

  it('el informe de --dry-run lista incluidos y omitidos sin revelar ningún valor', () => {
    const report = formatReport(digest);
    expect(report).toContain('Incluidos con contenido');
    expect(report).toContain('Omitidos, por motivo');
    expect(report).toMatch(/secreto \(nunca se lee\) \(9\)/);
    expect(report).toContain('.env');
    for (const value of ALL_FAKE_VALUES) expect(report).not.toContain(value);
    expect(formatSummary(digest)).toMatch(/9 por parecer secretos/);
    for (const value of ALL_FAKE_VALUES) expect(formatSummary(digest)).not.toContain(value);
  });
});

describe('scanRepo: errores', () => {
  it('carpeta inexistente', () => {
    const run = (): RepoDigest => scanRepo(join(tmpdir(), 'iark-no-existe-jamas'));
    expect(run).toThrow(CliError);
    expect(run).toThrow(/no existe/);
    try {
      run();
    } catch (error) {
      expect((error as CliError).exitCode).toBe(2);
    }
  });

  it('un archivo en lugar de una carpeta', () => {
    const dir = repo({ 'a.txt': 'x' });
    expect(() => scanRepo(join(dir, 'a.txt'))).toThrow(/no es una carpeta/);
  });

  it('se niega a recorrer la raíz del disco o la carpeta personal (un descuido con --from-repo ~ no envía nada)', () => {
    expect(() => scanRepo('/')).toThrow(/raíz del disco o tu carpeta personal/);
    const casa = repo({ 'README.md': '# mi casa\n', '.bash_history': `export TOKEN=${FAKE.github}\n` });
    vi.stubEnv('HOME', casa);
    try {
      expect(() => scanRepo(casa)).toThrow(/raíz del disco o tu carpeta personal/);
      // Una carpeta dentro de ella sí se puede escanear.
      mkdirSync(join(casa, 'proyecto'));
      writeFileSync(join(casa, 'proyecto', 'README.md'), '# proyecto\n');
      expect(paths(scanRepo(join(casa, 'proyecto')))).toEqual(['README.md']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('carpeta vacía', () => {
    const dir = mkdtempSync(join(tmpdir(), 'iark-vacia-'));
    dirs.push(dir);
    expect(() => scanRepo(dir)).toThrow(/no contiene archivos de texto.*vacía/);
  });

  it('una carpeta con solo imágenes y dependencias no tiene nada reconocible', () => {
    const dir = repo({ 'logo.png': Buffer.from([0x89, 0x50, 0, 0]), 'node_modules/x/index.js': 'x\n' });
    expect(() => scanRepo(dir)).toThrow(/no contiene archivos de texto/);
  });

  it('una carpeta con solo secretos lo dice sin revelarlos', () => {
    const dir = repo({ '.env': `X=${FAKE.envValue}\n`, 'server.pem': FAKE.pem });
    let message = '';
    try {
      scanRepo(dir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/no contiene archivos de texto/);
    expect(message).toMatch(/2 secreto/);
    expect(message).not.toContain(FAKE.envValue);
  });

  it('texto sin nada reconocible (ni manifiestos ni código)', () => {
    const dir = repo({ 'notas.txt': 'comprar leche\n', 'lista.csv': 'a,b\n' });
    expect(() => scanRepo(dir)).toThrow(/No se reconoce nada/);
  });

  it('un repositorio solo de código (sin manifiestos) sí vale: el modelo recibe el árbol y los componentes', () => {
    const d = scanRepo(repo({ 'src/pedidos.controller.ts': 'x\n', 'src/util.ts': 'y\n' }));
    expect(d.included).toHaveLength(0);
    expect(d.text).toContain('src/pedidos.controller.ts');
    expect(d.text).toContain('no se reconoció ningún archivo clave');
  });
});

describe('scanRepo: el repositorio de ejemplo', () => {
  it('reconoce la tienda: documentación, compose, contrato, despliegue, migración, manifiestos y entradas', () => {
    const d = scanRepo(copyFixtureRepo());
    const byCategory = (c: string): string[] => d.included.filter((f) => f.category === c).map((f) => f.path);
    expect(byCategory('docs')).toEqual(['README.md']);
    expect(byCategory('manifiesto')).toEqual(['services/facturacion/pom.xml', 'services/pedidos/package.json']);
    expect(byCategory('contenedores')).toEqual(['docker-compose.yml']);
    expect(byCategory('api')).toEqual(['api/openapi.yaml']);
    expect(byCategory('despliegue')).toEqual(['k8s/deployment.yaml']);
    expect(byCategory('datos')).toEqual(['db/migrations/001_pedidos.sql']);
    expect(byCategory('entrada')).toEqual(['services/pedidos/src/server.ts', 'services/facturacion/src/main/java/com/tienda/FacturacionApplication.java']);
    expect(d.text).toContain('services/pedidos/src/pedidos.controller.ts');
    expect(d.text).toContain('services/facturacion/src/main/java/com/tienda/PedidoCreadoListener.java');
    expect(d.redactions).toBe(0);
  });
});

describe('scanRepo: nombres con caracteres de control (un repositorio ajeno no ensucia la terminal)', () => {
  it('se omiten con su motivo y sin mostrar los controles; ni el resumen ni la lista llevan una secuencia de escape', () => {
    const d = scanRepo(repo({ 'README.md': '# Hola\n', 'package.json': '{"name":"x"}', [`mala\u001b[2Jruta.md`]: 'texto\n', 'src/dos\nlineas.ts': 'x\n', 'carpeta\u001b[31m/a.ts': 'x\n', 'bidi‮gnp.ts': 'x\n' }));
    expect(paths(d)).toEqual(['README.md', 'package.json']);
    expect(d.omittedCounts.ilegible).toBe(4);
    const shown = JSON.stringify([d.text, d.omitted, formatReport(d)]);
    expect(shown).not.toMatch(/\u001b|\\u001b/);
    expect(shown).not.toContain('‮');
    expect(d.omitted.filter((o) => o.reason === 'ilegible').every((o) => o.detail === 'nombre con caracteres de control')).toBe(true);
    expect(d.omitted.map((o) => o.path)).toContain('mala�[2Jruta.md');
    expect(d.text).not.toContain('lineas.ts');
  });
});

describe('scanRepo: un clon temporal de un repositorio remoto (opción remote)', () => {
  it('usa el nombre del repositorio en el resumen y marca el digest como remoto; la ruta temporal no aparece', () => {
    const dir = repo({ 'README.md': '# Tienda\nUsa Postgres.\n', 'package.json': '{"name":"tienda"}' });
    const d = scanRepo(dir, { remote: { name: 'tienda' } });
    expect(d.name).toBe('tienda');
    expect(d.remote).toBe(true);
    expect(d.text.startsWith('Repositorio: tienda\n')).toBe(true);
    expect(d.text).not.toContain(dir);
    expect(formatSummary(d)).toMatch(/^Repositorio «tienda»: /);
    // Una carpeta normal no queda marcada.
    expect(scanRepo(dir).remote).toBeUndefined();
  });

  it('no interpreta los .gitignore (son texto de un tercero y un clon solo trae lo versionado): lo «ignorado» entra', () => {
    const files = { 'README.md': '# T\n', 'package.json': '{"name":"x"}', '.gitignore': 'README.md\nsrc/\n', 'src/a.ts': 'x\n' };
    const local = scanRepo(repo(files));
    expect(paths(local)).not.toContain('README.md');
    expect(omittedPaths(local, 'ignorado')).toContain('README.md');
    const remote = scanRepo(repo(files), { remote: { name: 'x' } });
    expect(paths(remote)).toContain('README.md');
    expect(omittedPaths(remote, 'ignorado')).toEqual([]);
    expect(remote.filesSeen).toBe(4); // también el contenido de la carpeta src/, que .gitignore «ignoraba»
    expect(local.filesSeen).toBe(2);
  });

  it('un .gitignore hostil (retroceso exponencial en un patrón) no cuelga la lectura de un clon', () => {
    const name = `${'a'.repeat(100)}.ts`;
    const dir = repo({ 'README.md': '# T\n', '.gitignore': `${'*a'.repeat(30)}b\n`, [`src/${name}`]: 'x\n' });
    const started = Date.now();
    const d = scanRepo(dir, { remote: { name: 'hostil' } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(d.filesSeen).toBe(3); // README, .gitignore y el archivo de nombre largo: ninguno «ignorado»
    expect(d.omittedCounts.ignorado).toBeUndefined();
  });

  it('los errores hablan del repositorio y no de la ruta del directorio temporal', () => {
    const vacio = repo({ '.gitkeep-no-es-texto.png': Buffer.from([1, 2, 3]) });
    let message = '';
    try {
      scanRepo(vacio, { remote: { name: 'vacio' } });
    } catch (error) {
      message = (error as CliError).message;
    }
    expect(message).toMatch(/^El repositorio «vacio» no contiene archivos de texto que leer/);
    expect(message).not.toContain(vacio);

    const sinNada = repo({ 'notas.txt': 'comprar leche\n' });
    expect(() => scanRepo(sinNada, { remote: { name: 'notas' } })).toThrow(/No se reconoce nada en el repositorio «notas»: .*¿Es el repositorio que querías\?/);
    try {
      scanRepo(sinNada, { remote: { name: 'notas' } });
    } catch (error) {
      expect((error as CliError).message).not.toContain(sinNada);
    }
    expect(() => scanRepo(join(sinNada, 'no-existe'), { remote: { name: 'x' } })).toThrow('El repositorio «x» no existe.');
  });
});
