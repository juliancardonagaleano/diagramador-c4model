/**
 * Un error con su código de estado HTTP: lo que `iark serve` traduce en una respuesta JSON `{ error, ...extra }`.
 * `headers` son cabeceras de la respuesta de error (`WWW-Authenticate` en un 401, `Retry-After` en un 429).
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}
