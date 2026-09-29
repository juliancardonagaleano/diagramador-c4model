import { describe, expect, it } from 'vitest';
import { extractJson } from './extractJson';

describe('extractJson', () => {
  it('devuelve JSON puro tal cual', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('extrae JSON de un bloque ```json', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('recorta texto sobrante después del cierre aunque el JSON empiece en la posición 0', () => {
    // Antes: `first > 0` excluía este caso (el "{" está en la posición 0) y no se recortaba
    // el comentario final, rompiendo JSON.parse pese a que el documento era recuperable.
    const raw = '{"a":1}\nNota: generado por el modelo.';
    expect(extractJson(raw)).toBe('{"a":1}');
    expect(() => JSON.parse(extractJson(raw))).not.toThrow();
  });

  it('recorta texto sobrante antes y después cuando el JSON no empieza en la posición 0', () => {
    const raw = 'Aquí tienes el documento:\n{"a":1}\nEspero que ayude.';
    expect(extractJson(raw)).toBe('{"a":1}');
  });

  it('sin llaves, devuelve el texto recortado tal cual', () => {
    expect(extractJson('  hola  ')).toBe('hola');
  });
});
