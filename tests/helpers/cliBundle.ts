import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build, type Options } from 'tsup';
import configs from '../../tsup.config';

/**
 * Tiempo máximo (ms) para las pruebas que lanzan el CLI como proceso. Con la máquina descargada tardan segundos; con la
 * CPU saturada (varias PR en paralelo, carga 20-28 en 4 núcleos) cada arranque de `node` cuesta mucho más, y los 30 s
 * por defecto de Vitest se agotaban sin que nada estuviera roto. Un fallo real (un cuelgue, un código de salida
 * erróneo) sigue fallando: solo se le da más margen antes de darlo por colgado.
 */
export const PROCESS_TEST_TIMEOUT = 120_000;

/** Margen para empaquetar el CLI con tsup (varios segundos descargado, bastante más con la CPU saturada). */
export const BUNDLE_TIMEOUT = 120_000;

export interface CliBundle {
  /** Ruta de `cli/index.js` empaquetado; se ejecuta con `process.execPath`. */
  cli: string;
  /** Borra el paquete temporal. */
  dispose: () => void;
}

/**
 * Empaqueta el CLI con la misma configuración de tsup con la que se publica (`dist/cli/index.js`) y devuelve la ruta
 * para ejecutarlo con `node`. Arrancar el código fuente con `tsx` en cada llamada cuesta ~1,5 s de CPU (transpilar el
 * árbol entero); el paquete arranca en una fracción y es, además, lo que se instala de verdad. Cada archivo de prueba
 * empaqueta una vez a su propia carpeta (`name`) para poder correr en paralelo sin pisarse y para que `vitest --watch`
 * siempre use el código actual.
 */
export async function buildCliBundle(name: string): Promise<CliBundle> {
  // Dentro del repo para que node resuelva las dependencias externas (elkjs, zod, commander…) desde `node_modules`.
  const outDir = resolve('node_modules/.cache', `iark-cli-${name}`);
  const options = (configs as Options[]).find((c) => c.entry && !Array.isArray(c.entry) && 'cli/index' in c.entry);
  if (!options) throw new Error('tsup.config.ts debe definir la entrada cli/index');
  const dispose = () => rmSync(outDir, { recursive: true, force: true });
  dispose();
  await build({ ...options, config: false, outDir, dts: false, sourcemap: false, silent: true });
  return { cli: join(outDir, 'cli/index.js'), dispose };
}
