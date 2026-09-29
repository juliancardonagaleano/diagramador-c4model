/**
 * Referencias entre módulos: `urn:iark:<módulo>:<id>`. Permiten que, por ejemplo, un flujo de integración apunte a un
 * contenedor C4 o a una entidad de datos sin depender del código del otro módulo.
 */
const MODULE_ID = /^[a-z][a-z0-9-]*$/;

export interface ParsedUrn {
  module: string;
  id: string;
}

export function formatUrn(module: string, id: string): string {
  if (!MODULE_ID.test(module)) throw new Error(`Identificador de módulo inválido: «${module}» (use minúsculas, dígitos y guiones).`);
  if (!id || /\s/.test(id)) throw new Error('El id de una URN no puede estar vacío ni contener espacios.');
  return `urn:iark:${module}:${id}`;
}

export function parseUrn(value: string): ParsedUrn | null {
  const m = /^urn:iark:([a-z][a-z0-9-]*):(\S+)$/.exec(value);
  return m ? { module: m[1], id: m[2] } : null;
}
