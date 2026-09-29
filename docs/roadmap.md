# IArk - DIAgrams: hoja de ruta de la suite de arquitectura

Plan aprobado el 2026-09-29 con las recomendaciones de la propuesta (quinta especialidad: seguridad; monorepo con workspaces; federación por manifiesto).

## Estado

| Fase | Estado |
|---|---|
| 0 – Cimientos | **Hecha en su primera parte**: monorepo con workspaces, `@iark/kernel` (contrato `DomainModule`, `ModuleRegistry`, URN `urn:iark:<módulo>:<id>`, manifiesto `iark.manifest/1`, utilidades de importación e IA) y `@iark/domain-c4` (todo el modelo C4 actual como módulo `c4`). El grafo genérico se extrajo en la Fase 2 (layout y SVG); un modelo de elementos y vistas común sigue sin hacer falta. |
| 1 – Mermaid + importadores unificados | **Hecha**: `fromMermaid`/`toMermaid` en el núcleo, `iark import` unificado por módulo, `convert --to mermaid`, menús del frontend. Pendiente: vista previa renderizada de Mermaid (carga diferida de la librería `mermaid`). |
| 2 – Primer módulo vertical: Integraciones | **Hecha en el núcleo y el CLI** (2026-09-29): módulo `integration` (`packages/domain-integration`) con esquema, validación semántica, vistas derivadas (mapa y flujos), IA, import Mermaid, export Mermaid/SVG/draw.io y subcomandos `iark integration from-c4|catalog|matrix`. Para ello el kernel ganó lo genérico que pedía un segundo módulo: `AiSpec` + `generateStructured`, la sintaxis Mermaid compartida, layout ELK y render SVG de grafos, y el CLI acepta `--module` en `generate/import/convert/validate/schema/prompt`. El editor web y el widget embebido llegaron con la Fase 4 (banco de trabajo genérico y protocolo de módulos con `module` y `capabilities`). |
| 3 – Resto de módulos | **Hecha en el núcleo y el CLI** (2026-09-29): **Datos** hecho en el núcleo y el CLI (`packages/domain-data`): activos, dominios, pipelines con linaje aguas arriba y abajo, modelo entidad-relación, reglas de gobierno (clasificación y datos personales a lo largo del linaje), IA, import Mermaid (`flowchart` y `erDiagram`), export Mermaid/SVG/draw.io y `iark data lineage|catalog|pii|from-integration`. El kernel ganó el analizador común de `erDiagram`, fichas en el render SVG y `ModuleError` (los errores de módulo salen como mensaje limpio). **Empresarial** hecho en el núcleo y el CLI (`packages/domain-enterprise`): unidades, capacidades en árbol con madurez e importancia, procesos, aplicaciones y tecnología con ciclo de vida, mapa de capacidades, paisaje y vistas de impacto/dependencias/unidad, reglas de gobierno (cobertura, responsables, obsolescencia, duplicidades), IA, import Mermaid (con los tipos en las clases de los nodos, que el analizador del kernel ahora conserva), export Mermaid/SVG/draw.io y `iark enterprise coverage|impact|lifecycle|from-integration`. **Plataforma** hecho en el núcleo y el CLI (`packages/domain-platform`): entornos, redes anidadas, recursos con estado, servicios, despliegues en clústeres o máquinas del mismo entorno, dependencias (llamadas, mensajes, datos) y pipelines (CI, CD, IaC), topología, vista de despliegue por entorno (redes y anfitriones anidados), entrega continua y vistas de impacto acotadas al entorno, reglas de gobierno (servicio sin entorno, dependencia a recurso no aprovisionado o de otro entorno, paridad entre entornos, datos en red pública, puntos únicos de fallo, pipelines sin aprobación), IA, import Mermaid (entornos, redes y clústeres en los `subgraph`), export Mermaid/SVG/draw.io y `iark platform deployments|impact|from-integration`. **Seguridad** (la quinta especialidad, tomada como seguridad al aprobar las recomendaciones) hecho en el núcleo y el CLI (`packages/domain-security`): zonas de confianza anidadas, activos (actores, sistemas externos, procesos, almacenes), flujos con cifrado, autenticación y clasificación, amenazas STRIDE con riesgo y estado, controles, diagrama de flujo de datos con fronteras, modelo de amenazas y vistas de alcance/exposición de un activo, reglas de gobierno (fronteras sin cifrar ni autenticar, datos sensibles sin proteger, amenazas mal cerradas, cobertura STRIDE), IA, import Mermaid (zonas en los `subgraph`, cifrado en el tipo de flecha), export Mermaid/SVG/draw.io y `iark security risks|stride|exposure|from-integration|from-platform`. El kernel permite colorear los grupos del SVG. Pendiente: los editores web y el widget embebible de los módulos nuevos. |

