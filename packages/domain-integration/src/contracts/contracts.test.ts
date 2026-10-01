import type { AttachmentDiagnostic } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { CONTRACT_FORMATS, type ContractFormat } from '../types';
import { CONTRACT_FORMAT_INFO, CONTRACT_TRANSFORMS, checkContract, contractTemplate, reformatContract, summarizeContract } from './index';
import { describeJsonError, orderKeys, parseJson, positionAt, prettyJson, sortKeys } from './json';

const lines = (...rows: string[]): string => rows.join('\n');

const find = (diagnostics: AttachmentDiagnostic[], severity: AttachmentDiagnostic['severity'], fragment: string): AttachmentDiagnostic | undefined =>
  diagnostics.find((d) => d.severity === severity && d.message.includes(fragment));

const errorsOf = (format: ContractFormat, text: string): AttachmentDiagnostic[] => checkContract(format, text).filter((d) => d.severity === 'error');

function expectDiagnostic(format: ContractFormat, text: string, severity: AttachmentDiagnostic['severity'], fragment: string, at?: { line: number; column?: number }): void {
  const diagnostics = checkContract(format, text);
  const found = find(diagnostics, severity, fragment);
  expect(found, `Falta «${fragment}» (${severity}) en:\n${diagnostics.map((d) => `${d.severity} ${d.line ?? '-'}:${d.column ?? '-'} ${d.message}`).join('\n')}`).toBeDefined();
  if (at) {
    expect(found!.line).toBe(at.line);
    if (at.column !== undefined) expect(found!.column).toBe(at.column);
  }
}

function expectNoDiagnostic(format: ContractFormat, text: string, fragment: string): void {
  expect(checkContract(format, text).some((d) => d.message.includes(fragment))).toBe(false);
}

function reformatted(format: ContractFormat, text: string, name = 'Pedido creado'): string {
  const result = reformatContract(format, text, { name });
  if (!result.ok) throw new Error(`No se pudo formatear: ${result.reason}`);
  return result.text;
}

function reformatFailure(format: ContractFormat, text: string): string {
  const result = reformatContract(format, text, { name: 'x' });
  if (result.ok) throw new Error('Se esperaba un fallo');
  return result.reason;
}

describe('CONTRACT_FORMAT_INFO', () => {
  it('describe todos los formatos con su etiqueta, lenguaje y extensión', () => {
    expect(Object.keys(CONTRACT_FORMAT_INFO).sort()).toEqual([...CONTRACT_FORMATS].sort());
    const expected: Record<ContractFormat, [string, string, string]> = {
      openapi: ['OpenAPI (REST)', 'json', '.json'],
      asyncapi: ['AsyncAPI', 'json', '.json'],
      graphql: ['GraphQL (SDL)', 'graphql', '.graphql'],
      protobuf: ['Protobuf / gRPC (.proto)', 'proto', '.proto'],
      avro: ['Avro', 'json', '.avsc'],
      'json-schema': ['JSON Schema', 'json', '.json'],
      wsdl: ['WSDL (XML)', 'xml', '.wsdl'],
      cloudevents: ['CloudEvents (JSON)', 'json', '.json'],
      mcp: ['MCP (JSON)', 'json', '.json'],
      other: ['Otro', 'text', '.txt'],
    };
    for (const format of CONTRACT_FORMATS) {
      const info = CONTRACT_FORMAT_INFO[format];
      expect(info.id).toBe(format);
      expect([info.label, info.language, info.extension]).toEqual(expected[format]);
      expect(info.description?.length).toBeGreaterThan(10);
    }
  });
});

