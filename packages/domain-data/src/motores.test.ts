import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataCommands } from './commands';
import { checkContract, contractEngine, contractFromAsset, contractTables } from './contract';
import { contractAttachments } from './contract-editor';
import { toDdl } from './ddl';
import { dataEditor } from './editor';
import { BUILTIN_ENGINE_IDS, TYPE_CONCEPTS, checkType, conceptOf, isKnownType, listEngines, parseType, registerEngine, resolveEngine, suggestTypes, typeFor } from './engines';
import { inheritance } from './inherit';
import { analyzeData } from './issues';
import { dataModule } from './module';
import { dataJsonSchema, validateDataDocument } from './schema';
import type { DataDocument } from './types';

const parse = (input: unknown): DataDocument => {
  const r = validateDataDocument(input);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.document;
};
const example = JSON.parse(readFileSync('examples/ventas-datos.json', 'utf8')) as unknown;
const doc = parse(example);
const engine = (id: string) => resolveEngine(id)!;

describe('registro de motores', () => {
  it('trae los motores pedidos, con alias y el nombre que usa Open Data Contract', () => {
    expect(BUILTIN_ENGINE_IDS).toEqual(['postgresql', 'mysql', 'sqlserver', 'oracle', 'sqlite', 'bigquery', 'snowflake', 'redshift', 'databricks', 'mongodb', 'cassandra', 'dynamodb', 'kafka']);
    expect(resolveEngine('postgres')?.id).toBe('postgresql');
    expect(resolveEngine('PG')?.id).toBe('postgresql');
    expect(resolveEngine('SQL Server')?.id).toBe('sqlserver');
    expect(resolveEngine('mssql')?.id).toBe('sqlserver');
    expect(resolveEngine('mongo')?.id).toBe('mongodb');
    expect(resolveEngine('db2')).toBeUndefined();
    expect(resolveEngine(undefined)).toBeUndefined();
    expect(engine('postgresql').serverType).toBe('postgres');
  });

  it('cada motor define un tipo para cada concepto y ese tipo existe en su catálogo', () => {
    for (const e of listEngines()) {
      for (const concept of TYPE_CONCEPTS) {
        const type = e.concepts[concept];
        expect(type, `${e.id}.${concept}`).toBeTruthy();
        expect(isKnownType(e, type), `${e.id}.${concept} = ${type}`).toBe(true);
      }
      expect(e.types.length).toBeGreaterThan(8);
    }
  });

  it('es extensible: un motor registrado se resuelve, valida tipos y sustituye al anterior', () => {
    registerEngine({
      id: 'duckdb',
      label: 'DuckDB',
      family: 'sql',
      ddl: 'sql',
      aliases: ['duck'],
      types: ['integer', 'varchar', 'hugeint'],
      concepts: Object.fromEntries(TYPE_CONCEPTS.map((c) => [c, 'varchar'])) as never,
      sql: { quote: ['"', '"'] },
    });
    expect(resolveEngine('duck')?.label).toBe('DuckDB');
    expect(listEngines().map((e) => e.id)).toContain('duckdb');
    expect(checkType(engine('duckdb'), 'hugeint')).toEqual({ ok: true });
    expect(checkType(engine('duckdb'), 'jsonb')).toEqual({ ok: false, unknown: 'jsonb' });
    registerEngine({ ...engine('duckdb'), label: 'DuckDB 1.x' });
    expect(listEngines().filter((e) => e.id === 'duckdb')).toHaveLength(1);
    expect(resolveEngine('duckdb')?.label).toBe('DuckDB 1.x');
  });
});

