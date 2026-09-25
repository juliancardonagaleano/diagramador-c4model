import { Button } from '@douyinfe/semi-ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Red de seguridad general: sin esto, cualquier excepción de render (un bug no previsto en un
 * componente, un documento inconsistente que llegó a la UI) deja la pantalla completamente en
 * blanco, sin ningún mensaje. El estado del documento vive en localStorage (zustand `persist`),
 * así que recargar no pierde el trabajo salvo el cambio que causó el error.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Error no controlado en el diagramador:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-lg font-semibold">Ha ocurrido un error inesperado</div>
        <div className="max-w-md text-sm text-color-3">{this.state.error.message}</div>
        <Button theme="solid" type="primary" onClick={() => window.location.reload()}>
          Recargar
        </Button>
      </div>
    );
  }
}
