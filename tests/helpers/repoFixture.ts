import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Ayudas de las pruebas de `--from-repo`: repositorios temporales y secretos FALSOS con el formato de los reales.
 *
 * Los secretos se construyen en tiempo de ejecución a partir de trozos (`['ghp_', '…'].join('')`): así ningún literal del
 * código fuente parece un token (los escáneres de secretos de GitHub y de otros servicios no tienen nada que marcar) y, a la
 * vez, el texto que se planta en los repositorios de prueba sí tiene el formato real que la redacción debe reconocer.
 */

const j = (...parts: string[]): string => parts.join('');

export const FAKE = {
  github: j('gh', 'p_', '1A2b3C4d5E6f7G8h9I0j', 'KlMnOpQrStUvWxYz1234'),
  githubFine: j('github', '_pat_', '11ABCDEFG0aBcDeFgHiJkL', '_mNoPqRsTuVwXyZ0123456789abcdefABCDEF'),
  aws: j('AK', 'IA', 'IOSFODNN7', 'EXAMPLE'),
  awsSecret: j('wJalrXUtnFEMI', '/K7MDENG/', 'bPxRfiCYEXAMPLEKEY'),
  openai: j('sk', '-proj-', 'Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90'),
  anthropic: j('sk', '-ant-', 'api03-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe'),
  slack: j('xo', 'xb-', '123456789012-1234567890123-', 'abcdefghijklmnopqrstuvwx'),
  stripe: j('sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc'),
  google: j('AI', 'za', 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'),
  jwt: j('eyJ', 'hbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.eyJ', 'zdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ', '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'),
  password: 'Tr0ub4dor&3-clave-falsa',
  dbPassword: 'hunter2-contrasena-falsa',
  connectionPassword: 'p4ssw0rd-de-la-url',
  bearer: j('abcdef0123456789', 'ABCDEF0123456789', 'tokenFalso'),
  pem: j('-----BEGIN ', 'RSA PRIVATE KEY-----\n', 'MIIEowIBAAKCAQEAfalsafalsafalsafalsafalsafalsa\n', 'c2VjcmV0b19mYWxzb19kZV9wcnVlYmE=\n', '-----END ', 'RSA PRIVATE KEY-----'),
  envValue: 'valor-secreto-del-env-1234',
  envOtro: 'otro-valor-secreto-9876',
  tfstate: 'valor-secreto-del-tfstate',
  base64Secret: 'c3VwZXItc2VjcmV0by1iYXNlNjQ=',
} as const;

/** Todos los valores falsos que no deben aparecer jamás en nada que salga hacia un modelo ni en una salida del CLI. */
export const ALL_FAKE_VALUES: string[] = Object.values(FAKE).flatMap((v) => (v.includes('\n') ? v.split('\n').filter((l) => l.length > 20) : [v]));

/** Crea un repositorio temporal con estos archivos (`ruta → contenido`) y devuelve su carpeta. */
export function makeRepo(files: Record<string, string | Buffer>, prefix = 'iark-repo-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

export function removeRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Copia el repositorio de ejemplo versionado (`tests/fixtures/repo-tienda`) a una carpeta temporal. */
export function copyFixtureRepo(name = 'repo-tienda'): string {
  const dir = mkdtempSync(join(tmpdir(), 'iark-fixture-'));
  cpSync(resolve('tests/fixtures', name), dir, { recursive: true });
  return dir;
}

/**
 * Planta secretos falsos en un repositorio (el de ejemplo copiado a una carpeta temporal): archivos que se llaman como un
 * secreto y secretos dentro de archivos que SÍ se incluyen en el resumen (README, compose, manifiestos, migraciones…).
 */
export function plantSecrets(dir: string): void {
  const put = (rel: string, content: string): void => {
    const file = join(dir, ...rel.split('/'));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  // Archivos que no se leen jamás.
  put('.env', `DATABASE_URL=postgres://app:${FAKE.connectionPassword}@db:5432/pedidos\nSTRIPE_SECRET=${FAKE.stripe}\nVARIABLE_SOLO_EN_ENV=${FAKE.envValue}\n`);
  put('.env.production', `JWT_SECRET=${FAKE.envOtro}\n`);
  put('config/server.pem', `${FAKE.pem}\n`);
  put('config/id_rsa', `${FAKE.pem}\n`);
  put('.npmrc', `//registry.npmjs.org/:_authToken=${FAKE.github}\n`);
  put('infra/terraform.tfstate', JSON.stringify({ outputs: { clave: { value: FAKE.tfstate } } }));
  put('infra/terraform.tfvars', `db_password = "${FAKE.dbPassword}"\n`);
  put('credentials.json', JSON.stringify({ aws_access_key_id: FAKE.aws, aws_secret_access_key: FAKE.awsSecret }));
  put('secrets.yaml', `apiVersion: v1\nkind: Secret\ndata:\n  password: ${FAKE.base64Secret}\n`);
  put('.env.example', `DATABASE_URL=postgres://app:${FAKE.connectionPassword}@db/pedidos\nAMQP_URL=amqp://guest:${FAKE.password}@broker\nPUERTO=3000\n# SOLO_COMENTARIO=${FAKE.envValue}\n`);
  // Secretos dentro de archivos que sí entran en el resumen.
  put(
    'README.md',
    `# Tienda\n\nClave de la API de pagos: ${FAKE.stripe}\nToken de despliegue: ${FAKE.github}\nAWS_ACCESS_KEY_ID=${FAKE.aws}\n\n` +
      `${FAKE.pem}\n\nLlamada de ejemplo:\n\n    curl -H "Authorization: Bearer ${FAKE.bearer}" https://api.tienda.example/pedidos\n\n` +
      `El servicio de pedidos usa PostgreSQL y RabbitMQ.\n`,
  );
  put(
    'docker-compose.yml',
    `services:\n  pedidos:\n    build: ./services/pedidos\n    environment:\n      DB_PASSWORD: ${FAKE.dbPassword}\n      DATABASE_URL: postgres://app:${FAKE.connectionPassword}@db:5432/pedidos\n` +
      `      OPENAI_API_KEY: ${FAKE.openai}\n      ANTHROPIC_API_KEY: ${FAKE.anthropic}\n      SLACK_TOKEN: ${FAKE.slack}\n      GOOGLE_KEY: ${FAKE.google}\n      SESION: ${FAKE.jwt}\n` +
      `  db:\n    image: postgres:16\n`,
  );
  put(
    'k8s/secretos.yaml',
    `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: pedidos\n---\napiVersion: v1\nkind: Secret\nmetadata:\n  name: pedidos-secreto\ndata:\n  clave: ${FAKE.base64Secret}\n---\napiVersion: v1\nkind: Service\nmetadata:\n  name: pedidos\n`,
  );
  put('db/migrations/002_semilla.sql', `-- Usuario de la aplicación\nCREATE USER app WITH PASSWORD '${FAKE.dbPassword}';\n`);
}
