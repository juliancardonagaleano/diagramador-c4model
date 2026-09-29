/** Historial de deshacer/rehacer del lienzo: guarda el texto del documento antes de cada edición. */
export class EditHistory {
  private past: string[] = [];
  private future: string[] = [];

  constructor(private readonly limit = 100) {}

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Registra el texto que había ANTES de una edición. */
  record(before: string): void {
    if (this.past[this.past.length - 1] === before) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  /** Devuelve el texto anterior (y guarda `current` para rehacer), o `undefined` si no hay nada que deshacer. */
  undo(current: string): string | undefined {
    const previous = this.past.pop();
    if (previous === undefined) return undefined;
    this.future.push(current);
    return previous;
  }

  redo(current: string): string | undefined {
    const next = this.future.pop();
    if (next === undefined) return undefined;
    this.past.push(current);
    return next;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
