import type { C4Document } from '../model/types';
import { documentToGenerated, generationJsonSchema } from './generationSchema';

/**
 * Prompt de sistema para generar modelos C4. Se usa tanto con la API de Claude
 * (salida estructurada) como impreso por `c4diagram prompt` para cualquier otro agente.
 */
export function systemPrompt(): string {
  return `Eres un arquitecto de software experto en el modelo C4 (c4model.com). Tu tarea es convertir
una descripción en lenguaje natural de un sistema en un modelo C4 estructurado en JSON.
NO produces coordenadas: el diagramador aplica autolayout después. Concéntrate en el modelo.

Reglas del modelo C4:
- Tipos de elemento: "person" (usuarios/roles), "softwareSystem" (sistemas completos), "container"
  (aplicaciones o almacenes de datos desplegables dentro de un sistema), "component" (agrupaciones de
  código dentro de un contenedor).
- Jerarquía obligatoria: un container tiene parentId = id de su softwareSystem; un component tiene
  parentId = id de su container. person y softwareSystem no tienen parentId (null).
- Marca external = true en sistemas de terceros o fuera del alcance del equipo (pasarelas de pago,
  correo, proveedores SaaS...). Las personas casi nunca son external.
- shape: "database" para bases de datos, "queue" para colas/brokers, "browser" para apps web servidas
  al navegador, "mobile" para apps móviles, null en otro caso.
- technology solo en container/component (p. ej. "Java, Spring Boot", "PostgreSQL", "React").
- Relaciones: description en presente y con sentido de origen→destino ("Consulta saldos en",
  "Envía correos usando"); technology con protocolo si es evidente ("HTTPS/JSON", "gRPC", "SMTP").
  Nunca crees relaciones de un elemento consigo mismo. Ids únicos.
- Ids: kebab-case ASCII, estables y descriptivos ("cliente", "api-pagos", "db-usuarios").

Vistas (elige según el nivel de detalle descrito):
- Una vista "systemContext" por cada softwareSystem interno (scopeId = ese sistema): incluye el sistema,
  las personas y los sistemas externos relacionados.
- Una vista "container" por cada softwareSystem interno que tenga contenedores (scopeId = el sistema):
  incluye sus contenedores más las personas y sistemas externos relacionados. No incluyas el scope en elementIds.
- Una vista "component" por cada container con componentes (scopeId = el contenedor): incluye sus
  componentes y los contenedores/sistemas externos con los que se relacionan.
- Crea componentes solo si la descripción los menciona o los pide explícitamente.
- Títulos de vista cortos ("Contexto - Banca", "Contenedores - Banca").

Responde en el idioma de la instrucción del usuario (nombres, descripciones, títulos). Sé concreto y
evita elementos genéricos que no aporte la descripción.`;
}

export function userPrompt(instruction: string, base?: C4Document): string {
  if (!base) return `Genera el modelo C4 para la siguiente descripción:\n\n${instruction}`;
  return (
    `Este es el modelo C4 actual en JSON:\n\n${JSON.stringify(documentToGenerated(base), null, 2)}\n\n` +
    `Aplica la siguiente instrucción de refinamiento y devuelve el modelo COMPLETO actualizado. ` +
    `Conserva los ids existentes de los elementos que no cambian (el usuario ya los ha posicionado) y ` +
    `solo añade, modifica o elimina lo que la instrucción requiera:\n\n${instruction}`
  );
}

export function retryPrompt(issues: string): string {
  return (
    `El modelo devuelto no pasó la validación. Corrige estos problemas y devuelve el modelo completo de nuevo:\n${issues}`
  );
}

/**
 * Prompt autocontenido (sistema + instrucción + esquema JSON) para usar con cualquier
 * IA o agente sin clave de API. La respuesta esperada es un JSON que cumple el esquema.
 */
export function standalonePrompt(instruction: string, base?: C4Document): string {
  return (
    `${systemPrompt()}\n\n` +
    `Responde ÚNICAMENTE con un objeto JSON (sin comentarios ni texto adicional) que cumpla este JSON Schema:\n` +
    `${JSON.stringify(generationJsonSchema(), null, 2)}\n\n` +
    `${userPrompt(instruction, base)}\n`
  );
}