describe('catálogo de tipos', () => {
  it('descompone parámetros, modificadores, listas y tipos anidados', () => {
    expect(parseType('VARCHAR(255)').base).toBe('varchar');
    expect(parseType('timestamp(3) with time zone').base).toBe('timestamp with time zone');
    expect(parseType('int(11) unsigned').base).toBe('int');
    expect(parseType('text[]')).toMatchObject({ base: 'text', array: true });
    expect(parseType('map<text, list<int>>')).toEqual({ base: 'map', inner: ['text', 'list<int>'], array: false });
  });

  it('valida contra el motor: lo que es de otro motor no existe', () => {
    const pg = engine('postgresql');
    for (const ok of ['varchar(255)', 'character varying(20)', 'timestamp(3) with time zone', 'text[]', 'jsonb', 'UUID', 'double precision']) expect(isKnownType(pg, ok), ok).toBe(true);
    for (const bad of ['varchar2(10)', 'nvarchar', 'datetime', 'string']) expect(isKnownType(pg, bad), bad).toBe(false);
    expect(isKnownType(engine('oracle'), 'varchar2(10 char)')).toBe(true);
    expect(isKnownType(engine('mysql'), 'int(11) unsigned')).toBe(true);
    expect(isKnownType(engine('sqlserver'), 'nvarchar(max)')).toBe(true);
    expect(isKnownType(engine('bigquery'), 'STRUCT<a INT64, b STRING>')).toBe(true);
    expect(isKnownType(engine('bigquery'), 'ARRAY<STRUCT<a INT64, b TEXT>>')).toBe(false);
    expect(isKnownType(engine('cassandra'), 'frozen<list<text>>')).toBe(true);
    expect(checkType(engine('cassandra'), 'map<text, entero>')).toEqual({ ok: false, unknown: 'entero' });
    expect(isKnownType(engine('mongodb'), 'objectId')).toBe(true);
    expect(isKnownType(engine('dynamodb'), 'SS')).toBe(true);
    expect(isKnownType(engine('kafka'), 'timestamp-millis')).toBe(true);
  });

  it('reduce un tipo a su concepto y propone el equivalente del motor', () => {
    expect(['varchar2(30)', 'uuid', 'int8', 'numeric(10,2)', 'timestamp with time zone', 'datetime2', 'bytea', 'clob', 'jsonb', 'bool'].map(conceptOf)).toEqual(['string', 'uuid', 'bigint', 'decimal', 'timestamptz', 'timestamp', 'binary', 'text', 'json', 'boolean']);
    expect(suggestTypes(engine('postgresql'), 'varchar2')[0]).toBe('varchar(255)');
    expect(suggestTypes(engine('postgresql'), 'varchar2')).toEqual(['varchar(255)', 'char']);
    expect(suggestTypes(engine('oracle'), 'text')[0]).toBe('clob');
    expect(suggestTypes(engine('sqlserver'), 'uuid')[0]).toBe('uniqueidentifier');
    expect(suggestTypes(engine('postgresql'), 'timestmp')).toContain('timestamp');
  });

  it('añade los parámetros que un tipo necesita y sustituye el que el motor no tiene', () => {
    expect(typeFor(engine('mysql'), 'varchar')).toEqual({ type: 'varchar(255)', replaced: false });
    expect(typeFor(engine('mysql'), 'numeric')).toEqual({ type: 'numeric(18,2)', replaced: false });
    expect(typeFor(engine('mysql'), 'varchar(40)')).toEqual({ type: 'varchar(40)', replaced: false });
    expect(typeFor(engine('postgresql'), 'numeric')).toEqual({ type: 'numeric', replaced: false });
    expect(typeFor(engine('oracle'), 'uuid')).toEqual({ type: 'raw(16)', replaced: true });
    expect(typeFor(engine('postgresql'), undefined)).toEqual({ type: 'varchar(255)', replaced: false });
  });
});

describe('motor de un activo', () => {
  it('el activo lo declara y lo heredan los que cuelgan de él', () => {
    const { engineOf } = inheritance(doc);
    expect(engineOf('erp')).toBe('postgresql');
    expect(engineOf('erp-pedidos')).toBe('postgresql');
    expect(engineOf('dwh-fact-ventas')).toBe('snowflake');
    expect(engineOf('bronze-pedidos')).toBeUndefined();
    expect(engineOf('nada')).toBeUndefined();
  });

  it('el esquema acepta cualquier texto (el registro es extensible) y el JSON Schema lo documenta', () => {
    expect(parse({ assets: [{ id: 'a', kind: 'database', name: 'A', engine: 'motor-propio' }] }).assets[0].engine).toBe('motor-propio');
    const schema = dataJsonSchema() as { properties: { assets: { items: { properties: { engine: { type: string; description: string } } } } } };
    expect(schema.properties.assets.items.properties.engine.type).toBe('string');
    expect(schema.properties.assets.items.properties.engine.description).toContain('postgresql');
  });

  it('el panel de propiedades lo ofrece solo en bases, almacenes, lagos, fuentes y streams, y lo guarda', () => {
    const has = (kind: string) => dataEditor.fields({ type: 'node', kind }, doc).some((f) => f.key === 'engine');
    expect(['database', 'warehouse', 'lake', 'source', 'stream'].map(has)).toEqual([true, true, true, true, true]);
    expect(['table', 'report', 'model'].map(has)).toEqual([false, false, false]);
    const field = dataEditor.fields({ type: 'node', kind: 'lake' }, doc).find((f) => f.key === 'engine');
    expect(field).toMatchObject({ type: 'select', allowEmpty: true });
    expect((field as { options: Array<{ value: string }> }).options.map((o) => o.value)).toEqual(expect.arrayContaining(BUILTIN_ENGINE_IDS as string[]));
    const r = dataEditor.update(doc, 'lake', { engine: 'databricks' });
    expect(r.ok && r.document.assets.find((a) => a.id === 'lake')?.engine).toBe('databricks');
    const cleared = dataEditor.update(doc, 'dwh', { engine: '' });
    expect(cleared.ok && cleared.document.assets.find((a) => a.id === 'dwh')).not.toHaveProperty('engine');
  });
});

