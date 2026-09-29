const MAX_WARNINGS = 50;

/** Acumula los avisos de una importación, con un tope para que un archivo enorme no genere miles de líneas. */
export class Warnings {
  private list: string[] = [];
  private dropped = 0;

  add(message: string): void {
    if (this.list.length < MAX_WARNINGS) this.list.push(message);
    else this.dropped += 1;
  }

  result(): string[] {
    return this.dropped > 0 ? [...this.list, `… y ${this.dropped} aviso(s) más`] : this.list;
  }
}
