import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectError } from '@iark/kernel';
import { projectStoreContract } from '../../tests/helpers/projectStoreContract';
import { FolderProjectStore, isWorkspaceId, MAX_DOCUMENT_BYTES, SIDECAR_FORMAT } from './workspace';

const made: string[] = [];
/** Una carpeta temporal nueva; se borra al terminar cada prueba. */
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iark-ws-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Un espacio de trabajo dentro de una carpeta temporal (la raíz es un hijo: lo de fuera del espacio se ve en el padre). */
function workspace(): { outside: string; root: string; store: FolderProjectStore } {
  const outside = tmp();
  const root = join(outside, 'espacio');
  mkdirSync(root);
  return { outside, root, store: new FolderProjectStore(root) };
}

const rejects = async (promise: Promise<unknown>, code: string): Promise<ProjectError> => {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProjectError);
  expect((error as ProjectError).code).toBe(code);
  return error as ProjectError;
};

const symlinkOrSkip = (target: string, path: string): boolean => {
  try {
    symlinkSync(target, path);
    return true;
  } catch {
    return false; // sin permiso para crear enlaces (Windows sin modo desarrollador)
  }
};

projectStoreContract('carpeta', async () => {
  const dir = tmp();
  return { store: new FolderProjectStore(join(dir, 'espacio')), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
});

describe('FolderProjectStore: disposición en disco', () => {
  it('crea un directorio con project.json por proyecto y un <id>.<módulo>.json por diagrama, sin dejar temporales', async () => {
    const { root, store } = workspace();
    const project = await store.createProject({ name: 'Tienda web', description: 'Pedidos y pagos' });
    expect(project.id).toBe('tienda-web');
    const text = JSON.stringify({ hola: 'mundo' }, null, 2);
    const diagram = await store.saveDiagram(project.id, { module: 'security', name: 'Amenazas de «Tienda»', text });
    expect(diagram.id).toBe('amenazas-de-tienda');

    expect(readdirSync(root)).toEqual(['tienda-web']);
    expect(readdirSync(join(root, 'tienda-web')).sort()).toEqual(['amenazas-de-tienda.security.json', 'project.json']);
    // el documento es el texto, byte a byte
    expect(readFileSync(join(root, 'tienda-web', 'amenazas-de-tienda.security.json'), 'utf8')).toBe(text);
    const sidecar = JSON.parse(readFileSync(join(root, 'tienda-web', 'project.json'), 'utf8'));
    expect(sidecar).toMatchObject({
      format: SIDECAR_FORMAT,
      name: 'Tienda web',
      description: 'Pedidos y pagos',
      diagrams: { 'amenazas-de-tienda': { name: 'Amenazas de «Tienda»' } },
    });
    expect(sidecar.diagrams['amenazas-de-tienda'].createdAt).toBe(diagram.createdAt);
    expect(Object.keys(sidecar)).toEqual(['format', 'name', 'description', 'createdAt', 'diagrams']);
  });

  it('el id sale del nombre sin tildes y se numera si está tomado; renombrar no mueve nada', async () => {
    const { root, store } = workspace();
    const a = await store.createProject({ name: 'Gestión Ñandú' });
    const b = await store.createProject({ name: 'Gestion nandu!' }); // otro nombre, mismo slug
    expect([a.id, b.id]).toEqual(['gestion-nandu', 'gestion-nandu-2']);
    const renamed = await store.renameProject(a.id, 'Otro nombre');
    expect(renamed).toMatchObject({ id: 'gestion-nandu', name: 'Otro nombre' });
    expect(readdirSync(root).sort()).toEqual(['gestion-nandu', 'gestion-nandu-2']);

    const d = await store.saveDiagram(a.id, { module: 'c4', name: 'Contexto', text: '{}' });
    const d2 = await store.renameDiagram(a.id, d.id, 'Visión general');
    expect(d2).toMatchObject({ id: 'contexto', name: 'Visión general', updatedAt: d.updatedAt });
    expect(readdirSync(join(root, a.id)).sort()).toEqual(['contexto.c4.json', 'project.json']);
    // los nombres se comparan sin distinguir mayúsculas ni tildes de normalización, y entre ids distintos
    await rejects(store.createProject({ name: 'OTRO NOMBRE' }), 'exists');
    const c = await store.saveDiagram(a.id, { module: 'data', name: 'Contexto', text: '{}' }); // el nombre `Contexto` quedó libre
    expect(c.id).toBe('contexto-2');
    expect((await store.getProject(a.id))!.diagrams.map((x) => x.name)).toEqual(['Contexto', 'Visión general']);
  });

  it('dos módulos para el mismo nombre no pisan el archivo del otro (el id no incluye el módulo)', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    await store.saveDiagram(p.id, { module: 'c4', name: 'Mapa', text: 'uno' });
    await store.renameDiagram(p.id, 'mapa', 'Mapa viejo');
    const second = await store.saveDiagram(p.id, { module: 'data', name: 'Mapa', text: 'dos' });
    expect(second.id).toBe('mapa-2');
    expect(readdirSync(join(root, p.id)).sort()).toEqual(['mapa-2.data.json', 'mapa.c4.json', 'project.json']);
  });

  it('no usa nombres que Windows reserva', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'con' });
    expect(p.id).toBe('con-2');
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'NUL', text: '{}' });
    expect(d.id).toBe('nul-2');
    expect(readdirSync(root)).toEqual(['con-2']);
  });

  it('las fechas: createdAt se conserva y updatedAt crece con cada guardado (aunque sea en el mismo milisegundo)', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'a' });
    let previous = d.updatedAt;
    for (const text of ['b', 'c', 'd', 'e']) {
      const next = await store.saveDiagram(p.id, { id: d.id, text });
      expect(next.updatedAt > previous).toBe(true);
      expect(next.createdAt).toBe(d.createdAt);
      previous = next.updatedAt;
    }
    const read = (await store.getDiagram(p.id, d.id))!;
    expect(read.updatedAt).toBe(previous);
    expect((await store.getProject(p.id))!.diagrams[0].updatedAt).toBe(previous);
    expect((await store.getProject(p.id))!.updatedAt >= previous).toBe(true);
  });

  it('listProjects en una raíz que no existe devuelve [] y createProject la crea', async () => {
    const dir = tmp();
    const store = new FolderProjectStore(join(dir, 'a', 'b', 'espacio'));
    expect(await store.listProjects()).toEqual([]);
    expect(await store.getProject('x')).toBeUndefined();
    await store.createProject({ name: 'Uno' });
    expect(readdirSync(join(dir, 'a', 'b', 'espacio'))).toEqual(['uno']);
  });

  it('si la raíz es un archivo, falla como `unavailable`', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'archivo'), 'x');
    const store = new FolderProjectStore(join(dir, 'archivo'));
    await rejects(store.listProjects(), 'unavailable');
    await rejects(store.createProject({ name: 'X' }), 'unavailable');
  });

  it('la descripción es opcional, se recorta y no puede ser enorme ni algo que no sea texto', async () => {
    const { store } = workspace();
    expect((await store.createProject({ name: 'A', description: '   ' })).description).toBeUndefined();
    expect((await store.createProject({ name: 'B', description: '  Pedidos  ' })).description).toBe('Pedidos');
    await rejects(store.createProject({ name: 'C', description: 'x'.repeat(5000) }), 'invalid');
    await rejects(store.createProject({ name: 'D', description: 42 as unknown as string }), 'invalid');
    expect((await store.listProjects()).map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('rechaza documentos que pasan del tamaño máximo', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    await rejects(store.saveDiagram(p.id, { module: 'c4', name: 'Enorme', text: 'x'.repeat(MAX_DOCUMENT_BYTES + 1) }), 'invalid');
    expect((await store.getProject(p.id))!.diagrams).toEqual([]);
  });
});