describe('plantillas', () => {
  it.each(CONTRACT_FORMATS.filter((f) => f !== 'other'))('la plantilla de %s no produce ningún diagnóstico', (format) => {
    const template = contractTemplate(format, 'Pedidos');
    expect(template.trim().length).toBeGreaterThan(20);
    expect(checkContract(format, template)).toEqual([]);
  });

  it.each(CONTRACT_FORMATS.filter((f) => f !== 'other'))('la plantilla de %s ya está en forma canónica', (format) => {
    const template = contractTemplate(format, 'Pedidos');
    expect(reformatted(format, template, 'Pedidos')).toBe(template);
  });

  it('la plantilla de «other» está vacía y sin comprobaciones', () => {
    expect(contractTemplate('other', 'Lo que sea')).toBe('');
    expect(checkContract('other', 'cualquier texto')).toEqual([]);
  });

  it.each(CONTRACT_FORMATS.filter((f) => f !== 'other'))('la plantilla de %s es válida con nombres con acentos, espacios y vacíos', (format) => {
    for (const name of ['Gestión de Pedidos ñandú', '  ', '123 servicio', 'a"b<c>&d', 'Pedido\nviejo']) {
      const template = contractTemplate(format, name);
      expect(errorsOf(format, template), `${format} con «${name}»`).toEqual([]);
    }
  });

  it('usa el nombre para titular o nombrar', () => {
    expect(contractTemplate('openapi', 'Pedidos API')).toContain('"title": "Pedidos API"');
    expect(contractTemplate('asyncapi', 'Pedidos API')).toContain('"title": "Pedidos API"');
    expect(contractTemplate('protobuf', 'Pedidos API')).toContain('service PedidosAPI');
    expect(contractTemplate('protobuf', 'Pedidos API')).toContain('package com.example.pedidos_api.v1;');
    expect(contractTemplate('cloudevents', 'Pedido creado')).toContain('"type": "com.example.pedido-creado"');
    expect(contractTemplate('cloudevents', 'Pedido creado')).toContain('"source": "/pedido-creado"');
    expect(contractTemplate('mcp', 'Pedidos MCP')).toContain('"name": "pedidos-mcp"');
    expect(contractTemplate('json-schema', 'Pedido')).toContain('"title": "Pedido"');
    expect(contractTemplate('avro', 'pedido creado')).toContain('"name": "PedidoCreado"');
    expect(contractTemplate('graphql', 'Pedidos')).toContain('# Esquema GraphQL de Pedidos');
    expect(contractTemplate('wsdl', 'Pedidos')).toContain('<service name="Pedidos">');
  });

  it('las plantillas tienen el ejemplo mínimo que se pide', () => {
    const openapi = JSON.parse(contractTemplate('openapi', 'X'));
    expect(openapi.openapi).toBe('3.0.3');
    expect(Object.keys(openapi.paths['/recursos'])).toEqual(['get']);
    expect(openapi.paths['/recursos'].get.responses['200']).toBeDefined();

    const cloud = JSON.parse(contractTemplate('cloudevents', 'X'));
    expect(Object.keys(cloud)).toEqual(['specversion', 'id', 'source', 'type', 'datacontenttype', 'dataschema', 'subject', 'time', 'data']);

    const proto = contractTemplate('protobuf', 'X');
    expect(proto).toContain('syntax = "proto3";');
    expect(proto).toMatch(/service \w+ \{/);
    expect(proto).toMatch(/rpc \w+ \(\w+\) returns \(stream \w+\);/);

    const mcp = JSON.parse(contractTemplate('mcp', 'X'));
    expect([mcp.tools.length, mcp.resources.length, mcp.prompts.length]).toEqual([1, 1, 1]);

    const asyncapi = JSON.parse(contractTemplate('asyncapi', 'X'));
    expect(asyncapi.asyncapi).toBe('3.0.0');
    expect(Object.keys(asyncapi.channels)).toHaveLength(1);

    expect(JSON.parse(contractTemplate('json-schema', 'X')).$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(JSON.parse(contractTemplate('avro', 'X')).type).toBe('record');
    expect(contractTemplate('graphql', 'X')).toContain('type Query {');
    expect(contractTemplate('wsdl', 'X')).toContain('<portType');
  });
});

describe('texto vacío', () => {
  it.each(CONTRACT_FORMATS)('checkContract(%s) avisa de que no hay contenido', (format) => {
    expect(checkContract(format, '')).toEqual([{ severity: 'info', message: 'El contrato no tiene contenido.' }]);
    expect(checkContract(format, ' \n\t ')).toEqual([{ severity: 'info', message: 'El contrato no tiene contenido.' }]);
  });

  it.each(CONTRACT_FORMATS.filter((f) => f !== 'other'))('reformatContract(%s) rechaza el texto vacío y summarize devuelve []', (format) => {
    expect(reformatContract(format, '  ', { name: 'x' })).toEqual({ ok: false, reason: 'El contrato no tiene contenido.' });
    expect(summarizeContract(format, '')).toEqual([]);
  });
});

describe('utilidades JSON', () => {
  it('positionAt cuenta líneas y columnas desde 1', () => {
    expect(positionAt('abc', 0)).toEqual({ line: 1, column: 1 });
    expect(positionAt('abc\ndef', 5)).toEqual({ line: 2, column: 2 });
    expect(positionAt('abc\n', 4)).toEqual({ line: 2, column: 1 });
    expect(positionAt('abc', 99)).toEqual({ line: 1, column: 4 });
  });

  it('parseJson devuelve el valor o el error con su posición', () => {
    expect(parseJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
    const cases: Array<[string, number, number, string]> = [
      ['{\n  "a": 1,\n  "b": ,\n}', 3, 8, 'se esperaba un valor'],
      ['{\n  "a": 1,\n}', 2, 9, 'sobra una coma antes de «}»'],
      ['[1, 2,\n]', 1, 6, 'sobra una coma antes de «]»'],
      ['{"a": 1', 1, 8, 'se esperaba «,» o «}» y se encontró el final del texto'],
      ["{'a': 1}", 1, 2, 'se esperaba un nombre de propiedad entre comillas dobles'],
      ['{"a" 1}', 1, 6, 'se esperaba «:»'],
      ['{"a": tru}', 1, 7, 'valor no válido «tru»'],
      ['{"a": "x\ny"}', 1, 7, 'cadena sin cerrar'],
      ['{"a": "x\\q"}', 1, 9, 'secuencia de escape no válida'],
      ['{"a": 01}', 1, 7, 'número no válido'],
      ['{"a": 1} x', 1, 10, 'contenido inesperado'],
      ['', 1, 1, 'el texto termina de forma inesperada'],
    ];
    for (const [text, line, column, fragment] of cases) {
      const result = parseJson(text);
      expect(result.ok, text).toBe(false);
      if (result.ok) continue;
      expect(result.message, text).toContain(fragment);
      expect([result.line, result.column], text).toEqual([line, column]);
    }
  });

  it('describeJsonError incluye la línea y la columna', () => {
    const result = parseJson('{\n"a" }');
    if (result.ok) throw new Error('debería fallar');
    expect(describeJsonError(result)).toMatch(/\(línea 2, columna 5\)$/);
  });

  it('tolera una marca BOM al principio', () => {
    expect(parseJson('\uFEFF{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it('prettyJson usa 2 espacios y salto de línea final', () => {
    expect(prettyJson({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });

  it('orderKeys pone primero las claves indicadas y conserva el orden del resto', () => {
    const ordered = orderKeys({ z: 1, b: 2, a: 3, x: 4 }, ['a', 'q', 'b']);
    expect(Object.keys(ordered)).toEqual(['a', 'b', 'z', 'x']);
    expect(Object.keys(sortKeys({ b: 1, a: 2, c: 3 }))).toEqual(['a', 'b', 'c']);
  });

  it('orderKeys no se confunde con la clave __proto__', () => {
    const input = JSON.parse('{"__proto__": {"x": 1}, "a": 2}') as Record<string, unknown>;
    const ordered = orderKeys(input, ['a']);
    expect(Object.keys(ordered)).toEqual(['a', '__proto__']);
    expect(Object.getPrototypeOf(ordered)).toBe(Object.prototype);
  });
});

describe('CloudEvents: comprobación', () => {
  const valid = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ specversion: '1.0', id: '1', source: '/pedidos', type: 'com.empresa.pedido.creado', ...extra }, null, 2);

  it('un evento correcto no tiene problemas', () => {
    expect(checkContract('cloudevents', valid())).toEqual([]);
    expect(checkContract('cloudevents', valid({ datacontenttype: 'application/json; charset=utf-8', data: { a: 1 }, time: '2024-02-29T23:59:60.5+02:00' }))).toEqual([]);
    expect(checkContract('cloudevents', valid({ datacontenttype: 'application/octet-stream', data_base64: 'aGVsbG8=' }))).toEqual([]);
    expect(checkContract('cloudevents', valid({ partitionkey: 'a', traceparent: 'x' }))).toEqual([]);
  });

  it('un JSON inválido da el error con su posición', () => {
    expectDiagnostic('cloudevents', '{\n  "specversion": "1.0",\n  "id": "1",,\n}', 'error', 'JSON no válido', { line: 3, column: 13 });
    expectDiagnostic('cloudevents', '{"a": ', 'error', 'termina de forma inesperada', { line: 1 });
  });

  it('exige un objeto (o un array de eventos)', () => {
    expectDiagnostic('cloudevents', '3', 'error', 'debe ser un objeto JSON');
    expectDiagnostic('cloudevents', '"texto"', 'error', 'debe ser un objeto JSON');
    expectDiagnostic('cloudevents', 'null', 'error', 'debe ser un objeto JSON');
  });

  it('specversion debe ser "1.0"', () => {
    expectDiagnostic('cloudevents', '{"id":"1","source":"/a","type":"a.b.c"}', 'error', 'Falta «specversion»');
    expectDiagnostic('cloudevents', valid({ specversion: '0.3' }), 'error', '«specversion» debe ser "1.0" y es "0.3"', { line: 2, column: 3 });
    expectDiagnostic('cloudevents', valid({ specversion: 1 }), 'error', '«specversion» debe ser "1.0"');
  });

  it('id, source y type son obligatorios, cadenas y no vacíos', () => {
    for (const key of ['id', 'source', 'type']) {
      const event = JSON.parse(valid()) as Record<string, unknown>;
      delete event[key];
      expectDiagnostic('cloudevents', JSON.stringify(event), 'error', `Falta el atributo obligatorio «${key}»`);
      expectDiagnostic('cloudevents', valid({ [key]: '' }), 'error', `«${key}» no puede estar vacío`);
      expectDiagnostic('cloudevents', valid({ [key]: '   ' }), 'error', `«${key}» no puede estar vacío`);
      expectDiagnostic('cloudevents', valid({ [key]: 5 }), 'error', `«${key}» debe ser una cadena de texto`);
    }
  });

  it('señala la línea del atributo con el problema', () => {
    const text = lines('{', '  "specversion": "1.0",', '  "id": "",', '  "source": "/a",', '  "type": "com.a.b"', '}');
    expectDiagnostic('cloudevents', text, 'error', '«id» no puede estar vacío', { line: 3, column: 3 });
  });

  it('source debe ser una URI-reference', () => {
    for (const source of ['/pedidos', 'pedidos/1', 'https://example.com/a?b=c#d', 'urn:uuid:6e8bc430-9c3a-11d9-9669-0800200c9a66', 'mailto:a@b.c', '//host/ruta', '#frag']) {
      expect(checkContract('cloudevents', valid({ source })), source).toEqual([]);
    }
    for (const source of ['a b', 'ñandú', '/a%zz', '<x>']) {
      expectDiagnostic('cloudevents', valid({ source }), 'error', '«source» no es una URI-reference válida');
    }
  });

  it('datacontenttype debe tener la forma tipo/subtipo', () => {
    for (const value of ['json', 'application', 'application/', 5, 'a b/c']) {
      expectDiagnostic('cloudevents', valid({ datacontenttype: value }), 'error', '«datacontenttype» debe tener la forma tipo/subtipo');
    }
    expect(checkContract('cloudevents', valid({ datacontenttype: 'application/cloudevents+json' }))).toEqual([]);
  });

  it('dataschema debe ser una URI absoluta', () => {
    expectDiagnostic('cloudevents', valid({ dataschema: '/schemas/a.json' }), 'error', '«dataschema» debe ser una URI absoluta');
    expectDiagnostic('cloudevents', valid({ dataschema: 7 }), 'error', '«dataschema» debe ser una URI absoluta');
    expect(checkContract('cloudevents', valid({ dataschema: 'https://example.com/a.json' }))).toEqual([]);
  });

  it('subject, si existe, no puede estar vacío', () => {
    expectDiagnostic('cloudevents', valid({ subject: '' }), 'error', '«subject» debe ser una cadena de texto no vacía');
    expectDiagnostic('cloudevents', valid({ subject: 3 }), 'error', '«subject»');
    expect(checkContract('cloudevents', valid({ subject: 'pedido/1' }))).toEqual([]);
  });

  it('time debe ser RFC 3339 y una fecha real', () => {
    for (const time of ['2024-05-01', '2024-05-01 10:00:00Z', '2024-13-01T00:00:00Z', '2023-02-29T00:00:00Z', '2024-05-01T24:00:00Z', '2024-05-01T10:00:00', '2024-05-01T10:00:00+25:00', 12]) {
      expectDiagnostic('cloudevents', valid({ time }), 'error', '«time» debe ser una fecha y hora RFC 3339');
    }
    for (const time of ['2024-05-01T10:30:00Z', '2024-02-29T10:30:00.123456z', '2024-05-01t10:30:00-05:00']) {
      expect(checkContract('cloudevents', valid({ time })), String(time)).toEqual([]);
    }
  });

  it('data y data_base64 son excluyentes y data_base64 debe ser base64', () => {
    expectDiagnostic('cloudevents', valid({ data: { a: 1 }, data_base64: 'aGk=' }), 'error', '«data» y «data_base64» son excluyentes');
    expectDiagnostic('cloudevents', valid({ data_base64: 'no es base64!' }), 'error', '«data_base64» debe ser una cadena en base64 válida');
    expectDiagnostic('cloudevents', valid({ data_base64: 'abc' }), 'error', '«data_base64» debe ser una cadena en base64 válida');
    expectDiagnostic('cloudevents', valid({ data_base64: 5 }), 'error', '«data_base64» debe ser una cadena en base64 válida');
    expect(errorsOf('cloudevents', valid({ data_base64: '' }))).toEqual([]);
  });

  it('avisa de los nombres de atributos con caracteres no permitidos o demasiado largos', () => {
    expectDiagnostic('cloudevents', valid({ dataContentType: 'a/b' }), 'warning', 'El atributo «dataContentType» no es válido');
    expectDiagnostic('cloudevents', valid({ dataContentType: 'a/b' }), 'warning', '¿Querías decir «datacontenttype»?');
    expectDiagnostic('cloudevents', valid({ mi_extension: 1 }), 'warning', '«mi_extension» no es válido');
    expectDiagnostic('cloudevents', valid({ abcdefghijklmnopqrstu: 1 }), 'warning', 'supera los 20 caracteres');
    expect(checkContract('cloudevents', valid({ abcdefghijklmnopqrst: 1 }))).toEqual([]);
  });

  it('avisa si una extensión no es un valor simple', () => {
    expectDiagnostic('cloudevents', valid({ extra: { a: 1 } }), 'warning', 'La extensión «extra» debería ser un valor simple');
  });

  it('informa si type no parece llevar un prefijo de dominio inverso', () => {
    for (const type of ['pedido.creado', 'pedido', 'orders.created.v1']) {
      expectDiagnostic('cloudevents', valid({ type }), 'info', 'no parece llevar un prefijo de dominio inverso');
    }
    for (const type of ['com.empresa.pedido.creado', 'org.example.x', 'io.k8s.pod.created']) {
      expectNoDiagnostic('cloudevents', valid({ type }), 'prefijo de dominio');
    }
  });

  it('informa si hay data objeto y falta datacontenttype', () => {
    expectDiagnostic('cloudevents', valid({ data: { a: 1 } }), 'info', 'se asume application/json');
    expectNoDiagnostic('cloudevents', valid({ data: { a: 1 }, datacontenttype: 'application/json' }), 'se asume application/json');
    expectNoDiagnostic('cloudevents', valid({ data: 'texto' }), 'se asume application/json');
  });

  it('comprueba cada evento de un lote (batch) e indica cuál falla', () => {
    const batch = JSON.stringify([
      { specversion: '1.0', id: '1', source: '/a', type: 'com.a.b' },
      { specversion: '1.0', id: '', source: '/a', type: 'com.a.b' },
      7,
    ]);
    expectDiagnostic('cloudevents', batch, 'error', 'Evento 2: «id» no puede estar vacío');
    expectDiagnostic('cloudevents', batch, 'error', 'Evento 3: Un evento CloudEvents debe ser un objeto JSON');
    expect(find(checkContract('cloudevents', batch), 'error', 'Evento 1')).toBeUndefined();
    expectDiagnostic('cloudevents', '[]', 'warning', 'El lote de eventos está vacío');
  });
});

describe('CloudEvents: formateador', () => {
  it('envuelve un payload que no es un envoltorio', () => {
    const text = reformatted('cloudevents', '{"cliente":"Ana","total":10}', 'Pedido creado');
    expect(JSON.parse(text)).toEqual({
      specversion: '1.0',
      id: 'A234-1234-1234',
      source: '/pedido-creado',
      type: 'com.example.pedido-creado',
      datacontenttype: 'application/json',
      data: { cliente: 'Ana', total: 10 },
    });
    expect(text).toBe(
      lines(
        '{',
        '  "specversion": "1.0",',
        '  "id": "A234-1234-1234",',
        '  "source": "/pedido-creado",',
        '  "type": "com.example.pedido-creado",',
        '  "datacontenttype": "application/json",',
        '  "data": {',
        '    "cliente": "Ana",',
        '    "total": 10',
        '  }',
        '}',
        '',
      ),
    );
  });

  it('el resultado de envolver un payload no tiene errores', () => {
    expect(errorsOf('cloudevents', reformatted('cloudevents', '{"a":1}'))).toEqual([]);
  });

  it('el slug del nombre pierde acentos y signos, y tiene un valor por defecto', () => {
    expect(JSON.parse(reformatted('cloudevents', '{"a":1}', 'Gestión de Órdenes!')).source).toBe('/gestion-de-ordenes');
    expect(JSON.parse(reformatted('cloudevents', '{"a":1}', '???')).source).toBe('/evento');
    expect(JSON.parse(reformatted('cloudevents', '{"a":1}', '???')).type).toBe('com.example.evento');
  });

  it('envuelve también valores que no son objetos y arrays sin eventos', () => {
    expect(JSON.parse(reformatted('cloudevents', '"hola"')).data).toBe('hola');
    expect(JSON.parse(reformatted('cloudevents', '42')).data).toBe(42);
    expect(JSON.parse(reformatted('cloudevents', 'null')).data).toBeNull();
    expect(JSON.parse(reformatted('cloudevents', '[1,2,3]')).data).toEqual([1, 2, 3]);
    expect(JSON.parse(reformatted('cloudevents', '[{"a":1},{"b":2}]')).data).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('completa un envoltorio incompleto solo con lo que falta y sin inventar time', () => {
    const text = reformatted('cloudevents', '{"type":"com.acme.cosa.hecha","subject":"s"}', 'Mi evento');
    expect(JSON.parse(text)).toEqual({
      specversion: '1.0',
      id: 'A234-1234-1234',
      source: '/mi-evento',
      type: 'com.acme.cosa.hecha',
      subject: 's',
    });
    expect(text).not.toContain('"time"');
    expect(text).not.toContain('datacontenttype');

    const onlySource = JSON.parse(reformatted('cloudevents', '{"source":"/propio","id":"7"}', 'Mi evento'));
    expect(onlySource).toEqual({ specversion: '1.0', id: '7', source: '/propio', type: 'com.example.mi-evento' });
  });

  it('no sobrescribe valores existentes, aunque sean inválidos', () => {
    const result = JSON.parse(reformatted('cloudevents', '{"specversion":"0.3","id":"","type":"x","source":"/s"}'));
    expect(result.specversion).toBe('0.3');
    expect(result.id).toBe('');
  });

  it('trata null como atributo ausente', () => {
    const result = JSON.parse(reformatted('cloudevents', '{"type":"a.b.c","id":null}'));
    expect(result.id).toBe('A234-1234-1234');
  });

  it('produce el orden canónico y las extensiones en orden alfabético', () => {
    const input = JSON.stringify({
      data: { z: 1, a: 2 },
      zeta: 'z',
      time: '2024-01-01T00:00:00Z',
      subject: 's',
      alfa: 'a',
      type: 'com.a.b',
      dataschema: 'https://x.y/z',
      source: '/s',
      datacontenttype: 'application/json',
      id: '1',
      specversion: '1.0',
      medio: 'm',
    });
    const parsed = JSON.parse(reformatted('cloudevents', input));
    expect(Object.keys(parsed)).toEqual(['specversion', 'id', 'source', 'type', 'datacontenttype', 'dataschema', 'subject', 'time', 'alfa', 'medio', 'zeta', 'data']);
    expect(Object.keys(parsed.data)).toEqual(['z', 'a']);
  });

  it('coloca data_base64 al final', () => {
    const parsed = JSON.parse(reformatted('cloudevents', '{"data_base64":"aGk=","type":"a.b.c","source":"/s","id":"1","specversion":"1.0","ext":1}'));
    expect(Object.keys(parsed)).toEqual(['specversion', 'id', 'source', 'type', 'ext', 'data_base64']);
  });

  it('usa 2 espacios y termina con un salto de línea', () => {
    const text = reformatted('cloudevents', '{"type":"a.b.c","source":"/s","id":"1","specversion":"1.0"}');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.split('\n')[1]!.startsWith('  "specversion"')).toBe(true);
  });

  it('formatea un lote: cada evento se completa y se ordena', () => {
    const text = reformatted('cloudevents', '[{"type":"a.b.c","id":"1"},{"specversion":"1.0","source":"/b","type":"x.y.z","id":"2"},{"cosa":1}]', 'Lote');
    const parsed = JSON.parse(text) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ specversion: '1.0', id: '1', source: '/lote', type: 'a.b.c' });
    expect(Object.keys(parsed[1]!)).toEqual(['specversion', 'id', 'source', 'type']);
    expect(parsed[2]!.data).toEqual({ cosa: 1 });
    expect(text.startsWith('[\n  {\n    "specversion"')).toBe(true);
  });

  it('un lote vacío se queda vacío', () => {
    expect(reformatted('cloudevents', '[]')).toBe('[]\n');
  });

  it('un texto que no es JSON falla con la posición', () => {
    expect(reformatFailure('cloudevents', '{\n  "a": 1,\n}')).toMatch(/sobra una coma antes de «\}» \(línea 2, columna 9\)$/);
    expect(reformatFailure('cloudevents', 'esto no es json')).toContain('JSON no válido');
  });

  it('es idempotente', () => {
    for (const input of ['{"a":1}', '{"type":"a.b.c"}', '[{"type":"a.b.c"},{"x":1}]', '[1,2]', '"x"', '{"b":1,"id":"1","type":"a.b.c","source":"/s","specversion":"1.0","time":"2024-01-01T00:00:00Z"}']) {
      const once = reformatted('cloudevents', input);
      expect(reformatted('cloudevents', once), input).toBe(once);
    }
  });
});

describe('CloudEvents: resumen', () => {
  it('muestra tipo, fuente, tipo de contenido y claves de data', () => {
    const text = JSON.stringify({ specversion: '1.0', id: '1', source: '/pedidos', type: 'com.empresa.pedido.creado', datacontenttype: 'application/json', data: { id: 1, cliente: 'x' } });
    expect(summarizeContract('cloudevents', text)).toEqual([
      'Tipo de evento: com.empresa.pedido.creado',
      'Fuente: /pedidos',
      'Tipo de contenido: application/json',
      'Claves de data: id, cliente',
    ]);
  });

  it('resume un lote con varios tipos y fuentes', () => {
    const text = JSON.stringify([
      { type: 'a.b.c', source: '/uno', data: { x: 1 } },
      { type: 'a.b.d', source: '/dos', data: { y: 1 } },
      { type: 'a.b.c', source: '/uno' },
    ]);
    expect(summarizeContract('cloudevents', text)).toEqual(['Lote de 3 eventos', 'Tipos de evento: a.b.c, a.b.d', 'Fuentes: /uno, /dos', 'Claves de data: x, y']);
  });

  it('indica los datos binarios y devuelve [] si no se puede interpretar', () => {
    expect(summarizeContract('cloudevents', '{"type":"a.b.c","data_base64":"aGk="}')).toContain('data_base64: contenido binario');
    expect(summarizeContract('cloudevents', 'no json')).toEqual([]);
    expect(summarizeContract('cloudevents', '3')).toEqual([]);
  });
});

describe('Protobuf: comprobación', () => {
  const header = lines('syntax = "proto3";', 'package demo.v1;', '');

  it('un archivo correcto y completo no tiene problemas', () => {
    const text = lines(
      'syntax = "proto3";',
      '',
      'package acme.pedidos.v1;',
      '',
      'import "google/protobuf/timestamp.proto";',
      'import "google/protobuf/empty.proto";',
      'import "google/api/annotations.proto";',
      '',
      'option go_package = "github.com/acme/pedidos;pedidos";',
      '',
      'service Pedidos {',
      '  rpc Crear (CrearRequest) returns (Pedido) {',
      '    option (google.api.http) = {',
      '      post: "/v1/pedidos"',
      '      body: "*"',
      '    };',
      '  }',
      '  rpc Borrar (BorrarRequest) returns (google.protobuf.Empty);',
      '  rpc Seguir (stream Evento) returns (stream Evento);',
      '}',
      '',
      'message CrearRequest {',
      '  string cliente = 1 [(validate.rules).string = {min_len: 1}];',
      '  repeated Linea lineas = 2;',
      '  map<string, string> etiquetas = 3;',
      '  optional string nota = 4;',
      '  oneof pago {',
      '    string tarjeta = 5;',
      '    string transferencia = 6;',
      '  }',
      '  reserved 8 to max;',
      '  reserved "viejo";',
      '  message Linea {',
      '    string sku = 1;',
      '    int32 cantidad = 2;',
      '  }',
      '}',
      '',
      'message Pedido {',
      '  string id = 1;',
      '  Estado estado = 2;',
      '  google.protobuf.Timestamp creado = 3;',
      '  .acme.pedidos.v1.CrearRequest.Linea primera = 4;',
      '  Evento.Tipo tipo = 5;',
      '}',
      '',
      'message BorrarRequest { string id = 1; }',
      'message Evento {',
      '  enum Tipo { option allow_alias = true; TIPO_DESCONOCIDO = 0; DEFAULT = 0; CREADO = 1; }',
      '  Tipo tipo = 1;',
      '}',
      '',
      'enum Estado {',
      '  ESTADO_DESCONOCIDO = 0;',
      '  ESTADO_NUEVO = 1;',
      '  reserved 5;',
      '}',
      '',
    );
    expect(checkContract('protobuf', text)).toEqual([]);
  });

  it('syntax: proto2 es informativo, proto3 no avisa, otro valor es error, y falta es aviso', () => {
    expectDiagnostic('protobuf', lines('syntax = "proto2";', 'package a;'), 'info', 'proto2 funciona con gRPC', { line: 1 });
    expect(checkContract('protobuf', header)).toEqual([]);
    expectDiagnostic('protobuf', lines('syntax = "proto4";', 'package a;'), 'error', '«syntax» debe ser "proto2" o "proto3" y es "proto4"', { line: 1 });
    expectDiagnostic('protobuf', lines('package a;', 'message A {}'), 'warning', 'Falta la declaración «syntax»');
    expectDiagnostic('protobuf', lines('package a;', 'syntax = "proto3";'), 'error', '«syntax» debe ser la primera sentencia', { line: 2 });
  });

  it('syntax puede ir después de comentarios', () => {
    expect(checkContract('protobuf', lines('// cabecera', '/* más */', 'syntax = "proto3";', 'package a;'))).toEqual([]);
  });

  it('package: falta o está repetido', () => {
    expectDiagnostic('protobuf', 'syntax = "proto3";\nmessage A {}', 'warning', 'Falta «package»');
    expectDiagnostic('protobuf', lines('syntax = "proto3";', 'package a;', 'package b;'), 'error', '«package» ya está declarado en la línea 2', { line: 3 });
  });

  it('import repetido', () => {
    expectDiagnostic('protobuf', lines(header, 'import "a.proto";', 'import "a.proto";'), 'warning', 'El import "a.proto" está repetido (ya aparece en la línea 4)', { line: 5 });
  });

  it('llaves desbalanceadas (con su línea), sin contar las de cadenas y comentarios', () => {
    expectDiagnostic('protobuf', lines(header, 'message A {', '  string a = 1;'), 'error', 'La «{» abierta aquí no se cierra', { line: 4, column: 11 });
    expectDiagnostic('protobuf', lines(header, 'message A {', '}', '}'), 'error', 'Cierre «}» sin su apertura', { line: 6, column: 1 });
    expectDiagnostic('protobuf', lines(header, 'message A {', '  string a = 1;', ')'), 'error', 'Se esperaba «}»', { line: 6 });
    const balanced = lines(header, 'message A {', '  string a = 1; // } llave suelta', '  /* { */', '  string b = 2 [default = "}"];', '}');
    expect(errorsOf('protobuf', balanced)).toEqual([]);
  });

  it('cadenas y comentarios de bloque sin cerrar', () => {
    expectDiagnostic('protobuf', lines('syntax = "proto3;', 'package a;'), 'error', 'Cadena sin cerrar', { line: 1, column: 10 });
    expectDiagnostic('protobuf', lines(header, '/* sin cerrar', 'message A {}'), 'error', 'sin cerrar', { line: 4, column: 1 });
  });

  it('falta de punto y coma y sentencias desconocidas', () => {
    expectDiagnostic('protobuf', lines(header, 'message A {', '  string a = 1', '  string b = 2;', '}'), 'error', 'Se esperaba «;»', { line: 5, column: 15 });
    expectDiagnostic('protobuf', lines(header, 'mensaje A {}'), 'error', 'Sentencia no reconocida «mensaje»', { line: 4 });
    expectDiagnostic('protobuf', lines(header, 'message A { string a = ; }'), 'error', 'Se esperaba un número', { line: 4 });
    expectDiagnostic('protobuf', lines(header, 'message A { string a = 1; # }'), 'error', 'Carácter inesperado «#»', { line: 4 });
  });

  it('números de campo duplicados', () => {
    const text = lines(header, 'message Pedido {', '  string id = 1;', '  int32 cantidad = 1;', '}');
    expectDiagnostic('protobuf', text, 'error', 'El número de campo 1 de «Pedido.cantidad» ya lo usa «id» (línea 5)', { line: 6, column: 20 });
  });

  it('el número de campo se comparte con los campos de los oneof y no con otros mensajes', () => {
    expectDiagnostic('protobuf', lines(header, 'message A {', '  string a = 1;', '  oneof v {', '    int32 b = 1;', '  }', '}'), 'error', 'ya lo usa «a»', { line: 7 });
    expect(errorsOf('protobuf', lines(header, 'message A { string a = 1; }', 'message B { string a = 1; }'))).toEqual([]);
  });

  it('números de campo fuera de rango o en el rango reservado', () => {
    expectDiagnostic('protobuf', lines(header, 'message A { string a = 0; }'), 'error', 'fuera del rango permitido (1 a 536870911)', { line: 4 });
    expectDiagnostic('protobuf', lines(header, 'message A { string a = 536870912; }'), 'error', 'fuera del rango permitido');
    expectDiagnostic('protobuf', lines(header, 'message A { string a = -3; }'), 'error', 'fuera del rango permitido');
    expectDiagnostic('protobuf', lines(header, 'message A { string a = 19000; }'), 'error', 'rango 19000-19999');
    expectDiagnostic('protobuf', lines(header, 'message A { string a = 19999; }'), 'error', 'rango 19000-19999');
    expectDiagnostic('protobuf', lines(header, 'message A { string a = 1.5; }'), 'error', 'debe ser un entero');
    expect(errorsOf('protobuf', lines(header, 'message A { string a = 18999; string b = 20000; string c = 536870911; string d = 0x10; }'))).toEqual([]);
  });

  it('nombres de campo duplicados', () => {
    expectDiagnostic('protobuf', lines(header, 'message A {', '  string id = 1;', '  string id = 2;', '}'), 'error', 'El campo «A.id» está repetido (línea 5)', { line: 6 });
  });

  it('nombres de mensajes, enums y servicios duplicados en el mismo ámbito', () => {
    expectDiagnostic('protobuf', lines(header, 'message A {}', 'message A {}'), 'error', 'El nombre «A» ya está declarado en este ámbito (línea 4)', { line: 5 });
    expectDiagnostic('protobuf', lines(header, 'message A {}', 'enum A { X = 0; }'), 'error', 'El nombre «A» ya está declarado');
    expectDiagnostic('protobuf', lines(header, 'message M {', '  message N {}', '  enum N { X = 0; }', '}'), 'error', 'El nombre «N» ya está declarado');
    expect(errorsOf('protobuf', lines(header, 'message A { message N {} }', 'message B { message N {} }'))).toEqual([]);
  });

  it('reserved: números y nombres', () => {
    const text = lines(header, 'message A {', '  reserved 2, 9 to 11, 20 to max;', '  reserved "viejo";', '  string a = 10;', '  string viejo = 1;', '  string b = 12;', '  string c = 21;', '}');
    const diagnostics = checkContract('protobuf', text);
    expect(find(diagnostics, 'error', 'El número de campo 10 de «A.a» está reservado')?.line).toBe(7);
    expect(find(diagnostics, 'error', 'El nombre «viejo» está reservado')?.line).toBe(8);
    expect(find(diagnostics, 'error', 'El número de campo 21 de «A.c» está reservado')?.line).toBe(10);
    expect(find(diagnostics, 'error', 'El número de campo 12')).toBeUndefined();
  });

  it('en proto3 no existe required; los tipos de clave de un map están limitados', () => {
    expectDiagnostic('protobuf', lines(header, 'message A { required string a = 1; }'), 'error', 'en proto3 no existe «required»', { line: 4 });
    expect(errorsOf('protobuf', lines('syntax = "proto2";', 'package a;', 'message A { required string a = 1; }'))).toEqual([]);
    expectDiagnostic('protobuf', lines(header, 'message A { map<float, string> m = 1; }'), 'error', '«float» no puede ser clave de un map');
    expectDiagnostic('protobuf', lines(header, 'message A { map<bytes, string> m = 1; }'), 'error', '«bytes» no puede ser clave de un map');
    expect(errorsOf('protobuf', lines(header, 'message A { map<string, B> m = 1; map<int64, string> n = 2; }', 'message B {}'))).toEqual([]);
  });

  it('enum: primer valor 0 en proto3, vacío, duplicados y allow_alias', () => {
    expectDiagnostic('protobuf', lines(header, 'enum E {', '  UNO = 1;', '}'), 'error', 'En proto3 el primer valor de un enum debe ser 0 y «UNO» (enum «E») vale 1', { line: 5 });
    expect(errorsOf('protobuf', lines('syntax = "proto2";', 'package a;', 'enum E { UNO = 1; }'))).toEqual([]);
    expectDiagnostic('protobuf', lines(header, 'enum E {}'), 'error', 'El enum «E» no tiene valores', { line: 4 });
    expectDiagnostic('protobuf', lines(header, 'enum E {', '  A = 0;', '  A = 1;', '}'), 'error', 'El valor «A» del enum «E» está repetido (línea 5)', { line: 6 });
    expectDiagnostic('protobuf', lines(header, 'enum E {', '  A = 0;', '  B = 0;', '}'), 'error', 'El valor 0 del enum «E» ya lo usa «A» (línea 5); activa «option allow_alias = true;»', { line: 6 });
    expect(errorsOf('protobuf', lines(header, 'enum E {', '  option allow_alias = true;', '  A = 0;', '  B = 0;', '}'))).toEqual([]);
    expect(errorsOf('protobuf', lines(header, 'enum E {', '  A = 0;', '  B = -1;', '}'))).toEqual([]);
  });

  it('los valores de enums del mismo ámbito no pueden coincidir', () => {
    expectDiagnostic('protobuf', lines(header, 'enum E { UNKNOWN = 0; }', 'enum F { UNKNOWN = 0; }'), 'error', 'El valor «UNKNOWN» del enum «F» ya existe en el enum «E» (línea 4)', { line: 5 });
    expect(errorsOf('protobuf', lines(header, 'message M { enum E { UNKNOWN = 0; } }', 'message N { enum F { UNKNOWN = 0; } }'))).toEqual([]);
  });

  it('servicio sin rpc y rpc repetidos', () => {
    expectDiagnostic('protobuf', lines(header, 'service S {}'), 'warning', 'El servicio «S» no declara ningún rpc', { line: 4 });
    expectDiagnostic('protobuf', lines(header, 'service S {', '  rpc A (M) returns (M);', '  rpc A (M) returns (M);', '}', 'message M {}'), 'error', 'El rpc «S.A» está repetido (línea 5)', { line: 6 });
  });

  it('rpc con un tipo no declarado es un error si no hay imports', () => {
    const text = lines(header, 'service S {', '  rpc A (Peticion) returns (Respuesta);', '}', 'message Peticion {}');
    expectDiagnostic('protobuf', text, 'error', 'El tipo «Respuesta» (la respuesta de «S.A») no está declarado en este archivo', { line: 5, column: 29 });
    expect(find(checkContract('protobuf', text), 'error', '«Peticion»')).toBeUndefined();
  });

  it('con imports, un tipo no declarado es solo informativo', () => {
    const text = lines(header, 'import "comun.proto";', 'service S {', '  rpc A (Externo) returns (Externo);', '}');
    expectDiagnostic('protobuf', text, 'info', 'El tipo «Externo» (la petición de «S.A») no está declarado en este archivo', { line: 6 });
    expect(errorsOf('protobuf', text)).toEqual([]);
  });

  it('los tipos google.protobuf.* no son error: avisan si falta su import', () => {
    const without = lines(header, 'service S {', '  rpc A (google.protobuf.Empty) returns (stream google.protobuf.Timestamp);', '}');
    expect(errorsOf('protobuf', without)).toEqual([]);
    expectDiagnostic('protobuf', without, 'warning', 'necesita «import "google/protobuf/empty.proto";»');
    expectDiagnostic('protobuf', without, 'warning', 'necesita «import "google/protobuf/timestamp.proto";»');
    const withImports = lines(header, 'import "google/protobuf/empty.proto";', 'import "google/protobuf/timestamp.proto";', 'service S {', '  rpc A (google.protobuf.Empty) returns (stream google.protobuf.Timestamp);', '}');
    expect(checkContract('protobuf', withImports)).toEqual([]);
  });

  it('los tipos de campo no declarados son error si no hay imports; se resuelven por ámbito', () => {
    expectDiagnostic('protobuf', lines(header, 'message A { Otro x = 1; }'), 'error', 'El tipo «Otro» de «A.x» no está declarado', { line: 4 });
    expect(errorsOf('protobuf', lines(header, 'message A { B x = 1; A.B y = 2; .demo.v1.A.B z = 3; message B {} }'))).toEqual([]);
    expect(errorsOf('protobuf', lines(header, 'message A { Estado e = 1; }', 'enum Estado { X = 0; }'))).toEqual([]);
    expect(errorsOf('protobuf', lines(header, 'message A { string s = 1; map<string, Tipo> m = 2; }'))).not.toEqual([]);
  });

  it('comprueba anidados con su ruta completa', () => {
    const text = lines(header, 'message A {', '  message B {', '    string x = 1;', '    string y = 1;', '  }', '}');
    expectDiagnostic('protobuf', text, 'error', '«A.B.y»', { line: 7 });
  });

  it('ordena los diagnósticos por línea', () => {
    const diagnostics = checkContract('protobuf', lines('syntax = "proto3";', 'message A { string a = 0; }', 'message B { string a = 1; string a = 2; }'));
    const withLine = diagnostics.filter((d) => d.line !== undefined);
    expect(withLine.map((d) => d.line)).toEqual([...withLine.map((d) => d.line!)].sort((a, b) => a - b));
    expect(diagnostics[0]!.line).toBeUndefined();
  });
});

describe('Protobuf: formateador', () => {
  it('reindenta por profundidad de llaves con 2 espacios, sin espacios finales y con salto de línea final', () => {
    const input = lines('syntax = "proto3";', 'message A {', 'string a = 1;   ', '\tmessage B {', '          string b = 1;', '   }', '}', 'service S {', 'rpc R (A) returns (A);', '}');
    expect(reformatted('protobuf', input)).toBe(
      lines('syntax = "proto3";', 'message A {', '  string a = 1;', '  message B {', '    string b = 1;', '  }', '}', 'service S {', '  rpc R (A) returns (A);', '}', ''),
    );
  });

  it('deja como mucho una línea en blanco seguida y quita las del principio y el final', () => {
    const input = lines('', '', 'syntax = "proto3";', '', '', '', 'message A {}', '', '');
    expect(reformatted('protobuf', input)).toBe(lines('syntax = "proto3";', '', 'message A {}', ''));
  });

  it('conserva los comentarios de línea y de bloque', () => {
    const input = lines(
      '// Cabecera del archivo',
      'message A {',
      '// campo principal',
      'string a = 1; // trailing',
      '/*',
      ' * Varias líneas',
      ' */',
      'string b = 2;',
      '}',
    );
    expect(reformatted('protobuf', input)).toBe(
      lines('// Cabecera del archivo', 'message A {', '  // campo principal', '  string a = 1; // trailing', '  /*', '   * Varias líneas', '   */', '  string b = 2;', '}', ''),
    );
  });

  it('no cuenta las llaves que están dentro de cadenas ni de comentarios', () => {
    const input = lines(
      'message A {',
      'string a = 1 [default = "}"];',
      'string b = 2; // }',
      '/* { { { */',
      'string c = 3 [default = "{{"];',
      '/*',
      'texto con } y {{',
      '*/',
      'string d = 4;',
      '}',
      'message B {}',
    );
    const text = reformatted('protobuf', input);
    expect(text).toBe(
      lines(
        'message A {',
        '  string a = 1 [default = "}"];',
        '  string b = 2; // }',
        '  /* { { { */',
        '  string c = 3 [default = "{{"];',
        '  /*',
        'texto con } y {{',
        '   */',
        '  string d = 4;',
        '}',
        'message B {}',
        '',
      ),
    );
  });

  it('indenta los bloques de opciones de un rpc y los corchetes que ocupan varias líneas', () => {
    const input = lines(
      'service S {',
      'rpc R (A) returns (A) {',
      'option (google.api.http) = {',
      'get: "/v1/{id}"',
      '};',
      '}',
      '}',
      'message A {',
      'string a = 1 [',
      'deprecated = true',
      '];',
      '}',
    );
    expect(reformatted('protobuf', input)).toBe(
      lines(
        'service S {',
        '  rpc R (A) returns (A) {',
        '    option (google.api.http) = {',
        '      get: "/v1/{id}"',
        '    };',
        '  }',
        '}',
        'message A {',
        '  string a = 1 [',
        '    deprecated = true',
        '  ];',
        '}',
        '',
      ),
    );
  });

  it('normaliza los saltos de línea de Windows', () => {
    expect(reformatted('protobuf', 'message A {\r\nstring a = 1;\r\n}\r\n')).toBe('message A {\n  string a = 1;\n}\n');
  });

  it('falla si las llaves no están balanceadas, indicando la línea', () => {
    expect(reformatFailure('protobuf', lines('message A {', '  string a = 1;'))).toMatch(/La «\{» abierta aquí no se cierra\. \(línea 1, columna 11\)/);
    expect(reformatFailure('protobuf', lines('message A {}', '}'))).toMatch(/Cierre «\}» sin su apertura\. \(línea 2, columna 1\)/);
  });

  it('es idempotente', () => {
    const inputs = [
      lines('syntax="proto3";', 'message A {', 'string a=1; // }', '/*', '  * x {', ' */', '  message B {', '       string s = 1 [', 'deprecated=true', ']; }', '}', '', '', 'service S { rpc R (A) returns (A) { option (x) = { a: 1 }; } }'),
      contractTemplate('protobuf', 'Pedidos'),
      lines('  // sola', '', '', '  message A {}   '),
    ];
    for (const input of inputs) {
      const once = reformatted('protobuf', input);
      expect(reformatted('protobuf', once)).toBe(once);
    }
  });
});

describe('Protobuf: resumen', () => {
  it('lista los métodos con su tipo y cuenta los mensajes (incluidos los anidados)', () => {
    const text = lines(
      'syntax = "proto3";',
      'service Pedidos {',
      '  rpc Crear (A) returns (B);',
      '  rpc Escuchar (A) returns (stream B);',
      '  rpc Subir (stream A) returns (B);',
      '  rpc Chat (stream A) returns (stream B);',
      '}',
      'message A { message Interno {} }',
      'message B {}',
    );
    expect(summarizeContract('protobuf', text)).toEqual([
      'Pedidos.Crear (unary)',
      'Pedidos.Escuchar (server-stream)',
      'Pedidos.Subir (client-stream)',
      'Pedidos.Chat (bidi)',
      '3 mensajes',
    ]);
  });

  it('usa el singular y devuelve [] si no hay nada que resumir', () => {
    expect(summarizeContract('protobuf', 'message A {}')).toEqual(['1 mensaje']);
    expect(summarizeContract('protobuf', '// nada')).toEqual([]);
  });

  it('resume aunque el archivo tenga errores', () => {
    expect(summarizeContract('protobuf', 'service S { rpc A (X) returns (Y)\n rpc B (X) returns (stream Y); }')).toContain('S.B (server-stream)');
  });
});

describe('OpenAPI: comprobación', () => {
  const base = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify(
      {
        openapi: '3.0.3',
        info: { title: 'API', version: '1.0.0' },
        paths: { '/pedidos': { get: { operationId: 'listarPedidos', responses: { '200': { description: 'ok' } } } } },
        ...extra,
      },
      null,
      2,
    );

  it('un documento correcto no tiene problemas', () => {
    expect(checkContract('openapi', base())).toEqual([]);
  });

  it('JSON inválido con posición', () => {
    expectDiagnostic('openapi', '{\n  "openapi": "3.0.3",\n  "info": {,}\n}', 'error', 'JSON no válido', { line: 3, column: 12 });
  });

  it('la raíz debe ser un objeto', () => {
    expectDiagnostic('openapi', '[]', 'error', 'debe ser un objeto');
    expectDiagnostic('openapi', 'hola', 'error', 'debe ser un objeto');
  });

  it('openapi 3.x: falta, no es 3.x o es Swagger 2.0', () => {
    expectDiagnostic('openapi', '{"info":{"title":"a","version":"1"},"paths":{}}', 'error', 'Falta el campo «openapi»');
    expectDiagnostic('openapi', base({ openapi: '2.0.0' }), 'error', '«openapi» debe ser una versión 3.x', { line: 2 });
    expectDiagnostic('openapi', base({ openapi: 3 }), 'error', 'En YAML, ponla entre comillas');
    expectDiagnostic('openapi', '{"swagger":"2.0","info":{"title":"a","version":"1"},"paths":{}}', 'warning', 'Swagger 2.0: usa OpenAPI 3', { line: 1 });
    expect(find(checkContract('openapi', '{"swagger":"2.0","info":{"title":"a","version":"1"},"paths":{}}'), 'error', 'Falta el campo «openapi»')).toBeUndefined();
    expect(errorsOf('openapi', base({ openapi: '3.1.0' }))).toEqual([]);
  });

  it('info.title e info.version', () => {
    expectDiagnostic('openapi', base({ info: {} }), 'error', 'Falta «info.title»');
    expectDiagnostic('openapi', base({ info: { title: '', version: '1' } }), 'error', 'Falta «info.title»');
    expectDiagnostic('openapi', base({ info: { title: 'a' } }), 'error', 'Falta «info.version»');
    expectDiagnostic('openapi', base({ info: { title: 'a', version: 1 } }), 'error', '«info.version» debe ser texto');
    expectDiagnostic('openapi', base({ info: undefined }), 'error', 'Falta «info»');
  });

  it('paths: falta, vacío o con claves que no empiezan por /', () => {
    expectDiagnostic('openapi', '{"openapi":"3.0.3","info":{"title":"a","version":"1"}}', 'error', 'Falta «paths»');
    expect(find(checkContract('openapi', '{"openapi":"3.1.0","info":{"title":"a","version":"1"},"webhooks":{}}'), 'error', 'Falta «paths»')).toBeUndefined();
    expectDiagnostic('openapi', base({ paths: {} }), 'info', '«paths» está vacío');
    expectDiagnostic('openapi', base({ paths: { pedidos: {} } }), 'error', 'La ruta «pedidos» debe empezar por «/»');
    expectDiagnostic('openapi', base({ paths: [] }), 'error', '«paths» debe ser un objeto');
  });

  it('cada operación necesita responses no vacío', () => {
    const noResponses = base({ paths: { '/a': { get: { operationId: 'a' } } } });
    expectDiagnostic('openapi', noResponses, 'error', 'La operación GET /a no tiene «responses»');
    expectDiagnostic('openapi', base({ paths: { '/a': { post: { responses: {} } } } }), 'error', '«responses» de POST /a está vacío');
    expectDiagnostic('openapi', base({ paths: { '/a': { get: { responses: { '99': { description: 'x' } } } } } }), 'warning', 'El código de respuesta «99» de GET /a no es válido');
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      expectDiagnostic('openapi', base({ paths: { '/a': { [method]: { operationId: 'x' } } } }), 'error', `La operación ${method.toUpperCase()} /a no tiene «responses»`);
    }
    expect(errorsOf('openapi', base({ paths: { '/a': { get: { responses: { default: { description: 'x' }, '4XX': { description: 'y' } } } } } }))).toEqual([]);
  });

  it('señala la línea de la operación sin responses', () => {
    const text = lines('{', '  "openapi": "3.0.3",', '  "info": { "title": "a", "version": "1" },', '  "paths": {', '    "/a": {', '      "get": {}', '    }', '  }', '}');
    expectDiagnostic('openapi', text, 'error', 'no tiene «responses»', { line: 6, column: 7 });
  });

  it('un método en mayúsculas se avisa', () => {
    expectDiagnostic('openapi', base({ paths: { '/a': { GET: { responses: { '200': { description: 'x' } } } } } }), 'warning', '«GET» no es una operación válida');
  });

  it('operationId único', () => {
    const doc = base({
      paths: {
        '/a': { get: { operationId: 'dup', responses: { '200': { description: 'x' } } } },
        '/b': { get: { operationId: 'dup', responses: { '200': { description: 'x' } } } },
      },
    });
    expectDiagnostic('openapi', doc, 'error', 'El operationId «dup» está repetido (ya lo usa GET /a)');
    expectDiagnostic('openapi', base({ paths: { '/a': { get: { operationId: '', responses: { '200': { description: 'x' } } } } } }), 'error', 'operationId');
  });

  it('los parámetros {x} de la ruta deben declararse como in: path', () => {
    const undeclared = base({ paths: { '/a/{id}': { get: { responses: { '200': { description: 'x' } } } } } });
    expectDiagnostic('openapi', undeclared, 'warning', 'La ruta «/a/{id}» usa {id} pero GET /a/{id} no lo declara como parámetro «in: path»');

    const declared = base({
      paths: { '/a/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'x' } } } } },
    });
    expect(checkContract('openapi', declared)).toEqual([]);

    const atPathLevel = base({
      paths: { '/a/{id}': { parameters: [{ name: 'id', in: 'path', required: true }], get: { responses: { '200': { description: 'x' } } } } },
    });
    expect(checkContract('openapi', atPathLevel)).toEqual([]);

    const viaRef = base({
      paths: { '/a/{id}': { get: { parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'x' } } } } },
      components: { parameters: { Id: { name: 'id', in: 'path', required: true } } },
    });
    expect(checkContract('openapi', viaRef)).toEqual([]);

    const query = base({ paths: { '/a/{id}': { get: { parameters: [{ name: 'id', in: 'query' }], responses: { '200': { description: 'x' } } } } } });
    expectDiagnostic('openapi', query, 'warning', 'usa {id} pero');
  });

  it('los parámetros de ruta deben ser required y aparecer en la ruta', () => {
    const notRequired = base({ paths: { '/a/{id}': { get: { parameters: [{ name: 'id', in: 'path' }], responses: { '200': { description: 'x' } } } } } });
    expectDiagnostic('openapi', notRequired, 'error', '«required: true»');
    const extra = base({ paths: { '/a': { get: { parameters: [{ name: 'otro', in: 'path', required: true }], responses: { '200': { description: 'x' } } } } } });
    expectDiagnostic('openapi', extra, 'warning', 'El parámetro de ruta «otro» de GET /a no aparece en la ruta');
  });

  it('los $ref locales deben existir', () => {
    const doc = base({
      paths: { '/a': { get: { responses: { '200': { description: 'x', content: { 'application/json': { schema: { $ref: '#/components/schemas/Falta' } } } } } } } },
      components: { schemas: { Existe: { type: 'object' } } },
    });
    expectDiagnostic('openapi', doc, 'error', 'La referencia «#/components/schemas/Falta» no existe');
    const ok = base({
      paths: { '/a': { get: { responses: { '200': { description: 'x', content: { 'application/json': { schema: { $ref: '#/components/schemas/Existe' } } } } } } } },
      components: { schemas: { Existe: { type: 'object', properties: { yo: { $ref: '#/components/schemas/Existe' } } } } },
    });
    expect(checkContract('openapi', ok)).toEqual([]);
  });

  it('los $ref a otros documentos y los ejemplos no se verifican', () => {
    const doc = base({
      paths: { '/a': { get: { responses: { '200': { $ref: 'otro.yaml#/x' } } } } },
      components: { schemas: { E: { type: 'object', example: { $ref: '#/no/existe' } } } },
    });
    expect(checkContract('openapi', doc)).toEqual([]);
  });

  it('la línea del $ref roto apunta a su clave', () => {
    const text = lines(
      '{',
      '  "openapi": "3.0.3",',
      '  "info": { "title": "a", "version": "1" },',
      '  "paths": { "/a": { "get": { "responses": { "200": {',
      '    "description": "x",',
      '    "content": { "application/json": { "schema": {',
      '      "$ref": "#/components/schemas/Falta"',
      '    } } }',
      '  } } } } }',
      '}',
    );
    expectDiagnostic('openapi', text, 'error', 'no existe', { line: 7, column: 7 });
  });

  it('security debe apuntar a esquemas declarados', () => {
    const undeclared = base({ security: [{ bearer: [] }] });
    expectDiagnostic('openapi', undeclared, 'error', 'El esquema de seguridad «bearer» no está declarado en components.securitySchemes');
    const declared = base({ security: [{ bearer: [] }], components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } } });
    expect(checkContract('openapi', declared)).toEqual([]);
    const operationLevel = base({
      paths: { '/a': { get: { security: [{ otro: [] }, {}], responses: { '200': { description: 'x' } } } } },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    });
    expectDiagnostic('openapi', operationLevel, 'error', '«otro»');
    expectDiagnostic('openapi', base({ security: {} }), 'error', '«security» debe ser un array');
  });

  describe('YAML', () => {
    const yaml = lines(
      'openapi: 3.0.3',
      'info:',
      '  title: Pedidos',
      '  version: "1.0.0"',
      'paths:',
      '  /pedidos/{id}:',
      '    get:',
      '      operationId: obtenerPedido',
      '      parameters:',
      '        - name: id',
      '          in: path',
      '          required: true',
      '          schema: { type: string }',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      "                $ref: '#/components/schemas/Pedido'",
      'components:',
      '  schemas:',
      '    Pedido: { type: object }',
      '',
    );

    it('acepta un documento YAML correcto', () => {
      expect(checkContract('openapi', yaml)).toEqual([]);
    });

    it('comprueba las mismas reglas con la línea del YAML', () => {
      const broken = yaml.replace('          required: true\n', '').replace('#/components/schemas/Pedido', '#/components/schemas/Falta');
      expectDiagnostic('openapi', broken, 'error', '«required: true»', { line: 10 });
      expectDiagnostic('openapi', broken, 'error', '«#/components/schemas/Falta» no existe', { line: 19 });
    });

    it('un YAML mal formado da el error con su posición', () => {
      const diagnostics = checkContract('openapi', lines('openapi: 3.0.3', 'info:', '  title: X', ' version: "1"', 'paths: {}'));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]!.severity).toBe('error');
      expect(diagnostics[0]!.message).toContain('YAML no válido');
      expect(diagnostics[0]!.line).toBeGreaterThanOrEqual(3);
    });

    it('detecta las claves duplicadas', () => {
      expectDiagnostic('openapi', lines('openapi: 3.0.3', 'openapi: 3.0.2', 'info: { title: a, version: "1" }', 'paths: {}'), 'error', 'clave duplicada', { line: 2 });
    });

    it('avisa de una versión numérica sin comillas', () => {
      expectDiagnostic('openapi', lines('openapi: 3.0.3', 'info:', '  title: X', '  version: 1.0', 'paths: {}'), 'error', '«info.version» debe ser texto', { line: 4 });
    });
  });
});

