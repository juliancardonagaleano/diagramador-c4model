# IArk - DIAgrams

> Antes «Diagramador C4». IArk - DIAgrams evoluciona hacia una suite de diagramación de arquitectura (integraciones, datos, empresarial, plataforma, seguridad…); hoy incluye el editor del **modelo C4**. El comando `c4diagram` se mantiene como alias de `iark`. Hoja de ruta: [`docs/roadmap.md`](docs/roadmap.md).

Editor web de diagramas del **modelo C4** (Contexto, Contenedores y Componentes) con:

- **JSON limpio y estable** como formato nativo, convertible 1‑a‑1 a **`.drawio`** (usa la librería C4 oficial de draw.io, con placeholders `%c4Name%`, `%c4Type%`, `%c4Description%`, `%c4Technology%`) y **importable desde `.drawio` y desde el DSL de Structurizr** (web y CLI).
- **Autolayout jerárquico** (ELK, algoritmo *layered* con boundaries anidados) como característica central: el mismo motor se usa en el navegador y en el CLI.
- **Editor interactivo** con la estética de [drawdb.app](https://www.drawdb.app/): cabecera con menús, toolbar flotante, panel lateral con pestañas y cards, panel de problemas, tema claro/oscuro, deshacer/rehacer, minimapa.
- **CLI `iark`** para generar diagramas a partir de **instrucciones en lenguaje natural** (Claude, salida estructurada), aplicar autolayout y convertir a `.drawio` sin abrir un navegador. Se puede usar sin clave de API con cualquier otra IA o agente.
- **Modo embebido** por `<iframe>` con protocolo **postMessage** al estilo de draw.io (`embed.diagrams.net`) y un SDK de anfitrión.
- **Suite de módulos** (integraciones, datos, empresarial, plataforma, seguridad) con **banco de trabajo web**, **widget embebible** (SDK y Web Component `<iark-module>`), **federación por manifiesto**, **servicio HTTP** (`iark serve`, con Dockerfile) y **trazabilidad entre módulos** (`iark trace`).

## Instalación

```bash
npm install
npm run dev        # editor web en http://localhost:5173
npm run build      # librería (dist/core), CLI (dist/cli), SDK de embebido (dist/embed) y app (dist/app)
npm test           # pruebas unitarias y de componente (vitest + Testing Library)
npm run test:coverage  # igual, con informe de cobertura (informativo, sin umbral que bloquee)
npm run e2e        # pruebas de extremo a extremo con @playwright/test (requiere build:app previo)
npm run verify     # typecheck + test + build + e2e, de punta a punta
npm run manifest   # regenera public/.well-known/iark.json (manifiesto de federación) a partir de los módulos registrados
npm run cli -- serve --static dist/app   # servicio HTTP + sitio en http://127.0.0.1:8787 (tras npm run build)
```

Requisitos: Node 20+.

## Pruebas

- **Unitarias y de componente** (`src/**/*.test.ts(x)`, vitest): cubren el núcleo (modelo, autolayout,
  export a `.drawio`, CLI), el store (`documentStore.test.ts`) y componentes React puntuales donde aporta algo que
  ni el store ni un E2E cubren mejor (`@testing-library/react`, entorno jsdom vía pragma
  `// @vitest-environment jsdom`). `npm run test:coverage` genera el informe (`@vitest/coverage-v8`).
- **Extremo a extremo** (`tests/e2e/*.spec.ts`, `@playwright/test`): recorren la app compilada (`vite preview`)
  en el Chromium del entorno. `playwright.config.ts` ya apunta a `CHROMIUM_PATH` (o
  `/opt/pw-browsers/chromium`) sin descargar un navegador propio, y guarda captura + traza solo si una prueba
  falla (`npx playwright show-trace test-results/.../trace.zip`).

## Despliegue (GitHub Pages)

La app es un sitio estático (`dist/app`), sin servidor: la generación con IA vive solo en el CLI. No hay workflow
de GitHub Actions: el sitio compilado se entrega en la rama `gh-pages` con `npm run deploy:pages`, que construye la
app con la ruta base `/<repositorio>/` y publica el resultado (solo el sitio compilado, más `.nojekyll`). La rama
se reescribe en cada publicación.

- Origen de Pages: *Settings → Pages → Build and deployment → Deploy from a branch → `gh-pages` / (root)*.
- URL: `https://<usuario>.github.io/<repositorio>/` (la demo del modo embebido queda en
  `.../examples/embed-host.html`).
- `vite.config.ts` usa `BASE_PATH` como `base`. En hostings que sirven en la raíz (Cloudflare Pages, Netlify,
  Vercel) basta con `npm run build:app` y la carpeta `dist/app`, sin definir `BASE_PATH`.

## Formato JSON

Un documento contiene un **modelo** compartido (elementos y relaciones) y N **vistas**. Las coordenadas son absolutas y opcionales: cualquier elemento sin `x`/`y` se posiciona con autolayout.

```jsonc
{
  "version": "1.0",
  "workspace": { "name": "Banca en línea" },
  "model": {
    "elements": [
      { "id": "cliente", "type": "person", "name": "Cliente", "description": "…" },
      { "id": "banca", "type": "softwareSystem", "name": "Banca en línea", "description": "…" },
      { "id": "api", "type": "container", "name": "API", "technology": "Node.js", "parentId": "banca" },
      { "id": "db", "type": "container", "name": "BD", "technology": "PostgreSQL", "parentId": "banca", "shape": "database" },
      { "id": "pagos", "type": "softwareSystem", "name": "Pasarela de pagos", "external": true }
    ],
    "relationships": [
      { "id": "r1", "sourceId": "cliente", "targetId": "banca", "description": "Usa", "technology": "HTTPS" },
      { "id": "r2", "sourceId": "api", "targetId": "db", "description": "Lee y escribe", "technology": "SQL" }
    ]
  },
  "views": [
    { "id": "ctx", "type": "systemContext", "scopeId": "banca", "title": "Contexto",
      "elements": [{ "id": "cliente" }, { "id": "banca" }, { "id": "pagos" }], "layout": { "direction": "DOWN" } },
    { "id": "cont", "type": "container", "scopeId": "banca", "title": "Contenedores",
      "elements": [{ "id": "cliente", "x": 120, "y": 40, "width": 200, "height": 170 }, { "id": "api" }, { "id": "db" }, { "id": "pagos" }] }
  ]
}
```

| Campo | Valores |
|---|---|
| `element.type` | `person`, `softwareSystem`, `container`, `component` |
| `element.parentId` | `container` → id de su `softwareSystem`; `component` → id de su `container` |
| `element.shape` | `default`, `database`, `queue`, `browser`, `mobile` |
| `element.external` | `true` para sistemas de terceros (se pintan en gris) |
| `view.type` | `systemContext`, `container`, `component` |
| `view.scopeId` | sistema (contexto/contenedores) o contenedor (componentes). En contenedores y componentes se dibuja como **boundary**; en contexto es un nodo más y **debe estar en `elements`** (el validador lo exige) |
| `view.layout.direction` | `DOWN`, `RIGHT`, `UP`, `LEFT` |
| `view.layout.density` | `auto`, `compact`, `spacious` |
| `view.layout.distribution` | `centered`, `elk` (la elegida por el último autolayout) o `auto` |
| `view.edges[]` | rutas del autolayout: `{ id, points: [{x,y}…], label?: {x,y} }` (opcional; se recalculan si quedan obsoletas) |

Reglas que se derivan automáticamente (no se almacenan):

- **Boundaries**: el `scopeId` de una vista de contenedores/componentes y cualquier elemento visible con hijos visibles.
- **Relaciones**: se dibujan las que unen dos elementos visibles; si un extremo no está visible pero sí su ancestro, se dibuja una relación *implícita* (una por par).

El JSON Schema está en [`schema/c4-document.schema.json`](schema/c4-document.schema.json) (`npm run schema` lo regenera; `iark schema` lo imprime). Los módulos de integraciones, datos, empresarial, plataforma y seguridad tienen los suyos en `schema/integration-*.schema.json`, `schema/data-*.schema.json`, `schema/enterprise-*.schema.json`, `schema/platform-*.schema.json` y `schema/security-*.schema.json`.

## Notación del lienzo

Por defecto los nodos usan la **notación C4 clásica** (c4model.com / Structurizr): cajas rellenas con el color del tipo y texto blanco, persona con cabeza, cilindro para bases de datos, cilindro horizontal para colas, ventana para apps web y dispositivo para apps móviles; los boundaries son rectángulos punteados con etiqueta abajo‑izquierda. En el menú **Ver** se puede cambiar a **Tarjetas (estilo drawdb)**. El `.drawio` exportado usa siempre las formas C4 de draw.io.

## Niveles C1 › C2 › C3 y navegación

Todas las vistas comparten un mismo modelo; el **tipo** de cada vista es su nivel: `systemContext` = **C1**, `container` = **C2**, `component` = **C3**, y el `scopeId` indica qué sistema o contenedor detalla. Entre niveles se navega:

- **Doble clic** en un sistema (en C1) abre su vista de contenedores; doble clic en un contenedor (en C2) abre su vista de componentes. Si la vista no existe se crea con los elementos sugeridos por el modelo y autolayout. Los nodos con nivel inferior muestran la marca `⤵`.
- **Breadcrumb** en la esquina inferior izquierda (`C1 Contexto · Banca › C2 Contenedores · Banca › C3 Componentes · API`): cada tramo es clicable y el botón ↑ **sube de nivel** (`Alt+↑`; `Alt+↓` baja al nivel del elemento seleccionado).
- En el `.drawio`, los sistemas y contenedores con vista hija llevan un enlace `data:page/id,<vista>`, así que en draw.io también se salta de página con Ctrl/⌘ + clic.
- En modo embebido, cada cambio de vista emite el evento `viewChange { viewId, level, scopeId, title }` y el anfitrión puede navegar con `setView`.

## Autolayout inteligente

El autolayout no acepta el primer resultado de ELK: **mide la calidad** del diagrama y **se autocorrige**.

1. **Etiquetas con espacio**: cada relación se envía a ELK con el tamaño estimado de su etiqueta (`elk.edgeLabels`), así que las capas dejan hueco real y las etiquetas nunca caen sobre un nodo.
2. **Rutas ortogonales reales**: las rutas y posiciones de etiqueta que calcula ELK se guardan en la vista (`view.edges[]`, coordenadas absolutas) y son las que dibuja la app y las que se exportan como waypoints al `.drawio`. Si mueves un nodo, sus rutas se descartan y esa arista pasa a usar **puertos virtuales**: los puntos de salida se reparten a lo largo del lado para que las aristas que comparten nodo no se superpongan.
3. **Densidad adaptativa**: el espaciado crece con las relaciones por nodo (`spacing = base × (1 + 0.25·min(relaciones/nodo, 3))`); en Ajustes o con `--density` se puede forzar `compact`, `auto` o `spacious`.
4. **Convenciones C4**: las personas sin relaciones entrantes van en la primera capa y los sistemas externos "sumidero" en la última, para que todas las vistas se lean igual.
5. **Métrica y candidatos**: cada candidato se puntúa por cruces entre aristas, aristas que atraviesan nodos, etiquetas solapadas, área y proporción. Se prueban varias estrategias (`BRANDES_KOEPF`, `NETWORK_SIMPLEX`, `LINEAR_SEGMENTS`, espaciado ampliado y, si persisten cruces, `LAYER_SWEEP` exhaustivo) y se elige la mejor; se detiene en cuanto una sale limpia. La toolbar muestra el resultado ("✓ 0 cruces · 0 solapes") y el CLI lo imprime por vista. `--fast` hace una sola pasada.

## Direcciones y distribución

El autolayout admite las cuatro direcciones (arriba→abajo, izquierda→derecha, derecha→izquierda, abajo→arriba) y dos distribuciones:

- **Centrada y uniforme**: capas equiespaciadas, nodos de cada capa con la misma separación y cada capa centrada sobre el eje común; los hijos de un boundary quedan contiguos y los elementos exteriores fuera de él. Las aristas se enrutan con un router propio que esquiva nodos y boundaries por corredores libres y coloca las etiquetas donde no pisen nada.
- **ELK**: la colocación de ELK con sus rutas ortogonales.

Por defecto (`direction: auto`, `distribution: auto`) la prioridad depende del nivel:

| Nivel | 1.º | 2.º | 3.º |
|---|---|---|---|
| C1 (contexto) | ↓ centrado | ↓ ELK | → centrado / ELK |
| C2 y C3 (contenedores, componentes) | → centrado | → ELK | ↓ centrado / ELK |

Se elige el primer candidato limpio (0 cruces, 0 solapes); si ninguno lo es, el de mejor puntuación ("el que más se ajuste"). En la toolbar, el desplegable junto a Autolayout permite forzar dirección y distribución; el texto de calidad muestra la elección (`✓ 0 cruces · 0 solapes · → centrado`). En el CLI: `--direction auto|down|right|left|up` y `--distribution auto|centered|elk`. En el embebido: `autoLayout { direction, distribution }`.

## Conversión a `.drawio`

Cada vista se convierte en una página de draw.io. Los elementos se envuelven en `<object placeholders="1" c4Name=… c4Type=… c4Description=… c4Technology=…>` con los estilos de la librería C4 (`shape=mxgraph.c4.person2`, `cylinder3` para bases de datos, boundary punteado, relaciones ortogonales). Los hijos de un boundary cuelgan de su celda con geometría relativa, tal como los crea draw.io. El archivo se escribe sin comprimir, así que draw.io / diagrams.net lo abre directamente y se puede versionar en git.

```bash
npx iark convert examples/banca.json --out banca.drawio          # aplica autolayout si faltan coordenadas
npx iark convert examples/banca.json --locale en --view contexto  # etiquetas de tipo en inglés, una sola vista
npx iark convert examples/banca.json --notation card --out banca-tarjetas.drawio  # tarjetas estilo drawdb
```

Dos **notaciones** de figuras (`--notation`, menú Archivo o `toDrawio(doc, { notation })`):

- `c4` (por defecto): librería C4 oficial de draw.io (persona, sistema, contenedor, componente, cilindro).
- `card`: tarjetas estilo drawdb (rectángulo claro con franja del color C4, nombre, `[Tipo: tecnología]` y descripción); las bases de datos y colas conservan el cilindro con relleno claro.

Los archivos [`examples/banca-c4.drawio`](examples/banca-c4.drawio) y [`examples/banca-tarjetas.drawio`](examples/banca-tarjetas.drawio) son el ejemplo de banca exportado en cada notación (3 páginas, enlaces entre niveles y waypoints del autolayout).

## Importar un `.drawio`

Un diagrama de draw.io se puede convertir en un documento C4 (cada **página** pasa a ser una **vista**), tanto en la web (**Archivo ▸ Importar .drawio…**, pide confirmación si hay cambios sin guardar) como en el CLI (`iark import` deduce el formato de la extensión o del contenido; también hay un [DSL de Structurizr](#importar-un-dsl-de-structurizr)):

```bash
npx iark import examples/banca-c4.drawio --out banca.json     # el nombre del diagrama sale del archivo (o --name)
npx iark import diagrama.drawio | npx iark layout --stdin --force > reordenado.json   # descartando las posiciones
cat diagrama.drawio | npx iark import --stdin
```

En el CLI lo importado va a stdout (o a `--out`) y el resumen y los avisos a stderr, así que se puede encadenar con `validate`, `layout` y `convert`. Un archivo que no es de draw.io termina con el código 2 y un motivo de una línea.

Qué reconoce, de más a menos fiel:

- **Un `.drawio` exportado por esta herramienta** (ambas notaciones): recupera los ids, tipos, descripciones, tecnologías, `external`, `shape`, `color`, jerarquía (`parentId`), relaciones, vistas (título, tipo, alcance) y las posiciones y tamaños absolutos. Los ids escritos a propósito (kebab-case, como `web-app` o `r1`) se conservan también en `.drawio` de versiones anteriores de la herramienta o hechos a mano; los aleatorios de draw.io se sustituyen por un id derivado del nombre.
- **La librería C4 de draw.io** (`c4Name`, `c4Type`, `c4Description`, `c4Technology`, en español o inglés): los tipos salen de `c4Type`, "externo" del `c4Type` o del color de relleno, y la jerarquía del boundary que contiene cada forma. Un elemento con el mismo nombre y tipo en varias páginas es un único elemento.
- **Formas sueltas** (sin metadatos): nombre = primera línea del texto, `[Tipo: tecnología]` en una línea aparte fija el tipo y la tecnología, el resto es la descripción; una persona (`umlActor`) o un cilindro (base de datos, o cola si está girado) se reconocen por su forma; y sin más pistas el tipo lo da el anidamiento: sistema › contenedor › componente. Las flechas toman su descripción del texto y `[tecnología]`.
- Se leen las páginas **comprimidas** (el formato por defecto de versiones antiguas de draw.io) y un `<mxGraphModel>` suelto (*Extras ▸ Editar diagrama*).

Cómo se decide cada vista: un boundary de sistema (o de contenedor) que envuelve las formas de la página es su alcance y la vista pasa a ser de contenedores (o de componentes); sin boundary, se usa el enlace `data:page/id,…` de un sistema o contenedor que apunte a la página y, si no, el contenido.

Lo que **no** se importa (siempre se avisa, sin detener la importación): notas de texto suelto, formas sin texto, capas y formas ocultas, flechas sin origen o destino conectados, marcos que solo agrupan personas o sistemas (p. ej. "Empresa"), y las jerarquías que C4 no admite (esa forma se importa sin padre). Además:

- Las **rutas de las flechas** (waypoints) no se importan: la app las recalcula al abrir la vista (o con Autolayout).
- La notación de **tarjetas** no distingue navegador ni móvil (los dibuja como rectángulos), así que esas formas se recuperan sin `shape`.
- No se importan `tags`, `layout` ni la descripción del espacio de trabajo: `.drawio` no los guarda.
- Los `.drawio.svg` / `.drawio.png` (con el XML incrustado) no se leen; expórtalos antes como `.drawio`.

## Importar un DSL de Structurizr

Un modelo escrito en el [DSL de Structurizr](https://docs.structurizr.com/dsl) se importa con el mismo flujo y las mismas garantías que un `.drawio`: en la web con **Archivo ▸ Importar Structurizr DSL…** (pide confirmación si hay cambios sin guardar, deja el diagrama como "sin guardar" y lista los avisos en un modal) y en el CLI con `iark import`, que deduce el formato de la extensión (`.dsl`) o del contenido (`--format dsl|drawio` lo fuerza). Siempre produce un documento válido o un error de una línea (código de salida 2), con el número de línea del DSL cuando el fallo es de sintaxis.

```bash
npx iark import examples/banca.dsl --layout --out banca.json     # --layout coloca con ELK las vistas sin coordenadas
npx iark import examples/banca.dsl --layout | npx iark convert --stdin --out banca.drawio   # DSL → .drawio
```

Un DSL no tiene coordenadas, así que las vistas quedan sin posicionar: la app las coloca sola al abrirlas (o `--layout` en el CLI). [`examples/banca.dsl`](examples/banca.dsl) es el ejemplo de banca escrito en DSL y produce el mismo modelo y las mismas vistas que `examples/banca.json`.

Qué importa:

- **Modelo:** `person`, `softwareSystem`, `container` y `component` con su jerarquía (un contenedor dentro de su sistema, un componente dentro de su contenedor), descripción, tecnología y etiquetas; `group` y `enterprise` solo aportan su contenido.
- **Relaciones:** `origen -> destino "descripción" "tecnología" "etiquetas"`, también dentro de un elemento (`-> otro`, `this -> otro`), con identificador (`r = a -> b`) y adelantadas (pueden apuntar a elementos definidos más abajo).
- **Identificadores** planos y jerárquicos (`!identifiers hierarchical`, con referencias como `sistema.contenedor` o por ámbito); el identificador pasa a ser el `id` del elemento. También `!const`/`!var` con `${NOMBRE}`, comentarios (`#`, `//`, `/* */`), líneas continuadas con `\`, y cadenas `"…"` y `"""…"""`.
- **Vistas:** `systemLandscape`, `systemContext`, `container` y `component`, con su clave, descripción, `title`, `autoLayout tb|bt|lr|rl [separación de rangos] [separación de nodos]` (dirección y separaciones de la vista) y `include`/`exclude` con `*` (los elementos que C4 muestra por defecto en ese nivel), identificadores, `->x->`, `x->`, `->x`, y `element.tag`, `element.type` y `element.parent` (`==` y `!=`). Si el DSL no define vistas se crean las de por defecto (contexto, contenedores y componentes de cada sistema).
- **Estilos** (`styles { element "Etiqueta" { … } }`): `shape cylinder|pipe|webbrowser|mobiledevice…` pasa a la forma del elemento (base de datos, cola, navegador, móvil), `background` a color propio del elemento cuando no es el color estándar de C4, y las etiquetas `External` / `Existing System` (o el gris `#999999`) marcan el elemento como externo.
- **`!include`** de otros archivos en el CLI (relativos al archivo que incluye, con detección de ciclos); solo se leen archivos **dentro del directorio del archivo de entrada** (también siguiendo enlaces simbólicos), así que un DSL de origen desconocido no puede leer nada fuera de su carpeta. En la web y por stdin no hay otros archivos: el `!include` se omite con un aviso.

Qué **no** se importa (siempre se avisa, agrupado por sentencia, sin detener la importación): despliegue (`deploymentEnvironment`, `deploymentNode`…), vistas `dynamic`, `filtered`, `deployment`, `custom` e `image`, `!docs`, `!adrs`, `!ref`, `!script`, `url`, `properties`, `perspectives`, las expresiones de relaciones en `include`/`exclude` (`relationship==…`) y `workspace extends`; y un elemento en un sitio que C4 no admite (un contenedor fuera de un sistema, una persona dentro de uno…) se omite con su contenido. Los temas, la marca (`branding`) y la configuración se ignoran sin avisar, y los estilos de relaciones no se aplican.

## Mermaid

**Importar** (Archivo ▸ Importar Mermaid…, o `iark import diagrama.mmd`). Se admiten:

| Diagrama de Mermaid | Se convierte en |
|---|---|
| `C4Context`, `C4Container`, `C4Component`, `C4Dynamic` | `Person`, `System*`, `Container*`, `Component*` (con `_Ext`, `Db`, `Queue`), `System_Boundary` (sistema) y `Container_Boundary` (contenedor), `Rel`/`BiRel`/`Rel_*`; los `UpdateElementStyle`/`UpdateLayoutConfig` se ignoran |
| `flowchart` / `graph` | nodos y aristas (`-->`, `---`, `-.->`, `==>`, etiquetas `\|texto\|` o `-- texto -->`, cadenas y `A & B`); `subgraph` anidados = sistema › contenedor › componente; `[( )]` = base de datos, `([ ])` = cola |
| `sequenceDiagram` | `actor` = persona, `participant` = sistema, cada mensaje distinto = relación |
| `erDiagram` | entidad = sistema con forma de base de datos (atributos en la descripción), relación con su cardinalidad |

Mermaid no guarda coordenadas ni vistas: se crean las vistas por defecto y el autolayout hace el resto. Lo que no se entiende se lista como aviso. También vale un bloque ```` ```mermaid ```` de un Markdown o un archivo con frontmatter `title:`.

**Exportar** la vista activa (Archivo ▸ Exportar Mermaid, copiar al portapapeles, o `iark convert doc.json --to mermaid --view contenedores [--mermaid-format c4|flowchart]`). `generate --from` y `prompt --from` aceptan también `.drawio`, `.dsl` y `.mmd` como documento base.

**Vista previa** de cómo dibuja Mermaid la vista activa, sin salir de la aplicación: Archivo ▸ Vista previa de Mermaid… en el editor C4 (en C4 nativo o como diagrama de flujo, con el texto exportado a la vista) y, en el banco de trabajo, Exportar ▸ Mermaid ▸ Ver. El dibujo lo hace la librería [`mermaid`](https://mermaid.js.org), que solo se descarga la primera vez que se pide la vista previa (el resto de la aplicación no la carga) y es una dependencia de desarrollo: forma parte del sitio compilado, no del paquete npm ni del CLI. Es una aproximación para pegar en README, GitHub o Confluence; el diagrama definitivo es el del editor. «Tamaño real» permite leer los diagramas grandes con desplazamiento.

## Módulo de integraciones

Segunda especialidad de la suite (`--module integration`): modela **cómo se hablan los sistemas** (APIs, servidores MCP, pasarelas, brokers, colas y tópicos, almacenes, conectores, tareas programadas y usuarios), con sus **contratos editables** (OpenAPI, `.proto` de gRPC, CloudEvents y MCP) y los flujos de extremo a extremo. Vive en `packages/domain-integration` y no depende del código C4: se enlaza con él solo por referencias URN (`urn:iark:c4:<id>`).

Documento JSON (ejemplo completo en [`examples/pedidos-integracion.json`](examples/pedidos-integracion.json), esquema con `iark schema --module integration`):

| Parte | Contenido |
|---|---|
| `nodes` | los doce tipos de la notación (tabla siguiente); opcionales `technology`, `owner`, `external`, `ref` (URN al elemento C4 o de otro módulo), `contractId` (su contrato), `domain` (zona de un equipo o dominio) y, en un nodo `pattern`, el `pattern` EIP que aplica |
| `contracts` | `openapi`, `asyncapi`, `graphql`, `protobuf` (el `.proto` de gRPC), `avro`, `json-schema`, `wsdl`, `cloudevents`, `mcp` u `other`, con `version` y el texto en `content` |
| `interactions` | de un nodo a otro: `style` (`request-response`, `async-message`, `event`, `batch`, `stream`), `protocol`, `pattern` (18 patrones EIP y de resiliencia), `contractId`, `criticality` y `order` (lugar en la secuencia) |
| `flows` | secuencias ordenadas de interacciones (p. ej. «Crear un pedido») |

### Notación EIP

La misma figura en el lienzo, el SVG y el `.drawio` (una sola geometría en `packages/kernel/src/graph/shapes.ts`):

| Tipo | Figura | Lo que modela |
|---|---|---|
| `system` | caja | aplicación o sistema, interno o externo |
| `api` | hexágono | interfaz que expone un sistema (dentro de él) |
| `mcp` | ficha | servidor MCP: herramientas, recursos y prompts para agentes de IA (dentro de un sistema) |
| `gateway` | flecha | pasarela de APIs, ESB o proxy; puede contener colas y tópicos |
| `broker` | barra | plataforma de mensajería; contiene colas y tópicos |
| `queue` | tubo | cola punto a punto |
| `topic` | abanico | tópico de publicación-suscripción |
| `store` | cilindro | base de datos, ficheros o bucket |
| `connector` | caja redondeada | conector o adaptador de canal |
| `scheduler` | reloj | tarea programada (solo dispara) |
| `user` | figura humana | usuario final (solo llama) |
| `pattern` | rombo | patrón EIP como nodo intermedio (traductor, enrutador, agregador…) |

### Contratos: la metadata de las figuras

Cada nodo y cada interacción puede apuntar a un contrato (`contractId`), y el contrato lleva su texto. La pestaña **Contratos** del banco de trabajo es el editor: lista con formato, versión y usos; editor de texto con diagnósticos en vivo que llevan a la línea del problema; **Formatear**, **Plantilla**, conversión JSON ↔ YAML, copiar y descargar con la extensión del formato; resumen del contenido (operaciones, métodos RPC, herramientas…) y «Usado por», que salta a la figura. Desde el panel de propiedades de una figura, «Editar» abre su contrato y «Nuevo contrato» crea uno con el formato que encaja (API → OpenAPI o `.proto` si su tecnología es gRPC, servidor MCP → MCP, tópico o cola → CloudEvents, evento → CloudEvents) y lo deja asignado. La figura muestra el formato y la versión de su contrato como insignia.

| Formato | Qué comprueba | Qué formatea |
|---|---|---|
| CloudEvents (JSON) | `specversion` 1.0, `id`, `source`, `type`, `datacontenttype`, `dataschema`, `time` RFC 3339, `data` / `data_base64` excluyentes, nombres de atributos, también en lotes | **Formateador CloudEvents**: envuelve un payload suelto, completa un envoltorio incompleto y deja la estructura canónica |
| gRPC (`.proto`) | `syntax`, `package`, mensajes (números de campo únicos y en rango), enums proto3, `service` con sus `rpc` y tipos resolubles | reindenta conservando comentarios |
| REST (OpenAPI 3) | `openapi`, `info`, `paths`, respuestas, `operationId` único, parámetros de ruta, `$ref` locales, seguridad | orden canónico, JSON o YAML |
| MCP (JSON) | herramientas con nombre único e `inputSchema` de objeto, `required` dentro de `properties`, recursos con `uri`, prompts con argumentos | orden canónico |
| AsyncAPI, JSON Schema, Avro, GraphQL, WSDL | sintaxis y lo mínimo de cada formato | sangría |

### Patrones, orden y reglas

- **Patrón EIP**: una interacción lleva su patrón como **insignia con el icono del patrón sobre la línea**, o el patrón se dibuja como **nodo intermedio** (rombo) al estilo de los libros de EIP. No son redundantes sino dos formas del mismo dato: la insignia es compacta y el nodo deja ver el componente (un traductor entre dos canales, que sin él se unirían directamente). Las acciones del lienzo **Patrón → nodo** y **Nodo → insignia de patrón** pasan de una a otra sin perder el orden ni los pasos de los flujos; el análisis avisa si se declara el mismo patrón de las dos formas a la vez.
- **Orden**: `order` en una interacción la numera en cada vista (1, 2, 3…) por orden creciente y el número sale sobre la línea; solo ordena, así que se pueden dejar huecos (10, 20, 30). En un flujo manda el orden de sus pasos.
- **Reglas de conexión por tipo** (el lienzo no deja crear la unión y `validate` avisa en documentos existentes): solo un broker o una pasarela contiene colas y tópicos; los sistemas, APIs, conectores, tareas programadas y patrones publican en colas y tópicos, y los sistemas, APIs, pasarelas, conectores y patrones leen de ellos (un canal no se une con otro canal ni admite petición-respuesta); un almacén solo recibe lectura y escritura (petición-respuesta o lote) y nunca inicia una interacción; una tarea programada solo dispara; un usuario final solo llama y solo recibe notificaciones.

### Vistas y zonas

No se guardan coordenadas: las vistas se derivan del modelo (`map` con todo el mapa, `flow:<id>` por cada flujo y `system:<id>` por cada sistema, con él, lo que contiene y sus vecinos directos) y el autolayout las coloca. Los nodos con el mismo `domain` se dibujan dentro de una **zona** de equipo o dominio (los hijos siguen a su padre). Acciones del lienzo, sobre la selección múltiple (Ctrl/⌘ + clic, o Mayús + arrastre para un recuadro): **Agrupar en dominio…**, **Sacar del dominio** y **Agrupar por responsable** (una zona por equipo con los nodos que tienen `owner`).

`validate` comprueba la estructura (referencias, jerarquía, autoenlaces, nodos de patrón con su patrón, contratos que existen) y avisa de lo dudoso: colas sin productor o sin consumidor, interacciones sin contrato o duplicadas, contratos sin versión o con el contenido incorrecto, dependencias síncronas circulares, uniones que incumplen las reglas por tipo y patrones sin entrada o salida.

```bash
iark validate  pedidos.json --module integration
iark convert   pedidos.json --module integration --out mapa.svg          # también .mmd (Mermaid) y .drawio; --to fuerza el formato
iark convert   pedidos.json --module integration --to mermaid --view flow:crear-pedido   # el flujo sale como sequenceDiagram
iark convert   pedidos.json --module integration --view system:pedidos --out pedidos.svg # un sistema y sus vecinos
iark import    mapa.mmd     --module integration --out pedidos.json       # Mermaid (flowchart o sequence) → documento
iark generate  "Pedidos con Kafka y una pasarela de pagos" --module integration --json pedidos.json
iark prompt    "…" --module integration                                 # prompt autocontenido, sin clave de API
iark integration from-c4 banca.json                                     # sistemas y contenedores C4 → mapa de integración
iark integration catalog pedidos.json                                   # tabla Markdown de contratos y dónde se usan
iark integration matrix  pedidos.json                                   # matriz origen × destino con el estilo de cada enlace
iark integration contracts pedidos.json                                 # valida el contenido de cada contrato y lo resume
iark integration contract-export facturacion-proto pedidos.json > facturacion.proto   # saca un contrato a su archivo
iark integration cloudevents payload.json --type com.tienda.pedido.creado --source /pedidos   # formatea como CloudEvents 1.0
```

**Mermaid**: cada tipo tiene su forma (API `{{ }}`, pasarela `>" "]`, broker como `subgraph`, cola y tópico `([ ])`, almacén `[( )]`, conector `( )`, tarea programada `((( )))`, usuario `(( ))`, servidor MCP `[/ /]` y patrón `{ }`). Un sistema o un broker con hijos es un `subgraph`, una zona es un `subgraph` titulado «Dominio: X» que contiene a sus miembros, y las líneas con `order` llevan su número y las que tienen patrón, su nombre entre « ». Cuando la forma no basta para deducir el tipo (un tópico comparte forma con la cola) el texto lleva la marca «Tópico»; con ellas, la ida y vuelta por `iark import` conserva tipo, dominio, orden y patrón. Los contratos y su contenido no viajan por Mermaid: están en el documento JSON.

## Módulo de datos

Tercera especialidad de la suite (`--module data`): modela **dónde viven los datos, de dónde vienen y quién responde por ellos**. Vive en `packages/domain-data`, sin depender del código C4 ni del de integraciones; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/ventas-datos.json`](examples/ventas-datos.json), esquema con `iark schema --module data`):

| Parte | Contenido |
|---|---|
| `domains` | áreas de negocio que agrupan activos (Ventas, Clientes…), con su responsable |
| `assets` | `source`, `database`, `warehouse`, `lake`, `stream`, `table`, `view`, `file`, `report` y `model`; una tabla, vista o archivo puede colgar de su base, almacén o lago (`parentId`). Gobierno: `owner`, `steward`, `classification` (`public`…`restricted`), `pii`, `retention`; y `columns` (tipo, `pk`/`fk`/`uk`, `pii`) |
| `pipelines` | de una o varias entradas a una o varias salidas: `batch`, `elt`, `cdc`, `streaming`, `replication`, `api` o `manual`, con `tool`, `schedule` y `anonymizes`; opcionalmente `mappings` (linaje de columnas: `{ from: { assetId, column }, to: { assetId, column }, transform }`, de una entrada a una salida del pipeline) |
| `relations` | entre entidades (tablas, vistas, archivos, streams): `1:1`, `1:N`, `N:1` o `N:M` |

No se guardan coordenadas: las vistas se derivan del modelo. `lineage` es el linaje completo, `erd` el modelo entidad-relación (fichas con sus columnas) y `domain:<id>` una por dominio, con los activos vecinos en discontinuo. El linaje de un activo concreto se pide por su id: `lineage:<activo>` (todo), `upstream:<activo>` (de dónde vienen sus datos) y `downstream:<activo>` (qué depende de él). Un pipeline cuyas entradas y salidas están en un mismo contenedor se dibuja dentro de él.

**Linaje a nivel de columna** (opcional y retrocompatible: sin `mappings` nada cambia). Un pipeline puede declarar qué columna de sus entradas alimenta qué columna de sus salidas; el panel de propiedades del pipeline los edita como líneas de texto, `activo.columna -> activo.columna : transformación`. La vista `column:<activo>.<columna>` (también en el selector, una por cada columna de origen) dibuja un impacto de columna: fichas con solo las columnas afectadas (la de partida con ●), aguas arriba y aguas abajo, hasta los informes y modelos que dependen de ella (los informes y modelos sin columnas declaradas aceptan cualquier nombre de indicador). Funciona en el lienzo, en el SVG y en Mermaid (`--view column:erp-pedidos.total`).

`validate` comprueba la estructura y aplica reglas de **gobierno** que siguen el linaje: datos personales sin clasificar o clasificados por debajo de confidencial, un activo derivado de otro más sensible con una clasificación menor (salvo que su pipeline anonimice), activos sin responsable (más grave con datos personales), informes o modelos sin pipeline que los escriba, un mapeo a una columna que el activo no declara, datos personales que llegan por un mapeo a una columna no marcada como PII (salvo que el pipeline anonimice), pipelines por lotes sin frecuencia, ciclos de linaje y relaciones N:M sin tabla intermedia.

```bash
iark validate  datos.json --module data
iark convert   datos.json --module data --out linaje.svg                 # también .mmd (Mermaid) y .drawio (una página por vista)
iark convert   datos.json --module data --to mermaid --view erd          # erDiagram con columnas y claves
iark convert   datos.json --module data --out impacto.svg --view downstream:silver-ventas
iark import    linaje.mmd  --module data --out datos.json                # flowchart (linaje) o erDiagram → documento
iark generate  "Lago con CRM y ERP, almacén y un panel de ventas" --module data --json datos.json
iark data lineage silver-ventas datos.json                               # origen e impacto de un activo, con los responsables a avisar
iark data column-impact erp-pedidos.total datos.json                    # de qué columnas sale y qué columnas, informes y modelos dependen de ella
iark data catalog datos.json                                             # tabla Markdown de activos con dominio, responsable y clasificación
iark data pii datos.json                                                 # datos personales y adónde llegan sin anonimizarse
iark data from-integration mapa.json                                     # almacenes, colas y tópicos de un mapa de integración → activos con URN
```

Al importar un `flowchart`, `[( )]` es una base de datos, `([ ])` un stream y el resto tablas; cada arista (`A & B --> C`) es un pipeline (continua = por lotes, punteada = streaming, gruesa = CDC, o el tipo entre corchetes al final de la etiqueta) y un `subgraph` es un contenedor cuyo tipo se toma del prefijo que pone el exportador («Data lake: …»). Del `erDiagram` se conservan tipos, claves y multiplicidad, no la opcionalidad.

## Módulo empresarial

Cuarta especialidad de la suite (`--module enterprise`): un subconjunto pequeño de ArchiMate/TOGAF para responder **qué sabe hacer la empresa, con qué aplicaciones y sobre qué tecnología**. Vive en `packages/domain-enterprise`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/empresa-arquitectura.json`](examples/empresa-arquitectura.json) y, con un flujo de valor y servicios de negocio, en [`examples/empresa-flujo-de-valor.json`](examples/empresa-flujo-de-valor.json); esquema con `iark schema --module enterprise`):

| Parte | Contenido |
|---|---|
| `units` | la organización (direcciones, equipos, terceros): son los responsables; el SVG solo las dibuja si ejecutan un proceso (`assigned-to`) o están sueltas, y el paisaje del lienzo las dibuja todas para poder arrastrar una asignación hacia cualquiera |
| `capabilities` | capacidades de negocio en árbol (`parentId`), con `importance` (`differentiating`, `core`, `supporting`), `maturity` de 1 a 5 y `ownerId` (se hereda del padre) |
| `processes` | procesos de negocio |
| `applications` | `lifecycle` (`planned`, `active`, `sunset`, `retired`), `criticality`, `technology`, `vendor`, `external`, `ownerId` de negocio, `ref` a otro módulo y datos de gestión opcionales: `annualCost`, `users`, `strategy` (`keep`, `migrate`, `replace`, `retire`) y `endOfLife` |
| `technologies` | plataformas y tecnología (`platform`, `infrastructure`, `database`, `runtime`, `middleware`, `service`), con `version`, `lifecycle` y `endOfLife` |
| `valueStreams`, `valueStages` | **flujos de valor** (opcionales): un flujo (`stakeholder`: quien recibe el valor, `ownerId`) con sus etapas (`streamId`, `value`: lo que aporta), en el orden en que aparecen en el documento; cada etapa se enlaza con las capacidades que la habilitan (`enables`) |
| `businessServices` | **servicios de negocio** (opcionales): lo que se ofrece a clientes (`audience`, `ownerId`); exponen procesos y capacidades (`exposes`) |
| `relations` | `supports` (aplicación → capacidad o proceso), `realizes` (proceso → capacidad), `runs-on` (aplicación → tecnología) `depends-on` (aplicación → aplicación, o tecnología → tecnología), `composes` (el todo → su parte, del mismo tipo), `flows-to` (aplicación → aplicación o proceso → proceso), `assigned-to` (unidad → proceso) y `triggers` (proceso → proceso); `enables` (capacidad → etapa que habilita) y `exposes` (servicio de negocio → proceso o capacidad); los seis últimos son opcionales y el documento sigue en la versión 1.0 |

No se guardan coordenadas: las vistas se derivan del modelo. `capabilities` es el **mapa de capacidades** (cuadrícula anidada; el color indica la madurez por defecto o, con `capabilities:importance`, `capabilities:criticality` y `capabilities:lifecycle`, la importancia, la criticidad o el ciclo de vida de las aplicaciones que la soportan, con su leyenda; el borde indica la importancia y una línea discontinua marca las que no tienen aplicación), `value-stream` los **flujos de valor** (cada flujo es un recuadro con sus etapas como chevrones en cadena, de izquierda a derecha, y debajo las capacidades que las habilitan, ordenadas según sus etapas y unidas a ellas con aristas de un solo codo que no se cortan; una etapa sin capacidad se dibuja discontinua), `roadmap` la **hoja de ruta del ciclo de vida** (columnas por año de fin de soporte, retiradas y previstas), `landscape` el **paisaje** capacidad → proceso → aplicación → tecnología, con los colores de capa de ArchiMate (negocio amarillo, aplicación azul, tecnología verde) y el icono del tipo en la esquina de cada elemento y `unit:<id>` una por unidad con lo que tiene a su cargo (lo demás, en discontinuo). El impacto de un elemento se pide por su id: `impact:<id>` (lo que se apoya en él), `depends:<id>` (de qué depende) y `focus:<id>` (ambos). Las flechas van de quien se apoya a aquello en lo que se apoya.

`validate` comprueba la estructura (ids únicos entre tipos, jerarquías sin ciclos, responsables que son unidades, relaciones que encajan con sus extremos) y aplica reglas de **gobierno**: capacidades sin aplicación (aviso si son esenciales o diferenciadoras), aplicaciones sin responsable de negocio (aviso si son críticas), sin uso o sin tecnología, aplicaciones en retirada que nadie sustituye, elementos vivos que se apoyan en algo en retirada o retirado, tecnologías fuera de soporte (o que lo estarán en menos de 12 meses), capacidades con tres o más aplicaciones (posible duplicidad), procesos que no realizan ninguna capacidad, etapas de un flujo de valor que ninguna capacidad habilita (aviso), flujos sin etapas, servicios de negocio que no exponen nada y críticas que dependen de aplicaciones de criticidad baja.

```bash
iark validate  empresa.json --module enterprise
iark convert   empresa.json --module enterprise --out mapa.svg                       # mapa de capacidades; también .mmd y .drawio (una página por vista)
iark convert   empresa.json --module enterprise --out paisaje.svg --view landscape
iark convert   empresa.json --module enterprise --out impacto.svg --view impact:hana
iark import    paisaje.mmd  --module enterprise --out empresa.json                   # flowchart → documento
iark generate  "Comercio con tienda online, ERP, CRM y almacenes" --module enterprise --json empresa.json
iark enterprise coverage  empresa.json                                               # capacidades con sus aplicaciones y las que no tienen ninguna
iark enterprise impact    hana empresa.json [--direction dependencies|both]         # qué se ve afectado si cambia o se retira, con los responsables a avisar
iark enterprise lifecycle empresa.json [--today 2026-06-15]                          # obsolescencia: retiradas y fin de soporte, con las capacidades afectadas
iark enterprise from-integration mapa.json                                           # sistemas de un mapa de integración → aplicaciones con URN
```

Al importar un `flowchart`, el tipo de cada nodo sale de su clase (`:::application`, `class A capability`; también en español), del título de la capa que lo contiene («Capacidades», «Aplicaciones»…), de su forma (`([ ])` = proceso, `[( )]` = tecnología) y, por último, de que esté dentro de un `subgraph` (capacidad) o no (aplicación). Un `subgraph` que no es una capa es una capacidad que contiene a las suyas. Cada flecha se convierte en la relación que admiten sus extremos, en cualquier sentido. La segunda línea del texto de una aplicación es su tecnología y la de una tecnología, su versión. La interfaz web todavía no edita este módulo.

## Módulo de plataforma

Quinta especialidad de la suite (`--module platform`): modela **dónde corre cada cosa y cómo llega hasta ahí**: entornos, redes, recursos aprovisionados, servicios, despliegues, dependencias y pipelines. Vive en `packages/domain-platform`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`).

