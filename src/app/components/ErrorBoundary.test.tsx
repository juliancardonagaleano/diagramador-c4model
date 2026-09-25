// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): never {
  throw new Error('fallo de prueba');
}

describe('ErrorBoundary', () => {
  it('muestra un mensaje de fallback en vez de dejar la pantalla en blanco', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Ha ocurrido un error inesperado')).toBeInTheDocument();
    expect(screen.getByText('fallo de prueba')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recargar' })).toBeInTheDocument();
    spy.mockRestore();
  });

  it('renderiza a los hijos con normalidad cuando no hay error', () => {
    render(
      <ErrorBoundary>
        <div>todo bien</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('todo bien')).toBeInTheDocument();
  });
});
