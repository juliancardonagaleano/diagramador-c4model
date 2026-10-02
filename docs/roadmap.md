# IArk - DIAgrams: hoja de ruta de la suite de arquitectura

Plan aprobado el 2026-09-29 con las recomendaciones de la propuesta (quinta especialidad: seguridad; monorepo con workspaces; federación por manifiesto).

## Estado

| Fase | Estado |
|---|---|
| 0 – Cimientos | **Hecha en su primera parte**: monorepo con workspaces, `@iark/kernel` (contrato `DomainModule`, `ModuleRegistry`, URN `urn:iark:<módulo>:<id>`, manifiesto `iark.manifest/1`, utilidades de importación e IA) y `@iark/domain-c4` (todo el modelo C4 actual como módulo `c4`). El grafo genérico se extrajo en la Fase 2 (layout y SVG); un modelo de elementos y vistas común sigue sin hacer falta. |
| 1 – Mermaid + importadores unificados | **Hecha**: `fromMermaid`/`toMermaid` en el núcleo, `iark import` unificado por módulo, `convert --to mermaid`, menús del frontend. **Vista previa renderizada de Mermaid** (2026-09-29): Archivo ▸ Vista previa de Mermaid… en el editor C4 y Exportar ▸ Mermaid en el banco de trabajo, con la librería `mermaid` cargada solo al pedirla (`src/mermaid-preview`). |
| 2 – Primer módulo vertical: Integraciones | **Hecha en el núcleo y el CLI** (2026-09-29): módulo `integration` (`packages/domain-integration`) con esquema, validación semántica, vistas derivadas (mapa y flujos), IA, import Mermaid, export Mermaid/SVG/draw.io y subcomandos `iark integration from-c4|catalog|matrix`. Para ello el kernel ganó lo genérico que pedía un segundo módulo: `AiSpec` + `generateStructured`, la sintaxis Mermaid compartida, layout ELK y render SVG de grafos, y el CLI acepta `--module` en `generate/import/convert/validate/schema/prompt`. El editor web y el widget embebido llegaron con la Fase 4 (banco de trabajo genérico y protocolo de módulos con `module` y `capabilities`). |
| 3 – Resto de módulos | **Hecha en el núcleo y el CLI** (2026-09-29): **Datos** hecho en el núcleo y el CLI (`packages/domain-data`): activos, dominios, pipelines con linaje aguas arriba y abajo, modelo entidad-relación, reglas de gobierno (clasificación y datos personales a lo largo del linaje), IA, import Mermaid (`flowchart` y `erDiagram`), export Mermaid/SVG/draw.io y `iark data lineage|catalog|pii|from-integration`. El kernel ganó el analizador común de `erDiagram`, fichas en el render SVG y `ModuleError` (los errores de módulo salen como mensaje limpio). **Empresarial** hecho en el núcleo y el CLI (`packages/domain-enterprise`): unidades, capacidades en árbol con madurez e importancia, procesos, aplicaciones y tecnología con ciclo de vida, mapa de capacidades, paisaje y vistas de impacto/dependencias/unidad, reglas de gobierno (cobertura, responsables, obsolescencia, duplicidades), IA, import Mermaid (con los tipos en las clases de los nodos, que el analizador del kernel ahora conserva), export Mermaid/SVG/draw.io y `iark enterprise coverage|impact|lifecycle|from-integration`. **Plataforma** hecho en el núcleo y el CLI (`packages/domain-platform`): entornos, redes anidadas, recursos con estado, servicios, despliegues en clústeres o máquinas del mismo entorno, dependencias (llamadas, mensajes, datos) y pipelines (CI, CD, IaC), topología, vista de despliegue por entorno (redes y anfitriones anidados), entrega continua y vistas de impacto acotadas al entorno, reglas de gobierno (servicio sin entorno, dependencia a recurso no aprovisionado o de otro entorno, paridad entre entornos, datos en red pública, puntos únicos de fallo, pipelines sin aprobación), IA, import Mermaid (entornos, redes y clústeres en los `subgraph`), export Mermaid/SVG/draw.io y `iark platform deployments|impact|from-integration`. **Seguridad** (la quinta especialidad, tomada como seguridad al aprobar las recomendaciones) hecho en el núcleo y el CLI (`packages/domain-security`): zonas de confianza anidadas, activos (actores, sistemas externos, procesos, almacenes), flujos con cifrado, autenticación y clasificación, amenazas STRIDE con riesgo y estado, controles, diagrama de flujo de datos con fronteras, modelo de amenazas y vistas de alcance/exposición de un activo, reglas de gobierno (fronteras sin cifrar ni autenticar, datos sensibles sin proteger, amenazas mal cerradas, cobertura STRIDE), IA, import Mermaid (zonas en los `subgraph`, cifrado en el tipo de flecha), export Mermaid/SVG/draw.io y `iark security risks|stride|exposure|from-integration|from-platform`. El kernel permite colorear los grupos del SVG. Los editores web y el widget de los cinco módulos llegaron con la Fase 4. |
| 4 – Federación y servicio | **Hecha** (2026-09-29): el contrato `DomainModule` ganó `views`, `traceViews` y avisos por elemento para las superficies web. **Banco de trabajo** genérico `modulos.html` (`src/modules-app`, carga cada módulo bajo demanda) y **widget embebible** con un protocolo `postMessage` de módulos (acciones `load|configure|setView|export|validate|run|capabilities|…`, eventos con `requestId`, `capabilities` en el `init`) y SDK `createIarkModuleEmbed`. **Federación por manifiesto**: `/.well-known/iark.json` (`iark.manifest/1`, endpoints relativos `embed|schema|api`), JSON Schema publicados con el sitio y shell `suite.html` que descubre y monta los módulos de cualquier instancia. **Servicio HTTP** `iark serve` (`node:http`, sin dependencias; API por módulo y `/api/trace`; CORS opcional; sirve el sitio) y `Dockerfile`. **Web Component** `<iark-module>`. Las operaciones que comparten el banco de trabajo, el puente `postMessage` y el servicio HTTP viven en el kernel (`operations.ts`). |
| 5 – Trazabilidad entre módulos | **Hecha** (2026-09-29): referencias `ref: "urn:iark:<módulo>:<id>"` entre documentos, grafo transversal (`trace.ts` y su dibujo SVG `trace-svg.ts` en el kernel), `iark trace módulo=archivo… [--from --direction --depth --format markdown|mermaid|svg|json --strict]`, `POST /api/trace` (con SVG) y conservación de los `ref` al refinar con IA (`carryRefs`). **Vista web** `trazabilidad.html` (`src/trace-app`): reúne los documentos de los módulos, dibuja el grafo, lista enlaces y referencias sin resolver y calcula el alcance de un elemento. Los ejemplos traen la cadena empresarial → integración, plataforma → integración y seguridad → plataforma. |