Documento JSON (ejemplo completo en [`examples/plataforma-ejemplo.json`](examples/plataforma-ejemplo.json), esquema con `iark schema --module platform`):

| Parte | Contenido |
|---|---|
| `environments` | `dev`, `test`, `staging`, `prod` o `dr`, con `provider` y `region` |
| `networks` | redes de un entorno, anidables (`parentId`), con `exposure` (`public`, `private`, `isolated`) y `cidr` |
| `resources` | recursos de un entorno y, si procede, de una red: `cluster` y `vm` (los únicos **anfitriones**), `database`, `cache`, `queue`, `storage`, `load-balancer`, `gateway`, `dns`, `secret-store`, `registry`; con `status` (`planned`, `provisioned`, `decommissioned`) e `iac` |
| `services` | `service`, `worker`, `job` o `frontend`, con `owner`, `criticality` y `external` (SaaS de terceros: no se despliega) |
| `deployments` | dónde corre un servicio en un entorno: `hostId` (un clúster o una máquina **de ese entorno**), `replicas` y `version` |
| `dependencies` | de quién depende un servicio o un recurso: `calls` (síncrona), `messages` (asíncrona) o `data`, con `protocol` |
| `pipelines` | `ci`, `cd`, `ci-cd` o `iac`: los servicios que construyen o despliegan, los recursos que aprovisionan y los entornos por los que promocionan (`stages`, con `approval` manual) |