## 1. Punto de partida (lo que ya existe en el repo)

- **Núcleo sin DOM** (`src/core`, exportado como `iark-diagrams/core`): modelo `C4Document` (elementos, relaciones, vistas C1/C2/C3), validación con zod y JSON Schema, autolayout con ELK, export a `.drawio`, importadores de `.drawio` y de Structurizr DSL, y generación con IA (`core/ai`, proveedores Anthropic, Foundry y OpenAI-compatible).
- **CLI** `c4diagram` (`src/cli`, commander): `generate`, import/export, layout, esquema.
- **Frontend** React + `@xyflow/react` + zustand (`src/app`).
- **Embebido** por iframe + `postMessage` con protocolo versionado y validado con zod (`src/embed/protocol.ts`, SDK de anfitrión `c4-embed`).
- Publicación: compilado estático a `gh-pages` con `npm run deploy:pages` (sin GitHub Actions).

Conclusión: la base ya tiene las tres piezas que la suite necesita (núcleo puro, CLI, embebido por protocolo). Lo que falta es **generalizar el modelo más allá de C4** y **empaquetar cada especialidad como módulo independiente**.

## 2. Arquitectura objetivo

### 2.1 Capas

1. **`@suite/kernel`** (evolución de `core`): lo común a todas las especialidades. Grafo genérico de elementos y relaciones con `kind` y `metadata` extensibles, vistas, validación, autolayout, exportadores (drawio, SVG, PNG), interfaz de importadores. C4 pasa a ser *un dominio más* sobre el kernel (`@suite/domain-c4`), sin cambiar su JSON actual (compatibilidad con la versión `1.0`).
2. **Módulos de dominio** (uno por especialidad), cada uno con: esquema propio (extiende el del kernel), reglas de validación, paleta/estilos, prompts de IA, importadores/exportadores específicos y sus vistas.
3. **Adaptadores de entrada** (comunes): draw.io, Structurizr DSL, Mermaid.
4. **Superficies**: frontend, CLI, servicio HTTP opcional y widget embebible.

### 2.2 Contrato de módulo (plugin)

Cada especialidad implementa una interfaz mínima, descubrible por manifiesto:

```ts
interface DomainModule {
  id: string;                 // 'integration' | 'data' | 'enterprise' | 'platform' | 'security' | ...
  version: string;
  schema: ZodType;            // documento del dominio
  views: ViewKind[];          // vistas soportadas y su layout
  validate(doc): Issue[];     // reglas del dominio
  importers?: Importer[];     // desde drawio/structurizr/mermaid/otros
  exporters?: Exporter[];
  aiPrompt(ctx): PromptSpec;  // instrucciones y JSON Schema para la IA
  cliCommands?: CommandSpec[];// subcomandos que el CLI registra dinámicamente
}
```

Así el CLI y el frontend cargan módulos por manifiesto y no conocen los dominios en tiempo de compilación.

### 2.3 Cómo se hace "federado, embebible y desacoplado"

- **Un paquete y una unidad desplegable por especialidad.** Monorepo con workspaces (npm workspaces) y `packages/kernel`, `packages/domain-*`, `packages/cli`, `packages/embed`, `apps/web`.
- **Tres formas de consumirlo, todas con el mismo contrato:**
  - *Librería* (import ESM), para integrarlo en Node o en un frontend propio.
  - *Widget embebible*: se extiende el protocolo iframe/`postMessage` actual con un campo `module` y un handshake `capabilities` (qué módulos y versiones ofrece esa instancia). El anfitrión no necesita conocer el interior. Alternativa posterior: Web Component (`<c4-suite module="data">`) para quien no quiera iframe.
  - *Microservicio HTTP* opcional (`POST /v1/{module}/validate|layout|export|generate`), sin estado, con el mismo JSON Schema; empaquetado en contenedor.
