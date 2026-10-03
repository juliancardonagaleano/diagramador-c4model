import { describe, expect, it } from 'vitest';
import { FAKE } from '../../../tests/helpers/repoFixture';
import { REDACTED, redactSecrets } from './redact';

/** Cada caso: un texto con un secreto falso (formato real) y el valor que no debe sobrevivir. */
const CASES: Array<{ name: string; text: string; secret: string }> = [
  { name: 'token de GitHub (ghp_)', text: `export GH_TOKEN=${FAKE.github}`, secret: FAKE.github },
  { name: 'token de GitHub de grano fino', text: `uses: ${FAKE.githubFine}`, secret: FAKE.githubFine },
  { name: 'clave de acceso de AWS (AKIA…)', text: `aws_access_key_id = ${FAKE.aws}`, secret: FAKE.aws },
  { name: 'clave secreta de AWS', text: `aws_secret_access_key = ${FAKE.awsSecret}`, secret: FAKE.awsSecret },
  { name: 'clave sk- de OpenAI', text: `client = OpenAI("${FAKE.openai}")`, secret: FAKE.openai },
  { name: 'clave sk-ant- de Anthropic', text: `key: ${FAKE.anthropic}`, secret: FAKE.anthropic },
  { name: 'token de Slack (xox…)', text: `slack: ${FAKE.slack}`, secret: FAKE.slack },
  { name: 'clave de Stripe (sk_live_)', text: `const stripe = require('stripe')('${FAKE.stripe}');`, secret: FAKE.stripe },
  { name: 'clave de API de Google (AIza…)', text: `https://maps.example/api?key=${FAKE.google}`, secret: FAKE.google },
  { name: 'JWT', text: `session=${FAKE.jwt}; path=/`, secret: FAKE.jwt },
  { name: 'cabecera Authorization: Bearer', text: `curl -H "Authorization: Bearer ${FAKE.bearer}" https://x.example`, secret: FAKE.bearer },
  { name: 'cabecera Authorization: Basic', text: `Authorization: Basic ${FAKE.bearer}`, secret: FAKE.bearer },
  { name: 'Bearer suelto', text: `fetch(url, { headers: { h: 'Bearer ${FAKE.bearer}' } })`, secret: FAKE.bearer },
  { name: 'password = valor', text: `password = ${FAKE.password}`, secret: FAKE.password },
  { name: 'DB_PASSWORD: valor (YAML)', text: `    DB_PASSWORD: ${FAKE.dbPassword}`, secret: FAKE.dbPassword },
  { name: '"password": "valor" (JSON)', text: `{"user":"app","password":"${FAKE.password}"}`, secret: FAKE.password },
  { name: 'secret / token / api_key con comillas', text: `jwtSecret: '${FAKE.password}'\napi_key = "${FAKE.dbPassword}"\nAUTH_TOKEN=${FAKE.envValue}`, secret: FAKE.password },
  { name: 'contraseña en una URL de conexión', text: `postgres://app:${FAKE.connectionPassword}@db:5432/pedidos`, secret: FAKE.connectionPassword },
  { name: 'contraseña con @ dentro de la URL', text: `redis://:p@ss${FAKE.envValue}@cache:6379`, secret: FAKE.envValue },
  { name: 'cadena de conexión de .NET (Password=…;)', text: `Server=db;Database=x;User Id=sa;Password=${FAKE.dbPassword};Encrypt=true`, secret: FAKE.dbPassword },
  { name: 'AccountKey de Azure Storage', text: `DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=${FAKE.base64Secret};EndpointSuffix=core.windows.net`, secret: FAKE.base64Secret },
  { name: 'SQL: WITH PASSWORD \'…\'', text: `CREATE USER app WITH PASSWORD '${FAKE.dbPassword}';`, secret: FAKE.dbPassword },
  { name: 'SQL: IDENTIFIED BY', text: `CREATE USER app IDENTIFIED BY "${FAKE.dbPassword}";`, secret: FAKE.dbPassword },
  { name: 'bandera --password de un comando', text: `RUN tool login --user ci --password ${FAKE.dbPassword}`, secret: FAKE.dbPassword },
  { name: 'curl -u usuario:clave', text: `curl -u admin:${FAKE.password} https://x.example`, secret: FAKE.password },
  { name: '«_auth» de un package.json o .npmrc en JSON', text: `{"_auth":"${FAKE.base64Secret}"}`, secret: FAKE.base64Secret },
  { name: '«auth» de un config.json de Docker', text: `{"auths":{"r.example":{"auth":"${FAKE.base64Secret}"}}}`, secret: FAKE.base64Secret },
  { name: 'valor en bloque de YAML (password: |)', text: `config:\n  password: |\n    ${FAKE.password}\n    segunda-linea-secreta\n  otro: 1\n`, secret: 'segunda-linea-secreta' },
  { name: 'bloque de clave privada PEM', text: `key = """\n${FAKE.pem}\n"""`, secret: 'MIIEowIBAAKCAQEAfalsafalsafalsafalsafalsafalsa' },
  {
    name: 'bloque PEM sin cierre (recortado)',
    text: `${FAKE.pem.split('\n').slice(0, 2).join('\n')}`,
    secret: 'MIIEowIBAAKCAQEAfalsafalsafalsafalsafalsafalsa',
  },
];

