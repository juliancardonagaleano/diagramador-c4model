/**
 * Redacción de secretos: TODO texto que sale hacia un modelo (el contenido de los archivos del repositorio y el resumen
 * ya montado) pasa por `redactSecrets`, que sustituye el VALOR de cualquier cosa que parezca una credencial por
 * `[REDACTADO]` y deja intacta la clave (para que el modelo vea que existe una contraseña, no cuál es).
 *
 * Es la segunda barrera: la primera es no leer los archivos que se llaman como un secreto (`rules.ts`). Se prefiere pecar
 * de más (un `max_tokens: 4000` redactado no estropea nada) que de menos; cada patrón está cubierto en `redact.test.ts`
 * con secretos falsos pero con el formato real.
 *
 * Todas las expresiones son de coste lineal (sin cuantificadores anidados ni prefijos abiertos) porque se aplican a
 * texto de origen desconocido, también a líneas enormes (JS minificado).
 */

export const REDACTED = '[REDACTADO]';

export interface Redaction {
  text: string;
  /** Cuántos valores se han sustituido (no se guarda ni se devuelve ninguno de ellos). */
  count: number;
}

/**
 * Valores que son una referencia y no un secreto (`${DB_PASSWORD}`, `$DB_PASSWORD`, `process.env.X`, `{{ .Values.x }}`): se
 * dejan, porque dicen de dónde sale el secreto sin revelarlo. Una variable con valor por defecto (`${X:-changeme}`) NO
 * cuenta: ese valor por defecto sí puede ser real.
 */
const PLACEHOLDER = new RegExp(
  '^(?:' +
    [
      String.raw`\$\{[A-Za-z_][A-Za-z0-9_.]*\}$`,
      String.raw`\$\([^)]*\)$`,
      String.raw`\$[A-Z_][A-Z0-9_]*$`,
      String.raw`\{\{|\$\{\{`, // plantillas de Helm y expresiones de GitHub Actions
      String.raw`<[^<>]{0,60}>$`,
      String.raw`%[A-Za-z_][A-Za-z0-9_]*%$`,
      String.raw`process\.env|os\.environ|os\.getenv|System\.getenv|System\.getProperty|ENV\[|env\(|getenv\(`,
      String.raw`vault:|ssm:|secretsmanager:|aws-ssm:|!Ref|!Sub|!GetAtt`,
      String.raw`(?:var|local|data|module|each|random_[a-z_]+|aws_[a-z_]+|azurerm_[a-z_]+|google_[a-z_]+)\.[A-Za-z_]`, // referencias de Terraform
      String.raw`\[REDACTADO`,
    ].join('|') +
    ')',
);