describe('OpenAPI: formateador y resumen', () => {
  it('ordena la raíz: openapi, info, servers, tags, paths, components, security y el resto', () => {
    const input = JSON.stringify({
      'x-extra': 1,
      components: { schemas: {} },
      security: [],
      paths: {},
      tags: [],
      servers: [],
      info: { version: '1', title: 'a' },
      openapi: '3.0.3',
      externalDocs: { url: 'https://x.y' },
    });
    const text = reformatted('openapi', input);
    expect(Object.keys(JSON.parse(text))).toEqual(['openapi', 'info', 'servers', 'tags', 'paths', 'components', 'security', 'x-extra', 'externalDocs']);
    expect(Object.keys(JSON.parse(text).info)).toEqual(['version', 'title']);
    expect(text).toBe(prettyJson(JSON.parse(text)));
  });

  it('usa 2 espacios y salto de línea final', () => {
    expect(reformatted('openapi', '{"openapi":"3.0.3","info":{}}')).toBe('{\n  "openapi": "3.0.3",\n  "info": {}\n}\n');
  });

  it('un JSON inválido falla con la posición', () => {
    expect(reformatFailure('openapi', '{\n"a": }')).toMatch(/\(línea 2, columna 6\)$/);
  });

  it('formatea YAML conservando los comentarios y ordenando la raíz', () => {
    const input = lines(
      '# comentario inicial',
      'paths:',
      '  /a:',
      '    get:',
      '      # la respuesta',
      '      responses:',
      '          "200": {description: ok}',
      '# antes de info',
      'info: {title: X, version: "1"}',
      'openapi: 3.0.3',
    );
    const text = reformatted('openapi', input);
    expect(text).toBe(
      lines(
        'openapi: 3.0.3',
        '# antes de info',
        'info: { title: X, version: "1" }',
        '# comentario inicial',
        'paths:',
        '  /a:',
        '    get:',
        '      # la respuesta',
        '      responses:',
        '        "200": { description: ok }',
        '',
      ),
    );
    expect(text.indexOf('# la respuesta')).toBeGreaterThan(-1);
  });

  it('un YAML inválido falla con la posición', () => {
    expect(reformatFailure('openapi', 'a: [1, 2')).toMatch(/YAML no válido.*línea \d+, columna \d+/);
  });

  it('resume las operaciones con su operationId', () => {
    const doc = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'a', version: '1' },
      paths: {
        '/pedidos': { get: { operationId: 'listarPedidos', responses: {} }, post: { operationId: 'crearPedido', responses: {} }, parameters: [] },
        '/pedidos/{id}': { delete: { responses: {} } },
      },
    });
    expect(summarizeContract('openapi', doc)).toEqual(['GET /pedidos — listarPedidos', 'POST /pedidos — crearPedido', 'DELETE /pedidos/{id}']);
    expect(summarizeContract('openapi', 'no es json: [')).toEqual([]);
    expect(summarizeContract('openapi', '{"openapi":"3.0.3"}')).toEqual([]);
  });

  it('resume también un YAML', () => {
    expect(summarizeContract('openapi', 'paths:\n  /a:\n    get:\n      operationId: uno\n')).toEqual(['GET /a — uno']);
  });
});

