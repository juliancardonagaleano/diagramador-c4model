/**
 * Reglas del escáner sobre NOMBRES de carpetas y archivos: qué no se recorre, qué no se lee jamás (secretos), qué es binario
 * y qué revela la arquitectura (y con qué prioridad y tope de tamaño). Todo es por nombre y ruta; ninguna regla abre un archivo.
 */

/** Categorías de archivos «clave» (su contenido va al resumen), con el nombre que ve el modelo. */
export type RepoCategory = 'docs' | 'diagramas' | 'manifiesto' | 'contenedores' | 'api' | 'despliegue' | 'datos' | 'entrada' | 'config' | 'ci' | 'env';

export const CATEGORY_LABEL: Record<RepoCategory, string> = {
  docs: 'documentación',
  diagramas: 'diagrama existente',
  manifiesto: 'manifiesto de dependencias',
  contenedores: 'contenedores',
  api: 'contrato de API',
  despliegue: 'despliegue / infraestructura',
  datos: 'datos / esquema',
  entrada: 'punto de entrada',
  config: 'configuración',
  ci: 'integración continua',
  env: 'variables de entorno (solo nombres)',
};

/** Carpetas que no se recorren nunca (dependencias, salidas de compilación, cachés, editores). */
const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'jspm_packages',
  'dist',
  'build',
  'target',
  'out',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.cache',
  'coverage',
  '.nyc_output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.angular',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.idea',
  '.vscode',
  'obj',
  'Pods',
  '.dart_tool',
  '.terraform',
  '.serverless',
  'site-packages',
]);

export function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name);
}

/** Carpetas que contienen credenciales por convención: no se entra en ellas. */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.gcloud', '.secrets', 'secrets', '.config/gcloud']);

export function isSecretDir(name: string): boolean {
  return SECRET_DIRS.has(name);
}

const ENV_EXAMPLE = /^(?:\.env\.(?:example|sample|template|dist|defaults|tpl)|(?:example|sample|template)\.env|env\.(?:example|sample|template))$/i;

/** `.env.example` y parecidos: no se envían sus valores, pero sí los NOMBRES de las variables. */
export function isEnvExample(name: string): boolean {
  return ENV_EXAMPLE.test(name);
}

const SECRET_EXACT = new Set([
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.dockercfg',
  '.git-credentials',
  '.htpasswd',
  'htpasswd',
  '.envrc',
  '.vault-token',
  '.terraformrc',
  'terraform.rc',
  'kubeconfig',
  'wp-config.php',
  'local.settings.json',
  '.dev.vars',
  'google-services.json',
  'googleservice-info.plist',
  'master.key',
  'secring.gpg',
]);

const SECRET_PATTERNS: RegExp[] = [
  /^\.env(?:\.|$)/i, // .env, .env.local, .env.production…
  /\.env$/i, // prod.env
  /\.(?:pem|key|p12|pfx|jks|keystore|p8|ppk|gpg|kdbx|keytab)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /^credentials?(?:[._-]|$)/i,
  /^secrets?(?:[._-]|$)/i,
  /[-_.]secrets?\.[a-z]+$/i, // db-secret.yaml, app.secrets.json
  /\.tfstate(?:\.|$)/i,
  /\.tfvars(?:\.json)?$/i,
  /\.kubeconfig$/i,
  /^service[-_]?account.*\.json$/i,
  /(?:^|[-_.])vault\.ya?ml$/i,
  /\.vault$/i,
  /\.secrets?$/i,
];

/**
 * Motivo por el que un archivo se considera secreto por su nombre (y por tanto no se lee), o `undefined`. Los
 * `.env.example` no entran aquí: se tratan aparte (solo nombres de variables).
 */
export function secretReason(relPath: string): string | undefined {
  const segments = relPath.split('/');
  const name = segments[segments.length - 1];
  if (isEnvExample(name)) return undefined;
  for (const dir of segments.slice(0, -1)) if (isSecretDir(dir)) return `carpeta de credenciales (${dir}/)`;
  if (SECRET_EXACT.has(name.toLowerCase())) return `archivo de credenciales (${name})`;
  if (SECRET_PATTERNS.some((re) => re.test(name))) return /^\.env|\.env$/i.test(name) ? 'variables de entorno (.env): ni valores ni nombres' : `credenciales o claves (${name})`;
  return undefined;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'svg', 'tif', 'tiff', 'psd', 'avif', 'heic', 'icns', 'ai', 'eps']);