| 6 – Identidad e interactividad de los diagramadores | **En curso** (2026-09-29). Los módulos se veían todos igual (JSON + imagen SVG) frente al editor C4 interactivo. **Marco común**: el contrato `DomainModule` gana `editor` (`EditorSpec`: notación de nodos y relaciones con figuras `rect|rounded|cylinder|pill|hexagon|chevron|pipe|bar|circle|card|actor|document`, proyección del documento a grafo, campos de propiedades por tipo, operaciones `addNode|addEdge|update|remove|canConnect`). Sobre él, un único **lienzo** (`src/modules-app/canvas`, React Flow) con paleta de figuras por especialidad, tipo de relación al conectar, panel de propiedades, deshacer/rehacer, autolayout ELK, posiciones arrastrables guardadas por vista, minimapa y los mismos atajos del editor C4 (Ctrl+Z/Y, Ctrl+L, Supr, Esc, 0). El banco de trabajo abre en la pestaña «Lienzo» cuando el módulo tiene lienzo y deja el JSON y el SVG en «Vista SVG». **Adoptado**: Integración (con la notación EIP completa de la ronda de profundización: ver el apartado siguiente) y **Datos** (linaje con pipelines como chevrones entre sus activos y contenedores como zonas; ERD con fichas de columnas editables como texto y relaciones con cardinalidad; clasificación en el borde y PII como insignia). **C4 en el banco**: pestaña «C4» cuyo lienzo es el editor principal embebido (`C4EmbedCanvas`, protocolo `postMessage` existente) sincronizado con la pestaña JSON; el módulo C4 va en su propio trozo del bundle (`advancedChunks`) y sus elementos admiten `ref` opcional, así que entra en la trazabilidad. **Enlaces entre diagramas** (`src/modules-app/links.ts`): un elemento con `ref` lleva insignia ⤷; doble clic o Alt+↓ abre el módulo destino con el elemento seleccionado y encuadrado, una miga de pan y Alt+↑ vuelven; el panel de propiedades elige el enlace por módulo y elemento (sin escribir URN) y lista «Referenciado por» con el grafo de trazabilidad del núcleo; en C4 los elementos enlazados se siguen desde una tira sobre el editor. **Empresarial** (`packages/domain-enterprise/src/editor.ts`): notación de capas al estilo ArchiMate (capacidad redondeada, proceso como flecha, aplicación como caja, tecnología como barra); el mapa de capacidades se dibuja anidado con la cuadrícula propia del módulo (`EditorSpec.layout`, nuevo gancho del núcleo para vistas con colocación propia en vez del autolayout ELK), color por madurez y borde por importancia; el paisaje y las vistas por unidad van por capas con insignias de criticidad, ciclo de vida y fin de soporte; las relaciones aplican `RELATION_RULES` en cualquier sentido del arrastre (arrastrar capacidad → aplicación crea `application supports capability`) y las propiedades eligen unidad responsable, capacidad padre y madurez sin escribir ids. **Plataforma** (`packages/domain-platform/src/editor.ts`): identidad de diagrama de despliegue reutilizando la escena del exportador (`buildScene`): en la vista de un entorno las redes son zonas anidadas coloreadas por exposición (roja pública, azul privada, gris aislada), los clústeres y máquinas contienen las instancias de los servicios, y cada clase de recurso tiene su figura (cilindro datos/caché/almacenamiento, píldora colas, hexágono balanceador y secretos, flecha pasarela, círculo DNS, ficha registro); la topología es plana y la entrega dibuja cada pipeline como zona con sus pasos. Relaciones: `llama a`/`envía mensajes a`/`usa los datos de` crean dependencias entre lo que hay detrás de cada nodo (una instancia es su servicio), `corre en` de un servicio a un clúster crea el despliegue en su entorno y `pasa por` añade un servicio a un pipeline o un recurso a un pipeline IaC. `EditorSpec.addNode` recibe ahora la vista abierta: un recurso o red nace en el entorno que se está viendo y un servicio nace desplegado en el anfitrión elegido. **Seguridad** (`packages/domain-security/src/editor.ts`): identidad del diagrama de flujo de datos del modelado de amenazas: procesos como círculos, almacenes como tubos abiertos, actores como figuras humanas, sistemas externos discontinuos, zonas de confianza anidadas coloreadas del rojo (no confiable) al verde (restringida) y flujos que distinguen por color si van cifrados (tres tipos de relación: flujo, flujo cifrado, flujo sin cifrar). En el modelo de amenazas cada amenaza es un hexágono coloreado por riesgo con su categoría STRIDE, unida a lo que amenaza («amenaza a», que solo admite categorías aplicables al tipo de elemento) y a los controles que la mitigan («mitiga»); una amenaza nueva recae sobre el elemento seleccionado. **Con esto los cinco módulos tienen lienzo propio.** **Una sola geometría de figuras** (`packages/kernel/src/graph/shapes.ts`): `shapeParts` describe cada figura como trazados SVG y la usan el lienzo (React), el exportador SVG del núcleo (`renderGraphSvg`) y los exportadores `.drawio` (`drawioShapeStyle`), con un mapa de figuras por módulo compartido entre editor y exportadores; así el SVG y el `.drawio` muestran lo mismo que el lienzo. **Exportación SVG/PNG de C4**: `toSvg` (`packages/domain-c4/src/export/svg`) dibuja una vista colocada con la misma geometría (persona como actor, base de datos como cilindro, cola como tubo, navegador como ficha, móvil redondeado) y es el exportador `svg` del módulo; el puente embebido responde `export('svg')` con ese SVG y `export('png')` rasterizándolo en el navegador (`src/app/embed/rasterize.ts`). **Vista previa al importar**: la pestaña «Importar» dibuja con Mermaid el texto pegado cuando parece Mermaid, antes de sustituir el documento. |