describe('MCP: comprobación', () => {
  const tool = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'crear_pedido',
    description: 'Crea un pedido',
    inputSchema: { type: 'object', properties: { cliente: { type: 'string' }, lineas: { type: 'array' } }, required: ['cliente'] },
    ...extra,
  });
  const manifest = (extra: Record<string, unknown> = {}): string => JSON.stringify({ name: 'pedidos', version: '1.0.0', tools: [tool()], ...extra }, null, 2);

  it('acepta las tres formas: manifiesto, serverInfo y tools/list desnudo', () => {
    expect(checkContract('mcp', manifest())).toEqual([]);
    expect(errorsOf('mcp', JSON.stringify({ serverInfo: { name: 'pedidos', version: '1' }, protocolVersion: '2025-06-18', capabilities: { tools: {} }, tools: [tool()] }))).toEqual([]);
    expect(checkContract('mcp', JSON.stringify({ serverInfo: { name: 'pedidos', version: '1' }, tools: [tool()] }))).toEqual([]);
    const bare = checkContract('mcp', JSON.stringify({ tools: [tool()] }));
    expect(bare.map((d) => d.severity)).toEqual(['info']);
    expect(bare[0]!.message).toContain('resultado desnudo de tools/list');
    expect(checkContract('mcp', JSON.stringify({ tools: [tool()], nextCursor: 'x' })).filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('JSON inválido y raíz que no es un objeto', () => {
    expectDiagnostic('mcp', '{\n "tools": [,]\n}', 'error', 'JSON no válido', { line: 2 });
    expectDiagnostic('mcp', '[]', 'error', 'debe ser un objeto JSON');
  });

  it('nombre y versión del servidor', () => {
    expectDiagnostic('mcp', JSON.stringify({ name: '', version: '1', tools: [tool()] }), 'error', '«name» debe ser un texto no vacío');
    expectDiagnostic('mcp', JSON.stringify({ name: 'x', tools: [tool()] }), 'warning', 'Falta «version» del servidor');
    expectDiagnostic('mcp', JSON.stringify({ serverInfo: { version: '1' }, tools: [tool()] }), 'error', 'Falta «serverInfo.name»');
    expectDiagnostic('mcp', JSON.stringify({ serverInfo: { name: 'x' }, tools: [tool()] }), 'warning', 'Falta «serverInfo.version»');
    expectDiagnostic('mcp', JSON.stringify({ serverInfo: 'x', tools: [tool()] }), 'error', '«serverInfo» debe ser un objeto');
    expectDiagnostic('mcp', JSON.stringify({ version: '1', tools: [tool()] }), 'warning', 'Falta «name»');
  });

  it('protocolVersion y capabilities', () => {
    expectDiagnostic('mcp', manifest({ protocolVersion: '1.0' }), 'warning', '«protocolVersion» debería ser una fecha');
    expectDiagnostic('mcp', manifest({ capabilities: [] }), 'error', '«capabilities» debe ser un objeto');
  });

  it('herramientas: nombre válido y único', () => {
    expectDiagnostic('mcp', manifest({ tools: [tool({ name: 'crear pedido' })] }), 'error', 'El nombre de herramienta «crear pedido» no es válido');
    expectDiagnostic('mcp', manifest({ tools: [tool({ name: 'a'.repeat(129) })] }), 'error', 'no es válido');
    expectDiagnostic('mcp', manifest({ tools: [tool({ name: 'ñ' })] }), 'error', 'no es válido');
    expect(errorsOf('mcp', manifest({ tools: [tool({ name: 'a'.repeat(128) }), tool({ name: 'Ab_c-d.e9' })] }))).toEqual([]);
    expectDiagnostic('mcp', manifest({ tools: [tool(), tool()] }), 'error', 'La herramienta «crear_pedido» está repetida (ya es la nº 1)');
    expectDiagnostic('mcp', manifest({ tools: [{ inputSchema: { type: 'object' } }] }), 'error', 'La herramienta nº 1 no tiene «name»');
    expectDiagnostic('mcp', manifest({ tools: {} }), 'error', '«tools» debe ser un array');
    expectDiagnostic('mcp', manifest({ tools: [3] }), 'error', 'La herramienta nº 1 debe ser un objeto');
  });

  it('herramientas: inputSchema obligatorio de tipo object con properties objeto', () => {
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: undefined })] }), 'error', 'no tiene «inputSchema»');
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: 'x' })] }), 'error', 'El «inputSchema» de la herramienta «crear_pedido» debe ser un objeto');
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: { type: 'array' } })] }), 'error', 'debe tener type: "object"');
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: { properties: {} } })] }), 'error', 'debe tener type: "object"');
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: { type: 'object', properties: [] } })] }), 'error', '«properties» del «inputSchema» de la herramienta «crear_pedido» debe ser un objeto');
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: { type: 'object' } })] }), 'info', 'no declara «properties»');
  });

  it('herramientas: required debe estar incluido en properties', () => {
    const input = { type: 'object', properties: { a: {} }, required: ['a', 'b'] };
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: input })] }), 'error', '«required» de la herramienta «crear_pedido» menciona «b», que no está en «properties»');
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: { type: 'object', required: ['x'] } })] }), 'error', 'menciona «x»');
    expectDiagnostic('mcp', manifest({ tools: [tool({ inputSchema: { type: 'object', properties: {}, required: 'a' } })] }), 'error', '«required» del «inputSchema»');
    expect(errorsOf('mcp', manifest({ tools: [tool({ inputSchema: { type: 'object', properties: { a: {}, b: {} }, required: ['a', 'b'] } })] }))).toEqual([]);
  });

  it('herramientas: outputSchema de tipo object', () => {
    expectDiagnostic('mcp', manifest({ tools: [tool({ outputSchema: { type: 'string' } })] }), 'error', 'El «outputSchema» de la herramienta «crear_pedido» debe ser un objeto con type: "object"');
    expectDiagnostic('mcp', manifest({ tools: [tool({ outputSchema: 'x' })] }), 'error', '«outputSchema»');
    expect(errorsOf('mcp', manifest({ tools: [tool({ outputSchema: { type: 'object', properties: {} } })] }))).toEqual([]);
  });

  it('herramientas: annotations con booleanos', () => {
    expectDiagnostic('mcp', manifest({ tools: [tool({ annotations: { readOnlyHint: 'si' } })] }), 'error', '«annotations.readOnlyHint» de la herramienta «crear_pedido» debe ser un booleano');
    expectDiagnostic('mcp', manifest({ tools: [tool({ annotations: { destructiveHint: 1, idempotentHint: 0, openWorldHint: null } })] }), 'error', '«annotations.destructiveHint»');
    expectDiagnostic('mcp', manifest({ tools: [tool({ annotations: [] })] }), 'error', '«annotations» de la herramienta');
    expect(checkContract('mcp', manifest({ tools: [tool({ annotations: { readOnlyHint: true, destructiveHint: false, title: 'Crear' } })] }))).toEqual([]);
  });

  it('avisa si una herramienta no tiene description', () => {
    expectDiagnostic('mcp', manifest({ tools: [tool({ description: undefined })] }), 'warning', 'La herramienta «crear_pedido» no tiene «description»');
    expectDiagnostic('mcp', manifest({ tools: [tool({ description: '  ' })] }), 'warning', 'no tiene «description»');
  });

  it('recursos: uri con esquema y name', () => {
    expectDiagnostic('mcp', manifest({ resources: [{ uri: 'sin-esquema', name: 'r' }] }), 'error', 'debe tener esquema');
    expectDiagnostic('mcp', manifest({ resources: [{ uri: '/ruta/local', name: 'r' }] }), 'error', 'debe tener esquema');
    expectDiagnostic('mcp', manifest({ resources: [{ uri: 'file:///a' }] }), 'error', 'El recurso «file:///a» no tiene «name»');
    expectDiagnostic('mcp', manifest({ resources: [{ name: 'r' }] }), 'error', 'El recurso nº 1 no tiene «uri»');
    expectDiagnostic('mcp', manifest({ resources: [{ uri: 'file:///a', name: 'a' }, { uri: 'file:///a', name: 'b' }] }), 'warning', 'La «uri» «file:///a» está repetida');
    expectDiagnostic('mcp', manifest({ resources: {} }), 'error', '«resources» debe ser un array');
    expect(checkContract('mcp', manifest({ resources: [{ uri: 'https://x.y/z', name: 'z' }, { uri: 'db://tabla/1', name: 'db' }] }))).toEqual([]);
  });

  it('plantillas de recurso', () => {
    expectDiagnostic('mcp', manifest({ resourceTemplates: [{ name: 'a' }] }), 'error', 'no tiene «uriTemplate»');
    expectDiagnostic('mcp', manifest({ resourceTemplates: [{ uriTemplate: 'file:///{x}' }] }), 'error', 'no tiene «name»');
    expect(checkContract('mcp', manifest({ resourceTemplates: [{ uriTemplate: 'file:///{x}', name: 'a' }] }))).toEqual([]);
  });

  it('prompts: name y arguments con nombres únicos', () => {
    expectDiagnostic('mcp', manifest({ prompts: [{ description: 'x' }] }), 'error', 'El prompt nº 1 no tiene «name»');
    expectDiagnostic('mcp', manifest({ prompts: [{ name: 'p' }, { name: 'p' }] }), 'error', 'El prompt «p» está repetido (ya es el nº 1)');
    expectDiagnostic('mcp', manifest({ prompts: [{ name: 'p', arguments: [{ name: 'a' }, { name: 'a' }] }] }), 'error', 'El argumento «a» del prompt «p» está repetido (ya es el nº 1)');
    expectDiagnostic('mcp', manifest({ prompts: [{ name: 'p', arguments: [{ description: 'x' }] }] }), 'error', 'El argumento nº 1 del prompt «p» no tiene «name»');
    expectDiagnostic('mcp', manifest({ prompts: [{ name: 'p', arguments: {} }] }), 'error', '«arguments» del prompt «p» debe ser un array');
    expectDiagnostic('mcp', manifest({ prompts: [{ name: 'p', arguments: [{ name: 'a', required: 'si' }] }] }), 'error', '«required» del argumento «a»');
    expect(checkContract('mcp', manifest({ prompts: [{ name: 'p', arguments: [{ name: 'a', required: true }, { name: 'b' }] }] }))).toEqual([]);
  });

  it('avisa si no hay ni herramientas ni recursos ni prompts', () => {
    expectDiagnostic('mcp', JSON.stringify({ name: 'x', version: '1' }), 'warning', 'no declara herramientas, recursos ni prompts');
    expectDiagnostic('mcp', JSON.stringify({ name: 'x', version: '1', tools: [] }), 'warning', 'no declara herramientas, recursos ni prompts');
    expect(find(checkContract('mcp', JSON.stringify({ name: 'x', version: '1', prompts: [{ name: 'p' }] })), 'warning', 'no declara herramientas')).toBeUndefined();
  });

  it('señala la línea del problema', () => {
    const text = lines('{', '  "name": "x",', '  "version": "1",', '  "tools": [', '    {', '      "name": "t",', '      "description": "d",', '      "inputSchema": { "type": "array" }', '    }', '  ]', '}');
    expectDiagnostic('mcp', text, 'error', 'debe tener type: "object"', { line: 8, column: 7 });
  });
});

