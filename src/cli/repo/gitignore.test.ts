import { readFileSync } from 'node:fs';
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

describe('IgnoreMatcher: más de lo que usa git', () => {
  it('** al principio, en medio y al final', () => {
    const m = matcher('**/gen/\na/**/z.txt\nout/**\n**/*.snap\n');
    expect(m.ignores('gen', true)).toBe(true);
    expect(m.ignores('x/y/gen', true)).toBe(true);
    expect(m.ignores('gen', false)).toBe(false);
    expect(m.ignores('a/z.txt', false)).toBe(true); // ** en medio: cero carpetas
    expect(m.ignores('a/b/c/z.txt', false)).toBe(true);
    expect(m.ignores('b/a/z.txt', false)).toBe(false);
    expect(m.ignores('out/x', false)).toBe(true); // ** final: todo lo de dentro…
    expect(m.ignores('out/x/y/z', false)).toBe(true);
    expect(m.ignores('out', true)).toBe(false); // …pero no la carpeta misma
    expect(m.ignores('src/a.snap', false)).toBe(true);
    expect(m.ignores('a.snap', false)).toBe(true);
  });

  it('un ** pegado a otra cosa vale como un *, y ** solo lo ignora todo', () => {
    const m = matcher('a**b\n');
    expect(m.ignores('axxb', false)).toBe(true);
    expect(m.ignores('a/b', false)).toBe(false);
    expect(m.ignores('x/axb', false)).toBe(true);
    expect(matcher('**\n').ignores('lo/que/sea', false)).toBe(true);
    expect(matcher('/**\n').ignores('lo/que/sea', false)).toBe(true);
    const mid = matcher('a/**b\n');
    expect(mid.ignores('a/xb', false)).toBe(true);
    expect(mid.ignores('a/x/b', false)).toBe(false);
  });

  it('* no cruza carpetas y ? tampoco; una carpeta con barra final también ignora lo de dentro cuando la recorre el caminante', () => {
    const m = matcher('src/*.js\n?.md\n');
    expect(m.ignores('src/a.js', false)).toBe(true);
    expect(m.ignores('src/a/b.js', false)).toBe(false);
    expect(m.ignores('a.md', false)).toBe(true);
    expect(m.ignores('ab.md', false)).toBe(false);
    expect(m.ignores('x/a.md', false)).toBe(true);
  });

  it('las clases: rangos, negación con ! o ^, ] inicial, y nunca casan con «/»', () => {
    const m = matcher('f[a-c].txt\ng[!a-c].txt\nh[^x].txt\ni[]a].txt\nj[a\\]].txt\nk[z-a].txt\n');
    expect(m.ignores('fb.txt', false)).toBe(true);
    expect(m.ignores('fd.txt', false)).toBe(false);
    expect(m.ignores('gd.txt', false)).toBe(true);
    expect(m.ignores('ga.txt', false)).toBe(false);
    expect(m.ignores('hy.txt', false)).toBe(true);
    expect(m.ignores('hx.txt', false)).toBe(false);
    expect(m.ignores('i].txt', false)).toBe(true);
    expect(m.ignores('ia.txt', false)).toBe(true);
    expect(m.ignores('j].txt', false)).toBe(true);
    expect(m.ignores('ja.txt', false)).toBe(true);
    expect(m.ignores('kb.txt', false)).toBe(false); // rango invertido: no casa nada (y no tira la regla de abajo)
    const slash = matcher('a[!b]c\n');
    expect(slash.ignores('axc', false)).toBe(true);
    expect(slash.ignores('a/c', false)).toBe(false);
  });

  it('una clase sin cerrar es un «[» literal', () => {
    const m = matcher('a[b\nc[]d\n');
    expect(m.ignores('a[b', false)).toBe(true);
    expect(m.ignores('ab', false)).toBe(false);
    expect(m.ignores('c[]d', false)).toBe(true);
  });

  it('escapes: \\* \\? \\[ literales, \\! y \\# al principio, y el espacio final escapado se conserva', () => {
    const m = matcher('a\\*b\n\\!bang\n\\#almohadilla\nsp\\ \nsin-escape  \nq\\?\n');
    expect(m.ignores('a*b', false)).toBe(true);
    expect(m.ignores('axb', false)).toBe(false);
    expect(m.ignores('!bang', false)).toBe(true);
    expect(m.ignores('bang', false)).toBe(false);
    expect(m.ignores('#almohadilla', false)).toBe(true);
    expect(m.ignores('sp ', false)).toBe(true);
    expect(m.ignores('sp', false)).toBe(false);
    expect(m.ignores('sin-escape', false)).toBe(true); // el espacio final sin escapar se quita
    expect(m.ignores('q?', false)).toBe(true);
    expect(m.ignores('qx', false)).toBe(false);
  });

  it('negar una carpeta no reincorpora lo de dentro por sí solo, pero la última regla manda para cada ruta', () => {
    const m = matcher('build/\n!build/keep.txt\n*.o\n!main.o\n');
    expect(m.ignores('build', true)).toBe(true);
    expect(m.ignores('build/keep.txt', false)).toBe(false);
    expect(m.ignores('x.o', false)).toBe(true);
    expect(m.ignores('main.o', false)).toBe(false);
    expect(m.ignores('a/main.o', false)).toBe(false);
  });

  it('las reglas de una subcarpeta (base) valen dentro de ella, a cualquier profundidad si no están ancladas, y no para la carpeta misma', () => {
    const m = new IgnoreMatcher();
    m.add('/solo-aqui\n*.tmp\ndocs/x\n', 'pkg/api');
    expect(m.ignores('pkg/api/solo-aqui', false)).toBe(true);
    expect(m.ignores('pkg/api/sub/solo-aqui', false)).toBe(false);
    expect(m.ignores('pkg/api/sub/a.tmp', false)).toBe(true);
    expect(m.ignores('pkg/api/docs/x', false)).toBe(true);
    expect(m.ignores('pkg/otro/a.tmp', false)).toBe(false);
    expect(m.ignores('a.tmp', false)).toBe(false);
    expect(m.ignores('pkg/api', true)).toBe(false);
  });

  it('nombres con caracteres fuera del plano básico (un ? o una clase casa un carácter, no media pareja sustituta)', () => {
    const m = matcher('a?b\nc[😀]d\n');
    expect(m.ignores('a😀b', false)).toBe(true);
    expect(m.ignores('añb', false)).toBe(true);
    expect(m.ignores('c😀d', false)).toBe(true);
    expect(m.ignores('cd', false)).toBe(false);
  });
});

