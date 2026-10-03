import {
  bundleFileName,
  bundleToText,
  createBundle,
  duplicateDiagram,
  importBundle,
  parseBundle,
  ProjectError,
  snapshotProject,
  type Diagram,
  type DiagramMeta,
  type ImportedProject,
  type ProjectStore,
  type ProjectSummary,
} from '@iark/kernel';

/**
 * Sesión de proyectos de una pantalla (banco de trabajo o editor C4): qué proyecto y qué diagrama están abiertos, la lista
 * de proyectos, y el guardado automático del diagrama abierto con control de concurrencia. Sin React: la interfaz se
 * suscribe y el anfitrión (el controlador del banco o el editor C4) le pasa el texto cuando cambia.
 */

export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export interface ProjectsState {
  ready: boolean;
  /** `false` si el almacén no funciona (ventana privada, permisos…): la lista queda vacía y `error` dice por qué. */
  available: boolean;
  error?: string;
  projects: ProjectSummary[];
  /** Proyecto abierto: el que se muestra y donde se crean los diagramas nuevos. */
  projectId?: string;
  /** Diagrama del proyecto abierto en el editor; sus cambios se guardan solos. */
  diagramId?: string;
  save: SaveState;
  savedAt?: number;
  saveError?: string;
}

/** Dónde se recuerda el último proyecto y diagrama abiertos (por navegador; nunca es el único sitio donde viven los datos). */
export interface LastOpened {
  projectId?: string;
  diagramId?: string;
}
export interface PointerStorage {
  read(): LastOpened | undefined;
  write(value: LastOpened): void;
}

const POINTER_KEY = 'iark.projects.last';

export const localPointer: PointerStorage = {
  read() {
    try {
      const raw = window.localStorage.getItem(POINTER_KEY);
      const value = raw ? (JSON.parse(raw) as LastOpened) : undefined;
      return value && typeof value === 'object' ? value : undefined;
    } catch {
      return undefined;
    }
  },
  write(value) {
    try {
      window.localStorage.setItem(POINTER_KEY, JSON.stringify(value));
    } catch {
      /* sin almacenamiento: no se recuerda */
    }
  },
};

export interface SessionOptions {
  pointer?: PointerStorage;
  /** Espera tras el último cambio antes de guardar. */
  debounceMs?: number;
  /** Avisar a las demás pestañas de los cambios (BroadcastChannel). */
  broadcast?: boolean;
  /** Pide al navegador que no borre el almacenamiento por falta de espacio (`navigator.storage.persist`). */
  persist?: boolean;
}

const CHANNEL = 'iark-projects';

export class ProjectSession {
  private state: ProjectsState = { ready: false, available: true, projects: [], save: 'idle' };
  private listeners = new Set<() => void>();
  private pendingText: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | undefined;
  private baseUpdatedAt: string | undefined;
  private channel: BroadcastChannel | undefined;
  private persisted = false;
  private readonly pointer: PointerStorage | undefined;
  private readonly debounceMs: number;