### Pendiente

- Ronda de profundización de Integración: **hecha** (2026-10-01). Notación EIP completa (API hexágono, pasarela flecha, broker barra, cola tubo, tópico abanico, almacén cilindro) y nuevos tipos: conector, tarea programada, usuario final, servidor MCP y nodo de patrón. **Contratos editables como metadata de las figuras** (`Contract.content`, `contractId` en nodos e interacciones): editor en la pestaña «Contratos» con validación y formateo de CloudEvents (formateador propio), `.proto` de gRPC, OpenAPI (JSON/YAML), MCP, AsyncAPI, JSON Schema, Avro, GraphQL y WSDL, y comandos `iark integration contracts|contract-export|cloudevents`. Patrones EIP como insignia con icono sobre la línea y como nodo intermedio, con las acciones que convierten uno en otro; orden de las interacciones (`order`) numerado por vista; reglas de conexión por tipo; vista de un sistema (`system:<id>`) y zonas por dominio con selección múltiple y las acciones «Agrupar en dominio», «Sacar del dominio» y «Agrupar por responsable». El kernel gana las figuras abanico, reloj y rombo, las insignias sobre la línea del SVG y, en `EditorSpec`, `actions` (operaciones sobre la selección) y `attachments` (documentos de texto con editor propio); `AiSpec.carry` conserva al refinar con IA lo que el modelo no genera (el texto de los contratos).
- Rondas de profundización de Seguridad, Datos, Empresarial y Plataforma: **hechas con las opciones recomendadas (★)** de las preguntas D/E/P/S del hilo «Rondas de profundización de las otras especialidades» (2026-10-02); el usuario todavía no ha contestado las de Datos, Empresarial y Plataforma, así que lo que falte se ajustará con sus respuestas, en PR nuevas desde master.
  - **Seguridad** (#19, #26, #27, #29): fronteras de confianza, sugerencia de amenazas, estándar de control en los controles, reglas de conexión y acciones de protección; matriz de calor 3×4 (probabilidad × impacto) con arrastre y riesgo residual tras los controles implementados (vistas `heatmap` y `heatmap:residual`), cobertura de estándares (`standards`, `standards:<estándar>`) y superficie de ataque; tipos de activo identidad, secreto y canal de confianza. En el CLI, `iark security risks` muestra el residual junto al inherente y los comandos nuevos `heatmap [--residual]` y `standards [--catalogo …]` imprimen lo mismo que el lienzo (el catálogo va como opción porque el CLI genérico pone los argumentos posicionales antes del archivo).
  - **Datos** (#20, #23): gobierno visible (clasificación y datos personales como insignias y mapa de calor), ERD con pata de gallo, reglas de conexión, acciones, contratos de datos y **linaje a nivel de columna** (mapeos por pipeline, vista de impacto de columna, avisos, editor, IA, ejemplo y `iark data column-impact`).
  - **Empresarial** (#21, #24, #31): capas ArchiMate con iconos, mapa de capacidades coloreable por madurez, importancia, criticidad o ciclo de vida, relaciones nuevas (`composes`, `flows-to`, `assigned-to`, `triggers`), metadatos (coste, usuarios, estrategia, fin de soporte), hoja de ruta del ciclo de vida, **flujos de valor** (etapas en cadena enlazables a capacidades) y servicios de negocio. La colocación del flujo de valor ordena las capacidades por baricentro de sus etapas y traza cada arista con un codo propio (0 cruces en el ejemplo, 11 antes); el lienzo pinta esas rutas (`EdgeRoute.sides` en el núcleo).
  - **Plataforma** (#22, #25, #28): figuras de infraestructura, zonas por exposición, reglas, metadatos (coste, SLO/SLA, región), vista de costes y acciones (promover, duplicar entorno, escalar réplicas, puerta de aprobación); **comparar dos entornos** (`compare:<A>:<B>`, informe y `iark platform compare`) con un emparejado de recursos que no adivina (nombre, nombre normalizado sin sufijos de entorno, tecnología solo si es inequívoca, clase solo para las que no se repiten) y que dice cómo emparejó cada par.
- **Imagen Docker: construida y probada de verdad** (2026-10-02, #30). Se construyó con un dockerd local, corre como `node` (no root), sirve el sitio y la API, pasa el HEALTHCHECK y se detiene limpiamente. La prueba destapó que el CLI compilado (`dist/cli/index.js`) no arrancaba en master desde los contratos editables (`yaml` se incrustaba en el bundle ESM); corregido con `yaml` como dependencia externa y una prueba que empaqueta el CLI con la configuración de tsup (`tests/cli-bundle.test.ts`).
- **Pruebas e2e estables** (2026-10-02, #32): el lienzo de los módulos publica `data-layout` (`pending` o `ready`: autolayout aplicado a la estructura actual y primer encuadre terminado) y las pruebas lo esperan con los ayudantes `canvasReady`/`selectView` (`tests/e2e/canvas-helpers.ts`) en vez de actuar sobre posiciones provisionales; se corrigió una carrera real del primer encuadre en `DiagramCanvas`; las páginas anfitrión con iframes usan `domcontentloaded` (con iframes `networkidle` no siempre llega) y `E2E_PORT` permite correr e2e en varios checkouts a la vez (por defecto 4173). Tres pasadas completas seguidas limpias (103 pruebas).
- Pendientes menores conocidos:
  - Pruebas e2e del editor C4 antiguo (`canvas-and-editing`, `header-and-export`, `navigation-and-layout`, `sidepanel`…): conservan `waitForTimeout` y `networkidle`; no han fallado, pero darían más robustez con una señal de «asentado» como la del lienzo de los módulos.
  - Docker: no se ha probado el mapeo `-p` con red de puente ni un build en una máquina con red normal (sin el proxy de este entorno); `node_modules` pesa 176 MB en la imagen (~160 son del frontend, que Vite ya empaqueta: moverlo a `devDependencies` la adelgazaría pero cambia el `package.json` publicado); el HEALTHCHECK consulta el puerto 8787 fijo.
  - Plataforma: un campo opcional `counterpartOf` en los recursos que gane a toda heurística al comparar (toca tipos, esquemas, IA, duplicar entorno y el editor), y que `counterpartResource` (re-apuntado de dependencias al promover) reutilice el emparejado de la comparación.
  - Empresarial: si una capacidad la comparten flujos de valor no adyacentes, la arista que sube puede pisar los flujos intermedios (haría falta ruta de más de un codo); el orden por baricentro no hace búsqueda local, así que con etapas no contiguas quedan algunos cruces.


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