describe('FolderProjectStore: la carpeta es la fuente de verdad', () => {
  it('detecta proyectos y diagramas copiados a mano, aunque no estén en el sidecar', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'banca'));
    writeFileSync(join(root, 'banca', 'contexto.c4.json'), '{"a":1}');
    writeFileSync(join(root, 'banca', 'Ventas.v2.data.json'), '{"b":2}');
    const when = new Date('2025-03-04T05:06:07.123Z');
    utimesSync(join(root, 'banca', 'contexto.c4.json'), when, when);

    const [project] = await store.listProjects();
    expect(project).toMatchObject({ id: 'banca', name: 'banca' });
    expect(project.description).toBeUndefined();
    const [contexto, ventas] = project.diagrams;
    expect(ventas).toMatchObject({ id: 'Ventas.v2', module: 'data', name: 'Ventas.v2' });
    expect(contexto).toMatchObject({ id: 'contexto', module: 'c4', name: 'contexto', createdAt: '2025-03-04T05:06:07.123Z', updatedAt: '2025-03-04T05:06:07.123Z' });
    expect((await store.getDiagram('banca', 'contexto'))?.text).toBe('{"a":1}');
    expect(await store.getDiagram('banca', 'Ventas.v2')).toMatchObject({ module: 'data', text: '{"b":2}' });

    // se pueden renombrar y actualizar como cualquier otro; el sidecar se crea al escribir
    const updated = await store.saveDiagram('banca', { id: 'contexto', text: '{"a":2}' });
    expect(updated.createdAt).toBe('2025-03-04T05:06:07.123Z'); // la creación no sigue a la modificación
    expect(updated.updatedAt > '2025-03-04T05:06:07.123Z').toBe(true);
    await store.renameProject('banca', 'Banca móvil');
    await store.renameDiagram('banca', 'contexto', 'Contexto general');
    const after = (await store.getProject('banca'))!;
    expect(after.name).toBe('Banca móvil');
    expect(after.diagrams.map((d) => d.name)).toEqual(['Contexto general', 'Ventas.v2']);
    expect(readdirSync(join(root, 'banca')).sort()).toEqual(['Ventas.v2.data.json', 'contexto.c4.json', 'project.json']);
  });

  it('un archivo borrado a mano desaparece de la lista y su entrada del sidecar se poda al escribir', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    await store.saveDiagram(p.id, { module: 'c4', name: 'Uno', text: '1' });
    await store.saveDiagram(p.id, { module: 'c4', name: 'Dos', text: '2' });
    rmSync(join(root, p.id, 'uno.c4.json'));
    expect((await store.getProject(p.id))!.diagrams.map((d) => d.name)).toEqual(['Dos']);
    await store.saveDiagram(p.id, { module: 'c4', name: 'Tres', text: '3' });
    expect(Object.keys(JSON.parse(readFileSync(join(root, p.id, 'project.json'), 'utf8')).diagrams).sort()).toEqual(['dos', 'tres']);
    // y un nombre que quedó libre se puede volver a usar
    expect((await store.saveDiagram(p.id, { module: 'c4', name: 'Uno', text: '1b' })).id).toBe('uno');
  });

  it('ignora sin fallar lo que no encaja: otros archivos, ocultos, node_modules, ids o módulos inválidos, directorios con nombre de diagrama', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'p'));
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, '.algo'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'con sustancia')); // un nombre que no es un id válido
    mkdirSync(join(root, 'aux')); // reservado en Windows
    writeFileSync(join(root, 'suelto.c4.json'), '{}'); // un archivo en la raíz no es un proyecto
    writeFileSync(join(root, '.git', 'x.c4.json'), '{}');
    for (const name of [
      'ok.c4.json',
      'sin-modulo.json',
      'notas.txt',
      'otro.c4.json.bak',
      '.oculto.c4.json',
      'MAYUS.C4.json', // el módulo va en minúsculas
      'con espacio.c4.json',
      'acentuación.c4.json',
      '1.2.json',
      'proyecto.iark-project.json', // el archivo único de un proyecto exportado a su carpeta no es un diagrama
      '.ok.c4.json.123.tmp',
    ]) {
      writeFileSync(join(root, 'p', name), '{}');
    }
    mkdirSync(join(root, 'p', 'directorio.c4.json')); // un directorio con forma de diagrama
    mkdirSync(join(root, 'p', 'subcarpeta'));
    writeFileSync(join(root, 'p', 'subcarpeta', 'hondo.c4.json'), '{}'); // no se baja a subcarpetas

    const projects = await store.listProjects();
    expect(projects.map((x) => x.id)).toEqual(['p']);
    expect(projects[0].diagrams.map((d) => d.id)).toEqual(['ok']);
    expect(await store.getProject('.git')).toBeUndefined();
    expect(await store.getProject('node_modules')).toBeUndefined();
    expect(await store.getProject('suelto.c4.json')).toBeUndefined();
    expect(await store.getDiagram('p', 'directorio')).toBeUndefined();
    // crear con un nombre que choca con una entrada ignorada no la toca
    expect((await store.saveDiagram('p', { module: 'c4', name: 'directorio', text: 'x' })).id).toBe('directorio-2');
    expect(statSync(join(root, 'p', 'directorio.c4.json')).isDirectory()).toBe(true);
  });

  it('con dos archivos del mismo id y distinto módulo se usa el primero por orden alfabético, sin fallar', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'x.data.json'), '{"d":1}');
    writeFileSync(join(root, 'p', 'x.c4.json'), '{"c":1}');
    const project = (await store.getProject('p'))!;
    expect(project.diagrams).toHaveLength(1);
    expect(project.diagrams[0]).toMatchObject({ id: 'x', module: 'c4' });
    // un diagrama nuevo llamado `x` no choca con ninguno de los dos
    expect((await store.saveDiagram('p', { module: 'c4', name: 'Otro', text: '{}' })).id).toBe('otro');
    expect((await store.getProject('p'))!.diagrams.map((d) => d.id).sort()).toEqual(['otro', 'x']);
  });

  it('un sidecar corrupto, de otro formato o con campos raros se ignora con tolerancia', async () => {
    const { root, store } = workspace();
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    mkdirSync(join(root, 'c'));
    mkdirSync(join(root, 'd'));
    for (const id of ['a', 'b', 'c', 'd']) writeFileSync(join(root, id, 'x.c4.json'), '{}');
    writeFileSync(join(root, 'a', 'project.json'), '{ esto no es json');
    writeFileSync(join(root, 'b', 'project.json'), JSON.stringify({ format: 'otra/9', name: 'Nombre ajeno' }));
    writeFileSync(join(root, 'c', 'project.json'), JSON.stringify({ format: SIDECAR_FORMAT, name: 42, description: {}, createdAt: 'ayer', diagrams: { x: 'no', '../y': { name: 'Y' }, z: { name: ['a'] } } }));
    writeFileSync(join(root, 'd', 'project.json'), JSON.stringify({ format: SIDECAR_FORMAT, name: 'Bueno', diagrams: { x: { name: 'Equis', createdAt: '2024-01-02T03:04:05.000Z' } } }));
    const projects = await store.listProjects();
    expect(projects.map((p) => [p.id, p.name])).toEqual([
      ['a', 'a'],
      ['b', 'b'],
      ['d', 'Bueno'],
      ['c', 'c'],
    ].sort((x, y) => x[1].localeCompare(y[1])));
    expect(projects.every((p) => p.diagrams.length === 1)).toBe(true);
    expect((await store.getProject('c'))!.diagrams[0].name).toBe('x');
    expect((await store.getProject('d'))!.diagrams[0]).toMatchObject({ name: 'Equis', createdAt: '2024-01-02T03:04:05.000Z' });
    // al escribir en uno con el sidecar roto se reconstruye uno válido
    await store.renameProject('a', 'Reparado');
    expect(JSON.parse(readFileSync(join(root, 'a', 'project.json'), 'utf8'))).toMatchObject({ format: SIDECAR_FORMAT, name: 'Reparado' });
    expect((await store.getProject('a'))!.diagrams.map((d) => d.id)).toEqual(['x']);
  });

  it('un sidecar que es un directorio o un enlace no rompe el listado', async () => {
    const { outside, root, store } = workspace();
    mkdirSync(join(root, 'p'));
    mkdirSync(join(root, 'p', 'project.json'));
    writeFileSync(join(root, 'p', 'x.c4.json'), '{}');
    writeFileSync(join(outside, 'ajeno.json'), JSON.stringify({ format: SIDECAR_FORMAT, name: 'Ajeno' }));
    mkdirSync(join(root, 'q'));
    if (symlinkOrSkip(join(outside, 'ajeno.json'), join(root, 'q', 'project.json'))) {
      expect((await store.getProject('q'))!.name).toBe('q'); // no se lee el sidecar a través de un enlace
    }
    expect((await store.getProject('p'))!.diagrams.map((d) => d.id)).toEqual(['x']);
  });
});

