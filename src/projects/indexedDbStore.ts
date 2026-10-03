import { cleanName, ProjectError, requireModuleId, sameName, type Diagram, type DiagramMeta, type ProjectStore, type ProjectSummary, type SaveDiagramInput } from '@iark/kernel';

/**
 * Almacén de proyectos en IndexedDB: el de la app web. Tres almacenes de objetos para que listar no lea los documentos:
 * `projects`, `diagrams` (solo metadatos, con índice por proyecto) y `documents` (el texto, por id de diagrama). Cada
 * operación es una sola transacción, así que dos pestañas no pueden dejar un proyecto a medias ni repetir un nombre.
 */

const DB_NAME = 'iark-projects';
const DB_VERSION = 1;

interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}
interface DiagramRecord extends DiagramMeta {
  projectId: string;
}
interface DocumentRecord {
  id: string;
  text: string;
}

const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1);

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('Transacción cancelada', 'AbortError'));
  });

function newId(prefix: string): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  return `${prefix}-${random}`;
}

function toProjectError(error: unknown): unknown {
  if (error instanceof ProjectError) return error;
  const name = (error as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError') return new ProjectError('unavailable', 'No hay espacio de almacenamiento en el navegador: exporta o borra proyectos que ya no uses.');
  if (name === 'InvalidStateError' || name === 'SecurityError' || name === 'UnknownError' || name === 'AbortError') {
    return new ProjectError('unavailable', 'El almacenamiento del navegador no está disponible (¿ventana privada o permisos bloqueados?).');
  }
  return error;
}

/** `true` si este entorno ofrece IndexedDB (no en algunas ventanas privadas ni en iframes sin permiso). */
export function indexedDbAvailable(factory: IDBFactory | null = globalThis.indexedDB ?? null): boolean {
  return factory !== null && typeof factory !== 'undefined';
}

export class IndexedDbProjectStore implements ProjectStore {
  readonly kind = 'indexeddb';
  private db: Promise<IDBDatabase> | undefined;
  private last = 0;

  constructor(
    private readonly factory: IDBFactory | null = globalThis.indexedDB ?? null,
    private readonly dbName = DB_NAME,
  ) {}

  private open(): Promise<IDBDatabase> {
    if (!this.factory) return Promise.reject(new ProjectError('unavailable', 'Este navegador no ofrece IndexedDB: los proyectos no se pueden guardar aquí.'));
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      let opening: IDBOpenDBRequest;
      try {
        opening = this.factory!.open(this.dbName, DB_VERSION);
      } catch (error) {
        reject(toProjectError(error));
        return;
      }
      opening.onupgradeneeded = () => {
        const db = opening.result;
        db.createObjectStore('projects', { keyPath: 'id' });
        db.createObjectStore('diagrams', { keyPath: 'id' }).createIndex('byProject', 'projectId');
        db.createObjectStore('documents', { keyPath: 'id' });
      };
      opening.onsuccess = () => {
        const db = opening.result;
        // Otra pestaña con una versión más nueva pide actualizar: se suelta la conexión para no bloquearla.
        db.onversionchange = () => {
          db.close();
          this.db = undefined;
        };
        resolve(db);
      };
      opening.onerror = () => reject(toProjectError(opening.error));
      opening.onblocked = () => reject(new ProjectError('unavailable', 'Otra pestaña bloquea el almacenamiento de proyectos; ciérrala y reintenta.'));
    }).catch((error) => {
      this.db = undefined;
      throw toProjectError(error);
    });
    return this.db;
  }

  /** Marca de tiempo estrictamente creciente en este almacén (los guardados seguidos no repiten fecha). */
  private now(after = ''): string {
    const previous = after ? Date.parse(after) : 0;
    this.last = Math.max(Date.now(), this.last + 1, Number.isNaN(previous) ? 0 : previous + 1);
    return new Date(this.last).toISOString();
  }

  /** Ejecuta `body` en una transacción; si falla, la cancela entera. */
  private async run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const db = await this.open();
    let tx: IDBTransaction;
    try {
      tx = db.transaction(stores, mode);
    } catch (error) {
      this.db = undefined;
      throw toProjectError(error);
    }
    const complete = finished(tx);
    complete.catch(() => undefined);
    try {
      const result = await body(tx);
      await complete;
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* la transacción ya terminó */
      }
      throw toProjectError(error);
    }
  }

  private summary(project: ProjectRecord, diagrams: DiagramRecord[]): ProjectSummary {
    return {
      id: project.id,
      name: project.name,
      ...(project.description ? { description: project.description } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      diagrams: diagrams
        .filter((d) => d.projectId === project.id)
        .map(({ id, module, name, createdAt, updatedAt }) => ({ id, module, name, createdAt, updatedAt }))
        .sort(byName),
    };
  }

  private async projectOf(tx: IDBTransaction, id: string): Promise<ProjectRecord> {
    const project = (await request(tx.objectStore('projects').get(id))) as ProjectRecord | undefined;
    if (!project) throw new ProjectError('not-found', `No existe el proyecto «${id}».`);
    return project;
  }

  private async diagramsOf(tx: IDBTransaction, projectId: string): Promise<DiagramRecord[]> {
    return (await request(tx.objectStore('diagrams').index('byProject').getAll(projectId))) as DiagramRecord[];
  }

  listProjects(): Promise<ProjectSummary[]> {
    return this.run(['projects', 'diagrams'], 'readonly', async (tx) => {
      const projects = (await request(tx.objectStore('projects').getAll())) as ProjectRecord[];
      const diagrams = (await request(tx.objectStore('diagrams').getAll())) as DiagramRecord[];
      return projects.map((p) => this.summary(p, diagrams)).sort(byName);
    });
  }

  getProject(id: string): Promise<ProjectSummary | undefined> {
    return this.run(['projects', 'diagrams'], 'readonly', async (tx) => {
      const project = (await request(tx.objectStore('projects').get(id))) as ProjectRecord | undefined;
      return project ? this.summary(project, await this.diagramsOf(tx, id)) : undefined;
    });
  }

  async createProject(input: { name: string; description?: string }): Promise<ProjectSummary> {
    const name = cleanName(input.name, 'del proyecto');
    return this.run(['projects', 'diagrams'], 'readwrite', async (tx) => {
      const store = tx.objectStore('projects');
      const all = (await request(store.getAll())) as ProjectRecord[];
      if (all.some((p) => sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`);
      const now = this.now();
      const project: ProjectRecord = { id: newId('p'), name, ...(input.description?.trim() ? { description: input.description.trim() } : {}), createdAt: now, updatedAt: now };
      await request(store.add(project));
      return this.summary(project, []);
    });
  }

  async renameProject(id: string, rawName: string): Promise<ProjectSummary> {
    const name = cleanName(rawName, 'del proyecto');
    return this.run(['projects', 'diagrams'], 'readwrite', async (tx) => {
      const store = tx.objectStore('projects');
      const project = await this.projectOf(tx, id);
      const all = (await request(store.getAll())) as ProjectRecord[];
      if (all.some((p) => p.id !== id && sameName(p.name, name))) throw new ProjectError('exists', `Ya existe un proyecto llamado «${name}».`);
      const updated = { ...project, name, updatedAt: this.now(project.updatedAt) };
      await request(store.put(updated));
      return this.summary(updated, await this.diagramsOf(tx, id));
    });
  }

  deleteProject(id: string): Promise<void> {
    return this.run(['projects', 'diagrams', 'documents'], 'readwrite', async (tx) => {
      await this.projectOf(tx, id);
      for (const diagram of await this.diagramsOf(tx, id)) {
        await request(tx.objectStore('documents').delete(diagram.id));
        await request(tx.objectStore('diagrams').delete(diagram.id));
      }
      await request(tx.objectStore('projects').delete(id));
    });
  }

  getDiagram(projectId: string, diagramId: string): Promise<Diagram | undefined> {
    return this.run(['projects', 'diagrams', 'documents'], 'readonly', async (tx) => {
      await this.projectOf(tx, projectId);
      const meta = (await request(tx.objectStore('diagrams').get(diagramId))) as DiagramRecord | undefined;
      if (!meta || meta.projectId !== projectId) return undefined;
      const document = (await request(tx.objectStore('documents').get(diagramId))) as DocumentRecord | undefined;
      const { id, module, name, createdAt, updatedAt } = meta;
      return { id, module, name, createdAt, updatedAt, text: document?.text ?? '' };
    });
  }

  async saveDiagram(projectId: string, input: SaveDiagramInput): Promise<DiagramMeta> {
    if (typeof input.text !== 'string') throw new ProjectError('invalid', 'El documento del diagrama debe ser un texto.');
    return this.run(['projects', 'diagrams', 'documents'], 'readwrite', async (tx) => {
      const project = await this.projectOf(tx, projectId);
      const diagrams = tx.objectStore('diagrams');
      const documents = tx.objectStore('documents');
      const touch = async (stamp: string): Promise<void> => void (await request(tx.objectStore('projects').put({ ...project, updatedAt: stamp })));
      const strip = ({ id, module, name, createdAt, updatedAt }: DiagramRecord): DiagramMeta => ({ id, module, name, createdAt, updatedAt });

      if (input.id !== undefined) {
        const current = (await request(diagrams.get(input.id))) as DiagramRecord | undefined;
        if (!current || current.projectId !== projectId) throw new ProjectError('not-found', `No existe el diagrama «${input.id}» en el proyecto «${project.name}».`);
        if (input.module !== undefined && input.module !== current.module) throw new ProjectError('invalid', `Un diagrama no cambia de módulo (es de «${current.module}»).`);
        if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== current.updatedAt) {
          throw new ProjectError('conflict', `El diagrama «${current.name}» cambió desde que se abrió (otra pestaña o proceso lo guardó).`);
        }
        const updated: DiagramRecord = { ...current, updatedAt: this.now(current.updatedAt) };
        await request(documents.put({ id: current.id, text: input.text } satisfies DocumentRecord));
        await request(diagrams.put(updated));
        await touch(updated.updatedAt);
        return strip(updated);
      }

      const module = requireModuleId(input.module);
      const name = cleanName(input.name ?? 'Sin título', 'del diagrama');
      if ((await this.diagramsOf(tx, projectId)).some((d) => sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`);
      const now = this.now();
      const created: DiagramRecord = { id: newId('d'), projectId, module, name, createdAt: now, updatedAt: now };
      await request(documents.add({ id: created.id, text: input.text } satisfies DocumentRecord));
      await request(diagrams.add(created));
      await touch(now);
      return strip(created);
    });
  }

  async renameDiagram(projectId: string, diagramId: string, rawName: string): Promise<DiagramMeta> {
    const name = cleanName(rawName, 'del diagrama');
    return this.run(['projects', 'diagrams'], 'readwrite', async (tx) => {
      const project = await this.projectOf(tx, projectId);
      const diagrams = tx.objectStore('diagrams');
      const current = (await request(diagrams.get(diagramId))) as DiagramRecord | undefined;
      if (!current || current.projectId !== projectId) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`);
      if ((await this.diagramsOf(tx, projectId)).some((d) => d.id !== diagramId && sameName(d.name, name))) throw new ProjectError('exists', `Ya hay un diagrama llamado «${name}» en el proyecto «${project.name}».`);
      const updated: DiagramRecord = { ...current, name, updatedAt: this.now(current.updatedAt) };
      await request(diagrams.put(updated));
      await request(tx.objectStore('projects').put({ ...project, updatedAt: updated.updatedAt }));
      const { id, module, createdAt, updatedAt } = updated;
      return { id, module, name, createdAt, updatedAt };
    });
  }

  deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    return this.run(['projects', 'diagrams', 'documents'], 'readwrite', async (tx) => {
      const project = await this.projectOf(tx, projectId);
      const diagrams = tx.objectStore('diagrams');
      const current = (await request(diagrams.get(diagramId))) as DiagramRecord | undefined;
      if (!current || current.projectId !== projectId) throw new ProjectError('not-found', `No existe el diagrama «${diagramId}» en el proyecto «${project.name}».`);
      await request(tx.objectStore('documents').delete(diagramId));
      await request(diagrams.delete(diagramId));
      await request(tx.objectStore('projects').put({ ...project, updatedAt: this.now(project.updatedAt) }));
    });
  }

  /** Cierra la conexión (las pruebas, para poder borrar la base). */
  async close(): Promise<void> {
    const db = await this.db?.catch(() => undefined);
    db?.close();
    this.db = undefined;
  }
}
