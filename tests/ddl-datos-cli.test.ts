import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCliBundle, BUNDLE_TIMEOUT, PROCESS_TEST_TIMEOUT, type CliBundle } from './helpers/cliBundle';

// `iark data ddl --asset <id>` con un producto, una API o un glosario del catálogo: el CLI empaquetado, como se publica.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT, hookTimeout: BUNDLE_TIMEOUT });

const EXAMPLE = 'examples/datos-catalogo.json';

describe('iark data ddl --asset con productos, APIs y glosarios', () => {
  let bundle: CliBundle;
  const ddl = (...args: string[]) => {
    const r = spawnSync(process.execPath, [bundle.cli, 'data', 'ddl', EXAMPLE, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  /** Nombres de las tablas que genera el script, en orden. */
  const tables = (out: string): string[] => [...out.matchAll(/^CREATE TABLE (\S+) \(/gm)].map((m) => m[1]);

  beforeAll(async () => {
    bundle = await buildCliBundle('ddl-datos');
  }, BUNDLE_TIMEOUT);
  afterAll(() => bundle?.dispose());

  it('una API de datos: las tablas de los activos que expone', () => {
    const r = ddl('--asset', 'api-ventas');
    expect(r.code).toBe(0);
    expect(tables(r.out)).toEqual(['fact_ventas']);
  });

  it('un producto de datos: las de sus puertos de entrada y de salida, y las de lo que sirve una API publicada como salida', () => {
    const r = ddl('--asset', 'ventas-360');
    expect(r.code).toBe(0);
    expect(tables(r.out)).toEqual(['plata_ventas', 'dim_cliente', 'fact_ventas']);
    // Un puerto que no es una tabla (un modelo sin columnas) no añade nada.
    expect(tables(ddl('--asset', 'analitica-fuga').out)).toEqual(['dim_cliente', 'fact_ventas']);
  });

  it('un glosario: las tablas de los activos con términos enlazados', () => {
    const r = ddl('--asset', 'glosario-ventas');
    expect(r.code).toBe(0);
    expect(tables(r.out)).toEqual(['clientes', 'pedidos', 'dim_cliente', 'fact_ventas']);
  });

  it('un contenedor sigue filtrando como antes y un id que no existe da el error con la lista de activos, ya con los tipos del catálogo', () => {
    expect(tables(ddl('--asset', 'erp').out)).toEqual(['pedidos', 'lineas_de_pedido']);
    const r = ddl('--asset', 'no-existe');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('No existe el activo «no-existe». Activos: crm, crm-clientes');
    expect(r.err).toContain('ventas-360, analitica-fuga, api-ventas, glosario-ventas');
  });

  it('la ayuda del comando documenta qué da cada tipo de activo', () => {
    const help = spawnSync(process.execPath, [bundle.cli, 'data', 'ddl', '--help'], { encoding: 'utf8' }).stdout;
    expect(help).toMatch(/producto de datos/);
    expect(help).toMatch(/puertos de entrada y de salida/);
    expect(help).toMatch(/glosario/);
  });
});