No se guardan coordenadas: las vistas se derivan del modelo. `topology` es el grafo de servicios y recursos con sus dependencias, `env:<id>` el **despliegue de un entorno** (las redes y los clústeres son recuadros anidados que contienen los recursos y las instancias de cada servicio, con sus réplicas y versión) y `delivery` la **entrega continua** (pipelines con sus pasos por entorno). El impacto de un servicio o recurso se pide por su id: `impact:<id>` (lo que depende de él), `depends:<id>` (de qué depende) y `focus:<id>` (ambos); un recurso, o un servicio que corre en un solo entorno, se acota a ese entorno.

`validate` comprueba la estructura (ids únicos entre tipos, redes sin ciclos, despliegues en un clúster o máquina del mismo entorno, referencias) y aplica reglas de **gobierno**: servicios sin despliegue o sin responsable (aviso si son altos o críticos), producción sin pasar por un entorno anterior, dependencias de recursos previstos o dados de baja, de servicios que no corren en el mismo entorno o de recursos de otro entorno, tipos de recurso (base de datos, cola…) que un servicio usa en un entorno y no en otro, datos o secretos en una red pública, producción sin infraestructura como código, puntos únicos de fallo (una réplica de un servicio crítico), clústeres vacíos y recursos que nadie usa, llamadas circulares y pipelines sin aprobación manual en producción, sin servicios o que despliegan donde el servicio no corre.