describe('MCP: formateador y resumen', () => {
  it('produce el orden canónico', () => {
    const input = JSON.stringify({
      prompts: [{ arguments: [{ required: true, name: 'a' }], description: 'd', name: 'p' }],
      extra: 1,
      resources: [{ mimeType: 'text/plain', name: 'r', uri: 'file:///r' }],
      tools: [
        {
          annotations: { readOnlyHint: true },
          outputSchema: { type: 'object' },
          inputSchema: { type: 'object', properties: { z: {}, a: {} } },
          description: 'd',
          title: 'T',
          name: 't',
          extra: 2,
        },
      ],
      capabilities: {},
      serverInfo: { version: '1', name: 'x' },
      protocolVersion: '2025-06-18',
      version: '1',
      resourceTemplates: [{ name: 'n', uriTemplate: 'file:///{a}' }],
      name: 'srv',
    });
    const parsed = JSON.parse(reformatted('mcp', input));
    expect(Object.keys(parsed)).toEqual(['name', 'version', 'protocolVersion', 'serverInfo', 'capabilities', 'tools', 'resources', 'resourceTemplates', 'prompts', 'extra']);
    expect(Object.keys(parsed.tools[0])).toEqual(['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'extra']);
    expect(Object.keys(parsed.tools[0].inputSchema.properties)).toEqual(['z', 'a']);
    expect(Object.keys(parsed.serverInfo)).toEqual(['name', 'version']);
    expect(Object.keys(parsed.resources[0])).toEqual(['uri', 'name', 'mimeType']);
    expect(Object.keys(parsed.prompts[0])).toEqual(['name', 'description', 'arguments']);
    expect(Object.keys(parsed.prompts[0].arguments[0])).toEqual(['name', 'required']);
  });

  it('formatea un tools/list desnudo con 2 espacios y salto de línea final', () => {
    const text = reformatted('mcp', '{"tools":[{"inputSchema":{"type":"object"},"name":"t"}]}');
    expect(text).toBe(lines('{', '  "tools": [', '    {', '      "name": "t",', '      "inputSchema": {', '        "type": "object"', '      }', '    }', '  ]', '}', ''));
  });

  it('falla con JSON inválido o si la raíz no es un objeto', () => {
    expect(reformatFailure('mcp', '{"tools": [}')).toMatch(/\(línea 1, columna \d+\)$/);
    expect(reformatFailure('mcp', '[1]')).toContain('debe ser un objeto');
  });

  it('resume herramientas, recursos y prompts', () => {
    const text = JSON.stringify({
      tools: [
        { name: 'crear_pedido', inputSchema: { type: 'object', properties: { cliente: {}, lineas: {} } } },
        { name: 'sin_parametros', inputSchema: { type: 'object' } },
        { inputSchema: {} },
      ],
      resources: [{ uri: 'file:///catalogo.json', name: 'catalogo' }, { uri: 'https://x.y' }],
      resourceTemplates: [{ uriTemplate: 'file:///{id}', name: 'doc' }],
      prompts: [{ name: 'revisar', arguments: [{ name: 'codigo' }, { name: 'lenguaje' }] }, { name: 'saludar' }],
    });
    expect(summarizeContract('mcp', text)).toEqual([
      'herramienta crear_pedido(cliente, lineas)',
      'herramienta sin_parametros()',
      'recurso catalogo (file:///catalogo.json)',
      'recurso https://x.y',
      'plantilla de recurso doc (file:///{id})',
      'prompt revisar(codigo, lenguaje)',
      'prompt saludar()',
    ]);
    expect(summarizeContract('mcp', 'no json')).toEqual([]);
    expect(summarizeContract('mcp', '[]')).toEqual([]);
  });
});

describe('AsyncAPI', () => {
  const doc = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ asyncapi: '3.0.0', info: { title: 'Eventos', version: '1.0.0' }, channels: { a: { address: 'a.b' } }, ...extra }, null, 2);

  it('comprobaciones básicas', () => {
    expect(checkContract('asyncapi', doc())).toEqual([]);
    expectDiagnostic('asyncapi', '{"info":{"title":"a","version":"1"},"channels":{}}', 'error', 'Falta el campo «asyncapi»');
    expectDiagnostic('asyncapi', doc({ asyncapi: '1.0.0' }), 'error', '«asyncapi» debe ser una versión 2.x o 3.x', { line: 2 });
    expectDiagnostic('asyncapi', doc({ info: { title: 'a' } }), 'error', 'Falta «info.version»');
    expectDiagnostic('asyncapi', doc({ info: undefined }), 'error', 'Falta «info»');
    expectDiagnostic('asyncapi', doc({ channels: undefined }), 'warning', 'Falta «channels»');
    expectDiagnostic('asyncapi', doc({ channels: [] }), 'error', '«channels» debe ser un objeto');
    expectDiagnostic('asyncapi', '{"asyncapi": ', 'error', 'JSON no válido');
    expectDiagnostic('asyncapi', 'no json {', 'error', 'debe ser un objeto');
  });

  it('operaciones de AsyncAPI 3 y referencias', () => {
    expectDiagnostic('asyncapi', doc({ operations: { o: { action: 'publish', channel: { $ref: '#/channels/a' } } } }), 'error', 'debe tener action: "send" o "receive"');
    expectDiagnostic('asyncapi', doc({ operations: { o: { action: 'send' } } }), 'error', 'no indica su «channel»');
    expectDiagnostic('asyncapi', doc({ operations: { o: { action: 'send', channel: { $ref: '#/channels/falta' } } } }), 'error', 'La referencia «#/channels/falta» no existe');
    expect(checkContract('asyncapi', doc({ operations: { o: { action: 'receive', channel: { $ref: '#/channels/a' } } } }))).toEqual([]);
  });

  it('acepta YAML (2.x)', () => {
    const yaml = lines('asyncapi: 2.6.0', 'info:', '  title: X', '  version: 1.0.0', 'channels:', '  pedidos:', '    publish:', '      operationId: pub', '      message:', '        payload: { type: object }', '');
    expect(checkContract('asyncapi', yaml)).toEqual([]);
    expect(summarizeContract('asyncapi', yaml)).toEqual(['PUBLISH pedidos — pub']);
    expectDiagnostic('asyncapi', 'asyncapi: 3.0.0\ninfo: {title: X}\nchannels: {}\n', 'error', 'Falta «info.version»', { line: 2 });
  });

  it('formatea JSON y YAML sin cambiar el orden de las claves', () => {
    expect(reformatted('asyncapi', '{"info":{"version":"1","title":"a"},"asyncapi":"3.0.0"}')).toBe(lines('{', '  "info": {', '    "version": "1",', '    "title": "a"', '  },', '  "asyncapi": "3.0.0"', '}', ''));
    expect(reformatted('asyncapi', 'info: {title: a}\nasyncapi: 3.0.0\n')).toBe('info: { title: a }\nasyncapi: 3.0.0\n');
    expect(reformatFailure('asyncapi', '{"a":')).toContain('línea 1');
  });

  it('resume las operaciones de AsyncAPI 3 con la dirección del canal', () => {
    expect(summarizeContract('asyncapi', contractTemplate('asyncapi', 'Pedidos'))).toEqual(['SEND pedidos.recurso.creado — publicarRecursoCreado']);
    expect(summarizeContract('asyncapi', 'no json {')).toEqual([]);
  });
});

