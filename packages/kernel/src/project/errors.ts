export type ProjectErrorCode =
  /** El proyecto o el diagrama no existe. */
  | 'not-found'
  /** Ya hay uno con ese nombre. */
  | 'exists'
  /** Nombre, módulo o contenido que no se pueden aceptar. */
  | 'invalid'
  /** Alguien cambió el diagrama desde que se leyó (ver `SaveDiagramInput.ifUpdatedAt`). */
  | 'conflict'
  /** El almacenamiento no está disponible (ventana privada, permisos, disco). */
  | 'unavailable';

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}