```bash
iark validate  plataforma.json --module platform
iark convert   plataforma.json --module platform --out topologia.svg                   # topología; también .mmd y .drawio (una página por vista)
iark convert   plataforma.json --module platform --out produccion.svg --view env:prod
iark convert   plataforma.json --module platform --out entrega.svg --view delivery
iark convert   plataforma.json --module platform --out impacto.svg --view impact:kafka-prod
iark import    produccion.mmd --module platform --out plataforma.json                  # flowchart → documento
iark generate  "Tienda con Kubernetes, PostgreSQL y Kafka en desarrollo y producción" --module platform --json plataforma.json
iark platform deployments plataforma.json                                              # dónde corre cada servicio en cada entorno y qué versiones difieren
iark platform compare     dev prod plataforma.json                                     # compara dos entornos: lo que solo está en uno y las versiones o réplicas que difieren; dice cómo emparejó cada recurso si no fue por nombre
iark platform impact      kafka-prod plataforma.json [--direction dependencies|both] [--env prod]   # qué se cae si falla, con los responsables a avisar
iark platform from-integration mapa.json                                               # sistemas de un mapa de integración → servicios y recursos con URN
```

Al importar un `flowchart`, los `subgraph` con el prefijo que pone el exportador se reconocen como `Entorno: …`, `Red pública|privada|aislada: … (cidr)` y `Clúster: …` / `Máquina virtual: …`; un servicio dentro de un clúster queda desplegado en él (con `3 réplicas · v1.4.2` al final del texto) y los servicios con el mismo nombre en varios entornos son uno solo con varios despliegues. El tipo de cada nodo sale de su clase (`:::database`, `:::worker`, `:::external`; también en español) y, si no, de su forma (`[( )]` = base de datos, `([ ])` = cola); `class X planned|decommissioned` da el estado del recurso. Las flechas son dependencias: continua = llama, punteada = mensajes, gruesa = datos, con la etiqueta `protocolo · descripción`. Los pasos de la vista de entrega continua no se importan. La interfaz web todavía no edita este módulo.

