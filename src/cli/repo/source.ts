import { statSync } from 'node:fs';
import { CliError } from '../io';

/**
 * ¿Qué es lo que se pasó a `--from-repo`: una carpeta local o la URL de un repositorio git? Y, si es una URL, ¿se puede
 * clonar sin riesgo? Todo el módulo es puro (salvo la comprobación de «existe como carpeta», que se puede inyectar): decide
 * y valida; no clona ni toca la red.
 *
 * La URL es entrada no confiable que acaba como argumento de `git clone`, así que se acepta una lista cerrada de formas y
 * todo lo demás se rechaza con un mensaje claro:
 *  - `https://host[:puerto]/ruta/repo[.git]`
 *  - `ssh://[usuario@]host[:puerto]/ruta/repo[.git]`
 *  - la forma scp de git: `usuario@host:ruta/repo[.git]` (o `host.dominio:ruta/repo.git`)
 * Se rechazan `http://` (sin cifrar), `git://` (sin cifrar ni autenticación), `file://`, los ayudantes de transporte
 * (`ext::…`, que ejecutan programas) y cualquier otro esquema; las credenciales dentro de la URL (`https://usuario:token@…`:
 * acabarían en el historial de la terminal y en los registros); los valores que empiezan por `-` (se leerían como una opción
 * de git); y los espacios, saltos de línea y demás caracteres de control o invisibles.
 *
 * Los mensajes de error NO repiten nunca lo que escribió el usuario (puede llevar un token): hablan del tipo de problema.
 */

export interface RepoFolder {
  kind: 'folder';
  path: string;
}

export interface RepoUrl {
  kind: 'url';
  /** La URL tal cual se le pasa a git (validada: sin credenciales ni caracteres raros). */
  url: string;
  /** Lo que se muestra al usuario (por stderr). Igual que `url`: lo aceptado nunca lleva credenciales. */
  display: string;
  /** Nombre del repositorio sacado de la URL, sin `.git`: es el que sale en el resumen (nunca una ruta del equipo). */
  name: string;
  transport: 'https' | 'ssh';
}

export type RepoSource = RepoFolder | RepoUrl;

