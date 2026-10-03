import { describe, expect, it } from 'vitest';
import { CliError } from '../io';
import { classifyRepoSource, isValidRepoRef, type RepoSource } from './source';

/**
 * ¿Carpeta o URL?, y qué URL se pueden clonar. La decisión es una función pura: aquí «no existe ninguna carpeta» salvo que se
 * diga lo contrario, y nada toca el disco ni la red.
 */

const noFolder = (): boolean => false;
const classify = (value: string, isFolder: (p: string) => boolean = noFolder): RepoSource => classifyRepoSource(value, isFolder);

function rejection(value: string, isFolder: (p: string) => boolean = noFolder): CliError {
  try {
    classifyRepoSource(value, isFolder);
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).exitCode).toBe(2);
    return error as CliError;
  }
  throw new Error(`se esperaba un rechazo para ${JSON.stringify(value)}`);
}

describe('classifyRepoSource: URL aceptadas', () => {
  it.each([
    ['https://github.com/acme/tienda.git', 'tienda', 'https'],
    ['https://github.com/acme/tienda', 'tienda', 'https'],
    ['https://github.com/acme/tienda/', 'tienda', 'https'],
    ['HTTPS://github.com/acme/tienda.git', 'tienda', 'https'],
    ['https://gitlab.example.com:8443/grupo/sub/grupo/mi-repo.git', 'mi-repo', 'https'],
    ['https://dev.azure.com/org/proyecto/_git/mi_repo', 'mi_repo', 'https'],
    ['https://192.168.1.20/git/repo.git', 'repo', 'https'],
    ['https://[::1]:3000/acme/repo.git', 'repo', 'https'],
    ['https://git.example.com/~usuario/repo.v2.git', 'repo.v2', 'https'],
    ['ssh://git@github.com/acme/tienda.git', 'tienda', 'ssh'],
    ['ssh://git@host.example.com:2222/srv/git/tienda.git', 'tienda', 'ssh'],
    ['ssh://host.example.com/acme/tienda.git', 'tienda', 'ssh'],
    ['git@github.com:acme/tienda.git', 'tienda', 'ssh'],
    ['git@gitlab.example.com:grupo/sub/tienda', 'tienda', 'ssh'],
    ['usuario@host-interno:srv/repos/tienda.git', 'tienda', 'ssh'],
    ['github.com:acme/tienda.git', 'tienda', 'ssh'],
  ])('%s → %s (%s)', (value, name, transport) => {
    const source = classify(value);
    expect(source.kind).toBe('url');
    if (source.kind !== 'url') return;
    expect(source.name).toBe(name);
    expect(source.transport).toBe(transport);
    // Lo aceptado se pasa a git tal cual (salvo el esquema en minúsculas) y se muestra igual: no lleva credenciales.
    expect(source.url.toLowerCase()).toBe(value.toLowerCase());
    expect(source.display).toBe(source.url);
  });

  it('el nombre del repositorio sale de la URL: sin .git, sin barras y sin rutas del equipo', () => {
    expect((classify('https://example.com/a/b/c.git') as { name: string }).name).toBe('c');
    expect((classify('https://example.com/a/b/c.GIT/') as { name: string }).name).toBe('c');
    expect((classify('git@example.com:/srv/git/c.git') as { name: string }).name).toBe('c');
  });
});

describe('classifyRepoSource: carpeta o URL', () => {
  it('una ruta que existe como carpeta es siempre una carpeta, aunque se parezca a una URL', () => {
    const existing = new Set(['/tmp/proyecto', 'https://github.com/acme/tienda.git', 'git@github.com:acme/tienda.git', '-rara', 'C:\\repos\\tienda']);
    const isFolder = (p: string): boolean => existing.has(p);
    for (const value of existing) expect(classify(value, isFolder)).toEqual({ kind: 'folder', path: value });
  });

  it('una ruta que no existe y no parece una URL sigue siendo una «carpeta» (el escáner dirá que no existe)', () => {
    for (const value of ['./no-existe', '/tmp/x/no-existe', '../otro/repo', 'repo', 'carpeta con espacios', 'C:\\Users\\yo\\repo', 'localhost:repo', 'proyecto:v2', 'a/b:c']) {
      expect(classify(value), value).toEqual({ kind: 'folder', path: value });
    }
  });

  it('la ruta de una carpeta se devuelve tal cual (sin recortar)', () => {
    expect(classify(' ./con-espacios ')).toEqual({ kind: 'folder', path: ' ./con-espacios ' });
  });

  it('vacío: error de uso', () => {
    for (const value of ['', '   ', '\n']) expect(rejection(value).message).toMatch(/necesita la ruta de una carpeta o la URL/);
  });
});