## Módulo de seguridad

Sexta especialidad de la suite (`--module security`; la quinta de las que pidió el plan, tras integraciones, datos, empresarial y plataforma): modela **qué hay que proteger, de quién y con qué**, con el enfoque clásico de un análisis de amenazas sobre un diagrama de flujo de datos. Vive en `packages/domain-security`, sin depender del código de los demás módulos; se enlaza con ellos por URN (`urn:iark:integration:<id>`, `urn:iark:platform:<id>`).

Documento JSON (ejemplo completo en [`examples/seguridad-ejemplo.json`](examples/seguridad-ejemplo.json), esquema con `iark schema --module security`):

| Parte | Contenido |
|---|---|
| `zones` | zonas de confianza, anidables (`parentId`): `untrusted`, `dmz`, `internal` (por defecto) o `restricted`; cruzar de una a otra es cruzar una **frontera de confianza** |
| `assets` | `actor` (persona), `external` (sistema de un tercero), `process` (ejecuta código) `datastore` (guarda datos), `identity` (proveedor de identidad: IdP, SSO; figura de tarjeta), `secret` (secreto, clave o certificado; rombo) o `channel` (canal de confianza VPN/mTLS/túnel; se dibuja como un nodo pequeño en cheurón dentro de una zona, con un flujo a cada lado, de modo que los flujos que lo atraviesan cruzan la frontera por él), cada uno en una zona; con `classification` (`public`, `internal`, `confidential`, `restricted`), `encryptedAtRest` (almacenes y secretos), `authentication` (identidades y canales), `rotation` (secretos), `encrypted` (canales), `owner` y `ref`. Los tipos `identity`, `secret` y `channel` y sus campos son opcionales: los documentos anteriores siguen siendo válidos |
| `flows` | datos que viajan de un activo a otro: `protocol`, `classification`, `encrypted` y `authentication` (`none`, `password`, `token`, `mtls`, `sso`); lo que no se indica, se considera desconocido |
| `threats` | amenaza clasificada con **STRIDE** (`spoofing`, `tampering`, `repudiation`, `information-disclosure`, `denial-of-service`, `elevation-of-privilege`) sobre un activo o un flujo, con `likelihood`, `impact` y `status` (`open`, `mitigated`, `accepted`); el riesgo es probabilidad (1-3) × impacto (1-4) |
| `controls` | lo que mitiga las amenazas (`authentication`, `authorization`, `encryption`, `logging`, `validation`, `network`, `rate-limit`, `backup`, `secrets`), `implemented` o `planned`; cada amenaza cita los suyos en `controlIds` |

No se guardan coordenadas. `dfd` es el **diagrama de flujo de datos** (cada zona es un recuadro del color de su nivel de confianza, anidado en su padre; la flecha es verde si el flujo va cifrado, roja discontinua si no y gris si no se sabe, y más gruesa si lleva datos sensibles; los activos con amenazas graves abiertas se marcan en rojo) y `threats` el **modelo de amenazas** (controles → amenazas → activos y flujos amenazados). Desde un activo se piden `blast:<id>` (hasta dónde llegan los datos si se compromete), `exposure:<id>` (quién puede llegar hasta él) y `focus:<id>` (ambos).

Otras tres vistas derivadas (en el lienzo, en `--view` y en SVG, Mermaid y draw.io):

