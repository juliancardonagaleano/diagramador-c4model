# IArk - DIAgrams

> Antes «Diagramador C4». IArk - DIAgrams evoluciona hacia una suite de diagramación de arquitectura (integraciones, datos, empresarial, plataforma…); hoy incluye el editor del **modelo C4**. El comando `c4diagram` se mantiene como alias de `iark`. Hoja de ruta: [`docs/roadmap.md`](docs/roadmap.md).

Editor web de diagramas del **modelo C4** (Contexto, Contenedores y Componentes) con:

- **JSON limpio y estable** como formato nativo, convertible 1‑a‑1 a **`.drawio`** (usa la librería C4 oficial de draw.io, con placeholders `%c4Name%`, `%c4Type%`, `%c4Description%`, `%c4Technology%`) y **importable desde `.drawio` y desde el DSL de Structurizr** (web y CLI).
- **Autolayout jerárquico** (ELK, algoritmo *layered* con boundaries anidados) como característica central: el mismo motor se usa en el navegador y en el CLI.
- **Editor interactivo** con la estética de [drawdb.app](https://www.drawdb.app/): cabecera con menús, toolbar flotante, panel lateral con pestañas y cards, panel de problemas, tema claro/oscuro, deshacer/rehacer, minimapa.
- **CLI `iark`** para generar diagramas a partir de **instrucciones en lenguaje natural** (Claude, salida estructurada), aplicar autolayout y convertir a `.drawio` sin abrir un navegador. Se puede usar sin clave de API con cualquier otra IA o agente.
- **Modo embebido** por `<iframe>` con protocolo **postMessage** al estilo de draw.io (`embed.diagrams.net`) y un SDK de anfitrión.

## Instalación

```bash
npm install
npm run dev        # editor web en http://localhost:5173
npm run build      # librería (dist/core), CLI (dist/cli), SDK de embebido (dist/embed) y app (dist/app)
npm test           # pruebas unitarias y de componente (vitest + Testing Library)
npm run test:coverage  # igual, con informe de cobertura (informativo, sin umbral que bloquee)
npm run e2e        # pruebas de extremo a extremo con @playwright/test (requiere build:app previo)
npm run verify     # typecheck + test + build + e2e, de punta a punta
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

El JSON Schema está en [`schema/c4-document.schema.json`](schema/c4-document.schema.json) (`npm run schema` lo regenera; `iark schema` lo imprime). El módulo de integraciones tiene los suyos en `schema/integration-*.schema.json`.

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

## Módulo de integraciones

Segunda especialidad de la suite (`--module integration`): modela **cómo se hablan los sistemas** (APIs, gateways, brokers, colas y tópicos, almacenes), con sus contratos y los flujos de extremo a extremo. Vive en `packages/domain-integration` y no depende del código C4: se enlaza con él solo por referencias URN (`urn:iark:c4:<id>`).

Documento JSON (ejemplo completo en [`examples/pedidos-integracion.json`](examples/pedidos-integracion.json), esquema con `iark schema --module integration`):

| Parte | Contenido |
|---|---|
| `nodes` | `system`, `api` (dentro de un sistema), `gateway`, `broker`, `queue` / `topic` (dentro de un broker) y `store`; opcionales `technology`, `owner`, `external` y `ref` (URN al elemento C4 o de otro módulo) |
| `contracts` | `openapi`, `asyncapi`, `graphql`, `protobuf`, `avro`, `json-schema`, `wsdl` u `other`, con `version` |
| `interactions` | de un nodo a otro: `style` (`request-response`, `async-message`, `event`, `batch`, `stream`), `protocol`, `pattern` (circuit-breaker, saga, outbox, CQRS…), `contractId` y `criticality` |
| `flows` | secuencias ordenadas de interacciones (p. ej. «Crear un pedido») |

No se guardan coordenadas: las vistas se derivan del modelo (`map` con todo el mapa y `flow:<id>` por cada flujo) y el autolayout las coloca al exportar. `validate` comprueba la estructura (referencias, jerarquía, autoenlaces) y avisa de lo dudoso: colas sin productor o sin consumidor, interacciones sin contrato o duplicadas, contratos sin versión, dependencias síncronas circulares o una petición-respuesta contra una cola.

```bash
iark validate  pedidos.json --module integration
iark convert   pedidos.json --module integration --out mapa.svg          # también .mmd (Mermaid) y .drawio; --to fuerza el formato
iark convert   pedidos.json --module integration --to mermaid --view flow:crear-pedido   # el flujo sale como sequenceDiagram
iark import    mapa.mmd     --module integration --out pedidos.json       # Mermaid (flowchart o sequence) → documento
iark generate  "Pedidos con Kafka y una pasarela de pagos" --module integration --json pedidos.json
iark prompt    "…" --module integration                                 # prompt autocontenido, sin clave de API
iark integration from-c4 banca.json                                     # sistemas y contenedores C4 → mapa de integración
iark integration catalog pedidos.json                                   # tabla Markdown de contratos y dónde se usan
iark integration matrix  pedidos.json                                   # matriz origen × destino con el estilo de cada enlace
```

Al importar Mermaid, un `subgraph` con colas (`([ ])`) es un broker y cualquier otro un sistema que agrupa sus APIs; las colas y los tópicos comparten forma, así que un tópico vuelve como cola en la ida y vuelta. La interfaz web todavía no edita este módulo (siguiente paso de la hoja de ruta).

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
import { generateDocument, autoLayoutDocument, toDrawio, fromDrawio, fromStructurizrDsl, validateDocument, deriveView } from 'diagramador-c4model/core';

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

## Estructura del proyecto

Monorepo con workspaces de npm. Los paquetes internos se consumen desde su código fuente; `npm run build` los empaqueta dentro de `dist/`.

```
packages/kernel/       @iark/kernel: contrato de módulo (DomainModule), registro, URN, manifiesto de federación, IA estructurada, sintaxis Mermaid y layout/SVG de grafos genéricos
packages/domain-c4/    @iark/domain-c4: módulo `c4` (modelo, esquema zod, vistas, autolayout ELK, import/export draw.io, Structurizr y Mermaid, prompts de IA; sin DOM)
packages/domain-integration/  @iark/domain-integration: módulo `integration` (nodos, contratos, interacciones y flujos; import Mermaid, export Mermaid/SVG/draw.io, IA)
src/cli/               comandos de iark (commander); carga los módulos del registro
src/embed/             protocolo postMessage y SDK de anfitrión
src/app/               editor React (Vite, React Flow, Semi UI, Tailwind)
schema/                JSON Schema del documento y del formato de generación
examples/              documento de ejemplo y página anfitriona de demostración
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
