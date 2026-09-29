import {
  analyzeText,
  analyzeValue,
  exportDocument,
  importText,
  isKnownView,
  moduleCapabilities,
  pretty,
  renderSvg,
  runCommand,
  viewChoices,
  canRender,
  type Analysis,
  type AnyModule,
  type CommandOutput,
  type CommandRun,
  type ExportedFile,
  type ImportResult,
  type ModuleCapabilities,
  type ViewChoices,
} from './engine';

/** Un módulo que el banco de trabajo sabe cargar (bajo demanda: cada especialidad es un trozo aparte del paquete). */
export interface ModuleSource {
  id: string;
  /** Nombre corto para la pestaña. */
  label: string;
  load(): Promise<AnyModule>;
  /** Documento de ejemplo (JSON) para empezar. */
  example?(): Promise<string>;
}

/** Borradores del editor entre sesiones (localStorage en la app; nada en modo embebido). */
export interface DraftStorage {
  read(moduleId: string): string | null;
  write(moduleId: string, text: string): void;
}

export interface WorkbenchState {
  moduleId?: string;
  module?: AnyModule;
  loading: boolean;
  text: string;
  analysis: Analysis;
  choices: ViewChoices;
  viewId?: string;
  svg?: string;
  rendering: boolean;
  renderError?: string;
  readOnly: boolean;
  /** Hay cambios respecto a lo que cargó el anfitrión o al último guardado. */
  modified: boolean;
  /** Mensaje del anfitrión (acción `status`) o de la propia interfaz. */
  status?: string;
  error?: string;
}

export interface SuiteCapabilities {
  protocol: string;
  suite: string;
  /** Todos los módulos que ofrece esta instancia (aunque no estén cargados). */
  available: string[];
  /** Capacidades de los módulos cargados o pedidos. */
  modules: ModuleCapabilities[];
}

export const EMPTY_CHOICES: ViewChoices = { views: [], traces: [] };

export interface LoadOptions {
  module?: string;
  viewId?: string;
  readOnly?: boolean;
  /** Rechazar (sin tocar el estado) un documento que no cumpla el esquema del módulo. */
  strict?: boolean;
}

export class InvalidDocumentError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'InvalidDocumentError';
  }
}

/**
 * Estado y operaciones del banco de trabajo, sin React: la interfaz se suscribe y el puente `postMessage` lo maneja con
 * las mismas operaciones, de modo que un anfitrión puede hacer exactamente lo que hace una persona.
 */
export class WorkbenchController {
  private state: WorkbenchState = {
    loading: false,
    text: '',
    analysis: { status: 'empty' },
    choices: EMPTY_CHOICES,
    rendering: false,
    readOnly: false,
    modified: false,
  };
  private listeners = new Set<() => void>();
  private loaded = new Map<string, AnyModule>();
  private renderToken = 0;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private selectToken = 0;

  constructor(
    readonly sources: ModuleSource[],
    private readonly options: { storage?: DraftStorage; suite?: string; protocol?: string; renderDelay?: number } = {},
  ) {}

  // ───────────── suscripción ─────────────

  getState = (): WorkbenchState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<WorkbenchState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  get moduleIds(): string[] {
    return this.sources.map((s) => s.id);
  }

  private source(id: string): ModuleSource {
    const source = this.sources.find((s) => s.id === id);
    if (!source) throw new Error(`Este banco de trabajo no ofrece el módulo «${id}». Módulos: ${this.moduleIds.join(', ')}.`);
    return source;
  }

  async loadModule(id: string): Promise<AnyModule> {
    const cached = this.loaded.get(id);
    if (cached) return cached;
    const module = await this.source(id).load();
    if (module.id !== id) throw new Error(`El módulo cargado como «${id}» se declara «${module.id}».`);
    this.loaded.set(id, module);
    return module;
  }

  // ───────────── módulo y documento ─────────────

