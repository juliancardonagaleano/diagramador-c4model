import { z } from 'zod';
import { RESOURCE_KINDS } from '../types';

/**
 * Forma declarativa de un paquete de iconos (JSON): lo que se guarda en `workspace.iconPacks` de un documento o en un archivo
 * `.json` suelto. Los trazados se escriben dentro de atributos SVG y de estilos draw.io, así que solo admiten datos de trazado
 * (comandos y números) y los colores solo `#rgb` o `#rrggbb`: un paquete no puede colar marcado.
 */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.eE+-]+$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export const MAX_ICONS_PER_PACK = 400;

const keySchema = z.string().regex(KEY, 'Debe empezar por letra o número y usar solo letras, números, «.», «_» o «-» (hasta 63 caracteres)');

export const iconPathSchema = z.string().min(2).max(800).regex(PATH_DATA, 'Un trazado SVG solo admite comandos de trazado (M, L, C, A, Z…) y números');

export const iconDefSchema = z.object({
  label: z.string().min(1, 'El nombre del servicio no puede estar vacío').max(80),
  paths: z.array(iconPathSchema).min(1, 'Un icono necesita al menos un trazado').max(24),
  kinds: z.array(z.union([z.enum(RESOURCE_KINDS), z.literal('network')])).optional(),
  keywords: z.array(z.string().min(1).max(60)).max(40).optional(),
});

export const iconPackSchema = z.object({
  id: keySchema,
  name: z.string().min(1, 'El nombre del paquete no puede estar vacío').max(80),
  provider: keySchema,
  color: z.string().regex(HEX_COLOR, 'El color de acento es #rgb o #rrggbb'),
  aliases: z.array(z.string().min(1).max(60)).max(20).optional(),
  icons: z.record(keySchema, iconDefSchema).refine((icons) => Object.keys(icons).length <= MAX_ICONS_PER_PACK, `Un paquete admite hasta ${MAX_ICONS_PER_PACK} servicios`),
});

/** JSON Schema de un paquete de iconos suelto (el que se carga desde un archivo). */
export function platformIconPackJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(iconPackSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>;
}