  constructor(
    readonly store: ProjectStore,
    private readonly options: SessionOptions = {},
  ) {
    this.pointer = options.pointer;
    this.debounceMs = options.debounceMs ?? 500;
    if (options.broadcast !== false && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(CHANNEL);
        this.channel.onmessage = () => void this.refresh();
      } catch {
        this.channel = undefined;
      }
    }
  }

  // ───────────── suscripción ─────────────

  getState = (): ProjectsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<ProjectsState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  get project(): ProjectSummary | undefined {
    return this.state.projects.find((p) => p.id === this.state.projectId);
  }

  get diagram(): DiagramMeta | undefined {
    return this.project?.diagrams.find((d) => d.id === this.state.diagramId);
  }

  // ───────────── arranque y lista ─────────────

  /** Carga la lista. Devuelve lo último que había abierto, si sigue existiendo, para que el anfitrión decida si lo reabre. */
  async init(): Promise<LastOpened | undefined> {
    await this.refresh();
    this.set({ ready: true });
    const last = this.pointer?.read();
    const project = this.state.projects.find((p) => p.id === last?.projectId);
    if (!project) return undefined;
    this.set({ projectId: project.id });
    return { projectId: project.id, diagramId: project.diagrams.some((d) => d.id === last?.diagramId) ? last?.diagramId : undefined };
  }

  async refresh(): Promise<void> {
    try {
      const projects = await this.store.listProjects();
      const projectId = projects.some((p) => p.id === this.state.projectId) ? this.state.projectId : undefined;
      const diagramId = projects.find((p) => p.id === projectId)?.diagrams.some((d) => d.id === this.state.diagramId) ? this.state.diagramId : undefined;
      this.set({ projects, available: true, error: undefined, projectId, diagramId });
    } catch (error) {
      this.set({ available: false, error: (error as Error).message });
    }
  }

  private remember(): void {
    this.pointer?.write({ projectId: this.state.projectId, diagramId: this.state.diagramId });
  }

  private announce(): void {
    try {
      this.channel?.postMessage({ type: 'changed' });
    } catch {
      /* la pestaña se está cerrando */
    }
  }

  /** Pide al navegador almacenamiento persistente (una vez, y solo tras una acción de la persona). */
  private requestPersistence(): void {
    if (this.persisted || this.options.persist === false) return;
    this.persisted = true;
    try {
      void navigator.storage?.persist?.().catch(() => undefined);
    } catch {
      /* no disponible */
    }
  }

  // ───────────── proyectos ─────────────

  selectProject(id: string | undefined): void {
    if (id === this.state.projectId) return;
    void this.flush();
    this.set({ projectId: id, diagramId: undefined, save: 'idle', saveError: undefined });
    this.baseUpdatedAt = undefined;
    this.remember();
  }

  async createProject(name: string, description?: string): Promise<ProjectSummary> {
    const project = await this.store.createProject({ name, description });
    this.requestPersistence();
    await this.refresh();
    this.announce();
    this.selectProject(project.id);
    return project;
  }

  async renameProject(id: string, name: string): Promise<void> {
    await this.store.renameProject(id, name);
    await this.refresh();
    this.announce();
  }

  async deleteProject(id: string): Promise<void> {
    if (id === this.state.projectId) {
      this.discardPending();
      this.selectProject(undefined);
    }
    await this.store.deleteProject(id);
    await this.refresh();
    this.announce();
  }

  /** El proyecto completo en el archivo único: nombre sugerido y contenido. */
  async exportProject(id: string): Promise<{ fileName: string; text: string }> {
    await this.flush();
    const snapshot = await snapshotProject(this.store, id);
    return { fileName: bundleFileName(snapshot.name), text: bundleToText(createBundle(snapshot, { generator: 'IArk - DIAgrams' })) };
  }

  /** Crea un proyecto nuevo con el contenido del archivo y lo abre. Nunca pisa uno existente. */
  async importProject(text: string, name?: string): Promise<ImportedProject> {
    const imported = await importBundle(this.store, parseBundle(text), { name });
    this.requestPersistence();
    await this.refresh();
    this.announce();
    this.selectProject(imported.project.id);
    return imported;
  }

  // ───────────── diagramas ─────────────

  /** Abre un diagrama: guarda lo pendiente del anterior, lo adjunta (sus cambios se guardan solos) y lo devuelve. */
  async openDiagram(projectId: string, diagramId: string): Promise<Diagram> {
    await this.flush();
    const diagram = await this.store.getDiagram(projectId, diagramId);
    if (!diagram) throw new ProjectError('not-found', 'El diagrama ya no existe en el proyecto.');
    this.baseUpdatedAt = diagram.updatedAt;
    this.pendingText = undefined;
    this.set({ projectId, diagramId, save: 'idle', saveError: undefined });
    this.remember();
    return diagram;
  }

  /** Crea un diagrama en el proyecto abierto (o en `projectId`) y lo adjunta. */
  async createDiagram(input: { module: string; name?: string; text: string }, projectId = this.state.projectId): Promise<DiagramMeta> {
    if (!projectId) throw new ProjectError('invalid', 'Abre o crea un proyecto antes de guardar un diagrama en él.');
    await this.flush();
    const meta = await this.store.saveDiagram(projectId, input);
    this.requestPersistence();
    this.baseUpdatedAt = meta.updatedAt;
    this.pendingText = undefined;
    await this.refresh();
    this.set({ projectId, diagramId: meta.id, save: 'saved', savedAt: Date.now(), saveError: undefined });
    this.remember();
    this.announce();
    return meta;
  }

  async renameDiagram(projectId: string, diagramId: string, name: string): Promise<void> {
    const meta = await this.store.renameDiagram(projectId, diagramId, name);
    if (diagramId === this.state.diagramId) this.baseUpdatedAt = meta.updatedAt;
    await this.refresh();
    this.announce();
  }

  async duplicateDiagram(projectId: string, diagramId: string): Promise<DiagramMeta> {
    await this.flush();
    const copy = await duplicateDiagram(this.store, projectId, diagramId);
    await this.refresh();
    this.announce();
    return copy;
  }

  async deleteDiagram(projectId: string, diagramId: string): Promise<void> {
    if (diagramId === this.state.diagramId) {
      this.discardPending();
      this.detach();
    }
    await this.store.deleteDiagram(projectId, diagramId);
    await this.refresh();
    this.announce();
  }

  /** Guarda lo pendiente y deja de guardar en el diagrama abierto (el documento pasa a ser un borrador suelto). */
  async release(): Promise<void> {
    await this.flush();
    this.detach();
  }

  /** Deja de guardar en el diagrama abierto, descartando lo pendiente (para cuando el diagrama ya no existe). */
  detach(): void {
    this.discardPending();
    this.baseUpdatedAt = undefined;
    this.set({ diagramId: undefined, save: 'idle', saveError: undefined });
    this.remember();
  }

  // ───────────── guardado automático ─────────────

  get attached(): boolean {
    return this.state.projectId !== undefined && this.state.diagramId !== undefined;
  }

  /** El anfitrión avisa de que el documento del diagrama abierto cambió. Se guarda tras una pausa. */
  queueSave(text: string): void {
    if (!this.attached) return;
    this.pendingText = text;
    if (this.state.save !== 'conflict') this.set({ save: 'pending', saveError: undefined });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), this.debounceMs);
  }

  private discardPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.pendingText = undefined;
  }

  /** Guarda ya lo pendiente y espera a que termine (antes de cambiar de diagrama, exportar o salir). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
      await this.run();
    } else if (this.pendingText !== undefined && this.state.save === 'error') {
      await this.run();
    }
    await this.inFlight;
  }

  /** Hay cambios que aún no están guardados (para avisar al cerrar la pestaña). */
  get dirty(): boolean {
    return this.pendingText !== undefined || this.state.save === 'saving' || this.state.save === 'error' || this.state.save === 'conflict';
  }

  private run(): Promise<void> {
    this.timer = undefined;
    this.inFlight = (this.inFlight ?? Promise.resolve()).then(() => this.write());
    return this.inFlight;
  }

  private async write(): Promise<void> {
    const { projectId, diagramId } = this.state;
    const text = this.pendingText;
    if (text === undefined || !projectId || !diagramId || this.state.save === 'conflict') return;
    this.set({ save: 'saving' });
    try {
      const meta = await this.store.saveDiagram(projectId, { id: diagramId, text, ifUpdatedAt: this.baseUpdatedAt });
      // Si el diagrama abierto cambió mientras se guardaba, este resultado ya no le corresponde.
      if (this.state.diagramId !== diagramId) return;
      this.baseUpdatedAt = meta.updatedAt;
      if (this.pendingText === text) this.pendingText = undefined;
      this.set({ save: this.pendingText === undefined ? 'saved' : 'pending', savedAt: Date.now(), saveError: undefined });
      this.announce();
      await this.refresh();
    } catch (error) {
      const code = error instanceof ProjectError ? error.code : undefined;
      this.set({ save: code === 'conflict' ? 'conflict' : 'error', saveError: (error as Error).message });
    }
  }

  /**
   * Un conflicto se da cuando otra pestaña guardó el mismo diagrama. `overwrite` conserva lo de esta pestaña;
   * `reload` descarta lo de esta y devuelve el diagrama como quedó, para que el anfitrión lo cargue.
   */
  async resolveConflict(choice: 'overwrite' | 'reload'): Promise<Diagram | undefined> {
    const { projectId, diagramId } = this.state;
    if (!projectId || !diagramId) return undefined;
    const current = await this.store.getDiagram(projectId, diagramId);
    if (!current) {
      this.detach();
      return undefined;
    }
    this.baseUpdatedAt = current.updatedAt;
    this.set({ save: 'idle', saveError: undefined });
    if (choice === 'reload') {
      this.discardPending();
      return current;
    }
    if (this.pendingText !== undefined) await this.run();
    return undefined;
  }

  /** Reintenta un guardado que falló. */
  async retry(): Promise<void> {
    if (this.pendingText !== undefined) {
      this.set({ save: 'pending' });
      await this.run();
    }
  }

  dispose(): void {
    this.discardPending();
    this.listeners.clear();
    this.channel?.close();
  }
}