/** Espacios, controles C0/C1, separadores de línea y caracteres invisibles o de dirección de texto (Unicode). */
const FORBIDDEN_CHARS = /[\u0000-\u0020\u007f-\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/;

const HOST_LABEL = '[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?';
const HOSTNAME = new RegExp(`^${HOST_LABEL}(?:\\.${HOST_LABEL})*$`);
const IPV6_HOST = /^\[[0-9A-Fa-f:.]{2,45}\]$/;
const USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
/** Ruta del repositorio: sin comillas, `$`, comodines, `;`, `&`, `|`, `\`, `?` ni `#` (llegaría a un shell remoto o a una consulta). */
const URL_PATH_CHARS = /^[A-Za-z0-9._~+@:=,/%-]+$/;
const SCHEME_URL = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\//;
const TRANSPORT_HELPER = /^[A-Za-z0-9+.-]+::/;
const MAX_URL_LENGTH = 2048;

/** Una ruta que existe y es una carpeta (los enlaces simbólicos a carpetas cuentan). */
export function isLocalFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function fail(message: string): never {
  throw new CliError(message, 2);
}

const ACCEPTED_FORMS = 'https://host/grupo/repo.git, ssh://git@host/grupo/repo.git o git@host:grupo/repo.git';

/**
 * Decide si `value` es una carpeta o una URL de git y, si es una URL, la valida. Una ruta que existe como carpeta local es
 * SIEMPRE una carpeta (aunque se parezca a una URL). Lanza `CliError` (código 2) con un mensaje claro si es una URL que no se
 * puede usar. `isFolder` es inyectable para probar la decisión sin tocar el disco.
 */
export function classifyRepoSource(value: string, isFolder: (path: string) => boolean = isLocalFolder): RepoSource {
  if (value.trim() === '') fail('--from-repo necesita la ruta de una carpeta o la URL de un repositorio git.');
  if (isFolder(value)) return { kind: 'folder', path: value };
  if (value.startsWith('-')) fail('El valor de --from-repo no puede empezar por «-» (git lo leería como una opción). Para una carpeta, indica su ruta (p. ej. ./carpeta); para una URL, escríbela completa.');

  const probe = value.trim();
  const scheme = SCHEME_URL.exec(probe);
  const helper = scheme ? undefined : TRANSPORT_HELPER.test(probe);
  const scp = scheme || helper ? undefined : scpParts(probe);

  if (helper) fail('Los ayudantes de transporte de git (ext::, fd::…) no se admiten: ejecutan programas. Usa una URL https://, ssh:// o git@host:grupo/repo.git.');
  if (!scheme && !scp) {
    // Ni URL ni carpeta que exista: lo dirá el escáner («La carpeta … no existe»), salvo que parezca una URL con credenciales.
    if (probe.includes('@') && probe.includes(':')) fail(`El valor de --from-repo no es una carpeta que exista ni una URL de git válida (${ACCEPTED_FORMS}). Si lleva usuario y contraseña o token dentro, quítalos: usa el gestor de credenciales de git o ssh.`);
    return { kind: 'folder', path: value };
  }
  if (value !== probe || FORBIDDEN_CHARS.test(probe)) fail('La URL no puede contener espacios, saltos de línea ni caracteres de control o invisibles (¿se coló algo al copiarla?).');
  if (probe.length > MAX_URL_LENGTH) fail('La URL es demasiado larga.');

  if (scheme) {
    const name = scheme[1].toLowerCase();
    if (name === 'http') fail('Las URL http:// van sin cifrar y no se admiten: usa https://.');
    if (name === 'git') fail('El protocolo git:// no cifra ni autentica al servidor y no se admite: usa https:// o ssh://.');
    if (name === 'file') fail('file:// no se admite: para un repositorio local indica su carpeta (--from-repo /ruta/al/repositorio).');
    if (name !== 'https' && name !== 'ssh') fail(`El transporte «${name}://» no se admite: solo ${ACCEPTED_FORMS}.`);
    return parseSchemeUrl(name, probe.slice(scheme[0].length));
  }
  return parseScpUrl(scp!);
}

interface ScpParts {
  user?: string;
  host: string;
  path: string;
}

/** La forma scp de git (`usuario@host:ruta`): hay un `:` antes de cualquier `/`. Pide usuario o un host con punto: `C:\x` no lo es. */
function scpParts(probe: string): ScpParts | undefined {
  const colon = probe.indexOf(':');
  if (colon <= 0) return undefined;
  const slash = probe.indexOf('/');
  if (slash !== -1 && slash < colon) return undefined;
  const left = probe.slice(0, colon);
  const path = probe.slice(colon + 1);
  const at = left.lastIndexOf('@');
  const user = at === -1 ? undefined : left.slice(0, at);
  const host = at === -1 ? left : left.slice(at + 1);
  if (path === '' || host === '') return undefined;
  if (user === undefined && !host.includes('.') && !host.startsWith('[')) return undefined;
  return { user, host, path };
}

function parseSchemeUrl(scheme: 'https' | 'ssh', rest: string): RepoUrl {
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? undefined : authority.slice(0, at);
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  if (userinfo !== undefined) {
    // En https cualquier usuario puede ser en realidad un token (GitHub lo acepta); en ssh el usuario es normal (`git@`), la contraseña no.
    if (scheme === 'https' || userinfo.includes(':')) {
      fail('La URL lleva credenciales (usuario, contraseña o token) dentro: no se admiten ni se imprimen. Quítalas y usa el gestor de credenciales de git (credential helper) o ssh: el clonado usa la configuración de git y de ssh que ya tengas.');
    }
    if (!USER.test(userinfo)) fail('El usuario de la URL ssh no es válido.');
  }
  const { host, port } = splitHostPort(hostPort);
  checkHost(host);
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) fail('El puerto de la URL no es válido.');
  if (path === '' || path === '/') fail('La URL no indica el repositorio (falta la ruta, del tipo /grupo/repositorio.git).');
  checkPath(path, scheme === 'ssh');
  const url = `${scheme}://${userinfo !== undefined ? `${userinfo}@` : ''}${hostPort}${path}`;
  return { kind: 'url', url, display: url, name: repoNameFrom(path), transport: scheme };
}

