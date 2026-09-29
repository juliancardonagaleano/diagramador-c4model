import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createDefaultRegistry } from '../src/cli/registry';
import { suiteManifest } from '../src/cli/suiteManifest';

/** Escribe el manifiesto de federación que publica el sitio estático: `public/.well-known/iark.json`. */
export const MANIFEST_PATH = 'public/.well-known/iark.json';

export function renderManifest(): string {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
  return JSON.stringify(suiteManifest(createDefaultRegistry(), { version }), null, 2) + '\n';
}

if (process.argv[1]?.endsWith('generate-manifest.ts')) {
  mkdirSync('public/.well-known', { recursive: true });
  writeFileSync(MANIFEST_PATH, renderManifest());
  console.log(`Manifiesto escrito en ${MANIFEST_PATH}`);
}
