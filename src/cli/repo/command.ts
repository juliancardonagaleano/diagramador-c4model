import { InvalidArgumentError } from 'commander';
import { CliError, info } from '../io';
import { formatReport, formatSummary } from './format';
import { repoInstruction } from './prompt';
import { MAX_BUDGET_BYTES, scanRepo, type RepoDigest } from './scan';

/**
 * Pegamento entre el CLI y el escáner: opciones de `generate` y `prompt` (`--from-repo`, `--repo-budget`, `--dry-run`), su
 * validación y el aviso de lo que se envía. Nada de esto se expone por `iark serve`: leería el disco del servidor.
 */

export const FROM_REPO_HELP = 'dibuja la arquitectura leyendo la carpeta local de un repositorio: al modelo solo se envía un resumen acotado y sin secretos (ver «Privacidad» abajo)';
export const REPO_BUDGET_HELP = 'con --from-repo: tamaño máximo del resumen en KB (por defecto 60, máximo 1024)';
export const DRY_RUN_HELP = 'con --from-repo: imprime el prompt completo (lo que se enviaría) y, por stderr, los archivos incluidos y omitidos con su motivo; no llama a ningún modelo';

export const REPO_PRIVACY_HELP = `
Desde un repositorio (--from-repo <carpeta>):
  Lee una CARPETA LOCAL (no clona URLs ni usa credenciales de git) y envía al modelo, junto a tu instrucción, un resumen acotado:
  árbol de carpetas, lenguajes, rutas de componentes y el contenido recortado de los archivos que revelan la arquitectura (README
  y docs, manifiestos, Dockerfile y compose, Kubernetes/Helm/Terraform, OpenAPI/AsyncAPI/proto/GraphQL, CI, esquemas SQL, puntos
  de entrada). El resto del código fuente solo aparece como nombres de carpetas y archivos, nunca su contenido. Combínalo con
  --module y con --from (refinar un documento existente).

Privacidad:
  - No ejecuta git ni nada del repositorio, no sigue enlaces simbólicos y no sale de la carpeta; respeta .gitignore.
  - No lee .env* (ni sus valores ni sus nombres; de .env.example solo los NOMBRES), claves privadas, credenciales, .npmrc, .netrc,
    *.tfstate, terraform.tfvars ni documentos Secret de Kubernetes. Omite node_modules, dist, build, vendor, binarios y lockfiles.
  - Todo el texto incluido pasa por una redacción de secretos (tokens, claves de API, JWT, cabeceras Authorization, contraseñas
    en asignaciones y cadenas de conexión, claves privadas PEM): el valor se sustituye por [REDACTADO].
  - El contenido del repositorio va al modelo como datos, no como instrucciones.
  - Topes: presupuesto del resumen (--repo-budget), máximo de archivos y de bytes por archivo.
  - Antes de enviar, \`iark generate … --from-repo <carpeta> --dry-run\` (o \`iark prompt … --from-repo <carpeta>\`) muestra exactamente qué se enviaría, sin llamar a ningún modelo.`;

/** `--repo-budget`: KB (admite decimales) → bytes. */
export function parseRepoBudget(value: string): number {
  const kb = Number.parseFloat(value);
  if (!Number.isFinite(kb) || kb < 1 || kb * 1024 > MAX_BUDGET_BYTES) {
    throw new InvalidArgumentError(`El presupuesto del resumen debe ser un número de KB entre 1 y ${MAX_BUDGET_BYTES / 1024}.`);
  }
  return Math.round(kb * 1024);
}

export interface RepoFlags {
  fromRepo?: string;
  repoBudget?: number;
  dryRun?: boolean;
}

/** `--repo-budget` y `--dry-run` solo tienen sentido con `--from-repo`. */
export function assertRepoFlags(opts: RepoFlags): void {
  if (opts.fromRepo !== undefined) {
    if (opts.fromRepo.trim() === '') throw new CliError('--from-repo necesita la ruta de una carpeta.', 2);
    return;
  }
  if (opts.repoBudget !== undefined) throw new CliError('--repo-budget solo se usa junto con --from-repo <carpeta>.', 2);
  if (opts.dryRun) throw new CliError('--dry-run solo se usa junto con --from-repo <carpeta> (es la vista previa de lo que se enviaría).', 2);
}

export interface RepoContext {
  digest: RepoDigest;
  /** La instrucción del usuario con el resumen del repositorio incorporado. */
  instruction: string;
}

/** Escanea la carpeta de `--from-repo` y construye la instrucción ampliada; `undefined` si no se pidió. */
export function prepareRepo(instruction: string, opts: RepoFlags, moduleId: string): RepoContext | undefined {
  if (opts.fromRepo === undefined) return undefined;
  const digest = scanRepo(opts.fromRepo, { budgetBytes: opts.repoBudget });
  return { digest, instruction: repoInstruction(instruction, digest, moduleId) };
}

/** Dice por stderr qué lleva el resumen; con `sending` (generate sin --dry-run), que se va a enviar al modelo. */
export function reportRepoSummary(digest: RepoDigest, sending = false): void {
  info(formatSummary(digest));
  if (sending) info('Se enviará este resumen al modelo junto con tu instrucción; para ver el texto exacto antes de enviar, repite el comando con --dry-run.');
  if (digest.redactions > 0) info(`Aviso: se redactaron ${digest.redactions} valor(es) con aspecto de secreto; con --dry-run puedes ver exactamente qué texto se envía.`);
}

/** La lista de archivos incluidos y omitidos con su motivo (`--dry-run`), por stderr: stdout queda solo con el prompt. */
export function reportRepoFiles(digest: RepoDigest): void {
  info(formatSummary(digest));
  info(formatReport(digest));
}
