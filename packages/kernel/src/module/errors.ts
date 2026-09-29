/**
 * Error de uso de un módulo (una entrada que no se puede importar, un activo que no existe…). Los módulos lo extienden
 * para sus propios errores: el CLI lo muestra como un mensaje de una línea, sin stack ni «error inesperado».
 */
export class ModuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleError';
  }
}
