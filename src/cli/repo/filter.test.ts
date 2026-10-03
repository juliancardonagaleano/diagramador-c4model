import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CliError } from '../io';
import { PathFilter, repoGlobProblem } from './filter';

describe('repoGlobProblem: qué patrones valen para --repo-include y --repo-exclude', () => {
  it.each(['*.md', 'docs/', 'docs/**', '/src', 'services/*/Dockerfile', '**/*.test.ts', 'a?b', 'f[a-c].txt', '\\!rara', '\\#nota', 'sin-extension', 'lo que sea.md', 'ñ', '.github/workflows/'])('acepta %j', (value) => {
    expect(repoGlobProblem(value)).toBeUndefined();
  });

  it.each([
    ['', /está vacío/],
    ['   ', /está vacío/],
    ['a\nb', /saltos de línea o caracteres de control/],
    ['a\u0000b', /caracteres de control/],
    ['\u001b[2J', /caracteres de control/],
    ['a‮b', /caracteres de control/],
    [' src', /espacios al principio o al final/],
    ['src ', /espacios al principio o al final/],
    ['!src', /no puede empezar por «!»/],
    ['#src', /no puede empezar por «#».*comentario/],
    ['../fuera', /no puede llevar «\.\.»/],
    ['a/../b', /no puede llevar «\.\.»/],
    ['..', /no puede llevar «\.\.»/],
    ['/', /ningún archivo ni carpeta/],
    ['///', /ningún archivo ni carpeta/],
    ['a'.repeat(1001), /más de 1000 caracteres/],
  ])('rechaza %j', (value, message) => {
    expect(repoGlobProblem(value)).toMatch(message);
  });
});

describe('PathFilter', () => {
  it('sin patrones no hay filtro: nada cuadra', () => {
    const filter = new PathFilter([]);
    expect(filter.active).toBe(false);
    expect(filter.matches('a/b.md')).toBe(false);
    expect(filter.matchesEntry('a', true)).toBe(false);
  });

  it('un patrón con barra es relativo a la raíz y uno sin barra vale a cualquier profundidad', () => {
    const filter = new PathFilter(['*.md', 'docs/*.txt', '/solo-raiz.json']);
    expect(filter.matches('LEEME.md')).toBe(true);
    expect(filter.matches('a/b/c/LEEME.md')).toBe(true);
    expect(filter.matches('docs/notas.txt')).toBe(true);
    expect(filter.matches('x/docs/notas.txt')).toBe(false);
    expect(filter.matches('solo-raiz.json')).toBe(true);
    expect(filter.matches('x/solo-raiz.json')).toBe(false);
    expect(filter.matches('src/index.ts')).toBe(false);
  });

  it('una carpeta cuadra con todo lo que contiene (con o sin barra final), pero una barra final no cuadra con un archivo', () => {
    const conBarra = new PathFilter(['services/pedidos/']);
    expect(conBarra.matches('services/pedidos/package.json')).toBe(true);
    expect(conBarra.matches('services/pedidos/src/a/b.ts')).toBe(true);
    expect(conBarra.matches('services/facturacion/pom.xml')).toBe(false);
    const sinBarra = new PathFilter(['services/pedidos']);
    expect(sinBarra.matches('services/pedidos/package.json')).toBe(true);
    expect(sinBarra.matches('otro/services/pedidos/x')).toBe(false);
    const archivo = new PathFilter(['pedidos/']);
    expect(archivo.matches('pedidos')).toBe(false); // un archivo llamado «pedidos» no es la carpeta
    expect(archivo.matches('x/pedidos/y')).toBe(true);
  });

  it('** cruza carpetas, * y ? no', () => {
    const filter = new PathFilter(['k8s/**/*.yaml', 'src/*.ts', 'a?c']);
    expect(filter.matches('k8s/prod/eu/app.yaml')).toBe(true);
    expect(filter.matches('k8s/app.yaml')).toBe(true);
    expect(filter.matches('src/a.ts')).toBe(true);
    expect(filter.matches('src/sub/a.ts')).toBe(false);
    expect(filter.matches('abc')).toBe(true);
    expect(filter.matches('a/c')).toBe(false);
  });

  it('matchesEntry mira solo la entrada (lo que usa el recorrido para no bajar a una carpeta)', () => {
    const filter = new PathFilter(['legacy/', 'tmp', '*.bak']);
    expect(filter.matchesEntry('legacy', true)).toBe(true);
    expect(filter.matchesEntry('legacy', false)).toBe(false);
    expect(filter.matchesEntry('src/legacy', true)).toBe(true);
    expect(filter.matchesEntry('legacy/dentro.txt', false)).toBe(false); // se corta antes, al ver la carpeta
    expect(filter.matchesEntry('tmp', true)).toBe(true);
    expect(filter.matchesEntry('tmp', false)).toBe(true);
    expect(filter.matchesEntry('x/a.bak', false)).toBe(true);
  });

  it('los patrones con escape se toman al pie de la letra', () => {
    const filter = new PathFilter(['\\!importante.md', '\\#borrador.md']);
    expect(filter.matches('!importante.md')).toBe(true);
    expect(filter.matches('importante.md')).toBe(false);
    expect(filter.matches('#borrador.md')).toBe(true);
  });

  it('un patrón inválido lanza un error de uso (código 2) que nombra la opción y no ensucia la terminal', () => {
    for (const [pattern, option] of [['!x', '--repo-exclude'], ['../x', '--repo-include'], ['a\u001b[31mb\n', '--repo-exclude']] as const) {
      let error: CliError | undefined;
      try {
        new PathFilter([pattern], option);
      } catch (e) {
        error = e as CliError;
      }
      expect(error).toBeInstanceOf(CliError);
      expect(error!.exitCode).toBe(2);
      expect(error!.message).toContain(`de ${option} no vale`);
      expect(error!.message).not.toMatch(/\u001b|\n.*\n/);
    }
  });

  it('un patrón hostil (*a*a*a…b) contra un nombre de miles de «a» responde en milisegundos', () => {
    const filter = new PathFilter([`${'*a'.repeat(400)}b`, `${'**/'.repeat(100)}x`]);
    const start = performance.now();
    for (let i = 0; i < 50; i += 1) expect(filter.matches(`d/e/${'a'.repeat(5000)}`)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(filter.matches(`${'a'.repeat(5000)}b`)).toBe(true);
  });

  it('reutiliza el intérprete sin regex: filter.ts no construye expresiones regulares para casar', () => {
    const source = readFileSync('src/cli/repo/filter.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/new RegExp|RegExp\(/);
    expect(source).toMatch(/from '\.\/gitignore'/);
  });
});