- **Federación** (decisión pendiente, ver §6): lo más simple y robusto es **federación por manifiesto**: cada módulo publica `/.well-known/c4suite.json` con id, versión, endpoints y URL del widget; un *shell* ligero descubre e integra módulos sin acoplarse a su código. Module Federation de Vite es una opción solo si se quiere compartir componentes React en tiempo de ejecución; añade acoplamiento de versiones de React, por eso no la recomiendo como primer paso.
- **Referencias entre módulos por id estable** (por ejemplo, un flujo de integración referencia a un contenedor C4 o a una entidad de datos por `urn:suite:{modulo}:{id}`), sin dependencia de código entre módulos. Esto permite trazabilidad sin acoplar.
- **Versionado y compatibilidad**: cada documento lleva `module` y `version`; el kernel migra entre versiones.

## 3. Las especialidades

| Módulo | Qué modela | Vistas iniciales | Reglas de validación de ejemplo |
|---|---|---|---|
| **Integraciones** | Sistemas, APIs, colas/tópicos, eventos, patrones EIP (router, transformador, agregador), contratos | Mapa de integración, flujo/secuencia de mensajes | Productor sin consumidor, contrato sin versión, dependencia circular síncrona |
| **Datos** | Entidades, almacenes, pipelines, linaje, dominios de datos, calidad | ER lógico, linaje de datos, mapa de dominios/almacenes | Dato sin dueño, pipeline sin origen, PII sin clasificación |
| **Empresarial** | Capacidades de negocio, procesos, aplicaciones, tecnología (estilo ArchiMate/TOGAF simplificado) | Mapa de capacidades, capacidad↔aplicación↔tecnología | Capacidad sin aplicación, aplicación sin dueño de negocio |
| **Plataforma** | Clústeres, servicios, entornos, redes, CI/CD, dependencias de plataforma | Despliegue por entorno, topología | Servicio sin entorno, dependencia a recurso no aprovisionado |
| **Seguridad** (quinta, ver §3.1) | Zonas de confianza, activos, flujos de datos, amenazas STRIDE, controles | Flujos de datos con fronteras, modelo de amenazas | Cruce de frontera sin cifrar, dato sensible sin proteger, amenaza crítica abierta |

### 3.1 Sobre la repetición "arquitectura empresarial"

En el mensaje aparece "arquitectura empresarial" dos veces, por lo que hay cuatro especialidades distintas y una probablemente omitida. Mi sugerencia, en orden:

1. **Arquitectura de seguridad** (recomendada): límites de confianza, flujos de datos sensibles, amenazas (STRIDE) y controles. Encaja con los otros cuatro módulos y se apoya en el mismo grafo.
2. **Arquitectura de soluciones / software**: es lo que hoy cubre C4; podría ser simplemente el dominio `c4` ya existente y no una quinta especialidad nueva.
3. **Arquitectura de negocio** (si "empresarial" se quiso repartir en negocio y TI).

El plan no depende de esta decisión: los cuatro módulos claros pueden empezar y el quinto se añade sin cambios al kernel.

## 4. CLI

- Hoy: `c4diagram generate | import | export | layout | schema`.
- Propuesta: mantener esos comandos y añadir el **selector de módulo**: `c4diagram generate --module data "…"`, y subcomandos que cada módulo registra (`c4diagram data lineage …`, `c4diagram integration validate …`). El CLI lee los módulos instalados (los paquetes `@suite/domain-*` presentes) y monta sus comandos y prompts de IA, de modo que **instalar un módulo extiende el CLI**.
- **Generar diagramas desde fuentes** (un solo comando, formato autodetectado, ya existe la detección para drawio/dsl):
  - `c4diagram import <archivo> [--module X] [--format drawio|dsl|mermaid]`.
  - `c4diagram generate --from-source <archivo> "instrucción"`: importa la fuente, la normaliza al modelo y la IA la refina/completa (por ejemplo, a partir de un `.drawio` o un `.dsl` genera el resto de vistas o cambia de dominio).