describe('JSON Schema', () => {
  it('acepta un esquema, un booleano y subesquemas anidados', () => {
    expect(checkContract('json-schema', '{"type":"object","properties":{"a":{"type":["string","null"]}},"required":["a"],"$defs":{"x":{"type":"integer"}}}')).toEqual([]);
    expect(checkContract('json-schema', 'true')).toEqual([]);
    expect(checkContract('json-schema', '{"$ref":"#/$defs/x","$defs":{"x":true}}')).toEqual([]);
    expect(checkContract('json-schema', '{"type":"object","properties":{"type":{"type":"string"},"enum":{"type":"string"}}}')).toEqual([]);
  });

  it('errores de forma', () => {
    expectDiagnostic('json-schema', '3', 'error', 'debe ser un objeto o un booleano');
    expectDiagnostic('json-schema', '[]', 'error', 'debe ser un objeto o un booleano');
    expectDiagnostic('json-schema', '{\n"type": }', 'error', 'JSON no válido', { line: 2, column: 9 });
    expectDiagnostic('json-schema', '{"$schema": 5}', 'error', '«$schema» debe ser una URI');
    expectDiagnostic('json-schema', '{"type":"objeto"}', 'error', '«type» debe ser uno de');
    expectDiagnostic('json-schema', '{"type":["string","foo"]}', 'error', '«type» debe ser uno de');
    expectDiagnostic('json-schema', '{"properties":[]}', 'error', '«properties» debe ser un objeto');
    expectDiagnostic('json-schema', '{"required":"id"}', 'error', '«required» debe ser un array');
    expectDiagnostic('json-schema', '{"enum":[]}', 'error', '«enum» debe ser un array con al menos un valor');
    expectDiagnostic('json-schema', '{"allOf":[]}', 'error', '«allOf» debe ser un array con al menos un esquema');
    expectDiagnostic('json-schema', '{"properties":{"a":3}}', 'error', 'Un subesquema debe ser un objeto o un booleano');
    expectDiagnostic('json-schema', '{"pattern":"("}', 'warning', '«pattern» no es una expresión regular válida');
  });

  it('comprueba las referencias locales', () => {
    expectDiagnostic('json-schema', '{"properties":{"a":{"$ref":"#/$defs/falta"}}}', 'error', 'La referencia «#/$defs/falta» no existe');
    expect(checkContract('json-schema', '{"$ref":"#"}')).toEqual([]);
  });

  it('formatea y resume', () => {
    expect(reformatted('json-schema', '{"type":"object","properties":{"b":{},"a":{}},"required":["a"]}')).toBe(
      prettyJson({ type: 'object', properties: { b: {}, a: {} }, required: ['a'] }),
    );
    expect(reformatFailure('json-schema', '{"a" 1}')).toMatch(/línea 1, columna 6/);
    expect(summarizeContract('json-schema', '{"title":"Pedido","type":"object","properties":{"id":{},"total":{}},"required":["id"]}')).toEqual([
      'Título: Pedido',
      'Tipo: object',
      'Propiedades: id, total',
      'Obligatorias: id',
    ]);
    expect(summarizeContract('json-schema', 'true')).toEqual([]);
  });
});

