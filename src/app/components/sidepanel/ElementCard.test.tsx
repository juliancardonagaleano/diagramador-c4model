// @vitest-environment jsdom
// Nota: el Select de Semi UI (popup en portal, posicionado con mediciones de layout) no abre de
// forma fiable en jsdom, así que aquí solo se cubre lo que un `<input>` real permite probar. El
// caso de "cambiar de tipo limpia el padre incompatible" se prueba en dos capas ya cubiertas: la
// lógica pura en `core/model/factories.test.ts` (`isValidParentType`) y el flujo completo con
// Select real en `tests/e2e/sidepanel.spec.ts` (navegador de verdad, donde el popup sí funciona).
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from '../../store/documentStore';
import { ElementCard } from './ElementCard';

function elementNow(id: string) {
  return useDocumentStore.getState().doc.model.elements.find((e) => e.id === id)!;
}

describe('ElementCard', () => {
  beforeEach(() => {
    useDocumentStore.getState().loadSample();
  });

  it('se puede borrar el nombre y reescribirlo sin que el input rebote al valor anterior', async () => {
    const user = userEvent.setup();
    render(<ElementCard element={elementNow('cliente')} inActiveView selected />);
    const input = screen.getByDisplayValue('Cliente personal');

    await user.clear(input);
    // Vacío: el input refleja el borrador local (no se rompe ni salta al valor anterior).
    expect(input).toHaveValue('');
    // El store, mientras tanto, conserva el último nombre válido (no queda sin nombre).
    expect(elementNow('cliente').name).toBe('Cliente personal');

    await user.type(input, 'Cliente premium');
    expect(input).toHaveValue('Cliente premium');
    expect(elementNow('cliente').name).toBe('Cliente premium');
  });
});