- **Mermaid**: el CLI y el núcleo necesitan un *parser* propio para los tipos que mapean bien al modelo (`flowchart`, `graph`, `sequenceDiagram`, `erDiagram`, `C4Context/C4Container` de Mermaid). Se devuelven advertencias por lo que no se pueda mapear, como ya hace `import/warnings.ts`.
- Modo agente: ampliar la salida `--json` y los JSON Schemas por módulo para que otras IA/agentes generen documentos sin clave de API (ya soportado hoy para C4).

## 5. Mermaid en el frontend

- **Entrada**: pegar/abrir código Mermaid y convertirlo al modelo (mismo importador del CLI, mismo `core`), con panel de advertencias.
- **Salida**: exportar cualquier vista a Mermaid (texto) para pegar en README/Confluence/GitHub, además del `.drawio` actual.
- **Vista previa opcional** del Mermaid renderizado (librería `mermaid`, carga diferida para no engordar el bundle).
- Pantalla propia "Importar" que unifique drawio, Structurizr y Mermaid con autodetección.

## 6. Hoja de ruta por fases

**Fase 0 – Cimientos (sin cambio funcional visible)**
- Convertir el repo en monorepo (workspaces) y extraer `kernel` + `domain-c4` de `core` manteniendo la API pública actual y todos los tests verdes.
- Definir `DomainModule`, el manifiesto y las referencias `urn:suite:…`.

**Fase 1 – Mermaid + importadores unificados** *(se puede empezar ya; es independiente de los dominios)*
- `fromMermaid` en el núcleo + tests; comando `c4diagram import` unificado; exportador a Mermaid; UI de importación en el frontend.

**Fase 2 – Primer módulo vertical: Integraciones o Datos**
- Elegir uno (recomiendo *Integraciones*, es el más cercano a C4) y llevarlo de extremo a extremo: esquema, validación, vistas, IA, subcomandos CLI y widget embebido. Sirve para validar el contrato de módulo antes de replicarlo.

**Fase 3 – Resto de módulos** (Datos, Empresarial, Plataforma; y Seguridad como quinta) sobre el contrato ya probado. Datos, Empresarial, Plataforma y Seguridad, hechos.

**Fase 4 – Federación y servicio**
- Manifiesto `/.well-known`, *shell* que descubre módulos, extensión del protocolo `postMessage` con `capabilities`, servicio HTTP en contenedor, Web Component.

**Fase 5 – Quinta especialidad** y trazabilidad entre módulos (vista transversal).

### Qué podemos empezar hoy
Fase 1 (Mermaid) y Fase 0 (extracción del kernel) no dependen de ninguna decisión pendiente de negocio y no rompen nada existente.

## 7. Riesgos y decisiones abiertas

- **Un solo modelo genérico vs modelos por dominio**: propongo kernel genérico + esquemas por dominio; evita un "mega esquema" pero exige disciplina en el kernel.
- **Compatibilidad**: el JSON C4 `1.0` actual debe seguir cargando sin cambios.
- **Despliegue**: mantener publicación estática en `gh-pages` para el frontend; el servicio HTTP y los contenedores son opcionales y viven fuera de Pages. No se reintroducen workflows de Actions.
- **Tamaño del bundle** al añadir Mermaid y varios dominios: carga diferida por módulo.
- **Alcance de "empresarial"**: definir cuánto de ArchiMate/TOGAF se cubre (recomiendo un subconjunto pequeño al inicio).

## 8. Decisiones que necesito de ti

1. ¿Cuál es la quinta especialidad? (recomendada: seguridad)
2. ¿Empezamos por Fase 0 + Fase 1 (Mermaid) mientras decides el resto?
3. ¿Monorepo con workspaces está bien, o prefieres mantener un solo paquete con subpaths?
4. ¿Federación por manifiesto (simple) o Module Federation (más acoplada)?