describe('avisos del modelo por motor', () => {
  const messages = (d: DataDocument) => analyzeData(d).map((i) => i.message);

  it('sin motores no hay avisos nuevos', () => {
    expect(messages(parse({ ...(example as object), assets: doc.assets.map(({ engine: _e, ...a }) => a) }))).toEqual([]);
    expect(analyzeData(doc)).toEqual([]);
  });

  it('un tipo de columna que el motor no tiene se avisa con el equivalente', () => {
    const d = parse({
      assets: [
        { id: 'db', kind: 'database', name: 'Base', engine: 'postgresql', owner: 'x' },
        { id: 't', kind: 'table', name: 'T', parentId: 'db', columns: [{ name: 'a', type: 'varchar2(10)' }, { name: 'b', type: 'uuid' }, { name: 'c' }] },
      ],
    });
    const issues = analyzeData(d).filter((i) => i.elementId === 't' && /tipo/.test(i.message));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'warning' });
    expect(issues[0].message).toContain('La columna «a» de Tabla «T» declara el tipo «varchar2(10)», que no existe en PostgreSQL. ¿Quisiste decir «varchar(255)»');
  });

  describe('clave primaria de un tipo que el motor no admite como clave', () => {
    const mysql = (columns: unknown[], engine = 'mysql', kind = 'table') =>
      parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine, owner: 'x' }, { id: 't', kind, name: 'Líneas', parentId: 'db', columns }] });
    const keyIssues = (d: DataDocument) => analyzeData(d).filter((i) => i.elementId === 't' && /clave/.test(i.message));

    it('una clave primaria text, blob o json en MySQL es un aviso accionable, no un error', () => {
      for (const type of ['text', 'TEXT', 'longtext', 'tinytext', 'blob', 'mediumblob', 'json']) {
        const found = keyIssues(mysql([{ name: 'sku', type, keys: ['pk'] }]));
        expect(found, type).toHaveLength(1);
        expect(found[0].severity).toBe('warning');
        expect(found[0].message).toBe(`La columna «sku» de Tabla «Líneas» es clave primaria de tipo «${type}», que MySQL no admite como clave: su CREATE TABLE falla. Usa varchar(n) o una clave sustituta.`);
      }
    });

    it('MariaDB es un alias de MySQL y se avisa igual; una clave compuesta avisa de cada columna afectada', () => {
      expect(keyIssues(mysql([{ name: 'sku', type: 'text', keys: ['pk'] }], 'mariadb'))).toHaveLength(1);
      const compuesta = keyIssues(mysql([{ name: 'pedido_id', type: 'bigint', keys: ['pk', 'fk'] }, { name: 'sku', type: 'text', keys: ['pk'] }, { name: 'extra', type: 'json', keys: ['pk'] }]));
      expect(compuesta.map((i) => i.message.match(/«(\w+)»/)![1])).toEqual(['sku', 'extra']);
    });

    it('el tipo que se escribiría en MySQL también cuenta: jsonb no existe y se sustituye por json', () => {
      const found = keyIssues(mysql([{ name: 'doc', type: 'jsonb', keys: ['pk'] }]));
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('de tipo «json»');
    });

    it('no avisa si el tipo sirve de clave, si la columna no es clave, si el motor lo admite o si no es una tabla', () => {
      expect(keyIssues(mysql([{ name: 'sku', type: 'varchar(40)', keys: ['pk'] }, { name: 'id', type: 'char(36)', keys: ['pk'] }, { name: 'n', type: 'bigint', keys: ['pk'] }])).length).toBe(0);
      expect(keyIssues(mysql([{ name: 'sku', type: 'varchar', keys: ['pk'] }, { name: 'sin tipo', keys: ['pk'] }, { name: 'notas', type: 'text' }, { name: 'ref', type: 'text', keys: ['fk'] }])).length).toBe(0);
      expect(keyIssues(mysql([{ name: 'sku', type: 'text', keys: ['pk'] }], 'postgresql')).length).toBe(0);
      expect(keyIssues(mysql([{ name: 'sku', type: 'text', keys: ['pk'] }], 'mongodb')).length).toBe(0);
      expect(keyIssues(mysql([{ name: 'sku', type: 'text', keys: ['pk'] }], 'mysql', 'view')).length).toBe(0);
      // Sin motor declarado no se evalúa nada: un documento sin motores no recibe avisos nuevos.
      expect(keyIssues(parse({ assets: [{ id: 't', kind: 'table', name: 'Líneas', columns: [{ name: 'sku', type: 'text', keys: ['pk'] }] }] }))).toEqual([]);
    });

    it('un motor registrado por el usuario declara sus propios tipos que no admite como clave', () => {
      registerEngine({ ...engine('sqlite'), id: 'motor-clave', label: 'Motor de prueba', aliases: [], lenient: false, types: ['varchar', 'blobby'], concepts: Object.fromEntries(TYPE_CONCEPTS.map((c) => [c, 'varchar'])) as never, sql: { quote: ['"', '"'], noKeyTypes: ['blobby'] } });
      const found = keyIssues(mysql([{ name: 'k', type: 'blobby', keys: ['pk'] }], 'motor-clave'));
      expect(found[0].message).toContain('que Motor de prueba no admite como clave');
    });
  });

  it('SQLite acepta cualquier nombre de tipo: una nota, no un aviso', () => {
    const d = parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'sqlite', owner: 'x' }, { id: 't', kind: 'table', name: 'T', parentId: 'db', columns: [{ name: 'a', type: 'raro' }] }] });
    expect(analyzeData(d).find((i) => /raro/.test(i.message))?.severity).toBe('info');
  });

  it('un motor que no está en el registro se avisa', () => {
    const d = parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'db2', owner: 'x' }] });
    expect(messages(d).join('\n')).toMatch(/El motor «db2» de Base de datos «B» no está en el registro \(postgresql, mysql/);
  });

  it('un contrato que declara otro servidor que el del activo se avisa', () => {
    const d = parse({
      assets: [
        { id: 'db', kind: 'database', name: 'B', engine: 'mysql', owner: 'x' },
        { id: 't', kind: 'table', name: 'T', parentId: 'db', contractId: 'c' },
      ],
      contracts: [{ id: 'c', name: 'Contrato T', format: 'odcs', content: 'servers:\n  - server: prod\n    type: postgres\n' }],
    });
    expect(messages(d).filter((m) => /contrato/i.test(m))).toEqual(['El contrato «Contrato T» declara el servidor PostgreSQL pero Tabla «T» está en MySQL.']);
  });
});

