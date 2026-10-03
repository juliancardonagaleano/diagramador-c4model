import { diffDocuments, type DiffEntry } from '@iark/kernel';
import { describe, expect, it } from 'vitest';
import { compareMarks, elementOf, isNested, readComparable } from './compare';
import { FAKE_DOC, fakeModule } from './testing-editor';
import { c4Module, example, securityModule } from './testing';

const entry = (collection: string, id: string): DiffEntry => ({ collection, id, label: id });

describe('readComparable: el texto de otra versión', () => {
  it('lee el JSON del módulo, también entre vallas de código', async () => {
    const result = await readComparable(securityModule, example('seguridad-ejemplo.json'), 'v1.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document).toMatchObject({ zones: expect.any(Array) });
    expect((await readComparable(securityModule, '```json\n' + example('seguridad-ejemplo.json') + '\n```', 'pegado')).ok).toBe(true);
  });

  it('explica por qué no sirve: vacío, JSON roto o un documento que no cumple el esquema', async () => {
    expect(await readComparable(securityModule, '  \n', 'v1.json')).toEqual({ ok: false, reason: 'No hay nada que comparar: el texto está vacío.' });
    const syntax = await readComparable(securityModule, '{ roto', 'v1.json');
    expect(syntax.ok === false && syntax.reason).toMatch(/«v1\.json» no es JSON válido/);
    const schema = await readComparable(securityModule, JSON.stringify({ zones: [{ id: 'z', name: 'Z', trust: 'x' }] }), 'v1.json');
    expect(schema.ok === false && schema.reason).toMatch(/«v1\.json» no cumple el esquema del módulo «security» \(\d+ problemas?; el primero: zones\.0\.trust/);
  });

  it('importa lo que un importador del módulo reconoce (Mermaid en C4) y valida el resultado', async () => {
    const result = await readComparable(c4Module, example('banca.mmd'), 'banca.mmd');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.importer).toBe('mermaid');
      expect(result.document).toMatchObject({ model: { elements: expect.any(Array) } });
    }
    const unknown = await readComparable(c4Module, 'esto no es un diagrama', 'nota.txt');
    expect(unknown.ok).toBe(false);
  });

  it('un módulo sin importadores solo lee su JSON', async () => {
    expect((await readComparable(fakeModule as never, JSON.stringify(FAKE_DOC), 'v1.json')).ok).toBe(true);
    expect((await readComparable(fakeModule as never, 'texto', 'v1.txt')).ok).toBe(false);
  });
});

describe('elementOf: el elemento del lienzo al que se refiere un cambio', () => {
  it('un elemento de una lista es él mismo; una parte suya (columna, paso, elemento de una vista), el elemento del que cuelga', () => {
    expect(elementOf(entry('nodes', 'api'))).toBe('api');
    expect(elementOf(entry('assets[clientes].columns', 'email'))).toBe('clientes');
    expect(elementOf(entry('views[ctx].elements', 'a'))).toBe('ctx');
    expect(isNested(entry('nodes', 'api'))).toBe(false);
    expect(isNested(entry('assets[clientes].columns', 'email'))).toBe(true);
  });

  it('los campos sueltos del documento y los elementos sin id (posiciones) no tienen elemento', () => {
    expect(elementOf(entry('documento', 'documento'))).toBeUndefined();
    expect(elementOf(entry('pipelines[p].mappings', '#2'))).toBe('p');
    expect(elementOf(entry('mappings', '#2'))).toBeUndefined();
  });
});

describe('compareMarks: lo que se marca en el lienzo', () => {
  const base = { ...FAKE_DOC, nodes: [...FAKE_DOC.nodes.filter((n) => n.id !== 'libre'), { id: 'antiguo', kind: 'service' as const, name: 'Antiguo' }] };
  base.nodes = base.nodes.map((n) => (n.id === 'api' ? { ...n, retries: 1 } : n));
  base.edges = base.edges.map((e) => (e.id === 'cola-worker' ? { ...e, step: 3 } : e));

  it('lo añadido es nuevo, lo modificado (elementos y relaciones) modificado y lo quitado va aparte', () => {
    const marks = compareMarks(diffDocuments(base, FAKE_DOC), base);
    expect([...marks.marks]).toEqual([
      ['libre', 'added'],
      ['api', 'modified'],
      ['cola-worker', 'modified'],
    ]);
    expect([...marks.removed]).toEqual(['antiguo']);
    expect(marks.base).toBe(base);
  });

  it('una parte que cambia (una columna) marca como modificado el elemento del que cuelga, salvo que sea nuevo', () => {
    const before = { assets: [{ id: 't', name: 'T', columns: [{ name: 'a' }] }, { id: 'u', name: 'U' }] };
    const after = { assets: [{ id: 't', name: 'T', columns: [{ name: 'a' }, { name: 'b' }] }, { id: 'u', name: 'U', columns: [{ name: 'c' }] }, { id: 'v', name: 'V', columns: [{ name: 'd' }] }] };
    const marks = compareMarks(diffDocuments(before, after), before);
    expect([...marks.marks].sort()).toEqual([
      ['t', 'modified'],
      ['u', 'modified'],
      ['v', 'added'],
    ]);
    expect(marks.removed.size).toBe(0);
    const dropped = compareMarks(diffDocuments(after, before), after);
    expect(dropped.marks.get('t')).toBe('modified');
    expect([...dropped.removed]).toEqual(['v']);
  });

  it('sin diferencias no marca nada', () => {
    const marks = compareMarks(diffDocuments(FAKE_DOC, structuredClone(FAKE_DOC)), FAKE_DOC);
    expect(marks.marks.size).toBe(0);
    expect(marks.removed.size).toBe(0);
  });
});