describe('IgnoreMatcher: un .gitignore hostil no cuelga ni ralentiza (sin retroceso exponencial)', () => {
  /** Mide lo que tarda `fn` en ms. */
  const time = (fn: () => void): number => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it('*a*a*a…b contra aaaa… de miles de caracteres: milisegundos (con regex, esto no termina)', () => {
    const m = matcher(`${'*a'.repeat(400)}b\n`);
    for (const length of [255, 3000, 20000]) {
      let result = true;
      const ms = time(() => {
        result = m.ignores(`carpeta/${'a'.repeat(length)}`, false);
      });
      expect(result).toBe(false);
      expect(ms, `${length} caracteres`).toBeLessThan(200);
    }
    // Y si el nombre sí casa, también casa (un patrón así no es un caso muerto).
    expect(m.ignores(`${'a'.repeat(1000)}b`, false)).toBe(true);
    expect(m.ignores(`${'xa'.repeat(400)}b`, false)).toBe(true);
    expect(m.ignores(`${'xa'.repeat(399)}b`, false)).toBe(false);
  });

  it('** repetidos y mezclados con carpetas y clases: milisegundos', () => {
    const patterns = [`${'**/'.repeat(120)}x`, `${'a/**/'.repeat(100)}z`, `${'[a-z]*'.repeat(120)}Q`, `${'?*'.repeat(200)}!`, `${'*/'.repeat(100)}*.nunca`].join('\n');
    const m = matcher(patterns);
    const deep = `${'a/'.repeat(23)}${'a'.repeat(255)}`;
    const ms = time(() => {
      for (let i = 0; i < 200; i += 1) {
        m.ignores(deep, false);
        m.ignores(`${deep}/`, true);
      }
    });
    expect(ms).toBeLessThan(1500);
    expect(m.ignores(deep, false)).toBe(false);
  });

  it('un recorrido grande con un .gitignore sensato sigue siendo rápido', () => {
    const m = matcher('node_modules/\ndist/\n*.log\n.env*\n**/build/\ncoverage/\n*.min.js\n!keep.log\n');
    const ms = time(() => {
      for (let i = 0; i < 20000; i += 1) m.ignores(`src/modulo${i % 50}/componente${i}/archivo${i}.ts`, false);
    });
    expect(ms).toBeLessThan(1500);
  });

  it('las líneas de más de 1024 caracteres se descartan, y hay un tope de reglas', () => {
    const m = matcher(`${'a'.repeat(1100)}\nrara\n`);
    expect(m.ignores('a'.repeat(1100), false)).toBe(false);
    expect(m.ignores('rara', false)).toBe(true); // la línea siguiente sí cuenta
    const many = new IgnoreMatcher();
    many.add(`${Array.from({ length: 6000 }, (_, i) => `n${i}.tmp`).join('\n')}\n`, '');
    expect(many.ignores('n10.tmp', false)).toBe(true);
    expect(many.ignores('n5500.tmp', false)).toBe(false); // más allá de las 5000 primeras reglas
  });

  it('el recorte del final de línea no tiene coste cuadrático (un montón de espacios no cuelga)', () => {
    const ms = time(() => matcher(`${' '.repeat(1000)}x${' '.repeat(1000)}\n`));
    expect(ms).toBeLessThan(200);
  });

  it('el intérprete no traduce los patrones a expresiones regulares (que es lo que permitía el retroceso exponencial)', () => {
    const source = readFileSync('src/cli/repo/gitignore.ts', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(source).not.toMatch(/new RegExp|RegExp\(/);
  });
});
