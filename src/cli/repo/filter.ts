import { CliError } from '../io';
import { IgnoreMatcher } from './gitignore';

/**
 * Filtros del usuario sobre lo que entra en el resumen: `--repo-include <glob>` y `--repo-exclude <glob>` (repetibles).
 * Los patrones se escriben como en un `.gitignore` (sin negación) y son relativos a la raíz del repositorio: `*.md` vale en
 * cualquier carpeta, `docs/*.md` solo en `docs/`, `/src` ancla a la raíz, `legacy/` solo carpetas, `**` cruza carpetas.
 * Se casan con el intérprete de `.gitignore` (`gitignore.ts`, sin expresiones regulares: coste acotado).
 *
 * Los filtros SOLO pueden reducir lo que se envía. No hacen legible nada que la lista de secretos o las reglas del escáner
 * prohíban (`.env*`, claves, credenciales, `*.tfstate`…): un `--repo-include` que nombre uno de esos archivos no lo abre, y
 * lo que sí entra sigue pasando por la redacción de secretos.
 */

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const MAX_GLOB_CHARS = 1000;

/** Por qué un patrón no vale (para completar «El patrón … no vale: <motivo>»), o `undefined` si vale. */
export function repoGlobProblem(value: string): string | undefined {
  if (value.trim() === '') return 'está vacío';
  if (CONTROL.test(value)) return 'lleva saltos de línea o caracteres de control';
  if (value !== value.trim()) return 'lleva espacios al principio o al final';
  if (value.length > MAX_GLOB_CHARS) return `tiene más de ${MAX_GLOB_CHARS} caracteres`;
  if (value.startsWith('!')) return 'no puede empezar por «!» (aquí no hay negaciones; si el nombre empieza por «!», escríbelo como «\\!»)';
  if (value.startsWith('#')) return 'no puede empezar por «#» (en el formato de .gitignore sería un comentario; si el nombre empieza por «#», escríbelo como «\\#»)';
  if (value.split('/').includes('..')) return 'no puede llevar «..»: las rutas son relativas a la raíz del repositorio y nunca salen de él';
  if (/^\/+$/.test(value)) return 'no indica ningún archivo ni carpeta';
  return undefined;
}

/** Lo que se muestra de un patrón en un mensaje: sin controles que ensucien la terminal. */
const shown = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '\ufffd');

export class PathFilter {
  private readonly matcher = new IgnoreMatcher();
  readonly patterns: readonly string[];

  /** `option` es el nombre de la opción (`--repo-include`…), solo para los mensajes. Lanza `CliError` (código 2) si un patrón no vale. */
  constructor(patterns: readonly string[] = [], option = '--repo-include') {
    for (const pattern of patterns) {
      const problem = repoGlobProblem(pattern);
      if (problem) throw new CliError(`El patrón «${shown(pattern)}» de ${option} no vale: ${problem}.`, 2);
      if (this.matcher.add(pattern, '') !== 1) throw new CliError(`El patrón «${shown(pattern)}» de ${option} no vale: no se pudo interpretar (¿demasiado largo o demasiados patrones?).`, 2);
    }
    this.patterns = [...patterns];
  }

  /** ¿Hay algún patrón? */
  get active(): boolean {
    return this.patterns.length > 0;
  }

  /** ¿Cuadra esta entrada (archivo o carpeta) por sí misma? El recorrido no baja a las carpetas que cuadran. */
  matchesEntry(path: string, isDir: boolean): boolean {
    return this.active && this.matcher.ignores(path, isDir);
  }

  /** ¿Cuadra este archivo, o alguna de las carpetas que lo contienen? (`--repo-include services/pedidos` cubre lo que hay dentro.) */
  matches(path: string): boolean {
    if (!this.active) return false;
    const parts = path.split('/');
    for (let k = 1; k <= parts.length; k += 1) {
      if (this.matcher.ignores(parts.slice(0, k).join('/'), k < parts.length)) return true;
    }
    return false;
  }
}