describe('contrato de datos con servidor', () => {
  const contract = (servers: string, type = 'varchar2(10)'): string =>
    `apiVersion: v3.0.2\nkind: DataContract\nid: c\nname: C\nversion: 1.0.0\nstatus: draft\nteam:\n  name: x\n${servers}schema:\n  - name: clientes\n    properties:\n      - name: id\n        physicalType: uuid\n        primaryKey: true\n      - name: nombre\n        physicalType: ${type}\n`;
  const warnings = (text: string, options = {}) => checkContract(text, options).filter((d) => d.severity !== 'info');

  it('el borrador desde un activo declara su servidor con el nombre del estándar', () => {
    const text = contractFromAsset(doc, doc.assets.find((a) => a.id === 'erp-pedidos')!, 'Contrato de pedidos');
    expect(text).toMatch(/servers:\n {2}- server: erp\n {4}type: postgres\n/);
    expect(contractEngine(text)?.id).toBe('postgresql');
    expect(checkContract(text).filter((d) => d.severity !== 'info')).toEqual([]);
    const snowflake = contractFromAsset(doc, doc.assets.find((a) => a.id === 'dwh-dim-cliente')!, 'Contrato');
    expect(snowflake).toMatch(/type: snowflake/);
    expect(contractFromAsset(doc, doc.assets.find((a) => a.id === 'crm-clientes')!, 'Contrato')).not.toContain('servers');
  });

  it('valida los tipos físicos contra el catálogo del motor, con línea y columna', () => {
    const text = contract('servers:\n  - server: prod\n    type: postgres\n');
    const found = warnings(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', line: 19, column: 9 });
    expect(found[0].message).toContain('El tipo «varchar2(10)» de «clientes.nombre» no existe en PostgreSQL (según servers[0].type)');
    expect(found[0].message).toContain('¿Quisiste decir «varchar(255)»');
    expect(text.split('\n')[18]).toContain('physicalType: varchar2(10)');
    // El mismo contrato es válido para Oracle (varchar2) pero ahí falla uuid.
    const oracle = warnings(contract('servers:\n  - server: prod\n    type: oracle\n'));
    expect(oracle.map((d) => d.message)).toEqual([expect.stringContaining('«uuid» de «clientes.id» no existe en Oracle')]);
    expect(oracle[0].message).toContain('«raw(16)»');
  });

  it('entiende el servidor de la forma antigua (server.type) y por alias', () => {
    expect(warnings(contract('server:\n  type: postgresql\n'))).toHaveLength(1);
    expect(warnings(contract('server:\n  produccion:\n    type: mssql\n'))[0].message).toContain('no existe en SQL Server');
    expect(warnings(contract('servers:\n  - type: mongo\n    server: m\n', 'varchar(5)'))[0].message).toContain('no existe en MongoDB');
  });

  it('sin servidor no se validan los tipos, salvo con el motor del activo que lo usa', () => {
    const none = contract('');
    expect(warnings(none)).toEqual([]);
    expect(warnings(none, { engine: 'postgresql' })).toHaveLength(1);
    expect(warnings(none, { engine: 'postgresql' })[0].message).toContain('el del activo que usa el contrato');
    // Si el contrato declara servidor, manda el suyo.
    expect(warnings(contract('servers:\n  - server: p\n    type: oracle\n'), { engine: 'postgresql' }).map((d) => d.message).join()).not.toMatch(/PostgreSQL/);
  });

  it('un servidor que no está en el registro es una nota y no bloquea nada', () => {
    const notes = checkContract(contract('servers:\n  - server: x\n    type: clickhouse\n'));
    expect(notes.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(notes.find((d) => /clickhouse/.test(d.message))).toMatchObject({ severity: 'info', line: 11 });
  });

  it('SQLite avisa como nota', () => {
    const found = checkContract(contract('servers:\n  - server: l\n    type: sqlite\n', 'raro')).filter((d) => /raro/.test(d.message));
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('info');
  });

  it('el editor valida con el servidor del contrato o el motor del activo y sugiere los tipos', () => {
    const at = contractAttachments;
    const made = at.createFor!(parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'postgresql', owner: 'x' }, { id: 't', kind: 'table', name: 'T', parentId: 'db', columns: [{ name: 'a', type: 'text' }] }] }), 't');
    if (!made.ok) throw new Error(made.reason);
    const detail = at.read(made.document, made.id!)!;
    expect(detail.text).toContain('type: postgres');
    expect(at.suggestions?.(made.document, made.id!, detail.text)).toMatchObject({ title: 'Tipos de PostgreSQL', items: expect.arrayContaining(['uuid', 'jsonb', 'timestamp with time zone']) });
    // Sin servidor en el texto, vale el motor del activo que lo usa (el contexto de `check`).
    const bare = detail.text.replace(/servers:\n( {2}.*\n)+/, '').replace('physicalType: text', 'physicalType: varchar2(5)');
    expect(bare).not.toContain('servers');
    expect(at.check('odcs', bare).filter((d) => d.severity !== 'info')).toEqual([]);
    expect(at.check('odcs', bare, { document: made.document, id: made.id! }).filter((d) => d.severity === 'warning')).toHaveLength(1);
    expect(at.suggestions?.(made.document, made.id!, bare)?.title).toBe('Tipos de PostgreSQL');
    const orphan = at.add(doc, 'odcs', 'Suelto');
    if (!orphan.ok) throw new Error(orphan.reason);
    expect(at.suggestions?.(orphan.document, orphan.id!, at.read(orphan.document, orphan.id!)!.text)).toBeUndefined();
  });

  it('las tablas del contrato salen para el DDL', () => {
    const tables = contractTables(contract('', 'varchar(5)'));
    expect(tables).toEqual([
      {
        name: 'clientes',
        columns: [
          { name: 'id', type: 'uuid', primaryKey: true, unique: false, required: true, pii: false },
          { name: 'nombre', type: 'varchar(5)', primaryKey: false, unique: false, required: false, pii: false },
        ],
      },
    ]);
    expect(contractTables('a: [1')).toEqual([]);
  });
});

