import { extensionOf, isCodeFile, LANGUAGE_NAMES, suggestsComponent } from './rules';

/** Un archivo de texto visible para el escáner (ni ignorado, ni secreto, ni binario). */
export interface SeenFile {
  /** Ruta relativa a la carpeta analizada, con `/`. */
  rel: string;
  size: number;
}

interface DirNode {
  name: string;
  files: number;
  extensions: Map<string, number>;
  loose: string[];
  children: Map<string, DirNode>;
}

function newNode(name: string): DirNode {
  return { name, files: 0, extensions: new Map(), loose: [], children: new Map() };
}

function buildTree(files: SeenFile[]): DirNode {
  const root = newNode('');
  for (const file of files) {
    const parts = file.rel.split('/');
    const name = parts[parts.length - 1];
    const ext = extensionOf(name);
    let node = root;
    root.files += 1;
    bump(root.extensions, ext);
    for (const part of parts.slice(0, -1)) {
      let child = node.children.get(part);
      if (!child) node.children.set(part, (child = newNode(part)));
      node = child;
      node.files += 1;
      bump(node.extensions, ext);
    }
    node.loose.push(name);
  }
  return root;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topExtensions(map: Map<string, number>, n = 3): string {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([ext, count]) => `${count} .${ext || 'sin extensión'}`)
    .join(', ');
}

const MAX_ROOT_NAMES = 40;
const MAX_CHILDREN = 30;

/**
 * Árbol de carpetas con el número de archivos de cada una (y sus extensiones principales), hasta `depth` niveles. Los
 * archivos sueltos de la raíz se nombran (suelen ser los que dicen qué es el proyecto); de las demás carpetas solo se cuenta.
 */
export function renderTree(files: SeenFile[], depth: number): string {
  const root = buildTree(files);
  const lines: string[] = [];
  const rootNames = [...root.loose].sort();
  lines.push(`./ — ${root.files} archivos en total; sueltos en la raíz: ${rootNames.slice(0, MAX_ROOT_NAMES).join(', ') || '(ninguno)'}${rootNames.length > MAX_ROOT_NAMES ? `, … (+${rootNames.length - MAX_ROOT_NAMES})` : ''}`);
  const walk = (node: DirNode, level: number): void => {
    const children = [...node.children.values()].sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));
    for (const child of children.slice(0, MAX_CHILDREN)) {
      lines.push(`${'  '.repeat(level)}${child.name}/ — ${child.files} archivos (${topExtensions(child.extensions)})`);
      if (level < depth) walk(child, level + 1);
    }
    if (children.length > MAX_CHILDREN) lines.push(`${'  '.repeat(level)}… y ${children.length - MAX_CHILDREN} carpetas más`);
  };
  walk(root, 1);
  return lines.join('\n');
}

/** Lenguajes y formatos por número de archivos: «TypeScript 540, JSON 40, Markdown 30». */
export function renderLanguages(files: SeenFile[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    const language = LANGUAGE_NAMES[extensionOf(f.rel.slice(f.rel.lastIndexOf('/') + 1))];
    if (language) bump(counts, language);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([language, count]) => `${language} ${count}`)
    .join(', ');
}

/** Cuántos archivos de código fuente hay (para distinguir un repositorio con código de una carpeta cualquiera). */
export function countCode(files: SeenFile[]): number {
  return files.filter((f) => isCodeFile(f.rel.slice(f.rel.lastIndexOf('/') + 1))).length;
}

const MAX_PER_DIR = 6;

/**
 * Rutas (sin contenido) de los archivos de código cuyo nombre sugiere un componente: controladores, repositorios,
 * consumidores, clientes… Ayuda a dibujar el nivel de componentes sin gastar presupuesto en código. Se reparten por
 * carpeta (como mucho `MAX_PER_DIR` de cada una) y se acotan a `max` rutas.
 */
export function componentPaths(files: SeenFile[], max: number): { paths: string[]; total: number } {
  const perDir = new Map<string, number>();
  const paths: string[] = [];
  let total = 0;
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    const name = file.rel.slice(file.rel.lastIndexOf('/') + 1);
    if (!suggestsComponent(name) || /(?:^|\/)(?:tests?|__tests__|spec|e2e)\//i.test(file.rel) || /\.(?:test|spec)\.[a-z]+$/i.test(name)) continue;
    total += 1;
    const dir = file.rel.slice(0, Math.max(0, file.rel.lastIndexOf('/')));
    const n = perDir.get(dir) ?? 0;
    if (n >= MAX_PER_DIR || paths.length >= max) continue;
    perDir.set(dir, n + 1);
    paths.push(file.rel);
  }
  return { paths, total };
}
