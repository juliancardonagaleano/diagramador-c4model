import { z } from 'zod';
import { documentSchema } from '../core/model/schema';
import type { C4Document, LayoutDirection } from '../core/model/types';

/**
 * Protocolo postMessage entre la página anfitriona y el diagramador embebido
 * (`?embed=1&proto=json`), inspirado en el de draw.io (embed.diagrams.net).
 * Los mensajes son objetos JSON (o su serialización) con `event` (iframe → host)
 * o `action` (host → iframe).
 */

export const PROTOCOL_VERSION = '1.0';

export type ExportFormat = 'json' | 'drawio' | 'svg' | 'png';

// ───────────── host → iframe (action) ─────────────

export const loadActionSchema = z.object({
  action: z.literal('load'),
  document: z.union([documentSchema, z.string()]).optional(),
  autosave: z.boolean().optional(),
  title: z.string().optional(),
  readOnly: z.boolean().optional(),
  theme: z.enum(['light', 'dark']).optional(),
  viewId: z.string().optional(),
  /** Ejecutar autolayout al cargar (por defecto solo si faltan coordenadas). */
  autoLayout: z.boolean().optional(),
});

export const configureActionSchema = z.object({
  action: z.literal('configure'),
  theme: z.enum(['light', 'dark']).optional(),
  ui: z.enum(['full', 'min']).optional(),
  hideSidePanel: z.boolean().optional(),
  locale: z.string().optional(),
});

export const mergeActionSchema = z.object({
  action: z.literal('merge'),
  document: z.union([documentSchema, z.string()]),
  autoLayout: z.boolean().optional(),
});

export const exportActionSchema = z.object({
  action: z.literal('export'),
  format: z.enum(['json', 'drawio', 'svg', 'png']),
  /** Solo para drawio: notación C4 de draw.io (por defecto) o tarjetas estilo drawdb. */
  notation: z.enum(['c4', 'card']).optional(),
  viewId: z.string().optional(),
  /** Identificador libre que se devuelve en la respuesta para correlacionar. */
  requestId: z.string().optional(),
});

export const autoLayoutActionSchema = z.object({
  action: z.literal('autoLayout'),
  viewId: z.string().optional(),
  direction: z.enum(['auto', 'DOWN', 'RIGHT', 'UP', 'LEFT']).optional(),
  distribution: z.enum(['auto', 'centered', 'elk']).optional(),
  force: z.boolean().optional(),
});

export const setViewActionSchema = z.object({ action: z.literal('setView'), viewId: z.string() });
export const statusActionSchema = z.object({ action: z.literal('status'), message: z.string(), modified: z.boolean().optional() });
export const dialogActionSchema = z.object({
  action: z.literal('dialog'),
  title: z.string(),
  message: z.string(),
  button: z.string().optional(),
});
export const saveActionSchema = z.object({ action: z.literal('save'), exit: z.boolean().optional() });
export const exitActionSchema = z.object({ action: z.literal('exit') });

export const hostActionSchema = z.discriminatedUnion('action', [
  loadActionSchema,
  configureActionSchema,
  mergeActionSchema,
  exportActionSchema,
  autoLayoutActionSchema,
  setViewActionSchema,
  statusActionSchema,
  dialogActionSchema,
  saveActionSchema,
  exitActionSchema,
]);

export type HostAction = z.infer<typeof hostActionSchema>;
export type LoadAction = z.infer<typeof loadActionSchema>;

// ───────────── iframe → host (event) ─────────────

export interface InitEvent {
  event: 'init';
  version: string;
}
export interface ConfigureEvent {
  event: 'configure';
}
export interface LoadEvent {
  event: 'load';
  document: C4Document;
  viewId?: string;
}
export interface ChangeEvent {
  event: 'change' | 'autosave';
  document: C4Document;
}
export interface SaveEvent {
  event: 'save';
  document: C4Document;
  drawio?: string;
  exit: boolean;
}
export interface ExportEvent {
  event: 'export';
  format: ExportFormat;
  data: string;
  viewId?: string;
  requestId?: string;
}
export interface ExitEvent {
  event: 'exit';
  modified: boolean;
}
export interface ErrorEvent {
  event: 'error';
  message: string;
  issues?: Array<{ path: string; message: string }>;
  requestId?: string;
}
export interface LayoutDoneEvent {
  event: 'autoLayout';
  viewId?: string;
  direction?: LayoutDirection;
}

export interface ViewChangeEvent {
  event: 'viewChange';
  viewId: string;
  level: 'C1' | 'C2' | 'C3';
  scopeId?: string;
  title?: string;
}

export type EmbedEvent =
  | ViewChangeEvent
  | InitEvent
  | ConfigureEvent
  | LoadEvent
  | ChangeEvent
  | SaveEvent
  | ExportEvent
  | ExitEvent
  | ErrorEvent
  | LayoutDoneEvent;

/** Interpreta un `MessageEvent.data` (objeto o string JSON) como acción del anfitrión. */
export function parseHostAction(data: unknown): { ok: true; action: HostAction } | { ok: false; error: string } {
  let raw = data;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'El mensaje no es JSON válido' };
    }
  }
  if (!raw || typeof raw !== 'object' || !('action' in raw)) return { ok: false, error: 'Mensaje sin campo "action"' };
  const result = hostActionSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  }
  return { ok: true, action: result.data as HostAction };
}

export function isEmbedEvent(data: unknown): data is EmbedEvent {
  return !!data && typeof data === 'object' && 'event' in data && typeof (data as { event: unknown }).event === 'string';
}