describe('DDL por motor', () => {
  it('PostgreSQL: CREATE TABLE con la clave compuesta y los datos personales marcados', () => {
    const { text, warnings } = toDdl(doc, { assetId: 'erp' });
    expect(warnings).toEqual([]);
    expect(text).toBe(
      [
        '-- pedidos · ERP de pedidos',
        'CREATE TABLE pedidos (',
        '    id bigint NOT NULL,',
        '    cliente_id uuid NOT NULL,',
        '    fecha date NOT NULL,',
        '    total numeric NOT NULL,',
        '    PRIMARY KEY (id)',
        ');',
        '',
        '-- líneas de pedido · ERP de pedidos',
        'CREATE TABLE lineas_de_pedido (',
        '    pedido_id bigint NOT NULL,',
        '    producto text NOT NULL,',
        '    cantidad int NOT NULL,',
        '    precio numeric NOT NULL,',
        '    PRIMARY KEY (pedido_id, producto)',
        ');',
        '',
      ].join('\n'),
    );
    expect(toDdl(doc, { assetId: 'crm-clientes', schema: 'crm' }).text).toContain('CREATE TABLE crm.clientes (');
    expect(toDdl(doc, { assetId: 'crm-clientes', schema: 'crm' }).text).toContain('nombre text NOT NULL, -- PII');
  });

  it('sin indicar nada, cada tabla va en el dialecto de su motor y las que no lo declaran en PostgreSQL con un aviso', () => {
    const { text, warnings } = toDdl(doc);
    expect(text).toMatch(/^-- PostgreSQL\n/);
    expect(text).toContain('-- Snowflake\n');
    expect(text).toContain('CREATE TABLE dim_cliente (');
    expect(text).toContain('CREATE TABLE bronce_clientes (');
    expect(warnings).toEqual([expect.stringMatching(/^Sin motor declarado \(engine\) en «clientes», «bronce: clientes».*se usa PostgreSQL\.$/)]);
  });

  it('MySQL: comillas invertidas donde hacen falta, longitudes y precisión por defecto', () => {
    const d = parse({
      assets: [
        { id: 'db', kind: 'database', name: 'B', engine: 'mysql' },
        {
          id: 't',
          kind: 'table',
          name: 'Pedido de venta',
          parentId: 'db',
          columns: [
            { name: 'id', type: 'bigint', keys: ['pk'] },
            { name: 'order', type: 'varchar' },
            { name: 'total precio', type: 'numeric', nullable: true },
            { name: 'email', type: 'varchar(80)', keys: ['uk'], description: 'Correo\nde contacto' },
          ],
        },
      ],
    });
    const { text, warnings } = toDdl(d);
    expect(warnings).toEqual([]);
    expect(text).toContain('CREATE TABLE pedido_de_venta (');
    expect(text).toContain('    `order` varchar(255) NOT NULL,');
    expect(text).toContain('    `total precio` numeric(18,2),');
    expect(text).toContain('    email varchar(80) NOT NULL UNIQUE, -- Correo de contacto');
  });

  describe('clave primaria de un tipo que el motor no admite como clave', () => {
    const aviso = 'La clave primaria «líneas de pedido.producto» es de tipo «text», que MySQL no admite como clave: su CREATE TABLE falla. Usa varchar(n) o una clave sustituta.';

    it('MySQL: el DDL no cambia, pero avisa en un comentario sobre la tabla y en los avisos', () => {
      const { text, warnings } = toDdl(doc, { assetId: 'erp-lineas', engine: 'mysql' });
      expect(warnings).toEqual([aviso]);
      expect(text).toBe(
        [
          '-- líneas de pedido · ERP de pedidos',
          `-- AVISO: ${aviso}`,
          'CREATE TABLE lineas_de_pedido (',
          '    pedido_id bigint NOT NULL,',
          '    producto text NOT NULL,',
          '    cantidad int NOT NULL,',
          '    precio numeric(18,2) NOT NULL,',
          '    PRIMARY KEY (pedido_id, producto)',
          ');',
          '',
        ].join('\n'),
      );
    });

    it('solo la tabla afectada lleva el comentario, y no lo lleva el mismo documento en otro motor', () => {
      const all = toDdl(doc, { assetId: 'erp', engine: 'mysql' }).text;
      expect(all.match(/-- AVISO:/g)).toHaveLength(1);
      expect(all.indexOf('-- AVISO:')).toBeGreaterThan(all.indexOf('-- líneas de pedido'));
      expect(toDdl(doc, { assetId: 'erp' }).text).not.toContain('AVISO');
      expect(toDdl(doc, { assetId: 'erp', engine: 'oracle' }).text).not.toContain('AVISO');
      // Con el motor declarado en el activo, sin forzarlo.
      const declared = parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'mariadb' }, { id: 't', kind: 'table', name: 'Archivo', parentId: 'db', columns: [{ name: 'contenido', type: 'longblob', keys: ['pk'] }] }] });
      expect(toDdl(declared).text).toMatch(/^-- Archivo · B\n-- AVISO: La clave primaria «Archivo\.contenido» es de tipo «longblob», que MySQL no admite como clave/);
    });

    it('un tipo lógico de un contrato que acaba en text o json también avisa; uno que acaba en varchar, no', () => {
      const contrato = (props: string) => parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'mysql' }, { id: 't', kind: 'table', name: 'T', parentId: 'db', contractId: 'c' }], contracts: [{ id: 'c', name: 'C', format: 'odcs', content: `schema:\n  - name: clientes\n    properties:\n${props}` }] });
      const bad = toDdl(contrato('      - name: ref\n        physicalType: text\n        primaryKey: true\n'), { contractId: 'c' });
      expect(bad.text).toContain('-- AVISO: La clave primaria «clientes.ref» es de tipo «text»');
      expect(bad.warnings).toHaveLength(1);
      const ok = toDdl(contrato('      - name: ref\n        logicalType: string\n        primaryKey: true\n'), { contractId: 'c' });
      expect(ok.text).not.toContain('AVISO');
      expect(ok.warnings).toEqual([]);
    });

    it('un nombre con saltos de línea no rompe el comentario', () => {
      const d = parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'mysql' }, { id: 't', kind: 'table', name: 'T', parentId: 'db', columns: [{ name: 'a\nb', type: 'text', keys: ['pk'] }] }] });
      const lines = toDdl(d).text.split('\n').filter((l) => l.includes('AVISO'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('«T.a b»');
    });
  });

  it('traduce el tipo que el motor no tiene y lo avisa', () => {
    const { text, warnings } = toDdl(doc, { assetId: 'erp', engine: 'oracle' });
    expect(text).toContain('id number(19) NOT NULL,');
    expect(text).toContain('cliente_id raw(16) NOT NULL,');
    expect(text).toContain('producto clob NOT NULL,');
    expect(text).toContain('total numeric(18,2) NOT NULL,');
    expect(warnings).toEqual(expect.arrayContaining(['El tipo «uuid» de «pedidos.cliente_id» no existe en Oracle: se usa «raw(16)».']));
    const bq = toDdl(doc, { assetId: 'erp-lineas', engine: 'bigquery' });
    expect(bq.text).toContain('PRIMARY KEY (pedido_id, producto) NOT ENFORCED');
    const sqlserver = toDdl(doc, { assetId: 'erp-pedidos', engine: 'sqlserver' });
    expect(sqlserver.text).toContain('cliente_id uniqueidentifier NOT NULL,');
  });

  it('MongoDB: validador $jsonSchema, índices únicos y esquema JSON suelto', () => {
    const { text } = toDdl(doc, { assetId: 'erp-lineas', engine: 'mongodb' });
    expect(text).toContain('db.createCollection("lineas_de_pedido", {');
    expect(text).toContain('"bsonType": "object"');
    expect(text).toContain('"required": [\n        "pedido_id",\n        "producto",\n        "cantidad",\n        "precio"\n      ]');
    expect(text).toContain('"pedido_id": {\n          "bsonType": "long"\n        }');
    expect(text).toContain('db.getCollection("lineas_de_pedido").createIndex({ "pedido_id": 1, "producto": 1 }, { unique: true });');
    const json = JSON.parse(toDdl(doc, { assetId: 'erp-pedidos', engine: 'mongodb', format: 'json' }).text) as Record<string, { $jsonSchema: { properties: Record<string, { bsonType: string }> } }>;
    expect(Object.keys(json)).toEqual(['pedidos']);
    expect(json.pedidos.$jsonSchema.properties.total.bsonType).toBe('decimal');
  });

  it('Cassandra, DynamoDB y Kafka tienen su forma propia', () => {
    expect(toDdl(doc, { assetId: 'erp-lineas', engine: 'cassandra', schema: 'ventas' }).text).toContain('PRIMARY KEY ((pedido_id), producto)');
    const dynamo = JSON.parse(toDdl(doc, { assetId: 'erp-lineas', engine: 'dynamodb' }).text) as { KeySchema: Array<{ KeyType: string }>; AttributeDefinitions: Array<{ AttributeType: string }> };
    expect(dynamo.KeySchema.map((k) => k.KeyType)).toEqual(['HASH', 'RANGE']);
    expect(dynamo.AttributeDefinitions.map((a) => a.AttributeType)).toEqual(['N', 'S']);
    const avro = JSON.parse(toDdl(parse({ assets: [{ id: 's', kind: 'stream', name: 'Pedidos creados', engine: 'kafka', columns: [{ name: 'id', type: 'long', keys: ['pk'] }, { name: 'nota', type: 'string', nullable: true }, { name: 'cuando', type: 'timestamp-millis' }] }] })).text) as {
      name: string;
      fields: Array<{ name: string; type: unknown; default?: null }>;
    };
    expect(avro.name).toBe('pedidos_creados');
    expect(avro.fields).toEqual([
      { name: 'id', type: 'long' },
      { name: 'nota', type: ['null', 'string'], default: null },
      { name: 'cuando', type: { type: 'long', logicalType: 'timestamp-millis' } },
    ]);
  });

  it('desde un contrato: su servidor fija el dialecto y su schema las tablas', () => {
    const d = parse({
      assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'mysql' }, { id: 't', kind: 'table', name: 'T', parentId: 'db', contractId: 'c' }],
      contracts: [
        {
          id: 'c',
          name: 'Contrato',
          format: 'odcs',
          content: 'servers:\n  - server: p\n    type: snowflake\nschema:\n  - name: clientes\n    properties:\n      - name: id\n        logicalType: integer\n        primaryKey: true\n      - name: nombre\n        logicalType: string\n      - name: alta\n        physicalType: timestamp_ntz\n        required: true\n',
        },
      ],
    });
    const { text, warnings } = toDdl(d, { contractId: 'c' });
    expect(warnings).toEqual([]);
    expect(text).toContain('-- clientes · contrato «Contrato»');
    expect(text).toContain('    id integer NOT NULL,\n    nombre string,\n    alta timestamp_ntz NOT NULL,');
    // Sin servidor en el contrato, vale el motor del activo que lo usa; --engine manda sobre ambos.
    const sinServidor = { ...d, contracts: [{ ...d.contracts![0], content: d.contracts![0].content!.replace(/servers:\n( {2}.*\n)+/, '') }] };
    expect(toDdl(sinServidor, { contractId: 'c' }).text).toContain('    nombre varchar(255),');
    expect(toDdl(d, { contractId: 'c', engine: 'bigquery' }).text).toContain('nombre string,');
  });

  it('avisa de lo que no puede hacer y falla con peticiones imposibles', () => {
    expect(() => toDdl(doc, { engine: 'access' })).toThrow(/Motor desconocido «access»\. Motores: postgresql/);
    expect(() => toDdl(doc, { assetId: 'nada' })).toThrow(/No existe el activo «nada»/);
    expect(() => toDdl(doc, { contractId: 'nada' })).toThrow(/No existe el contrato «nada»/);
    expect(toDdl(doc, { assetId: 'panel-ventas' }).warnings).toEqual(['«Panel de ventas» no contiene tablas con columnas.']);
    expect(toDdl(parse({ assets: [{ id: 'v', kind: 'view', name: 'V', columns: [{ name: 'a' }] }] }), { assetId: 'v' }).warnings[0]).toMatch(/es una vista/);
    const unregistered = parse({ assets: [{ id: 'db', kind: 'database', name: 'B', engine: 'db2' }, { id: 't', kind: 'table', name: 'T', parentId: 'db', columns: [{ name: 'a', type: 'int' }] }] });
    expect(toDdl(unregistered).warnings[0]).toMatch(/El motor «db2» de «T» no está en el registro/);
    expect(toDdl(parse({ assets: [{ id: 't', kind: 'table', name: 'T', columns: [{ name: 'a' }] }] }), { engine: 'cassandra' }).warnings.join('\n')).toMatch(/Cassandra la exige/);
    expect(toDdl(parse({})).text).toBe('');
  });

  it('BigQuery y Databricks no admiten UNIQUE y lo avisan', () => {
    const d = parse({ assets: [{ id: 't', kind: 'table', name: 'T', columns: [{ name: 'a', type: 'int', keys: ['pk'] }, { name: 'b', type: 'string', keys: ['uk'] }] }] });
    const { text, warnings } = toDdl(d, { engine: 'databricks' });
    expect(text).toContain(') USING DELTA;');
    expect(text).not.toContain('UNIQUE');
    expect(warnings).toContain('Databricks no admite UNIQUE: se omite en «T».');
  });
});