function isPlaceholder(value: string): boolean {
  const bare = value.replace(/^["']|["']$/g, '');
  return bare.length === 0 || PLACEHOLDER.test(bare);
}

/** Sustituye el contenido de un valor conservando las comillas con las que venía. */
function maskValue(value: string): string {
  const quote = value[0];
  return (quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote) ? `${quote}${REDACTED}${quote}` : REDACTED;
}

/** Cadenas con formato propio (prefijo + cuerpo): se sustituyen enteras. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub (ghp_, gho_, ghu_, ghs_, ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic (sk-ant-…), etc.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g, // AWS access key id
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g, // Google API
  /\b[spr]k_(?:live|test)_[0-9A-Za-z]{16,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{16,}/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bhf_[A-Za-z0-9]{30,}/g, // Hugging Face
  /\bshp(?:at|ca|pa|ss)_[a-f0-9]{32}/g, // Shopify
  /\bdop_v1_[a-f0-9]{40,}/g, // DigitalOcean
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // JWT
  /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
  /\b[0-9a-f]{32}@(?:o\d+\.)?(?:[a-z0-9-]+\.)*sentry\.io/g, // DSN de Sentry (la clave va de usuario)
];

/** Bloques `-----BEGIN … PRIVATE KEY-----`: completos, o sin cierre (recortados) hasta el final del texto. */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_OPEN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/;

/** `Authorization: Bearer xxx`, `"Authorization": "Basic xxx"`, `proxy-authorization=xxx`. */
const AUTH_HEADER = /\b(authorization|proxy-authorization)(["']?[ \t]*[:=][ \t]*["']?)((?:bearer|basic|token|digest|negotiate)\s+)?([^\s"',;]+)/gi;
/** `Bearer <token>` suelto (ejemplos de curl, código de clientes HTTP). */
const BEARER = /\b(Bearer)\s+([A-Za-z0-9._~+/=-]{20,})/g;

/** Contraseña (o clave) dentro de una URL o cadena de conexión: `postgres://usuario:CLAVE@host/db`. */
const URL_USERINFO = /(:\/\/[^\s:@/'"<>]*:)([^\s'"<>/]+)@/g;

/** `curl -u usuario:clave`. */
const CURL_USER = /(\bcurl\b[^\n]*?\s-u\s+)([^\s]+)/g;

/** `--password=xxx`, `--token xxx` en comandos de Dockerfile, CI y scripts. */
const CLI_FLAG = /(--(?:password|passwd|token|secret|api-key|apikey|access-key|secret-key|client-secret)(?:[ =]+))("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi;

/** SQL: `CREATE USER app WITH PASSWORD 'x'`, `IDENTIFIED BY 'x'` (sin `=` ni `:`). */
const SQL_PASSWORD = /\b(password|identified[ \t]+by)([ \t]+)('(?:[^'\\\n]|\\.|'')*'|"(?:[^"\\\n]|\\.)*")/gi;

/** `"auth": "base64…"` de los `config.json` de Docker. */
const DOCKER_AUTH = /(["']_?auth["'][ \t]*:[ \t]*)("[^"\n]+"|'[^'\n]+')/g;

const VALUE = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[^\s"',;]+`;
/** Palabras que delatan que lo que sigue es una credencial (dentro del nombre de la clave, en cualquier posición). */
const KEYWORDS = [
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'token',
  String.raw`api[_-]?key`,
  'apikey',
  String.raw`access[_-]?key`,
  String.raw`private[_-]?key`,
  String.raw`account[_-]?key`,
  String.raw`shared[_-]?access[_-]?key`,
  String.raw`auth[_-]?key`,
  String.raw`signing[_-]?key`,
  String.raw`encryption[_-]?key`,
  String.raw`master[_-]?key`,
  'credential',
].join('|');
/**
 * `password = x`, `"api_key": "x"`, `DB_PASSWORD: x`, `jwtSecret => x`, `Pwd=x;`: una clave cuyo nombre contiene una de
 * estas palabras seguida de `=`, `:`, `:=` o `=>` y un valor (en la misma línea). El sufijo del nombre está acotado (40)
 * para que sea lineal.
 */
const ASSIGNMENT = new RegExp(String.raw`(${KEYWORDS})([A-Za-z0-9_.-]{0,40}["']?[ \t]*(?::=|=>|[:=])[ \t]*)(${VALUE})`, 'gi');
/** Cabecera de un valor de YAML en bloque (`password: |`, `- token: >-`): el secreto está en las líneas de debajo. */
const BLOCK_HEAD = new RegExp(String.raw`^([ \t]*(?:-[ \t]+)*)["']?[A-Za-z0-9_.-]{0,60}?(?:${KEYWORDS})[A-Za-z0-9_.-]{0,40}["']?[ \t]*:[ \t]*[|>][+-]?[0-9]?[ \t\r]*$`, 'i');

/** Sustituye el cuerpo (las líneas con más sangría que la clave) de los valores en bloque de YAML cuya clave delata un secreto. */
function redactBlockScalars(text: string): Redaction {
  if (!/[|>][+-]?[0-9]?[ \t\r]*$/m.test(text)) return { text, count: 0 };
  const lines = text.split('\n');
  const out: string[] = [];
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const head = BLOCK_HEAD.exec(lines[i]);
    if (!head) {
      out.push(lines[i]);
      continue;
    }
    const indent = head[1].replace(/-/g, ' ').length;
    out.push(lines[i].replace(/[|>][+-]?[0-9]?[ \t\r]*$/, REDACTED));
    count += 1;
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].length - lines[i + 1].trimStart().length > indent)) i += 1;
  }
  return { text: out.join('\n'), count };
}

/** Aplica una sustitución contando las coincidencias que de verdad cambian algo. */
function replaceCounting(text: string, re: RegExp, replace: (match: string, ...groups: string[]) => string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(re, (match: string, ...rest: unknown[]) => {
    // Los argumentos son: los grupos (`undefined` si no participaron), el desplazamiento y el texto entero.
    const groups = rest.slice(0, rest.findIndex((x) => typeof x === 'number')) as string[];
    const next = replace(match, ...groups);
    if (next !== match) count += 1;
    return next;
  });
  return { text: out, count };
}

export function redactSecrets(input: string): Redaction {
  let text = input;
  let count = 0;
  const apply = (re: RegExp, replace: (match: string, ...groups: string[]) => string): void => {
    const r = replaceCounting(text, re, replace);
    text = r.text;
    count += r.count;
  };

  apply(PEM_BLOCK, () => REDACTED);
  apply(PEM_OPEN, () => REDACTED);
  for (const re of TOKEN_PATTERNS) apply(re, () => REDACTED);

  apply(AUTH_HEADER, (match, name, sep, scheme, value) => (isPlaceholder(value) ? match : `${name}${sep}${scheme ?? ''}${REDACTED}`));
  apply(BEARER, () => `Bearer ${REDACTED}`);
  apply(URL_USERINFO, (match, head, secret) => (isPlaceholder(secret) ? match : `${head}${REDACTED}@`));
  apply(CURL_USER, (match, head, creds) => (isPlaceholder(creds) ? match : `${head}${REDACTED}`));
  apply(CLI_FLAG, (match, head, value) => (isPlaceholder(value) ? match : `${head}${maskValue(value)}`));
  apply(SQL_PASSWORD, (match, key, space, value) => (isPlaceholder(value) ? match : `${key}${space}${maskValue(value)}`));
  apply(DOCKER_AUTH, (_match, head, value) => `${head}${maskValue(value)}`);
  const blocks = redactBlockScalars(text);
  text = blocks.text;
  count += blocks.count;
  apply(ASSIGNMENT, (match, key, sep, value) => (isPlaceholder(value) ? match : `${key}${sep}${maskValue(value)}`));

  return { text, count };
}