describe('FolderProjectStore: seguridad', () => {
  it('los enlaces simbólicos que salen de la raíz se ignoran (proyectos, archivos y el sidecar) y no se siguen al crear ni al borrar', async () => {
    const { outside, root, store } = workspace();
    mkdirSync(join(outside, 'ajeno'));
    writeFileSync(join(outside, 'ajeno', 'secreto.c4.json'), '{"secreto":true}');
    writeFileSync(join(outside, 'secreto.txt'), 'no debe verse ni tocarse');
    if (!symlinkOrSkip(join(outside, 'ajeno'), join(root, 'enlace'))) return;
    // un proyecto de verdad con un enlace a un archivo de fuera con forma de diagrama, y otro a un directorio
    mkdirSync(join(root, 'p'));
    writeFileSync(join(root, 'p', 'bueno.c4.json'), '{}');
    symlinkSync(join(outside, 'secreto.txt'), join(root, 'p', 'espejo.c4.json'));
    symlinkSync(join(outside, 'ajeno'), join(root, 'p', 'carpeta.c4.json'));
    symlinkSync(join(outside, 'ajeno', 'secreto.c4.json'), join(root, 'p', 'secreto.c4.json'));

    expect((await store.listProjects()).map((p) => p.id)).toEqual(['p']);
    expect(await store.getProject('enlace')).toBeUndefined();
    await rejects(store.getDiagram('enlace', 'secreto'), 'not-found');
    await rejects(store.saveDiagram('enlace', { module: 'c4', name: 'X', text: '{}' }), 'not-found');
    await rejects(store.deleteProject('enlace'), 'not-found');
    expect((await store.getProject('p'))!.diagrams.map((d) => d.id)).toEqual(['bueno']);
    expect(await store.getDiagram('p', 'espejo')).toBeUndefined();
    expect(await store.getDiagram('p', 'secreto')).toBeUndefined();
    await rejects(store.saveDiagram('p', { id: 'espejo', text: 'pisado' }), 'not-found');

    // crear con un nombre que ya ocupa un enlace elige otro id y no escribe a través del enlace
    const created = await store.createProject({ name: 'Enlace' });
    expect(created.id).toBe('enlace-2');
    const diagram = await store.saveDiagram('p', { module: 'c4', name: 'Espejo', text: 'nuevo' });
    expect(diagram.id).toBe('espejo-2');
    expect(readFileSync(join(outside, 'secreto.txt'), 'utf8')).toBe('no debe verse ni tocarse');
    expect(readdirSync(join(outside, 'ajeno'))).toEqual(['secreto.c4.json']);

    // borrar un proyecto que contiene enlaces quita los enlaces, no lo que hay al otro lado
    await store.deleteProject('p');
    expect(readFileSync(join(outside, 'secreto.txt'), 'utf8')).toBe('no debe verse ni tocarse');
    expect(readdirSync(join(outside, 'ajeno'))).toEqual(['secreto.c4.json']);
  });

  it('un enlace dentro de la raíz tampoco cuenta como proyecto (no se listaría dos veces)', async () => {
    const { root, store } = workspace();
    await store.createProject({ name: 'Real' });
    if (!symlinkOrSkip(join(root, 'real'), join(root, 'alias'))) return;
    expect((await store.listProjects()).map((p) => p.id)).toEqual(['real']);
    expect(await store.getProject('alias')).toBeUndefined();
  });

  it('la raíz puede ser un enlace (es una decisión de quien configura el espacio de trabajo)', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'real'));
    if (!symlinkOrSkip(join(dir, 'real'), join(dir, 'espacio'))) return;
    const store = new FolderProjectStore(join(dir, 'espacio'));
    await store.createProject({ name: 'Uno' });
    expect(readdirSync(join(dir, 'real'))).toEqual(['uno']);
    expect((await store.listProjects()).map((p) => p.id)).toEqual(['uno']);
  });

  const malicious = ['..', '../x', '../../etc/passwd', '..\\x', '/etc', '/', 'a/b', 'a\\b', '.', '.hidden', 'x..y', 'a.', ' a', 'a b', '', 'a\0b', 'con', 'NUL', 'com1.txt', '%2e%2e', 'é', 'a'.repeat(101)];

  it('isWorkspaceId solo admite un segmento de ruta sencillo', async () => {
    for (const id of malicious) expect(isWorkspaceId(id), JSON.stringify(id)).toBe(false);
    for (const id of ['tienda', 'Tienda_2', 'a', 'x.v2', 'a-b.c_d', 'node_modules', '1.2', 'a'.repeat(100)]) expect(isWorkspaceId(id), id).toBe(true);
    for (const value of [undefined, null, 4, {}, []]) expect(isWorkspaceId(value)).toBe(false);
    // `node_modules` puede ser un diagrama, pero nunca un proyecto
    await rejects(new FolderProjectStore(tmp()).deleteProject('node_modules'), 'invalid');
  });

  it('ningún id que llegue de fuera sale de la raíz: ni para leer, ni para escribir, ni para borrar', async () => {
    const { outside, root, store } = workspace();
    const project = await store.createProject({ name: 'P' });
    await store.saveDiagram(project.id, { module: 'c4', name: 'D', text: '{}' });
    writeFileSync(join(outside, 'x.c4.json'), 'fuera');
    mkdirSync(join(outside, 'otro'));
    const snapshot = () => JSON.stringify([readdirSync(outside).sort(), readdirSync(root).sort(), readdirSync(join(root, 'p')).sort()]);
    const before = snapshot();

    for (const id of malicious) {
      expect(await store.getProject(id), `getProject ${JSON.stringify(id)}`).toBeUndefined();
      await rejects(store.getDiagram(id, 'd'), 'not-found');
      expect(await store.getDiagram('p', id), `getDiagram ${JSON.stringify(id)}`).toBeUndefined();
      await rejects(store.renameProject(id, 'Otro'), 'invalid');
      await rejects(store.deleteProject(id), 'invalid');
      await rejects(store.saveDiagram(id, { module: 'c4', name: 'X', text: '{}' }), 'invalid');
      await rejects(store.saveDiagram('p', { id, text: 'x' }), 'invalid');
      await rejects(store.renameDiagram('p', id, 'X'), 'invalid');
      await rejects(store.deleteDiagram('p', id), 'invalid');
    }
    // un módulo con separadores tampoco forma un archivo fuera de sitio
    for (const module of ['../x', 'a/b', '..', 'C4', 'x.y', '']) await rejects(store.saveDiagram('p', { module, name: 'M', text: '{}' }), 'invalid');
    expect(snapshot()).toBe(before);
    expect(readFileSync(join(outside, 'x.c4.json'), 'utf8')).toBe('fuera');
  });

  it('los nombres con `..` o separadores dan ids dentro de la raíz', async () => {
    const { outside, root, store } = workspace();
    const a = await store.createProject({ name: '../../etc/passwd' });
    const b = await store.createProject({ name: '..\\..\\windows' });
    const c = await store.createProject({ name: '/' }); // solo símbolos: id de reserva
    expect([a.id, b.id, c.id]).toEqual(['etc-passwd', 'windows', 'proyecto']);
    const d = await store.saveDiagram(a.id, { module: 'c4', name: '../../../x', text: '{}' });
    expect(d.id).toBe('x');
    expect(readdirSync(root).sort()).toEqual(['etc-passwd', 'proyecto', 'windows']);
    expect(readdirSync(outside)).toEqual(['espacio']);
  });
});