- **`heatmap`, matriz de calor 3 × 4** (probabilidad × impacto): cada amenaza en su celda, con la celda coloreada por su riesgo. En el lienzo se **arrastra una amenaza a otra celda** (o sobre otra amenaza) y cambia su `likelihood` e `impact`. `heatmap:residual` (selector «Colorear por → Residual») la coloca donde queda tras los controles. **Regla del riesgo residual** (`residualOf`, no se guarda, se calcula): solo cuentan los controles `implemented` enlazados en `controlIds`; con **uno** la probabilidad baja un nivel (los controles evitan que ocurra), con **dos o más** baja además el impacto un nivel (detectan y acotan el daño); nunca por debajo de `low`. Las amenazas reducidas llevan la marca «residual ↓» (en la vista residual, borde discontinuo); una amenaza con residual alto o crítico pese a sus controles genera un aviso. La matriz residual no se arrastra.
- **`standards`, cobertura de estándares** (solo si algún control declara `standard`; `standards:<asvs|nist-800-53|iso-27001|cis>` para un catálogo): los controles agrupados por catálogo, unidos con «mitiga» a las amenazas; cada amenaza se marca como cubierta (control implementado de ese estándar), con cobertura prevista o **sin cobertura**. Las amenazas sin ningún control con estándar se avisan.
- **`surface`, superficie de ataque** (si algún flujo entra desde una zona no confiable): los activos expuestos (borde rojo, «expuesto: entrada directa»), el **radio de alcance** (saltos por los flujos de datos desde la entrada), los flujos de entrada en rojo grueso y ★ en lo que interesa proteger; se avisa de lo que se alcanza a uno o dos saltos de fuera.

`validate` comprueba la estructura (ids únicos entre tipos, zonas sin ciclos, flujos entre activos, amenazas sobre activos o flujos, controles existentes) y aplica reglas de **gobierno**: flujos que cruzan una frontera sin cifrar (aviso si tocan una zona no confiable o llevan datos sensibles), entradas a una zona más confiable sin autenticación o que saltan una zona intermedia, datos sensibles en almacenes sin cifrar en reposo o en zonas poco confiables, datos sensibles que salen a un tercero o de un almacén a un actor, clasificaciones incoherentes con los flujos, amenazas abiertas de riesgo alto o crítico, «mitigadas» sin un control implementado, riesgos críticos aceptados, categorías STRIDE que no aplican al elemento, controles sin uso y lo que cruza fronteras sin amenazas analizadas.

```bash
iark validate  seguridad.json --module security
iark convert   seguridad.json --module security --out flujos.svg                      # diagrama de flujo de datos; también .mmd y .drawio (una página por vista)
iark convert   seguridad.json --module security --out amenazas.svg --view threats
iark convert   seguridad.json --module security --out alcance.svg --view blast:pedidos
iark import    flujos.mmd --module security --out seguridad.json                       # flowchart → documento
iark generate  "Tienda con WAF, API, base de datos y pasarela de pagos" --module security --json seguridad.json
iark security risks    seguridad.json [--status open]                                  # registro de riesgos ordenado por riesgo inherente, con estado, controles y el riesgo residual que queda tras los implementados (↓ si baja)
iark security heatmap  seguridad.json [--residual]                                     # matriz de calor probabilidad × impacto: amenazas por celda y qué amenazas hay en cada una; --residual, donde quedan tras los controles
iark security stride   seguridad.json [--gaps]                                         # cobertura STRIDE: qué categorías aplican a cada activo y flujo y cuáles siguen sin analizar
iark security standards seguridad.json [--catalogo asvs]                               # cobertura de estándares: por catálogo (asvs, nist-800-53, iso-27001, cis), sus controles y las amenazas cubiertas, con cobertura prevista o sin cobertura
iark security exposure seguridad.json                                                  # superficie de ataque: entradas desde zonas no confiables y caminos hasta lo que interesa proteger
iark security from-integration mapa.json                                               # mapa de integración → activos y flujos con URN (zonas por heurística)
iark security from-platform plataforma.json [--env prod]                               # entorno de una plataforma → zonas por red, activos y flujos con URN
```

Al importar un `flowchart`, cada `subgraph` es una zona (con el prefijo `Zona no confiable|DMZ|interna|restringida: …` que pone el exportador se conoce su nivel; sin él se importa como interna y se avisa) y cada nodo, un activo cuyo tipo sale de su clase (`:::actor`, `:::external`, `:::process`, `:::datastore`; también en español) o, si no, de su forma (`[( )]` = almacén, `([ ])` = actor). Al final del texto del nodo se leen `datos confidenciales` y `cifrado en reposo` / `sin cifrar en reposo`. Las flechas son flujos: gruesa `==>` = cifrado, punteada `-.->` = sin cifrar, continua = no se sabe; la etiqueta es `protocolo · descripción · datos … · autenticación …`. Las amenazas y los controles se describen en el JSON, no en Mermaid. La interfaz web todavía no edita este módulo.

## Trazabilidad entre módulos

Los elementos de un documento pueden apuntar a los de otro módulo con una referencia estable `ref: "urn:iark:<módulo>:<id>"` (por ejemplo, un servicio de plataforma que realiza un sistema de integración, o un activo de seguridad que es un servicio de plataforma). Ningún módulo conoce el código de otro: `iark trace` reúne los documentos y sigue esos enlaces.

```bash
# Enlaces por par de módulos y referencias sin resolver
iark trace integration=examples/pedidos-integracion.json platform=examples/plataforma-ejemplo.json security=examples/seguridad-ejemplo.json
# Impacto de tocar un sistema de integración: qué se apoya en él, entre módulos (y de qué se apoya)
iark trace integration=… platform=… security=… --from integration:pedidos --direction referrers
iark trace … --format mermaid   # un subgrafo por módulo; --format svg para el dibujo; --format json para otras herramientas; --strict falla (código 3) con URN mal formadas o inexistentes
```

- `--direction refs|referrers|both` y `--depth n` acotan el alcance; sin `--from` se muestra el grafo completo.
- Un módulo sin documento aportado no invalida los enlaces hacia él: se listan como «sin resolver» (y no rompen `--strict`).
- El servicio HTTP expone lo mismo en `POST /api/trace` (ver más abajo; devuelve el grafo, el informe, el Mermaid y el SVG) y `generate --from …` conserva los `ref` del documento base al refinar con IA, aunque el modelo no los conozca.
- **En la web**: `trazabilidad.html` reúne los documentos de los módulos (ejemplos, archivos o JSON pegado, sin subir nada a ningún servidor), dibuja el grafo con un recuadro por módulo, lista los enlaces por par de módulos y las referencias sin resolver, y calcula el alcance de un elemento (quién se apoya en él, de qué se apoya y a cuántos saltos). Usa el mismo código que el CLI. Se llega desde el banco de trabajo y desde el shell de la suite.
- Los ejemplos (`examples/*.json`) ya traen una cadena real: empresarial → integración, plataforma → integración y seguridad → plataforma.

## CLI `iark`

```
iark generate "<instrucción>" [--from base.json] [--out d.drawio] [--json d.json] [--model claude-opus-5] [--effort high] [--direction DOWN]
iark layout   [archivo.json | --stdin] [--out out.json] [--direction auto|down|right|left|up] [--distribution auto|centered|elk] [--density auto|compact|spacious] [--fast] [--force] [--view id]
iark convert  [archivo.json | --stdin] [--out out.drawio] [--notation c4|card] [--no-waypoints] [--locale es|en] [--view id...]
iark import   [archivo.drawio|archivo.dsl | --stdin] [--format auto|drawio|dsl] [--out out.json] [--name nombre] [--layout]
iark validate [archivo.json | --stdin] [--strict]
iark schema   [--generation]
iark prompt   "<instrucción>" [--from base.json]
iark example
iark modules  [--json]
iark <módulo> <comando>   # comandos propios de cada módulo (p. ej. `iark integration catalog`)
```

`generate`, `import`, `convert`, `validate`, `schema` y `prompt` aceptan `--module <id>` para trabajar con cualquier módulo de la suite (por defecto `c4`); `iark modules` lista los instalados y sus formatos de importación y exportación.

En desarrollo: `npm run cli -- <comando>`; tras `npm run build`: `node dist/cli/index.js` o `npx iark` si el paquete está instalado.

### Generar diagramas con IA (Claude)

```bash
export ANTHROPIC_API_KEY=…   # o `ant auth login`
npx iark generate "Sistema de banca en línea con app web (React), API (Node.js), base de datos PostgreSQL y una pasarela de pagos externa. Los clientes consultan saldos y hacen pagos." \
  --out banca.drawio --json banca.json
```

Flujo: la instrucción se envía a Claude (`claude-opus-5` por defecto) con **salida estructurada** contra el esquema del modelo *sin coordenadas*; el resultado se valida (referencias, jerarquía C4) con un reintento automático si hay errores; después se aplica **autolayout** a todas las vistas y se escriben el JSON y el `.drawio`. Con `--from base.json` la instrucción se trata como un refinamiento del documento existente ("agrega una cola Kafka entre la API y las notificaciones"), conservando los ids y posiciones ya fijados.

#### Con Microsoft (Azure) Foundry: Claude u otros modelos

`generate` funciona con dos tipos de despliegue de Foundry; la plataforma se detecta por la URL, o se fuerza con `--provider`. Guarda las variables como secretos del entorno, nunca en el repositorio.

**Cualquier modelo de Foundry** (DeepSeek, Llama, Mistral, GPT…, `--provider openai`): usa el endpoint compatible con OpenAI del recurso.

```bash
export AI_BASE_URL=https://<recurso>.openai.azure.com/openai/v1    # también vale ANTHROPIC_FOUNDRY_BASE_URL
export AI_API_KEY=…                                                # o ANTHROPIC_FOUNDRY_API_KEY
export AI_MODEL=<nombre-de-tu-despliegue>                          # o ANTHROPIC_FOUNDRY_MODEL
npx iark generate "Una tienda en línea con web, API y base de datos" --json tienda.json --out tienda.drawio
```

No todos los modelos garantizan el esquema, así que el JSON Schema va también en el prompt, se pide `json_schema` (o `json_object`, o nada si el modelo no lo admite) y la respuesta se valida con zod; si es ilegible o incumple el esquema se reintenta con el error. Se descartan los bloques `<think>…</think>` de los modelos de razonamiento. La calidad del diagrama depende del modelo.

**Claude en Foundry** (`--provider foundry`): protocolo de mensajes de Anthropic, con salida estructurada garantizada.

```bash
export ANTHROPIC_FOUNDRY_API_KEY=…
export ANTHROPIC_FOUNDRY_BASE_URL=https://<recurso>.services.ai.azure.com/anthropic/   # o ANTHROPIC_FOUNDRY_RESOURCE=<recurso>
export ANTHROPIC_FOUNDRY_MODEL=<nombre-de-tu-despliegue-de-claude>
```

