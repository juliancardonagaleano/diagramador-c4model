/**
 * Un intérprete mínimo de `.gitignore` (sin dependencias y sin lanzar `git`: el escáner no ejecuta nunca nada del
 * repositorio que lee). Cubre lo que usan los proyectos reales: comentarios, `!` de negación, `/` inicial o intermedio que
 * ancla el patrón, `/` final que limita a carpetas, `*`, `?`, `[…]` y `**`. La última regla que coincide manda, y las de las
 * carpetas más profundas se añaden después, así que pueden anular a las de arriba (como hace git).
 */

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Traduce el glob de una línea de `.gitignore` a una expresión regular sobre rutas con `/`. */
function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) {
      out += escapeRegex(glob[(i += 1)]);
    } else if (c === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/';
        const after = glob[i + 2];
        if (before && after === '/') {
          out += '(?:.*/)?'; // `**/` : cero o más carpetas
          i += 2;
        } else if (before && after === undefined) {
          out += '.*'; // `/**` al final: todo lo de dentro
          i += 1;
        } else {
          out += '[^/]*'; // `**` pegado a otra cosa se comporta como `*`
          i += 1;
        }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) out += '\\[';
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = end;
      }
    } else out += escapeRegex(c);
  }
  return out;
}

function escapeRegex(c: string): string {
  return c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export class IgnoreMatcher {
  private rules: Rule[] = [];

  /**
   * Añade las reglas de un `.gitignore` (o de `.git/info/exclude`). `base` es la carpeta del archivo respecto a la raíz
   * del repositorio, con `/` y sin barra final (`''` para la raíz).
   */
  add(content: string, base: string): void {
    for (const raw of content.split(/\r?\n/)) {
      let line = raw.replace(/(?<!\\)\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
      let dirOnly = false;
      if (line.endsWith('/')) {
        dirOnly = true;
        line = line.replace(/\/+$/, '');
      }
      if (!line) continue;
      const anchored = line.includes('/');
      line = line.replace(/^\//, '');
      const prefix = base ? `${escapeRegex(base)}/` : '';
      const body = globToRegex(line);
      try {
        this.rules.push({ re: new RegExp(`^${prefix}${anchored ? '' : '(?:.*/)?'}${body}$`), negate, dirOnly });
      } catch {
        // Un patrón que no se puede traducir se ignora: peor es fallar con un .gitignore raro.
      }
    }
  }

  /** ¿Está ignorada esta ruta (relativa a la raíz del repositorio, con `/`)? */
  ignores(path: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(path)) ignored = !rule.negate;
    }
    return ignored;
  }
}