const BINARY_EXTENSIONS = new Set([
  'pdf', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war', 'ear', 'class', 'dll', 'exe', 'so', 'dylib', 'o', 'a', 'bin', 'dat', 'db', 'sqlite', 'sqlite3', 'mdb',
  'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'ogg', 'webm', 'pyc', 'pyo', 'wasm', 'iso', 'dmg', 'apk', 'ipa', 'nupkg', 'whl', 'egg',
  'map', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt',
]);
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'composer.lock', 'gemfile.lock',
  'go.sum', 'gradle.lockfile', 'packages.lock.json', 'pubspec.lock', 'mix.lock', 'flake.lock', 'uv.lock', 'podfile.lock', 'deno.lock',
]);

/** `imagen`, `binario` o `lockfile` si el nombre lo delata; si no, `undefined`. */
export function nonTextKind(name: string): 'imagen' | 'binario' | 'lockfile' | undefined {
  const lower = name.toLowerCase();
  if (LOCKFILES.has(lower)) return 'lockfile';
  if (lower === '.ds_store' || lower === 'thumbs.db') return 'binario';
  if (lower.endsWith('.min.js') || lower.endsWith('.min.css')) return 'binario';
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'imagen';
  if (BINARY_EXTENSIONS.has(ext)) return 'binario';
  return undefined;
}

export interface Classification {
  category: RepoCategory;
  /** Menor = antes. Desempata la profundidad de la ruta (lo más cercano a la raíz primero) y luego la ruta. */
  priority: number;
  /** Tope de bytes de contenido de este archivo. */
  cap: number;
}

const KB = 1024;

/** Cuota de cada categoría (fracción del presupuesto de contenido) antes de repartir lo que sobre. */
export const CATEGORY_SHARE: Record<RepoCategory, number> = {
  docs: 0.22,
  diagramas: 0.1,
  manifiesto: 0.17,
  contenedores: 0.12,
  api: 0.18,
  despliegue: 0.18,
  datos: 0.1,
  entrada: 0.08,
  config: 0.05,
  ci: 0.05,
  env: 0.03,
};

const CODE_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'java', 'kt', 'kts', 'rs', 'rb', 'php', 'cs', 'scala', 'ex', 'exs', 'swift', 'dart', 'clj', 'cpp', 'cc', 'c', 'h', 'hpp', 'vue', 'svelte', 'groovy', 'lua', 'pl', 'sh']);

const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'fixtures', 'fixture', '__fixtures__', 'testdata', 'test-data', 'mocks', '__mocks__', 'cypress']);

/** ¿Está en una carpeta de pruebas o de datos de prueba? Sus archivos describen las pruebas, no el sistema: van los últimos. */
export function isTestPath(relPath: string): boolean {
  return relPath.split('/').slice(0, -1).some((d) => TEST_DIRS.has(d.toLowerCase()));
}

export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  return lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
}

export function isCodeFile(name: string): boolean {
  return CODE_EXTENSIONS.has(extensionOf(name));
}

const MANIFESTS = /^(?:package\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|go\.mod|cargo\.toml|pyproject\.toml|requirements[^/]*\.txt|pipfile|setup\.py|setup\.cfg|composer\.json|gemfile|mix\.exs|pubspec\.yaml|build\.sbt|deno\.json|cmakelists\.txt|[^/]+\.csproj|[^/]+\.fsproj|[^/]+\.sln)$/i;
const DOC_NAMES = /(?:architect|arquitect|(?:^|[/_.-])adrs?(?:[/_.-]|$)|design|diseno|diseño|overview|context|decision|topolog|infra|deploy|integration|integracion|integración|data-?model|security|seguridad|(?:^|[/_.-])c4(?:[/_.-]|$))/i;
const ENTRY_NAMES = /^(?:main|app|server|application|program|startup|manage|__main__|wsgi|asgi|bootstrap|cli)\.[a-z]+$/i;
const K8S_DIRS = new Set(['k8s', 'kubernetes', '.k8s', 'deploy', 'deployment', 'deployments', 'manifests', 'charts', 'chart', 'helm', 'kustomize', 'overlays', 'infra', 'infrastructure', 'terraform', 'iac', 'ansible', 'cloudformation', 'pulumi', 'bicep']);
const SPEC_FILE = /^(?:openapi|swagger|asyncapi)[^/]*\.(?:ya?ml|json)$/i;