En Foundry no se envían los *fallbacks* del servidor (solo existen en la API de Anthropic).

### Sin clave de API: cualquier IA o agente

`iark prompt` imprime un prompt autocontenido (reglas C4 + JSON Schema + instrucción). Pégalo en el asistente que prefieras (o deja que un agente como Claude Code lo ejecute) y tuberiza la respuesta:

```bash
npx iark prompt "Plataforma de reservas de hotel con app móvil, backend y pagos" > prompt.txt
# … la IA responde con un JSON (se acepta envuelto en ```json) …
cat respuesta.json | npx iark layout --stdin --out reservas.json
npx iark convert reservas.json --out reservas.drawio
```

La pestaña **IA** del editor web hace lo mismo sin llamar a ningún servicio: "Copiar prompt para IA" y "Pegar JSON generado" (valida, aplica autolayout y carga o fusiona el modelo).

### Uso programático

```ts
import { generateDocument, autoLayoutDocument, toDrawio, fromDrawio, fromStructurizrDsl, validateDocument, deriveView } from 'iark-diagrams/core';

const { document } = await generateDocument({ instruction: 'Un sistema de tickets…' }); // Claude + autolayout
const laid = await autoLayoutDocument(validateDocument(json).document, { direction: 'RIGHT', force: true });
const xml = toDrawio(laid, { locale: 'en' });
const { document: imported, warnings } = await fromDrawio(xml, { name: 'Tickets' }); // .drawio → documento C4 (lanza DrawioImportError si no es utilizable)
const fromDsl = fromStructurizrDsl(dslText, { resolveInclude });                       // DSL de Structurizr → documento C4 (lanza DslImportError, con la línea)
```

`core` no depende del DOM: funciona en Node y en el navegador. `fromStructurizrDsl` es síncrono y solo lee otros archivos si le das un `resolveInclude`. `fromDrawio` descomprime las páginas comprimidas con `DecompressionStream` (Node 20.12+ y los navegadores actuales); un archivo sin comprimir no lo necesita.

## Embebido en otra aplicación (iframe + postMessage)

Abre la app con `?embed=1&proto=json[&origin=https://mi-host][&theme=dark][&ui=min][&configure=1]` dentro de un `<iframe>`. El protocolo sigue el patrón de draw.io: el iframe emite `init`, el anfitrión responde `load`, y a partir de ahí intercambian mensajes JSON (objeto o cadena).

**iframe → anfitrión (`event`)**

| `event` | Cuándo | Carga útil |
|---|---|---|
| `init` | la app está lista | `{ version }` |
| `configure` | antes de `init`, si se abrió con `&configure=1` | — |
| `load` | documento cargado | `{ document, viewId }` |
| `change` / `autosave` | cada cambio (500 ms de throttle); `autosave` solo si `load.autosave = true` | `{ document }` |
| `save` | Guardar / Guardar y salir | `{ document, drawio, exit }` |
| `export` | respuesta a `action: export` | `{ format, data, viewId, requestId }` |
| `autoLayout` | tras un autolayout pedido por el anfitrión | `{ viewId, direction }` |
| `viewChange` | el usuario (o `setView`) cambió de vista | `{ viewId, level: 'C1' \| 'C2' \| 'C3', scopeId, title }` |
| `exit` | salir | `{ modified }` |
| `error` | documento inválido, acción desconocida… | `{ message, issues?, requestId? }` |

**anfitrión → iframe (`action`)**

| `action` | Parámetros |
|---|---|
| `load` | `document?` (objeto o JSON), `autosave?`, `title?`, `readOnly?`, `theme?`, `viewId?`, `autoLayout?` |
| `configure` | `theme?`, `ui?: 'full' \| 'min'`, `hideSidePanel?` |
| `merge` | `document`, `autoLayout?` — fusiona elementos/relaciones/vistas y relanza el autolayout |
| `export` | `format: 'json' \| 'drawio'` (`svg`/`png` responden `error` por ahora), `notation?: 'c4' \| 'card'`, `viewId?`, `requestId?` |
| `autoLayout` | `viewId?`, `direction?: 'auto' \| 'DOWN' \| 'RIGHT' \| 'LEFT' \| 'UP'`, `distribution?: 'auto' \| 'centered' \| 'elk'`, `force?` |
| `setView` | `viewId` |
| `status` | `message`, `modified?` — texto en la cabecera |
| `dialog` | `title`, `message`, `button?` |
| `save` | `exit?` — fuerza la emisión de `save` |
| `exit` | — |

Seguridad: solo se atienden mensajes cuyo `source` es `window.parent`; con `&origin=` se exige además ese `event.origin` y se usa como `targetOrigin` de las respuestas (sin él se usa `*`, solo recomendable en desarrollo). Los documentos recibidos se validan con el mismo esquema zod del núcleo.

### SDK de anfitrión

```html
<div id="editor" style="height: 100vh"></div>
<script type="module">
  import { createIarkEmbed } from 'iark-diagrams/embed'; // o dist/embed/iark-embed.global.js → window.IArkEmbed
  const embed = createIarkEmbed({
    container: '#editor',
    url: 'https://mi-servidor/diagramador/',
    document: miDocumento,          // opcional; sin coordenadas ⇒ autolayout
    autosave: true,
    theme: 'dark',
    onSave: ({ document, drawio, exit }) => guardar(document, drawio),
    onChange: (document) => console.log('cambió', document),
    onExit: () => cerrarModal(),
  });
  await embed.ready;
  const xml = await embed.export('drawio');
  embed.autoLayout({ direction: 'RIGHT' });
  embed.merge(otroFragmento);
  embed.setView('contenedores');
  embed.destroy();
</script>
```

Demo completa: [`examples/embed-host.html`](examples/embed-host.html) (en desarrollo: `http://localhost:5173/examples/embed-host.html`; tras `npm run build` queda en `dist/app/examples/embed-host.html`).

## Suite web: banco de trabajo, widget, shell y servicio

Los cinco módulos nuevos comparten una interfaz genérica que se genera a partir del contrato `DomainModule` (esquema, vistas, exportadores, informes…), de modo que un módulo nuevo aparece en la web sin escribir pantallas. Cada módulo se carga bajo demanda (`import()` dinámico), así que el editor C4 no paga su peso.

| Superficie | Dónde | Para qué |
|---|---|---|
| Banco de trabajo | `modulos.html?module=security` | Editar el JSON del módulo con validación en vivo (esquema + reglas del dominio), ver las vistas y las vistas de traza, exportar (Mermaid con su vista previa dibujada, SVG, draw.io), importar Mermaid, ejecutar informes y conversiones (`from-integration`…). El borrador se guarda en el navegador (no en modo embebido). |
| Widget embebible | `modulos.html?embed=1&proto=json&origin=…` | Mismo banco de trabajo dentro de un `<iframe>`, con un protocolo `postMessage` propio (`src/embed/moduleProtocol.ts`). |
| Trazabilidad | `trazabilidad.html` | Vista transversal: enlaces `urn:iark:…` entre los documentos de varios módulos, referencias sin resolver y alcance de un elemento (ver «Trazabilidad entre módulos»). |
| Shell de la suite | `suite.html` | Descubre los módulos de una instancia leyendo su manifiesto y monta el editor C4 o el widget del módulo elegido. Acepta una URL de manifiesto de otra instancia. |
| Servicio HTTP | `iark serve` | La misma API para todos los módulos y el sitio estático, en un proceso Node sin dependencias. |

### Protocolo de módulos y SDK

Es el protocolo del editor C4 con dos añadidos: el `init` lleva el `capabilities` de la instancia (módulos, formatos, informes y vistas de traza) y las acciones/eventos llevan un `requestId` para correlacionar las respuestas. El origen del anfitrión es `?origin`, o el del `referrer`, o el propio; los mensajes nunca se envían a `*`.

- **Acciones** (anfitrión → iframe): `load` (con `module`, `document` o texto con `importer`, `viewId`, `autosave`, `readOnly`), `configure` (`theme`, `ui: 'full' | 'min'`), `setView`, `export`, `validate`, `run` (informe o conversión), `capabilities`, `status`, `dialog`, `save`, `exit`.
- **Eventos** (iframe → anfitrión): `init`, `configure`, `load`, `change`, `autosave`, `issues`, `viewChange`, `export`, `result`, `capabilities`, `save`, `exit`, `error`.
- **`ui=min`** oculta la marca y las pestañas de módulos pero conserva las acciones.

```js
import { createIarkModuleEmbed } from 'iark-diagrams/embed'; // o dist/embed/iark-embed.global.js → window.IArkEmbed.createIarkModuleEmbed
const embed = createIarkModuleEmbed({
  container: '#panel',
  url: 'https://mi-servidor/diagramador/modulos.html', // o el `endpoints.embed` del manifiesto
  module: 'security',
  document: miDocumento,
  autosave: true,
  onChange: ({ document, issues }) => guardar(document),
});
const capacidades = await embed.initialized;
await embed.ready;
const svg = await embed.export('svg', 'dfd');
const { output } = await embed.run('risks', { options: { status: 'open' } });
```

Las acciones que esperan respuesta (`load`, `export`, `validate`, `run`, `capabilities`) devuelven una promesa y se rechazan con el mensaje de `error`, o por tiempo (15 s, configurable). Las que se lanzan antes del `init` se encolan. Demo: [`examples/modules-host.html`](examples/modules-host.html).

### Web Component `<iark-module>`

```html
<script type="module" src="https://mi-servidor/diagramador/embed/iark-module-element.js"></script>
<iark-module manifest="https://mi-servidor/diagramador/.well-known/iark.json" module="security" theme="dark" ui="min" style="height: 520px"></iark-module>
<script>document.querySelector('iark-module').document = miDocumento;</script>
```

Atributos: `manifest` (descubre el editor del módulo en la instancia) o `src` (URL directa de `modulos.html`), `module`, `theme`, `ui`, `readonly`, `autosave`, `view`. El documento va por la propiedad `document` (objeto o JSON). Eventos DOM: `iark-init`, `iark-load`, `iark-change`, `iark-view-change`, `iark-save`, `iark-exit`, `iark-error`, `iark-result`. Métodos: `export`, `run`, `validate`, `capabilities`, `setView`, `save`; esperan a que el widget esté listo. Demo: [`examples/web-component-host.html`](examples/web-component-host.html). Se empaqueta como `dist/embed/iark-module-element.{js,global.js}` y como el subpath `iark-diagrams/element`.

### Federación por manifiesto

Cada instancia publica `/.well-known/iark.json` (esquema `iark.manifest/1`): módulos, versiones, formatos y **endpoints relativos** al manifiesto (`embed`, `schema`, `api`). El sitio estático lo incluye junto con los JSON Schema de cada módulo (`npm run manifest` lo regenera; una prueba comprueba que no se desincroniza), y `iark serve` lo genera al vuelo con la URL de su API. El shell y el Web Component solo dependen de ese manifiesto, no del código de los módulos.

### Servicio HTTP (`iark serve`)

```bash
npm run build
node dist/cli/index.js serve --static dist/app --port 8787      # o: docker build -t iark-diagrams . && docker run --rm -p 8787:8787 iark-diagrams
curl localhost:8787/api/modules
curl -X POST localhost:8787/api/security/validate -d @examples/seguridad-ejemplo.json
curl -X POST 'localhost:8787/api/security/export?format=svg&view=dfd' -d @examples/seguridad-ejemplo.json > dfd.svg
```

| Ruta | Descripción |
|---|---|
| `GET /.well-known/iark.json` · `GET /api/modules` | Manifiesto de la instancia y capacidades de los módulos |
| `GET /api/<módulo>/capabilities` · `/schema[?kind=generation]` | Formatos, informes, vistas de traza; JSON Schema del documento o de la salida de IA |
| `POST /api/<módulo>/validate` · `/views` · `/export?format=&view=` | Cuerpo: el documento JSON |
| `POST /api/<módulo>/import?importer=&name=` | Cuerpo: texto (Mermaid…) → documento y avisos |
| `POST /api/<módulo>/run/<comando>` | Cuerpo `{ input?, args?, options? }` → informe o conversión |
| `POST /api/trace` | Cuerpo `{ documents: [{ module, document }], from?, direction?, depth? }` → grafo de trazabilidad |

Sin estado, sin dependencias (`node:http`). Sin `--cors` solo responde al mismo origen; `--cors https://mi-app.example` (o `*`) abre la API a un navegador de otro origen. El cuerpo máximo es de 5 MB. La generación con IA sigue viviendo solo en el CLI.

#### Imagen Docker

El `Dockerfile` (dos etapas sobre `node:22-alpine`) compila la biblioteca, el CLI y el sitio, deja solo las dependencias de producción y arranca `iark serve --host 0.0.0.0 --port 8787 --static dist/app` como el usuario `node` (no root). La imagen pesa unos 355 MB (la base de Node, 167 MB; `node_modules`, 176 MB; el sitio, 9 MB; el CLI, 4 MB) y no guarda estado.

```bash
docker build -t iark-diagrams .
docker run --rm -p 8787:8787 iark-diagrams                                   # editor, banco de trabajo, shell y API en http://localhost:8787
docker run --rm -p 9000:8787 iark-diagrams --cors https://mi-app.example    # otro puerto del anfitrión y la API abierta a ese origen
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges -p 8787:8787 iark-diagrams   # endurecida: no escribe en disco
```

- Los argumentos tras el nombre de la imagen se añaden al `ENTRYPOINT` (`--cors`, `--static`…); si repites una opción, gana la última. Para cambiar el puerto de publicación basta `-p`; si cambias el `--port` de dentro, el `HEALTHCHECK` (que consulta `/api/modules` en el 8787) fallará: sobrescríbelo con `--health-cmd` o `--no-healthcheck`.
- El contenedor pasa a `healthy` en unos segundos (`docker inspect --format '{{.State.Health.Status}}' <contenedor>`) y `docker stop` lo detiene en menos de un segundo con código 0: `iark serve` cierra el servidor al recibir `SIGTERM`, sin necesidad de `--init`.
- Probado con Docker 29 (`docker build` y `docker run --network host`, en un entorno sin red de puente): `/`, `/modulos.html?module=data`, `/suite.html`, `/trazabilidad.html`, `/.well-known/iark.json`, `/api/modules`, validar y exportar (SVG, Mermaid y draw.io) un ejemplo de cada módulo, importar Mermaid, `run/<comando>` y `POST /api/trace`.

## Estructura del proyecto

Monorepo con workspaces de npm. Los paquetes internos se consumen desde su código fuente; `npm run build` los empaqueta dentro de `dist/`.

```
packages/kernel/       @iark/kernel: contrato de módulo (DomainModule), registro, URN, manifiesto de federación, IA estructurada, sintaxis Mermaid (flowchart, sequence, erDiagram) y layout/SVG de grafos genéricos
packages/domain-c4/    @iark/domain-c4: módulo `c4` (modelo, esquema zod, vistas, autolayout ELK, import/export draw.io, Structurizr y Mermaid, prompts de IA; sin DOM)
packages/domain-integration/  @iark/domain-integration: módulo `integration` (nodos, contratos, interacciones y flujos; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-data/  @iark/domain-data: módulo `data` (activos, dominios, pipelines y linaje, modelo entidad-relación y gobierno del dato; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-enterprise/  @iark/domain-enterprise: módulo `enterprise` (capacidades, procesos, aplicaciones y tecnología con ciclo de vida; mapa de capacidades, paisaje, impacto y obsolescencia; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-platform/  @iark/domain-platform: módulo `platform` (entornos, redes, recursos, servicios, despliegues, dependencias y pipelines; topología, despliegue por entorno, entrega continua e impacto; import Mermaid, export Mermaid/SVG/draw.io, IA)
packages/domain-security/  @iark/domain-security: módulo `security` (zonas de confianza, activos, flujos de datos, amenazas STRIDE y controles; diagrama de flujo de datos, modelo de amenazas, riesgos y superficie de ataque; import Mermaid, export Mermaid/SVG/draw.io, IA)
src/cli/               comandos de iark (commander): módulos, `trace`, `serve`; carga los módulos del registro
src/embed/             protocolo postMessage (C4 y de módulos), SDK de anfitrión y Web Component <iark-module>
src/modules-app/       banco de trabajo genérico de módulos (controlador sin React, editor, protocolo del puente)
src/shell/             shell de la suite (descubrimiento por manifiesto)
src/trace-app/         vista web de trazabilidad entre módulos (tablero sin DOM + página)
src/app/               editor React (Vite, React Flow, Semi UI, Tailwind)
schema/                JSON Schema del documento y del formato de generación
examples/              documentos de ejemplo por módulo y páginas anfitrionas de demostración
public/.well-known/    manifiesto de federación publicado con el sitio (iark.json)
Dockerfile             imagen del servicio (`iark serve` + sitio)
docs/roadmap.md        hoja de ruta de la suite (integraciones, datos, empresarial, plataforma…)
tests/e2e/             pruebas Playwright
```

`iark modules` lista los módulos instalados y `iark modules --json` emite su manifiesto (`iark.manifest/1`), que es la base de la federación. Cada especialidad nueva es un paquete `@iark/domain-*` que implementa `DomainModule` y se registra en `src/cli/registry.ts`.

## Decisiones de diseño

- **Modelo compartido + vistas** (como Structurizr): renombrar un contenedor lo actualiza en todas las vistas; cada vista es una página del `.drawio`.
- **La IA nunca produce coordenadas**: produce el modelo; ELK produce la geometría. Esto hace la generación robusta y el autolayout la pieza central del sistema.
- **ELK `layered` con `hierarchyHandling: INCLUDE_CHILDREN`** porque es el único motor JS que trata los boundaries como nodos compuestos.
- **Semi UI + Tailwind 4** son las mismas librerías que usa drawdb, lo que permite reproducir su estética (tabs tipo card, cards colapsables, grid de puntos, tarjetas con franja de color).
- **Niveles como vistas tipadas sobre un modelo único**, no diagramas independientes: así C1, C2 y C3 se mantienen coherentes entre sí y la navegación (doble clic, breadcrumb, enlaces de página en draw.io) se deriva de la relación vista ↔ alcance sin datos adicionales.

## Prueba real de `generate`

La generación con IA está cubierta por pruebas con clientes simulados (`src/core/ai/*.test.ts`) y, además, se ejecutó
contra un servicio real. Estado por proveedor:

| Proveedor | Estado |
|---|---|
| **Foundry, cualquier modelo** (`--provider openai`) | **Probado** con DeepSeek‑V4‑Pro (28‑09‑2026): un intento, JSON válido, 6 elementos, 4 relaciones y 2 vistas; `validate --strict` sin errores ni avisos, todas las vistas con coordenadas y el `.drawio` con una página por vista. Variables usadas: `AI_API_KEY`, `AI_BASE_URL` y `AI_MODEL` (también valen las `ANTHROPIC_FOUNDRY_*`). |
| **Claude en Foundry** (`--provider foundry`) | **Sin probar**: requiere un despliegue de Claude en el recurso, `ANTHROPIC_FOUNDRY_BASE_URL` (`https://<recurso>.services.ai.azure.com/anthropic/`) o `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY` y `ANTHROPIC_FOUNDRY_MODEL` con el nombre de ese despliegue. |
| **API de Anthropic** | **Sin probar**: requiere `ANTHROPIC_API_KEY` con créditos (la suscripción de Claude.ai no incluye acceso a la API). |

La prueba real destapó un defecto que las pruebas con clientes simulados no veían: la vista de contexto salía **sin su
propio sistema** (y por tanto sin aristas) porque `generatedToDocument` descartaba el `scopeId` en todas las vistas
y ningún validador lo exigía. Ahora solo se descarta en contenedores/componentes, y `validateDocument` rechaza una vista
`systemContext` que no incluya su alcance (lo que dispara el reintento con el error), con el mismo aviso en el panel de
problemas y en `validate --strict`.

Para repetir la prueba con otro proveedor o modelo:

```bash
npm run cli -- generate "Sistema de banca en línea con app web (React), API (Node.js), PostgreSQL y una pasarela de pagos externa" \
  --json examples/banca-ia.generated.json --out examples/banca-ia.generated.drawio
npm run cli -- validate examples/banca-ia.generated.json --strict
```

y comprobar que `validate` no reporta errores, que todas las vistas tienen coordenadas y que el `.drawio` abre en
draw.io con una página por vista (la vista de contexto debe llevar el sistema y sus relaciones). Los archivos
`*.generated.*` están ignorados por git. Si el endpoint rechaza algo (formato de respuesta, parámetros de tokens,
autenticación), el ajuste va en `src/core/ai/openaiCompat.ts`. Las credenciales van siempre en los ajustes del entorno
(*Environment variables* / *API credentials*), nunca en el chat, en el código ni en git (`.gitignore` excluye `.env*`).

## Fuera de alcance (v1)

Servidor MCP, exportación PNG/SVG desde el modo embebido, vistas de despliegue/código, colaboración en tiempo real, importar `.drawio` o DSL desde el modo embebido (el anfitrión puede usar `fromDrawio` / `fromStructurizrDsl` del núcleo), exportar a DSL de Structurizr.
