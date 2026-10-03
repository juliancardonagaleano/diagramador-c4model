/** Un error con su código de estado HTTP: lo que `iark serve` traduce en una respuesta JSON `{ error, ...extra }`. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