/**
 * ¿Qué papel juega este archivo en la arquitectura? `undefined` si no es uno de los archivos «clave» (el resto del código
 * aparece solo en el árbol de carpetas). Solo mira la ruta; los YAML sin pista en el nombre los rastrea `sniffYaml`.
 */
export function classify(relPath: string): Classification | undefined {
  const segments = relPath.split('/');
  const name = segments[segments.length - 1];
  const lower = name.toLowerCase();
  const dirs = segments.slice(0, -1);
  const depth = dirs.length;
  const ext = extensionOf(name);
  const inDir = (...names: string[]): boolean => dirs.some((d) => names.includes(d.toLowerCase()));

  if (isEnvExample(name)) return { category: 'env', priority: 9, cap: 4 * KB };

  // Diagramas que ya existen en el repositorio: la fuente más fiel de lo que el equipo cree que es su arquitectura.
  if (['dsl', 'puml', 'plantuml', 'pu', 'mmd', 'mermaid', 'd2'].includes(ext) || lower === 'workspace.dsl') return { category: 'diagramas', priority: 0.5, cap: 8 * KB };

  // Documentación.
  if (/^readme(?:\.[a-z]+)?$/i.test(name) && depth <= 2) return { category: 'docs', priority: 0, cap: depth === 0 ? 8 * KB : 4 * KB };
  if (/^(?:architecture|arquitectura|design|security|seguridad|system|overview)(?:[._-][^/]*)?\.(?:md|rst|adoc|txt)$/i.test(name) && depth <= 3) return { category: 'docs', priority: 0, cap: 6 * KB };
  if (['md', 'rst', 'adoc'].includes(ext) && inDir('docs', 'doc', 'documentation', 'adr', 'adrs', 'decisions', 'architecture', 'arquitectura') && depth <= 4) {
    const relevant = DOC_NAMES.test(relPath);
    return { category: 'docs', priority: relevant ? 0 : 10, cap: relevant ? 4 * KB : 2 * KB };
  }

  // Contratos de API.
  if (['proto', 'graphql', 'gql', 'avsc', 'wsdl'].includes(ext) && depth <= 5) return { category: 'api', priority: 3, cap: ext === 'proto' || ext === 'wsdl' ? 5 * KB : 6 * KB };
  if (SPEC_FILE.test(name)) return { category: 'api', priority: 3, cap: 12 * KB };

  // Contenedores.
  if (/^dockerfile(?:\.[^/]+)?$/i.test(name) || /^[^/]+\.dockerfile$/i.test(name) || lower === 'containerfile') return { category: 'contenedores', priority: 2, cap: 3 * KB };
  if (/^(?:docker-)?compose(?:\.[^/]+)?\.ya?ml$/i.test(name) || /^docker-compose[^/]*\.ya?ml$/i.test(name)) return { category: 'contenedores', priority: 2, cap: 8 * KB };
  if (lower === 'procfile') return { category: 'contenedores', priority: 2, cap: 1 * KB };

  // Despliegue e infraestructura.
  if (['tf', 'bicep'].includes(ext)) return { category: 'despliegue', priority: 4, cap: 4 * KB };
  if (/^(?:chart|kustomization|skaffold|pulumi|serverless|cdk|werf)\.(?:ya?ml|json)$/i.test(name)) return { category: 'despliegue', priority: 4, cap: 3 * KB };
  if (/^(?:app|template|samconfig)\.(?:ya?ml|toml)$/i.test(name) && (depth === 0 || inDir(...K8S_DIRS))) return { category: 'despliegue', priority: 4, cap: 3 * KB };
  if (/^values(?:[-.][^/]*)?\.ya?ml$/i.test(name) && inDir('charts', 'chart', 'helm', 'deploy', 'k8s', 'kubernetes')) return { category: 'despliegue', priority: 4, cap: 3 * KB };
  if (['yaml', 'yml'].includes(ext) && inDir(...K8S_DIRS) && !inDir('templates') && depth <= 5) return { category: 'despliegue', priority: 4, cap: 3 * KB };

  // CI.
  if (inDir('.github') && inDir('workflows') && ['yml', 'yaml'].includes(ext)) return { category: 'ci', priority: 8, cap: 2 * KB };
  if (/^(?:\.gitlab-ci\.ya?ml|jenkinsfile|azure-pipelines\.ya?ml|bitbucket-pipelines\.ya?ml|\.drone\.ya?ml|cloudbuild\.ya?ml|buildspec\.ya?ml)$/i.test(name) || (inDir('.circleci') && ext === 'yml')) {
    return { category: 'ci', priority: 8, cap: 2 * KB };
  }

  // Datos.
  if (lower === 'schema.prisma' || lower === 'schema.rb' || lower === 'dbt_project.yml' || ext === 'ddl') return { category: 'datos', priority: 5, cap: 6 * KB };
  if (ext === 'sql' || (inDir('migrations', 'migration', 'migrate', 'db') && ['sql', 'py', 'rb', 'cs'].includes(ext) && depth <= 5)) return { category: 'datos', priority: 5, cap: 3 * KB };

  // Manifiestos de dependencias.
  if (MANIFESTS.test(name)) return { category: 'manifiesto', priority: 1, cap: lower === 'pom.xml' ? 5 * KB : 4 * KB };

  // Configuración de aplicación (suelen declarar bases de datos, colas y servicios vecinos).
  if (/^(?:application(?:-[a-z0-9]+)?\.(?:ya?ml|properties)|appsettings(?:\.[a-z0-9]+)?\.json|bootstrap\.ya?ml)$/i.test(name) && depth <= 4) return { category: 'config', priority: 7, cap: 2 * KB };

  // Puntos de entrada.
  if (isCodeFile(name) && ((ENTRY_NAMES.test(name) && depth <= 3) || (/^index\.[a-z]+$/i.test(name) && depth <= 1) || (lower === 'main.go' && depth <= 4) || /(?:application|program|startup)\.(?:java|kt|cs)$/i.test(name))) {
    return { category: 'entrada', priority: 6, cap: 2 * KB };
  }

  return undefined;
}

