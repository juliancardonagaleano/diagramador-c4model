/**
 * Atajos del lienzo de los módulos. Son los mismos del editor C4 (Ctrl+Z, Ctrl+Y, Supr, Ctrl+L, Ctrl+rueda…) para que
 * los cinco diagramadores y el editor C4 se manejen igual.
 */
export type CanvasAction = 'undo' | 'redo' | 'delete' | 'layout' | 'fit' | 'deselect' | 'follow' | 'back';

export const CANVAS_SHORTCUTS: Array<[string, string]> = [
  ['Ctrl/⌘ + Z', 'Deshacer'],
  ['Ctrl/⌘ + Y · Ctrl/⌘ + Shift + Z', 'Rehacer'],
  ['Ctrl/⌘ + L', 'Autolayout de la vista (descarta las posiciones movidas)'],
  ['Supr / Retroceso', 'Borrar el elemento o la relación seleccionados'],
  ['Escape', 'Quitar la selección'],
  ['0', 'Ajustar a la ventana'],
  ['Ctrl/⌘ + rueda', 'Zoom'],
  ['Arrastrar desde un punto de conexión', 'Crear una relación del tipo elegido en la barra'],
  ['Doble clic en un elemento enlazado · Alt + ↓', 'Seguir el enlace a su elemento en otro módulo'],
  ['Alt + ↑', 'Volver al diagrama desde el que se llegó'],
];

export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** Traduce una pulsación en una acción del lienzo, o `undefined` si no es un atajo (o se está escribiendo en un campo). */
export function matchShortcut(e: KeyLike, typing: boolean): CanvasAction | undefined {
  if (typing) return undefined;
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (mod && key === 'y') return 'redo';
  if (mod && key === 'l') return 'layout';
  if (!mod && !e.altKey && (e.key === 'Delete' || e.key === 'Backspace')) return 'delete';
  if (!mod && !e.altKey && e.key === 'Escape') return 'deselect';
  if (!mod && !e.altKey && e.key === '0') return 'fit';
  if (!mod && e.altKey && e.key === 'ArrowDown') return 'follow';
  if (!mod && e.altKey && e.key === 'ArrowUp') return 'back';
  return undefined;
}
