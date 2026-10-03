import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Cada paquete de `packages/*` declara en SU `package.json` las librerías de terceros que importa su código (no las pruebas), con
// la misma versión que la raíz. Antes `domain-platform` (yaml) y `domain-enterprise` (fast-xml-parser) las resolvían por las de la
// raíz sin declararlas, y `runtime-deps.test.ts` solo mira el `package.json` de la raíz: si un paquete se publicara o se instalara
// por separado fallaría al importarlas.
interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
const readManifest = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;
const root = readManifest('package.json');
const rootVersions = { ...root.devDependencies, ...root.dependencies };
const builtins = new Set(builtinModules);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });

/** Paquetes externos que importa un archivo: `import … from 'x'`, `export … from 'x'`, `import 'x'` e `import('x')` (los comentarios no cuentan). */
function importedPackages(source: string): string[] {
  const specifiers = [
    ...[...source.matchAll(/^\s*(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]),
    ...[...source.matchAll(/^[^*/\n]*\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1]),
  ];
  return specifiers
    .filter((s) => !s.startsWith('.') && !s.startsWith('node:') && !builtins.has(s.split('/')[0]))
    .map((s) => s.split('/').slice(0, s.startsWith('@') ? 2 : 1).join('/'));
}

const packages = readdirSync('packages').filter((d) => existsSync(join('packages', d, 'package.json')));

describe('dependencias declaradas por cada paquete del monorepo', () => {
  it('hay paquetes que comprobar', () => {
    expect(packages).toEqual(expect.arrayContaining(['kernel', 'domain-c4', 'domain-data', 'domain-enterprise', 'domain-integration', 'domain-platform', 'domain-security']));
  });

  it.each(packages)('packages/%s declara en `dependencies` todo lo que importa su código', (dir) => {
    const manifest = readManifest(join('packages', dir, 'package.json'));
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const imported = new Map<string, string>();
    for (const file of sourceFiles(join('packages', dir, 'src'))) for (const name of importedPackages(readFileSync(file, 'utf8'))) if (!imported.has(name)) imported.set(name, file);
    for (const [name, file] of imported) expect(declared.has(name), `${file} importa «${name}», que no está en las dependencies de ${manifest.name}`).toBe(true);
  });

  it.each(packages)('packages/%s usa las mismas versiones que la raíz para lo que comparten', (dir) => {
    const manifest = readManifest(join('packages', dir, 'package.json'));
    for (const [name, version] of Object.entries({ ...manifest.devDependencies, ...manifest.dependencies })) {
      if (name.startsWith('@iark/')) continue; // paquetes del propio monorepo («*»)
      expect(rootVersions[name], `${manifest.name} declara «${name}», que la raíz no tiene`).toBeDefined();
      expect(version, `${manifest.name} declara ${name}@${version} y la raíz ${rootVersions[name]}`).toBe(rootVersions[name]);
    }
  });

  it('el importador de Kubernetes (yaml) y el de ArchiMate (fast-xml-parser) están declarados en su propio paquete', () => {
    expect(readManifest('packages/domain-platform/package.json').dependencies).toMatchObject({ yaml: root.dependencies?.yaml });
    expect(readManifest('packages/domain-enterprise/package.json').dependencies).toMatchObject({ 'fast-xml-parser': root.dependencies?.['fast-xml-parser'] });
  });
});