describe('classifyRepoSource: URL rechazadas, con un mensaje claro', () => {
  it.each([
    ['http://github.com/acme/tienda.git', /http:\/\/ van sin cifrar.*usa https:\/\//],
    ['HTTP://github.com/acme/tienda.git', /sin cifrar/],
    ['git://github.com/acme/tienda.git', /git:\/\/ no cifra ni autentica/],
    ['file:///home/yo/repo', /file:\/\/ no se admite.*indica su carpeta/],
    ['file://localhost/home/yo/repo', /file:\/\/ no se admite/],
    ['ftp://example.com/repo.git', /transporte «ftp:\/\/» no se admite/],
    ['ssh+git://github.com/acme/tienda.git', /transporte «ssh\+git:\/\/» no se admite/],
    ['git+ssh://github.com/acme/tienda.git', /transporte «git\+ssh:\/\/» no se admite/],
    ['rsync://example.com/repo', /no se admite/],
    ['ext::sh -c touch% /tmp/pwned', /ayudantes de transporte de git \(ext::/],
    ['ext::ssh -oProxyCommand=evil x', /ayudantes de transporte/],
    ['fd::17/foo', /ayudantes de transporte/],
    ['transport::address', /ayudantes de transporte/],
  ])('%s', (value, message) => {
    expect(rejection(value).message).toMatch(message);
  });

  it.each([
    '-ouploadpack',
    '--upload-pack=touch /tmp/pwned',
    '--upload-pack=evil',
    '-c core.sshCommand=evil',
    '-',
  ])('un valor que empieza por «-» (inyección de argumentos): %s', (value) => {
    expect(rejection(value).message).toMatch(/no puede empezar por «-»/);
    // La inyección tampoco se cuela detrás de un esquema o de una forma scp.
    for (const url of [`https://-oProxyCommand=evil/x.git`, `ssh://-oProxyCommand=evil/x.git`, `-oProxyCommand=evil@host:x.git`, `git@-oProxyCommand=evil:x.git`]) {
      const message = rejection(url).message;
      expect(message, url).toMatch(/no es válido|empieza por|no puede empezar/);
    }
  });

  it('el host y el usuario nunca empiezan por «-» (ssh los leería como una opción)', () => {
    expect(rejection('ssh://-oProxyCommand=touch%20x/repo.git').message).toMatch(/host/);
    expect(rejection('ssh://-p@host/repo.git').message).toMatch(/usuario/);
    expect(rejection('git@-host:repo.git').message).toMatch(/host/);
    expect(rejection('-x@host:repo.git').message).toMatch(/no puede empezar por «-»/);
    expect(rejection('usuario@host:-oProxyCommand=evil').message).toMatch(/ruta del repositorio/);
  });

  describe('credenciales dentro de la URL: se rechazan y NUNCA se imprimen', () => {
    const token = ['gh', 'p_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].join('');
    const password = 'clave-super-secreta-123';
    it.each([
      [`https://usuario:${token}@github.com/acme/tienda.git`, token],
      [`https://${token}@github.com/acme/tienda.git`, token],
      [`https://usuario@github.com/acme/tienda.git`, 'usuario@'],
      [`https://usuario:${password}@gitlab.example.com/grupo/repo.git`, password],
      [`https://x-access-token:${token}@github.com/acme/tienda.git`, token],
      [`ssh://git:${password}@github.com/acme/tienda.git`, password],
      [`https://a@b:${password}@host/x.git`, password],
    ])('%s', (value, secret) => {
      const error = rejection(value);
      expect(error.message).toMatch(/lleva credenciales .* dentro: no se admiten ni se imprimen/);
      expect(error.message).toMatch(/gestor de credenciales de git .* o ssh/);
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain('github.com');
      expect(error.message).not.toContain('gitlab');
    });

    it('un valor con credenciales que no es una URL válida tampoco se repite', () => {
      for (const value of [`usuario:${password}@github.com/acme/tienda`, `usuario:${token}@github.com:acme/x`]) {
        const error = rejection(value);
        expect(error.message).not.toContain(password);
        expect(error.message).not.toContain(token);
        expect(error.message).toMatch(/ni una URL de git válida/);
      }
    });

    it('ninguno de los demás mensajes de rechazo repite el valor escrito', () => {
      const secretValue = `${token}@evil`;
      for (const value of [`http://u:${secretValue}/x`, `git://${secretValue}/x`, `file://${secretValue}/x`, `ftp://${secretValue}/x`, `ext::${secretValue}`, `https://host/a b/${secretValue}`, `-${secretValue}`]) {
        expect(rejection(value).message, value).not.toContain(token);
      }
    });
  });

  it.each([
    ['con un espacio dentro', 'https://github.com/acme/tienda .git'],
    ['con un espacio al final', 'https://github.com/acme/tienda.git '],
    ['con un espacio al principio', ' https://github.com/acme/tienda.git'],
    ['con un salto de línea al final', 'https://github.com/acme/tienda.git\n'],
    ['con un salto de línea dentro (otra línea de git)', 'https://github.com/acme/tienda.git\nhttps://evil.example/x.git'],
    ['con un retorno de carro', 'https://github.com/acme/tienda.git\r'],
    ['con un tabulador', 'https://github.com/acme/\ttienda.git'],
    ['con un carácter NUL', 'https://github.com/acme/tienda\u0000.git'],
    ['con un salto de línea Unicode', 'https://github.com/acme/tienda\u2028.git'],
    ['con un espacio de ancho cero', 'https://github.com/acme/tienda\u200b.git'],
    ['con un carácter de dirección de texto', 'https://github.com/acme/tienda\u202e.git'],
    ['forma scp con espacios', 'git@github.com:acme/tienda .git'],
    ['forma scp con salto de línea', 'git@github.com:acme/tienda.git\n'],
    ['ssh con una orden detrás', 'ssh://git@github.com/acme/tienda.git -o ProxyCommand=evil'],
  ])('espacios, saltos de línea y caracteres invisibles: %s', (_caso, value) => {
    expect(rejection(value).message).toMatch(/no puede contener espacios, saltos de línea ni caracteres de control o invisibles/);
  });

  it.each([
    ['comillas', "https://github.com/acme/'tienda'.git"],
    ['dólar y paréntesis', 'https://github.com/acme/$(id).git'],
    ['acento grave', 'https://github.com/acme/`id`.git'],
    ['punto y coma', 'https://github.com/acme/a;b.git'],
    ['ampersand', 'https://github.com/acme/a&b.git'],
    ['barra vertical', 'https://github.com/acme/a|b.git'],
    ['barra invertida', 'https://github.com/acme/a\\b.git'],
    ['interrogación', 'https://github.com/acme/a.git?x=1'],
    ['almohadilla', 'https://github.com/acme/a.git#rama'],
    ['comodín', 'https://github.com/acme/*.git'],
    ['scp con dólar', 'git@github.com:acme/$(x).git'],
    ['ssh con comillas', "ssh://git@github.com/acme/'x'.git"],
  ])('caracteres no admitidos en la ruta: %s', (_caso, value) => {
    expect(rejection(value).message).toMatch(/caracteres no admitidos/);
  });

  it.each([
    ['https://github.com', /no indica el repositorio/],
    ['https://github.com/', /no indica el repositorio/],
    ['https:///acme/x.git', /host/],
    ['https://exa mple.com/x.git', /espacios/],
    ['https://exámple.com/x.git', /nombre del host/],
    ['https://host_con$/x.git', /nombre del host/],
    ['https://github.com:abc/x.git', /puerto/],
    ['https://github.com:0/x.git', /puerto/],
    ['https://github.com:99999/x.git', /puerto/],
    ['https://github.com/acme/../otro.git', /«\.» ni «\.\.»/],
    ['https://github.com/acme/./otro.git', /«\.» ni «\.\.»/],
    ['https://github.com/a%0Ab.git', /escape «%»/],
    ['https://github.com/a%zz.git', /escape «%»/],
    ['ssh://git@github.com/a%20b.git', /no puede llevar «%»/],
    ['https://github.com/.git', /nombre del repositorio/],
    ['https://github.com/acme/...', /nombre del repositorio/],
    ['https://[::1/x.git', /host/],
  ])('URL mal formadas: %s', (value, message) => {
    expect(rejection(value).message).toMatch(message);
  });

  it('una URL demasiado larga', () => {
    expect(rejection(`https://github.com/acme/${'a'.repeat(2100)}.git`).message).toMatch(/demasiado larga/);
  });
});

describe('isValidRepoRef (--repo-ref)', () => {
  it.each(['main', 'master', 'develop', 'v1.2.3', 'release/1.0', 'feature/mi-rama_2', 'user@feature', 'v1.0+build.5', '2024-q1', 'a'])('acepta %s', (ref) => {
    expect(isValidRepoRef(ref)).toBe(true);
  });

  it.each([
    '',
    '-main',
    '--upload-pack=evil',
    '--branch=x',
    ' main',
    'ma in',
    'main\n',
    'main;touch x',
    '$(id)',
    '`id`',
    '/main',
    'main/',
    'a//b',
    'a..b',
    '..',
    'a@{1}',
    '@',
    'rama.lock',
    'a/b.lock/c',
    'main.',
    '.oculta',
    'a/.b',
    'caña',
    'a'.repeat(201),
    'a\u0000b',
    'a\u202eb',
  ])('rechaza %j', (ref) => {
    expect(isValidRepoRef(ref)).toBe(false);
  });
});
