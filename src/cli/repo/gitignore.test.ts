import { describe, expect, it } from 'vitest';
import { IgnoreMatcher } from './gitignore';

function matcher(content: string, base = ''): IgnoreMatcher {
  const m = new IgnoreMatcher();
  m.add(content, base);
  return m;
}

describe('IgnoreMatcher (.gitignore)', () => {
  it('ignora por nombre en cualquier profundidad, y respeta comentarios y líneas vacías', () => {
    const m = matcher('# comentario\n\n*.log\nsalida.txt\n');
    expect(m.ignores('app.log', false)).toBe(true);
    expect(m.ignores('a/b/c/app.log', false)).toBe(true);
    expect(m.ignores('a/salida.txt', false)).toBe(true);
    expect(m.ignores('app.logx', false)).toBe(false);
    expect(m.ignores('src/index.ts', false)).toBe(false);
  });

  it('una barra al principio o en medio ancla el patrón a su carpeta', () => {
    const m = matcher('/generado\ndocs/borrador\n');
    expect(m.ignores('generado', true)).toBe(true);
    expect(m.ignores('src/generado', true)).toBe(false);
    expect(m.ignores('docs/borrador', false)).toBe(true);
    expect(m.ignores('otro/docs/borrador', false)).toBe(false);
  });

  it('una barra al final limita el patrón a carpetas', () => {
    const m = matcher('cache/\n');
    expect(m.ignores('cache', true)).toBe(true);
    expect(m.ignores('src/cache', true)).toBe(true);
    expect(m.ignores('cache', false)).toBe(false);
  });

  it('entiende *, ?, [] y **', () => {
    const m = matcher('doc-?.md\nnota[0-9].txt\n**/tmp/**\nsrc/**/*.gen.ts\n');
    expect(m.ignores('doc-a.md', false)).toBe(true);
    expect(m.ignores('doc-ab.md', false)).toBe(false);
    expect(m.ignores('nota7.txt', false)).toBe(true);
    expect(m.ignores('notaX.txt', false)).toBe(false);
    expect(m.ignores('a/tmp/x/y.txt', false)).toBe(true);
    expect(m.ignores('src/a/b/x.gen.ts', false)).toBe(true);
    expect(m.ignores('src/x.gen.ts', false)).toBe(true);
    expect(m.ignores('lib/x.gen.ts', false)).toBe(false);
  });

  it('la negación (!) reincorpora y la última regla manda', () => {
    const m = matcher('*.md\n!LEEME.md\n');
    expect(m.ignores('notas.md', false)).toBe(true);
    expect(m.ignores('LEEME.md', false)).toBe(false);
    expect(m.ignores('docs/LEEME.md', false)).toBe(false);
  });

  it('las reglas de una carpeta solo valen dentro de ella (y las más profundas pueden anular a las de arriba)', () => {
    const m = new IgnoreMatcher();
    m.add('*.csv\n', '');
    m.add('!datos.csv\nlocal.txt\n', 'sub');
    expect(m.ignores('x.csv', false)).toBe(true);
    expect(m.ignores('sub/datos.csv', false)).toBe(false);
    expect(m.ignores('sub/otro.csv', false)).toBe(true);
    expect(m.ignores('sub/local.txt', false)).toBe(true);
    expect(m.ignores('local.txt', false)).toBe(false);
    expect(m.ignores('otra/local.txt', false)).toBe(false);
  });

  it('acepta finales de línea de Windows y no se rompe con un patrón raro', () => {
    const m = matcher('build/\r\n*.tmp\r\n[\r\n');
    expect(m.ignores('build', true)).toBe(true);
    expect(m.ignores('a.tmp', false)).toBe(true);
  });
});
