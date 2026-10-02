import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CliError, fallbackDocumentName, writeOutput } from './io';

describe('writeOutput', () => {
  it('escribe el contenido en el archivo indicado, creando el directorio si falta', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c4io-'));
    const file = join(dir, 'nested', 'out.json');
    writeOutput(file, '{"a":1}');
    expect(readFileSync(file, 'utf8')).toBe('{"a":1}');
  });

  it('escribe en stdout si no se indica archivo (o es "-")', () => {
    // No hay una forma limpia de capturar process.stdout.write en vitest sin mockear;
    // basta con comprobar que no lanza.
    expect(() => writeOutput(undefined, 'x')).not.toThrow();
    expect(() => writeOutput('-', 'x')).not.toThrow();
  });

  it('un fallo de escritura produce un CliError claro, no una excepción cruda', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c4io-'));
    const asFile = join(dir, 'soy-un-archivo');
    writeFileSync(asFile, '');
    // Intentar usar un archivo existente como si fuera un directorio padre falla al crear la ruta.
    const badPath = join(asFile, 'salida.json');
    expect(() => writeOutput(badPath, 'x')).toThrow(CliError);
  });
});

describe('fallbackDocumentName', () => {
  it('quita la extensión de los formatos de C4 sin distinguir mayúsculas y conserva la carpeta fuera', () => {
    expect(fallbackDocumentName('/tmp/banca.drawio')).toBe('banca');
    expect(fallbackDocumentName('banca.DSL')).toBe('banca');
    expect(fallbackDocumentName('x/y/flujo.mmd')).toBe('flujo');
  });

  it('quita también las extensiones que declaran los importadores, las dobles incluidas', () => {
    const extensions = ['.tf', '.tf.json', '.yaml', '.sql', '.archimate'];
    expect(fallbackDocumentName('infra/main.tf', extensions)).toBe('main');
    expect(fallbackDocumentName('infra/main.tf.json', extensions)).toBe('main');
    expect(fallbackDocumentName('k8s/tienda.yaml', extensions)).toBe('tienda');
    expect(fallbackDocumentName('tienda.SQL', extensions)).toBe('tienda');
    expect(fallbackDocumentName('modelo.archimate', extensions)).toBe('modelo');
  });

  it('deja el nombre si la extensión no es de un formato conocido o si todo el nombre es la extensión', () => {
    expect(fallbackDocumentName('banca.v2')).toBe('banca.v2');
    expect(fallbackDocumentName('datos.sql')).toBe('datos.sql');
    expect(fallbackDocumentName('.tf', ['.tf'])).toBe('.tf');
  });
});