  /**
   * Activa un módulo. Con `text` lo usa como contenido; si no, el borrador guardado o, la primera vez, el ejemplo del módulo.
   */
  async selectModule(id: string, initial?: { text?: string }): Promise<void> {
    if (id === this.state.moduleId && initial?.text === undefined) return;
    const token = ++this.selectToken;
    this.set({ loading: true, error: undefined });
    try {
      const module = await this.loadModule(id);
      let text = initial?.text ?? this.options.storage?.read(id) ?? undefined;
      if (text === undefined) text = (await this.source(id).example?.()) ?? '';
      if (token !== this.selectToken) return;
      this.apply(module, text, { modified: false });
    } catch (error) {
      if (token === this.selectToken) this.set({ loading: false, error: (error as Error).message });
    }
  }

  /** Aplica `text` como contenido del módulo `module` y recalcula todo lo derivado. */
  private apply(module: AnyModule, text: string, patch: { modified: boolean; viewId?: string; readOnly?: boolean }): void {
    const analysis = analyzeText(module, text);
    const choices = analysis.status === 'ok' ? viewChoices(module, analysis.document) : EMPTY_CHOICES;
    const previous = this.state.moduleId === module.id ? this.state.viewId : undefined;
    const wanted = patch.viewId ?? previous;
    const viewId = wanted && isKnownView(choices, wanted) ? wanted : choices.views[0]?.id;
    const moduleChanged = this.state.moduleId !== module.id;
    this.set({
      moduleId: module.id,
      module,
      loading: false,
      text,
      analysis,
      choices,
      viewId,
      modified: patch.modified,
      readOnly: patch.readOnly ?? this.state.readOnly,
      error: undefined,
      ...(moduleChanged ? { svg: undefined, renderError: undefined } : {}),
    });
    this.scheduleRender(0);
  }

  /** Edición del texto por la persona (o por el anfitrión con `merge`). */
  setText(text: string): void {
    const { module, readOnly } = this.state;
    if (!module || readOnly || text === this.state.text) return;
    this.apply(module, text, { modified: true });
    this.options.storage?.write(module.id, text);
    if (this.state.analysis.status === 'ok') this.scheduleRender(this.options.renderDelay ?? 250);
  }

  /**
   * Carga un documento (objeto o texto JSON) en el módulo indicado o en el activo. Con `strict` un documento inválido se
   * rechaza sin tocar el estado; si no, se muestra tal cual para que la persona vea los problemas.
   */
  async loadDocument(input: unknown, options: LoadOptions = {}): Promise<Analysis> {
    const module = await this.loadModule(options.module ?? this.state.moduleId ?? this.requireDefault());
    const text = typeof input === 'string' ? input : pretty(input);
    const analysis = typeof input === 'string' ? analyzeText(module, input) : analyzeValue(module, input);
    if (options.strict && analysis.status !== 'ok') throw asInvalid(analysis);
    this.selectToken += 1; // descarta una selección de módulo en curso
    this.apply(module, text, { modified: false, viewId: options.viewId, readOnly: options.readOnly });
    return this.state.analysis;
  }

  private requireDefault(): string {
    const first = this.sources[0];
    if (!first) throw new Error('El banco de trabajo no tiene módulos.');
    return first.id;
  }

  /** Sustituye el documento por el resultado de una importación o conversión (cuenta como cambio de la persona). */
  useDocumentText(text: string): void {
    const { module } = this.state;
    if (!module) return;
    this.apply(module, text, { modified: true });
    this.options.storage?.write(module.id, text);
  }

  async loadExample(): Promise<void> {
    const { moduleId } = this.state;
    if (!moduleId) return;
    const text = await this.source(moduleId).example?.();
    if (text === undefined) return;
    this.useDocumentText(text);
  }

  markSaved(): void {
    this.set({ modified: false });
  }

  setReadOnly(readOnly: boolean): void {
    this.set({ readOnly });
  }