describe('Avro', () => {
  const record = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ type: 'record', name: 'Pedido', namespace: 'com.example', fields: [{ name: 'id', type: 'string' }], ...extra });

  it('acepta registros, uniones, tipos con nombre y tipos recursivos', () => {
    expect(checkContract('avro', record())).toEqual([]);
    expect(checkContract('avro', '"string"')).toEqual([]);
    expect(checkContract('avro', '["null","string"]')).toEqual([]);
    expect(
      checkContract(
        'avro',
        JSON.stringify({
          type: 'record',
          name: 'Nodo',
          namespace: 'a.b',
          fields: [
            { name: 'siguiente', type: ['null', 'Nodo'] },
            { name: 'estado', type: { type: 'enum', name: 'Estado', symbols: ['A', 'B'] } },
            { name: 'otro', type: 'Estado' },
            { name: 'lista', type: { type: 'array', items: 'string' } },
            { name: 'mapa', type: { type: 'map', values: 'long' } },
            { name: 'hash', type: { type: 'fixed', name: 'Hash', size: 16 } },
            { name: 'fecha', type: { type: 'long', logicalType: 'timestamp-millis' } },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('un record necesita type, name y fields', () => {
    expectDiagnostic('avro', '{"name":"X","fields":[]}', 'error', 'Falta «type»');
    expectDiagnostic('avro', '{"type":"record","fields":[]}', 'error', 'necesita un «name»');
    expectDiagnostic('avro', '{"type":"record","name":"X"}', 'error', 'necesita «fields» (un array)');
    expectDiagnostic('avro', record({ name: '1x' }), 'error', 'El nombre «1x» no es válido');
    expectDiagnostic('avro', '3', 'error', 'Un esquema Avro debe ser');
    expectDiagnostic('avro', '{"a":', 'error', 'JSON no válido');
  });

  it('comprueba los campos', () => {
    expectDiagnostic('avro', record({ fields: [{ name: 'a', type: 'string' }, { name: 'a', type: 'int' }] }), 'error', 'El campo «a» está repetido');
    expectDiagnostic('avro', record({ fields: [{ name: 'a' }] }), 'error', 'Falta «type» en el campo "a"');
    expectDiagnostic('avro', record({ fields: [{ name: 'a b', type: 'string' }] }), 'error', 'no es válido');
    expectDiagnostic('avro', record({ fields: [{ name: 'a', type: 'Falta' }] }), 'error', 'El tipo «Falta» no está definido');
    expectDiagnostic('avro', record({ fields: [{ name: 'a', type: ['null', 'null'] }] }), 'error', 'La unión repite el tipo «null»');
    expectDiagnostic('avro', record({ fields: [{ name: 'a', type: [] }] }), 'error', 'Una unión no puede estar vacía');
    expectDiagnostic('avro', record({ fields: [{ name: 'a', type: ['null', ['string']] }] }), 'error', 'no puede contener otra unión');
    expectDiagnostic('avro', record({ fields: ['x'] }), 'error', 'Cada campo debe ser un objeto');
  });

  it('enum, fixed, array y map', () => {
    expectDiagnostic('avro', '{"type":"enum","name":"E","symbols":["A","A"]}', 'error', 'El símbolo «A» está repetido');
    expectDiagnostic('avro', '{"type":"enum","name":"E","symbols":["1"]}', 'error', 'no es válido');
    expectDiagnostic('avro', '{"type":"enum","name":"E"}', 'error', 'necesita «symbols»');
    expectDiagnostic('avro', '{"type":"fixed","name":"F"}', 'error', 'necesita «size»');
    expectDiagnostic('avro', '{"type":"array"}', 'error', 'necesita «items»');
    expectDiagnostic('avro', '{"type":"map"}', 'error', 'necesita «values»');
    expectDiagnostic('avro', record({ fields: [{ name: 'a', type: { type: 'record', name: 'Pedido', fields: [] } }] }), 'error', 'El tipo «com.example.Pedido» ya está definido');
  });

  it('formatea y resume', () => {
    expect(reformatted('avro', '{"type":"record","name":"P","fields":[{"name":"b","type":"int"},{"name":"a","type":"string"}]}')).toBe(
      prettyJson({ type: 'record', name: 'P', fields: [{ name: 'b', type: 'int' }, { name: 'a', type: 'string' }] }),
    );
    expect(reformatFailure('avro', '{"a"')).toContain('línea 1');
    expect(summarizeContract('avro', record({ fields: [{ name: 'id', type: 'string' }, { name: 'total', type: 'double' }] }))).toEqual(['record Pedido (id, total)']);
    expect(summarizeContract('avro', '{"type":"enum","name":"E","symbols":["A"]}')).toEqual(['enum E']);
  });
});

describe('GraphQL', () => {
  it('acepta un esquema con comentarios, cadenas y descripciones con llaves', () => {
    const text = lines('"""Descripción { con llave"""', 'type A {', '  "a } b" a(x: Int = 1): String # }', '  b: [String!]!', '}', '# type Comentado {');
    expect(checkContract('graphql', text)).toEqual([]);
  });

  it('llaves y paréntesis desbalanceados, con su posición', () => {
    expectDiagnostic('graphql', lines('type A {', '  a: String', ''), 'error', 'La «{» abierta aquí no se cierra', { line: 1, column: 8 });
    expectDiagnostic('graphql', lines('type A {', '}', '}'), 'error', 'Cierre «}» sin su apertura', { line: 3, column: 1 });
    expectDiagnostic('graphql', lines('type A {', '  a(x: Int: String', '}'), 'error', 'Se esperaba «)» para cerrar la «(» de la línea 2', { line: 3 });
    expectDiagnostic('graphql', lines('type A {', '  a: [String', '}'), 'error', 'Se esperaba «]»');
    expectDiagnostic('graphql', 'type A { a: "sin cerrar }', 'error', 'Cadena sin cerrar', { line: 1 });
    expectDiagnostic('graphql', 'type A { a: String }\n"""sin cerrar', 'error', 'sin cerrar', { line: 2 });
  });

  it('avisa si no se reconoce ninguna definición', () => {
    expectDiagnostic('graphql', 'hola mundo', 'warning', 'No se reconoce ninguna definición');
    expectDiagnostic('graphql', '# solo un comentario\nhola', 'warning', 'No se reconoce ninguna definición');
    expectNoDiagnostic('graphql', 'scalar Fecha', 'No se reconoce');
    expectNoDiagnostic('graphql', 'query { a }', 'No se reconoce');
  });

  it('reindenta con 2 espacios sin tocar descripciones de bloque', () => {
    const input = lines('type Query{', 'recurso(', 'id: ID!', '): Recurso', '}', '"""', '  Descripción {', '"""', 'type Recurso { id: ID! }', '', '', '');
    expect(reformatted('graphql', input)).toBe(lines('type Query{', '  recurso(', '    id: ID!', '  ): Recurso', '}', '"""', '  Descripción {', '"""', 'type Recurso { id: ID! }', ''));
  });

  it('falla al formatear si hay llaves sin pareja y es idempotente', () => {
    expect(reformatFailure('graphql', 'type A {')).toMatch(/abierta aquí no se cierra\. \(línea 1, columna 8\)/);
    const once = reformatted('graphql', 'type A{\n a:  String # }\n}\n\n\n\ntype B{\nb(\n x:Int\n):Int}');
    expect(reformatted('graphql', once)).toBe(once);
  });

  it('resume operaciones y tipos', () => {
    expect(summarizeContract('graphql', contractTemplate('graphql', 'x'))).toEqual(['Query.recurso', 'Query.recursos', 'Mutation.crearRecurso', 'type Recurso', 'input NuevoRecurso']);
    expect(summarizeContract('graphql', 'type A {')).toEqual([]);
  });
});

describe('WSDL', () => {
  it('acepta XML bien formado con raíz definitions o description', () => {
    expect(checkContract('wsdl', '<?xml version="1.0"?><definitions name="x"/>')).toEqual([]);
    expect(checkContract('wsdl', '<description xmlns="http://www.w3.org/ns/wsdl"/>')).toEqual([]);
    expect(checkContract('wsdl', '<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"/>')).toEqual([]);
  });

  it('XML mal formado con línea y columna', () => {
    expectDiagnostic('wsdl', lines('<definitions>', '  <types>', '</definitions>'), 'error', 'se esperaba «</types>» (abierta en la línea 2, columna 3) y se encontró «</definitions>»', { line: 3 });
    expectDiagnostic('wsdl', '<a><b></a>', 'error', 'XML mal formado', { line: 1 });
    expectDiagnostic('wsdl', '<a>', 'error', 'la etiqueta «<a>» no se cierra');
    expectDiagnostic('wsdl', 'hola', 'error', 'XML mal formado', { line: 1, column: 1 });
    expectDiagnostic('wsdl', '<a x="1" x="2"/>', 'error', 'el atributo «x» está repetido');
    expectDiagnostic('wsdl', '<a></a><b></b>', 'error', 'más de un elemento raíz');
  });

  it('avisa si la raíz no es de un WSDL', () => {
    expectDiagnostic('wsdl', '<?xml version="1.0"?><html/>', 'warning', 'La raíz es «html»');
  });

  it('formatea reindentando, conservando comentarios y entidades', () => {
    const input = '<?xml version="1.0"?><!-- cabecera --><definitions name="n" xmlns:a="x"><portType name="P"><operation name="O"/></portType><documentation>a &amp; b &#233;</documentation></definitions>';
    expect(reformatted('wsdl', input)).toBe(
      lines(
        '<?xml version="1.0"?>',
        '<!-- cabecera -->',
        '<definitions name="n" xmlns:a="x">',
        '  <portType name="P">',
        '    <operation name="O"/>',
        '  </portType>',
        '  <documentation>a &amp; b &#233;</documentation>',
        '</definitions>',
        '',
      ),
    );
  });

  it('el formateador falla con XML mal formado', () => {
    expect(reformatFailure('wsdl', '<a><b></a>')).toMatch(/XML mal formado.*\(línea 1, columna \d+\)/);
  });

  it('resume el servicio y las operaciones', () => {
    expect(summarizeContract('wsdl', contractTemplate('wsdl', 'Pedidos'))).toEqual(['servicio Pedidos', 'PedidosPortType.Obtener']);
    expect(summarizeContract('wsdl', 'hola')).toEqual([]);
  });
});

describe('Otro', () => {
  it('no comprueba nada y el formateador deja el texto igual', () => {
    expect(checkContract('other', 'lo que sea {')).toEqual([]);
    expect(reformatContract('other', ' texto  libre ', { name: 'x' })).toEqual({ ok: true, text: ' texto  libre ' });
    expect(summarizeContract('other', 'algo')).toEqual([]);
  });
});

describe('idempotencia de los formateadores', () => {
  const samples: Array<[ContractFormat, string[]]> = [
    ['cloudevents', ['{"a":1}', '{"type":"a.b.c","zeta":1,"alfa":2}', '[{"type":"a.b.c"},{"b":2}]', '[]', '3']],
    [
      'protobuf',
      [
        'syntax="proto3";\n\n\n\nmessage A {\n string a=1; // }\n/* {\n x */\n   message B {string b = 1;}\n}\nservice S{rpc R(A)returns(A);}',
        '',
        '   \n',
      ].filter((text) => text.trim() !== ''),
    ],
    ['openapi', ['{"paths":{},"info":{"title":"a","version":"1"},"openapi":"3.0.3"}', 'paths: {}\n# c\ninfo: {title: a, version: "1"}\nopenapi: 3.0.3\n', '{"openapi":"3.0.3","info":{"title":"a","version":"1"},"paths":{"/a":{"get":{"responses":{"default":{"description":"x"},"200":{"description":"y"}}}}}}']],
    ['asyncapi', ['{"channels":{},"asyncapi":"3.0.0"}', 'channels: {}\nasyncapi: 3.0.0\n']],
    ['mcp', ['{"prompts":[],"tools":[{"description":"d","name":"t","inputSchema":{"type":"object"}}],"name":"s"}']],
    ['json-schema', ['{"properties":{"b":{},"a":{}},"type":"object"}', 'true']],
    ['avro', ['{"fields":[],"name":"A","type":"record"}', '["null","string"]']],
    ['graphql', ['type A{a:String}\n\n\n\ntype B{\nb(\nx:Int\n):Int}']],
    ['wsdl', ['<a><b x="1"/><!--c--><c>texto</c></a>', '<?xml version="1.0"?><definitions><types/></definitions>']],
    ['other', ['cualquier  texto ']],
  ];

  it.each(samples)('%s: reformat(reformat(x)) === reformat(x)', (format, inputs) => {
    for (const input of inputs) {
      const once = reformatContract(format, input, { name: 'Pedido' });
      expect(once.ok, input).toBe(true);
      if (!once.ok) continue;
      const twice = reformatContract(format, once.text, { name: 'Pedido' });
      expect(twice, input).toEqual({ ok: true, text: once.text });
    }
  });

  it('el resultado de formatear un contrato válido sigue siendo válido', () => {
    for (const format of CONTRACT_FORMATS.filter((f) => f !== 'other')) {
      const template = contractTemplate(format, 'Pedidos');
      const text = reformatted(format, template);
      expect(checkContract(format, text), format).toEqual(checkContract(format, template));
    }
  });
});

describe('transformaciones', () => {
  const transform = (id: string) => CONTRACT_TRANSFORMS.find((t) => t.id === id)!;
  const yaml = lines(
    'openapi: 3.0.3',
    'info:',
    '  title: Pedidos',
    '  version: "1.0"',
    'paths:',
    '  /pedidos:',
    '    get:',
    '      responses:',
    '        "200":',
    '          description: ok',
    '',
  );

  it('ofrece to-yaml y to-json para openapi y asyncapi', () => {
    expect(CONTRACT_TRANSFORMS.map((t) => t.id)).toEqual(['to-yaml', 'to-json']);
    for (const t of CONTRACT_TRANSFORMS) {
      expect(t.label.length).toBeGreaterThan(3);
      expect(t.formats).toEqual(['openapi', 'asyncapi']);
    }
  });

  it('YAML → JSON → YAML conserva el contenido', () => {
    const json = transform('to-json').run(yaml, { name: 'x', format: 'openapi' });
    expect(json.ok).toBe(true);
    if (!json.ok) return;
    expect(JSON.parse(json.text)).toEqual({
      openapi: '3.0.3',
      info: { title: 'Pedidos', version: '1.0' },
      paths: { '/pedidos': { get: { responses: { '200': { description: 'ok' } } } } },
    });
    expect(json.text.endsWith('}\n')).toBe(true);

    const back = transform('to-yaml').run(json.text, { name: 'x', format: 'openapi' });
    expect(back).toEqual({ ok: true, text: yaml });
    expect(checkContract('openapi', yaml)).toEqual([]);
  });

  it('JSON → YAML → JSON es un viaje de ida y vuelta exacto', () => {
    for (const format of ['openapi', 'asyncapi'] as const) {
      const json = contractTemplate(format, 'Pedidos');
      const toYaml = transform('to-yaml').run(json, { name: 'x', format });
      expect(toYaml.ok).toBe(true);
      if (!toYaml.ok) continue;
      expect(toYaml.text.trimStart().startsWith('{')).toBe(false);
      expect(checkContract(format, toYaml.text)).toEqual([]);
      const back = transform('to-json').run(toYaml.text, { name: 'x', format });
      expect(back).toEqual({ ok: true, text: json });
    }
  });

  it('las claves numéricas de las respuestas siguen siendo texto tras el viaje', () => {
    const json = contractTemplate('openapi', 'Pedidos');
    const toYaml = transform('to-yaml').run(json, { name: 'x', format: 'openapi' });
    if (!toYaml.ok) throw new Error(toYaml.reason);
    expect(toYaml.text).toContain('"200":');
  });

  it('to-yaml ordena la raíz de OpenAPI y to-json de un JSON lo reformatea', () => {
    const toYaml = transform('to-yaml').run('{"paths":{},"openapi":"3.0.3","info":{"title":"a","version":"1"}}', { name: 'x', format: 'openapi' });
    expect(toYaml.ok && toYaml.text.startsWith('openapi: 3.0.3\n')).toBe(true);
    expect(transform('to-json').run('{"a":1}', { name: 'x', format: 'asyncapi' })).toEqual({ ok: true, text: '{\n  "a": 1\n}\n' });
  });

  it('to-yaml sobre un YAML lo reformatea conservando los comentarios', () => {
    const result = transform('to-yaml').run('# nota\nopenapi:   3.0.3\n', { name: 'x', format: 'openapi' });
    expect(result).toEqual({ ok: true, text: '# nota\nopenapi: 3.0.3\n' });
  });

  it('los textos inválidos o vacíos fallan con un motivo', () => {
    const bad = transform('to-yaml').run('{"a":', { name: 'x', format: 'openapi' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain('JSON no válido');
    const badYaml = transform('to-json').run('a: [1', { name: 'x', format: 'openapi' });
    expect(badYaml.ok).toBe(false);
    if (!badYaml.ok) expect(badYaml.reason).toContain('YAML no válido');
    expect(transform('to-json').run('  ', { name: 'x', format: 'openapi' })).toEqual({ ok: false, reason: 'El contrato no tiene contenido.' });
  });
});

describe('robustez', () => {
  const garbage = [
    '{',
    '}',
    '[[[[[[[[[[',
    '"',
    "'",
    '<<<>>>',
    '\u0000\u0001',
    'null',
    '0',
    '// solo comentario',
    '/* sin cerrar',
    '{"a": {"b": {"c": [1, 2, {"d": null}]}}}',
    'a: b: c',
    '- - - -',
    '\uFEFF{"specversion":"1.0"}',
    '{"__proto__": {"x": 1}, "type": "a.b.c", "tools": 3, "paths": 4}',
    `${'['.repeat(2000)}${']'.repeat(2000)}`,
    `${'{"a":'.repeat(1500)}1${'}'.repeat(1500)}`,
    'x'.repeat(100000),
  ];

  it.each(CONTRACT_FORMATS)('%s: nunca lanza excepciones con entradas arbitrarias', (format) => {
    for (const text of garbage) {
      expect(() => checkContract(format, text), text.slice(0, 20)).not.toThrow();
      expect(() => reformatContract(format, text, { name: 'x' }), text.slice(0, 20)).not.toThrow();
      expect(() => summarizeContract(format, text), text.slice(0, 20)).not.toThrow();
      for (const t of CONTRACT_TRANSFORMS) expect(() => t.run(text, { name: 'x', format: 'openapi' })).not.toThrow();
    }
  });

  it('todos los diagnósticos tienen mensaje en español y posiciones válidas', () => {
    for (const format of CONTRACT_FORMATS) {
      for (const text of garbage) {
        for (const diagnostic of checkContract(format, text)) {
          expect(diagnostic.message.length).toBeGreaterThan(5);
          expect(['error', 'warning', 'info']).toContain(diagnostic.severity);
          if (diagnostic.line !== undefined) expect(diagnostic.line).toBeGreaterThanOrEqual(1);
          if (diagnostic.column !== undefined) expect(diagnostic.column).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });
});
