/** Id legible a partir de un nombre: sin tildes, en minúsculas y con guiones (como los de los demás importadores). */
export const slugify = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

/** Palabras de un nombre de columna (`Email_Cliente` → `email`, `cliente`), en minúsculas y sin tildes. */
const wordsOf = (name: string): string[] =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const PERSONAL_WORDS = new Set([
  'email', 'mail', 'correo', 'dni', 'nif', 'nie', 'ssn', 'telefono', 'tel', 'phone', 'movil', 'celular', 'mobile', 'iban', 'passport', 'pasaporte',
  'nacimiento', 'birthdate', 'birthday', 'apellido', 'apellidos', 'surname',
]);

/**
 * ¿El nombre de la columna recuerda a un dato personal (correo, DNI, teléfono…)? Solo sirve para sugerirlo en un aviso: un
 * nombre no basta para afirmar que la columna contiene datos personales, así que los importadores no la marcan como PII.
 */
export function looksPersonal(columnName: string): boolean {
  const words = wordsOf(columnName);
  return words.some((w) => PERSONAL_WORDS.has(w)) || (words.includes('name') && (words.includes('first') || words.includes('last')));
}

/** Frase de aviso con las columnas que parecen datos personales (`tabla.columna`), o `undefined` si no hay ninguna. */
export function personalHint(columns: Array<{ table: string; column: string }>): string | undefined {
  const found = columns.filter((c) => looksPersonal(c.column)).map((c) => `${c.table}.${c.column}`);
  if (found.length === 0) return undefined;
  const shown = found.slice(0, 12).join(', ');
  return `${found.length} columna(s) tienen nombre de dato personal (${shown}${found.length > 12 ? ', …' : ''}); se importan sin marcar como PII porque un nombre no lo demuestra: márcalas tú si lo son.`;
}
