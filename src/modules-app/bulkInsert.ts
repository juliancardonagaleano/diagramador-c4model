import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/** A partir de cuántas líneas una inserción de texto se aplica de una vez en vez de dejársela al navegador. */
export const BULK_INSERT_LINES = 200;

/** Cuenta los saltos de línea de `text`, parando en `limit` (no recorre más de lo necesario). */
function countLines(text: string, limit: number): number {
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1 && lines < limit; i = text.indexOf('\n', i + 1)) lines += 1;
  return lines;
}

/**
 * Chromium inserta un `insertText` de muchas líneas en un `<textarea>` línea a línea, recalculando el diseño de todo el
 * cuadro en cada salto: el coste crece con el cuadrado de las líneas (medido con un `manifest.json` de dbt de 128 KB y
 * ~5000 líneas: 38 s en una página vacía sin nada de la app, 53 s en el banco de trabajo). Es lo que pasa con `fill()` y
 * `keyboard.insertText()` de Playwright y con cualquier inserción sintética (dictado, extensiones); pegar de verdad
 * (Ctrl+V, menú contextual) no lo sufre (~120 ms) y no se toca.
 *
 * Mitigación: ante un `beforeinput` de tipo `insertText` con muchas líneas se cancela la inserción nativa y se aplica el
 * texto de una vez con `setValue` (el estado controlado de React), dejando el cursor al final de lo insertado. El
 * resultado visible es el mismo (mismo texto, mismo cursor); lo único que cambia es que ese cambio concreto no entra en
 * el historial de deshacer nativo del cuadro. Las pulsaciones normales, el IME y el pegado real no pasan por aquí.
 */
export function useBulkInsert(ref: RefObject<HTMLTextAreaElement | null>, setValue: (value: string) => void): void {
  const caret = useRef<number | undefined>(undefined);

  // Sin lista de dependencias: el cuadro puede montarse después (p. ej. cuando el módulo ya tiene importadores).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onBeforeInput = (event: InputEvent): void => {
      const data = event.data;
      if (event.inputType !== 'insertText' || !data || !event.cancelable || countLines(data, BULK_INSERT_LINES) < BULK_INSERT_LINES) return;
      event.preventDefault();
      const { selectionStart: start, selectionEnd: end, value } = el;
      caret.current = start + data.length;
      setValue(value.slice(0, start) + data + value.slice(end));
    };
    el.addEventListener('beforeinput', onBeforeInput);
    return () => el.removeEventListener('beforeinput', onBeforeInput);
  });

  // Tras pintar el texto nuevo, el cursor va al final de lo insertado (React deja el cursor al final del cuadro).
  useLayoutEffect(() => {
    const position = caret.current;
    if (position === undefined) return;
    caret.current = undefined;
    ref.current?.setSelectionRange(position, position);
  });
}