describe('módulo: exportador y comandos', () => {
  const run = (name: string, args: string[], input: unknown, options: Record<string, unknown> = {}) => {
    const warnings: string[] = [];
    const out = dataCommands.find((c) => c.name === name)!.run({ args, options, input: JSON.stringify(input), warn: (m) => warnings.push(m) }) as string;
    return { out, warnings };
  };

  it('el DDL es un formato de exportación más', async () => {
    const exporter = dataModule.exporters.find((e) => e.id === 'ddl')!;
    expect(exporter).toMatchObject({ extension: '.sql', mime: 'text/plain' });
    expect(await exporter.export(doc, {})).toContain('CREATE TABLE pedidos (');
    expect(await exporter.export(doc, { options: { engine: 'mysql', schema: 'ventas' } })).toContain('CREATE TABLE ventas.pedidos (');
  });

  it('el exportador de DDL y iark data ddl llevan el aviso de la clave en el propio esquema', async () => {
    const exporter = dataModule.exporters.find((e) => e.id === 'ddl')!;
    const exported = (await exporter.export(doc, { options: { engine: 'mysql' } })) as string;
    expect(exported).toMatch(/-- líneas de pedido · ERP de pedidos\n-- AVISO: La clave primaria «líneas de pedido\.producto» es de tipo «text», que MySQL no admite como clave/);
    const { out, warnings } = run('ddl', [], example, { asset: 'erp-lineas', engine: 'mysql' });
    expect(out).toContain('-- AVISO: La clave primaria «líneas de pedido.producto»');
    expect(out).toContain('    producto text NOT NULL,');
    expect(warnings).toEqual(['aviso: La clave primaria «líneas de pedido.producto» es de tipo «text», que MySQL no admite como clave: su CREATE TABLE falla. Usa varchar(n) o una clave sustituta.']);
  });

  it('iark data ddl genera el esquema y deja los avisos aparte', () => {
    const { out, warnings } = run('ddl', [], example, { asset: 'erp-lineas', engine: 'oracle' });
    expect(out).toContain('CREATE TABLE lineas_de_pedido (');
    expect(warnings).toEqual(['aviso: El tipo «bigint» de «líneas de pedido.pedido_id» no existe en Oracle: se usa «number(19)».', 'aviso: El tipo «text» de «líneas de pedido.producto» no existe en Oracle: se usa «clob».']);
    expect(run('ddl', [], example, { asset: 'erp-pedidos', engine: 'mongodb', format: 'json' }).out).toContain('"$jsonSchema"');
    expect(run('ddl', [], { assets: [{ id: 'a', kind: 'source', name: 'A' }] }).out).toMatch(/^-- No hay tablas/);
    expect(() => run('ddl', [], example, { engine: 'access' })).toThrow(/Motor desconocido/);
    expect(() => run('ddl', [], example, { format: 'xml' })).toThrow(/Formato inválido/);
  });

  it('iark data engines lista los motores y el catálogo de uno', () => {
    const all = run('engines', [], undefined).out;
    expect(all).toContain('| postgresql | PostgreSQL | sql | postgres, pg, psql |');
    expect(all).toContain('| kafka | Apache Kafka | stream |');
    const one = run('engines', ['mongo'], undefined).out;
    expect(one).toContain('MongoDB (mongodb) · document');
    expect(one).toContain('objectId');
    expect(one).toContain('- decimal: decimal');
    expect(() => run('engines', ['access'], undefined)).toThrow(/Motor desconocido/);
  });

  it('el generado por IA sabe de motores', async () => {
    const ai = dataModule.ai!;
    expect(ai.system()).toContain('"postgresql", "mysql"');
    const schema = ai.generationJsonSchema() as { properties: { assets: { items: { properties: Record<string, unknown> } } } };
    expect(Object.keys(schema.properties.assets.items.properties)).toContain('engine');
    const refined = ai.toDocument({
      workspace: { name: 'X', description: null },
      domains: [],
      assets: [{ id: 'db', kind: 'database', name: 'B', description: null, technology: null, engine: 'mongodb', owner: null, steward: null, domainId: null, parentId: null, classification: null, pii: null, retention: null, external: null, columns: null }],
      pipelines: [],
      relations: [],
    });
    expect(refined.ok && (refined.document as DataDocument).assets[0].engine).toBe('mongodb');
  });
});