describe('FolderProjectStore: concurrencia', () => {
  it('muchos guardados a la vez en el mismo almacén no se pisan: ids distintos, archivos completos', async () => {
    const { root, store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const names = Array.from({ length: 25 }, (_, i) => (i % 2 ? `a b ${i}` : `a-b ${i}`)); // slugs repetidos entre nombres distintos
    const metas = await Promise.all(names.map((name, i) => store.saveDiagram(p.id, { module: 'c4', name, text: JSON.stringify({ i }) })));
    expect(new Set(metas.map((m) => m.id)).size).toBe(25);
    const files = readdirSync(join(root, p.id)).filter((f) => f.endsWith('.c4.json'));
    expect(files).toHaveLength(25);
    for (const [i, meta] of metas.entries()) expect((await store.getDiagram(p.id, meta.id))?.text).toBe(JSON.stringify({ i }));
    expect(readdirSync(join(root, p.id)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await store.getProject(p.id))!.diagrams).toHaveLength(25);
  });

  it('el mismo nombre a la vez: uno se crea y los demás fallan con `exists`', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.saveDiagram(p.id, { module: 'c4', name: 'Igual', text: '{}' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as ProjectError).code).toBe('exists');
  });

  it('con `ifUpdatedAt`, de varias actualizaciones simultáneas sobre la misma versión solo gana una', async () => {
    const { store } = workspace();
    const p = await store.createProject({ name: 'P' });
    const d = await store.saveDiagram(p.id, { module: 'c4', name: 'D', text: 'v0' });
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => store.saveDiagram(p.id, { id: d.id, text: `v${i}`, ifUpdatedAt: d.updatedAt })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') expect((r.reason as ProjectError).code).toBe('conflict');
  });

  it('dos almacenes sobre la misma carpeta (dos procesos) que crean el mismo id a la vez no se pisan', async () => {
    const { root, store } = workspace();
    const other = new FolderProjectStore(root);
    const p = await store.createProject({ name: 'P' });
    for (let round = 0; round < 10; round++) {
      const [a, b] = await Promise.all([
        store.saveDiagram(p.id, { module: 'c4', name: `a b ${round}`, text: 'del primero' }),
        other.saveDiagram(p.id, { module: 'c4', name: `a-b ${round}`, text: 'del segundo' }),
      ]);
      expect(a.id).not.toBe(b.id);
      expect((await store.getDiagram(p.id, a.id))?.text).toBe('del primero');
      expect((await store.getDiagram(p.id, b.id))?.text).toBe('del segundo');
    }
    expect((await store.getProject(p.id))!.diagrams).toHaveLength(20);
  });

  it('dos proyectos con el mismo nombre a la vez: uno solo', async () => {
    const { root, store } = workspace();
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => store.createProject({ name: 'Tienda' })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(readdirSync(root)).toEqual(['tienda']);
  });
});