/** Los archivos YAML sin pista en la ruta se abren (solo para clasificar) y se reconocen por su cabecera. */
export function sniffYaml(head: string): Classification | undefined {
  if (/^openapi:\s*\S/m.test(head) || /^swagger:\s*\S/m.test(head) || /^asyncapi:\s*\S/m.test(head)) return { category: 'api', priority: 3, cap: 12 * KB };
  if ((/^apiVersion:\s*\S/m.test(head) && /^kind:\s*\S/m.test(head)) || /^AWSTemplateFormatVersion:/m.test(head) || /^\s+Type:\s*["']?AWS::/m.test(head)) {
    return { category: 'despliegue', priority: 4, cap: 3 * KB };
  }
  return undefined;
}

const COMPONENT_NAMES = /(?:controller|resource|router|routes?|handler|service|repository|consumer|producer|listener|subscriber|publisher|gateway|client|adapter|worker|scheduler|saga|usecase|use_case|dao|entity|migration|processor|connector|facade|endpoint|resolver|gateway|broker)/i;

/** ¿El nombre de este archivo de código sugiere un componente (controlador, repositorio, consumidor…)? */
export function suggestsComponent(name: string): boolean {
  return isCodeFile(name) && COMPONENT_NAMES.test(name.replace(/\.[^.]+$/, ''));
}

/** Nombre legible de la tecnología según la extensión, para el resumen de lenguajes. */
export const LANGUAGE_NAMES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', go: 'Go', java: 'Java', kt: 'Kotlin', kts: 'Kotlin',
  rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', scala: 'Scala', ex: 'Elixir', exs: 'Elixir', swift: 'Swift', dart: 'Dart', clj: 'Clojure', cpp: 'C++', cc: 'C++', c: 'C', h: 'C/C++',
  hpp: 'C++', vue: 'Vue', svelte: 'Svelte', groovy: 'Groovy', sql: 'SQL', tf: 'Terraform', proto: 'Protobuf', graphql: 'GraphQL', gql: 'GraphQL', sh: 'Shell', yaml: 'YAML', yml: 'YAML',
  json: 'JSON', md: 'Markdown', html: 'HTML', css: 'CSS', scss: 'CSS', xml: 'XML', toml: 'TOML',
};