describe('redactSecrets', () => {
  it.each(CASES)('redacta $name', ({ text, secret }) => {
    const result = redactSecrets(text);
    expect(result.text).not.toContain(secret);
    expect(result.text).toContain(REDACTED);
    expect(result.count).toBeGreaterThan(0);
  });

  it('conserva la clave y sustituye solo el valor', () => {
    expect(redactSecrets(`DB_PASSWORD=${FAKE.dbPassword}`).text).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets(`password: ${FAKE.password}`).text).toBe(`password: ${REDACTED}`);
    expect(redactSecrets(`"api_key": "${FAKE.password}"`).text).toBe(`"api_key": "${REDACTED}"`);
    expect(redactSecrets(`postgres://app:${FAKE.connectionPassword}@db:5432/x`).text).toBe(`postgres://app:${REDACTED}@db:5432/x`);
    expect(redactSecrets(`Authorization: Bearer ${FAKE.bearer}`).text).toBe(`Authorization: Bearer ${REDACTED}`);
  });

  it('un valor en bloque de YAML se redacta entero sin llevarse por delante lo que sigue', () => {
    const yaml = ['config:', '  password: |', '    una-linea', '    otra-linea', '  otro: 1', '  - token: >-', '      muchas', '      lineas', 'fin: true'].join('\n');
    expect(redactSecrets(yaml).text).toBe(['config:', `  password: ${REDACTED}`, '  otro: 1', `  - token: ${REDACTED}`, 'fin: true'].join('\n'));
  });

  it('redacta varios secretos y los cuenta', () => {
    const text = `a=1\nDB_PASSWORD=${FAKE.dbPassword}\nTOKEN=${FAKE.github}\nlinea normal\npostgres://u:${FAKE.connectionPassword}@h/d\n`;
    const result = redactSecrets(text);
    expect(result.count).toBeGreaterThanOrEqual(3);
    expect(result.text).toContain('a=1');
    expect(result.text).toContain('linea normal');
    expect(result.text).not.toContain(FAKE.dbPassword);
    expect(result.text).not.toContain(FAKE.connectionPassword);
  });

  it('deja intactas las referencias a un secreto (dicen de dónde sale sin revelarlo)', () => {
    const text = [
      'password: ${DB_PASSWORD}',
      'token: $CI_TOKEN',
      'apiKey: process.env.API_KEY',
      'secret: {{ .Values.secret }}',
      'DB_PASSWORD=<tu-contraseña>',
      'password: os.environ["DB_PASSWORD"]',
      'NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
      'administrator_password = var.db_password',
      'secret_id = aws_secretsmanager_secret.api.id',
    ].join('\n');
    const result = redactSecrets(text);
    expect(result.text).toBe(text);
    expect(result.count).toBe(0);
  });

  it('no trata como referencia una variable con valor por defecto (el valor por defecto puede ser real)', () => {
    const result = redactSecrets('DB_PASSWORD: ${DB_PASSWORD:-pass-por-defecto-real}');
    expect(result.text).not.toContain('pass-por-defecto-real');
  });

  it('no estropea los campos de un manifiesto que solo referencian un Secret de Kubernetes', () => {
    const yaml = ['env:', '  - name: POSTGRES_PASSWORD', '    valueFrom:', '      secretKeyRef:', '        name: db-credentials', '        key: password'].join('\n');
    expect(redactSecrets(yaml).text).toBe(yaml);
  });

  it('no toca el texto corriente ni el código sin secretos', () => {
    const text = 'La API de pedidos publica pedido.creado en RabbitMQ.\nconst total = items.reduce((a, b) => a + b.precio, 0);\nhttps://api.pagos.example/v1/cobros\n';
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });

  it('es idempotente', () => {
    const once = redactSecrets(`password = ${FAKE.password}\ntoken: ${FAKE.github}\n${FAKE.pem}\n`);
    expect(redactSecrets(once.text)).toEqual({ text: once.text, count: 0 });
  });

  it('es lineal: una línea enorme (JS minificado) no la cuelga', () => {
    const started = Date.now();
    redactSecrets(`${'a'.repeat(1_000_000)}\n${'password'.repeat(50_000)}\n${'token: '.repeat(50_000)}\n${' '.repeat(200_000)}secret`);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