  setStatus(status: string | undefined, modified?: boolean): void {
    this.set({ status, ...(modified === undefined ? {} : { modified }) });
  }

  // ───────────── vistas ─────────────

  /** `false` si la vista no existe en el documento actual. */
  setView(viewId: string): boolean {
    if (!isKnownView(this.state.choices, viewId)) return false;
    if (viewId !== this.state.viewId) {
      this.set({ viewId });
      this.scheduleRender(0);
    }
    return true;
  }

  scheduleRender(delay: number): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = setTimeout(() => void this.render(), delay);
  }

  /** Dibuja la vista activa. Con un documento inválido conserva el último dibujo válido. */
  async render(): Promise<void> {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    const { module, analysis, viewId } = this.state;
    if (!module || analysis.status !== 'ok') return;
    if (!canRender(module)) {
      this.set({ svg: undefined, rendering: false, renderError: `El módulo «${module.name}» no tiene vista de diagrama en este banco de trabajo.` });
      return;
    }
    const token = ++this.renderToken;
    this.set({ rendering: true });
    try {
      const svg = await renderSvg(module, analysis.document, viewId);
      if (token === this.renderToken) this.set({ svg, rendering: false, renderError: undefined });
    } catch (error) {
      if (token === this.renderToken) this.set({ rendering: false, renderError: (error as Error).message });
    }
  }

  // ───────────── operaciones sobre el documento actual ─────────────

  private current(): { module: AnyModule; document: unknown } {
    const { module, analysis } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    if (analysis.status !== 'ok') {
      const why = analysis.status === 'empty' ? 'el documento está vacío' : analysis.status === 'syntax' ? `no es JSON válido (${analysis.error})` : 'no cumple el esquema del módulo';
      throw new InvalidDocumentError(`No se puede continuar: ${why}.`, analysis.status === 'schema' ? analysis.issues : []);
    }
    return { module, document: analysis.document };
  }

  exportAs(format: string, viewId?: string): Promise<ExportedFile> {
    const { module, document } = this.current();
    return exportDocument(module, document, format, { viewId: viewId ?? this.state.viewId });
  }

  async importFrom(text: string, importerId?: string, context: { name?: string; file?: string } = {}): Promise<ImportResult> {
    const { module } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    const result = await importText(module, text, importerId, { name: context.name, file: context.file, fallbackName: context.file?.replace(/\.[^.]+$/, '') });
    this.useDocumentText(pretty(result.document));
    return result;
  }

  /** Informes y conversiones del módulo. Los informes leen el documento del editor; las conversiones, el que se les pasa. */
  run(command: string, run: CommandRun & { fromEditor?: boolean }): Promise<CommandOutput> {
    const { module } = this.state;
    if (!module) throw new Error('No hay ningún módulo activo.');
    return runCommand(module, command, { ...run, input: run.input ?? (run.fromEditor === false ? undefined : this.state.text) });
  }

  // ───────────── capacidades ─────────────

  /** Capacidades de los módulos pedidos (por defecto, todos: los carga si hace falta). */
  async capabilities(ids?: string[]): Promise<SuiteCapabilities> {
    const wanted = ids ?? this.moduleIds;
    const modules = await Promise.all(wanted.map((id) => this.loadModule(id)));
    return {
      protocol: this.options.protocol ?? '1.0',
      suite: this.options.suite ?? 'IArk - DIAgrams',
      available: this.moduleIds,
      modules: modules.map(moduleCapabilities),
    };
  }

  dispose(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.listeners.clear();
  }
}

function asInvalid(analysis: Exclude<Analysis, { status: 'ok' }>): InvalidDocumentError {
  if (analysis.status === 'empty') return new InvalidDocumentError('El documento está vacío.');
  if (analysis.status === 'syntax') return new InvalidDocumentError(`El documento no es JSON válido: ${analysis.error}`);
  return new InvalidDocumentError(`Documento inválido:\n${analysis.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}`, analysis.issues);
}