function parseScpUrl(parts: ScpParts): RepoUrl {
  if (parts.user !== undefined && !USER.test(parts.user)) fail('El usuario de la URL no es válido.');
  checkHost(parts.host);
  if (parts.path.startsWith('-') || parts.path.startsWith(':')) fail('La ruta del repositorio de la URL no es válida.');
  checkPath(parts.path, true);
  const url = `${parts.user !== undefined ? `${parts.user}@` : ''}${parts.host}:${parts.path}`;
  return { kind: 'url', url, display: url, name: repoNameFrom(parts.path), transport: 'ssh' };
}

function splitHostPort(hostPort: string): { host: string; port?: string } {
  if (hostPort.startsWith('[')) {
    const end = hostPort.indexOf(']');
    if (end === -1) fail('El host de la URL no es válido.');
    const rest = hostPort.slice(end + 1);
    if (rest !== '' && !rest.startsWith(':')) fail('El host de la URL no es válido.');
    return { host: hostPort.slice(0, end + 1), port: rest === '' ? undefined : rest.slice(1) };
  }
  const colon = hostPort.indexOf(':');
  return colon === -1 ? { host: hostPort } : { host: hostPort.slice(0, colon), port: hostPort.slice(colon + 1) };
}

/** El host empieza siempre por una letra o un dígito (uno con `-` delante se leería como una opción de ssh) y es ASCII. */
function checkHost(host: string): void {
  if (!HOSTNAME.test(host) && !IPV6_HOST.test(host)) fail('El nombre del host de la URL no es válido (solo letras ASCII, dígitos, «.», «-» y «_»; los dominios internacionales, en forma xn--).');
  if (host.length > 253) fail('El nombre del host de la URL es demasiado largo.');
}

function checkPath(path: string, noPercent: boolean): void {
  if (!URL_PATH_CHARS.test(path)) fail('La ruta del repositorio de la URL lleva caracteres no admitidos (comillas, «$», «;», «&», «|», «\\», «?», «#», comodines…).');
  if (path.split('/').some((segment) => segment === '..' || segment === '.')) fail('La ruta del repositorio de la URL no puede llevar «.» ni «..».');
  if (/%(?![0-9A-Fa-f]{2})/.test(path) || /%(?:[01][0-9A-Fa-f]|7[Ff])/.test(path)) fail('La ruta del repositorio de la URL lleva un escape «%» inválido o de un carácter de control.');
  if (noPercent && path.includes('%')) fail('La ruta de una URL ssh no puede llevar «%».');
}

/** Última parte de la ruta, sin barras finales ni `.git`: `/grupo/sub/repo.git/` → `repo`. */
function repoNameFrom(path: string): string {
  const last = path.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const name = last.replace(/\.git$/i, '');
  if (!/[A-Za-z0-9]/.test(name)) fail('No se pudo deducir el nombre del repositorio de la URL (falta la ruta, del tipo /grupo/repositorio.git).');
  return name;
}

/** `--repo-ref`: nombre de rama o etiqueta. Lista conservadora: solo lo habitual y nunca algo que git lea como opción. */
const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/+@-]{0,199}$/;

export const REF_ERROR = 'La rama o etiqueta de --repo-ref solo puede llevar letras, dígitos y «. _ / + @ -», sin empezar por «-» ni «/», sin «..», «//» ni «@{», y sin terminar en «/», «.» o «.lock».';

export function isValidRepoRef(ref: string): boolean {
  if (!REF_PATTERN.test(ref)) return false;
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  if (ref === '@') return false;
  return !ref.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock'));
}
