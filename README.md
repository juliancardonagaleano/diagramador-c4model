# Diagramador C4

Editor web de diagramas del **modelo C4** (Contexto, Contenedores y Componentes) con:

- **JSON limpio y estable** como formato nativo, convertible 1‑a‑1 a **`.drawio`** (usa la librería C4 oficial de draw.io, con placeholders `%c4Name%`, `%c4Type%`, `%c4Description%`, `%c4Technology%`).
- **Autolayout jerárquico** (ELK, algoritmo *layered* con boundaries anidados) como característica central: el mismo motor se usa en el navegador y en el CLI.
- **Editor interactivo** con la estética de [drawdb.app](https://www.drawdb.app/): cabecera con menús, toolbar flotante, panel lateral con pestañas y cards, panel de problemas, tema claro/oscuro, deshacer/rehacer, minimapa.
- **CLI `c4diagram`** para generar diagramas a partir de **instrucciones en lenguaje natural** (Claude, salida estructurada), aplicar autolayout y convertir a `.drawio` sin abrir un navegador. Se puede usar sin clave de API con cualquier otra IA o agente.
- **Modo embebido** por `<iframe>` con protocolo **postMessage** al estilo de draw.io (`embed.diagrams.net`) y un SDK de anfitrión.

## Instalación

```bash
npm install
npm run dev        # editor web en http://localhost:5173
npm run build      # librería (dist/core), CLI (dist/cli), SDK de embebido (dist/embed) y app (dist/app)
npm test           # pruebas unitarias (vitest)
npm run e2e        # pruebas de extremo a extremo con Playwright (requiere build previo)
```

Requisitos: Node 20+.

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
| `view.scopeId` | sistema (contexto/contenedores) o contenedor (componentes); se dibuja como **boundary** |
| `view.layout.direction` | `DOWN`, `RIGHT`, `UP`, `LEFT` |
| `view.layout.density` | `auto`, `compact`, `spacious` |
| `view.edges[]` | rutas del autolayout: `{ id, points: [{x,y}…], label?: {x,y} }` (opcional; se recalculan si quedan obsoletas) |

Reglas que se derivan automáticamente (no se almacenan):

- **Boundaries**: el `scopeId` de una vista de contenedores/componentes y cualquier elemento visible con hijos visibles.
- **Relaciones**: se dibujan las que unen dos elementos visibles; si un extremo no está visible pero sí su ancestro, se dibuja una relación *implícita* (una por par).

El JSON Schema está en [`schema/c4-document.schema.json`](schema/c4-document.schema.json) (`npm run schema` lo regenera; `c4diagram schema` lo imprime).

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

## Conversión a `.drawio`

Cada vista se convierte en una página de draw.io. Los elementos se envuelven en `<object placeholders="1" c4Name=… c4Type=… c4Description=… c4Technology=…>` con los estilos de la librería C4 (`shape=mxgraph.c4.person2`, `cylinder3` para bases de datos, boundary punteado, relaciones ortogonales). Los hijos de un boundary cuelgan de su celda con geometría relativa, tal como los crea draw.io. El archivo se escribe sin comprimir, así que draw.io / diagrams.net lo abre directamente y se puede versionar en git.

```bash
npx c4diagram convert examples/banca.json --out banca.drawio          # aplica autolayout si faltan coordenadas
npx c4diagram convert examples/banca.json --locale en --view contexto  # etiquetas de tipo en inglés, una sola vista
npx c4diagram convert examples/banca.json --notation card --out banca-tarjetas.drawio  # tarjetas estilo drawdb
```

Dos **notaciones** de figuras (`--notation`, menú Archivo o `toDrawio(doc, { notation })`):

- `c4` (por defecto): librería C4 oficial de draw.io (persona, sistema, contenedor, componente, cilindro).
- `card`: tarjetas estilo drawdb (rectángulo claro con franja del color C4, nombre, `[Tipo: tecnología]` y descripción); las bases de datos y colas conservan el cilindro con relleno claro.

Los archivos [`examples/banca-c4.drawio`](examples/banca-c4.drawio) y [`examples/banca-tarjetas.drawio`](examples/banca-tarjetas.drawio) son el ejemplo de banca exportado en cada notación (3 páginas, enlaces entre niveles y waypoints del autolayout).

## CLI `c4diagram`

```
c4diagram generate "<instrucción>" [--from base.json] [--out d.drawio] [--json d.json] [--model claude-opus-5] [--effort high] [--direction DOWN]
c4diagram layout   [archivo.json | --stdin] [--out out.json] [--direction RIGHT] [--density auto|compact|spacious] [--fast] [--force] [--view id]
c4diagram convert  [archivo.json | --stdin] [--out out.drawio] [--notation c4|card] [--no-waypoints] [--locale es|en] [--view id...]
c4diagram validate [archivo.json | --stdin] [--strict]
c4diagram schema   [--generation]
c4diagram prompt   "<instrucción>" [--from base.json]
c4diagram example
```

En desarrollo: `npm run cli -- <comando>`; tras `npm run build`: `node dist/cli/index.js` o `npx c4diagram` si el paquete está instalado.

### Generar diagramas con IA (Claude)

```bash
export ANTHROPIC_API_KEY=…   # o `ant auth login`
npx c4diagram generate "Sistema de banca en línea con app web (React), API (Node.js), base de datos PostgreSQL y una pasarela de pagos externa. Los clientes consultan saldos y hacen pagos." \
  --out banca.drawio --json banca.json
```

Flujo: la instrucción se envía a Claude (`claude-opus-5` por defecto) con **salida estructurada** contra el esquema del modelo *sin coordenadas*; el resultado se valida (referencias, jerarquía C4) con un reintento automático si hay errores; después se aplica **autolayout** a todas las vistas y se escriben el JSON y el `.drawio`. Con `--from base.json` la instrucción se trata como un refinamiento del documento existente ("agrega una cola Kafka entre la API y las notificaciones"), conservando los ids y posiciones ya fijados.

### Sin clave de API: cualquier IA o agente

`c4diagram prompt` imprime un prompt autocontenido (reglas C4 + JSON Schema + instrucción). Pégalo en el asistente que prefieras (o deja que un agente como Claude Code lo ejecute) y tuberiza la respuesta:

```bash
npx c4diagram prompt "Plataforma de reservas de hotel con app móvil, backend y pagos" > prompt.txt
# … la IA responde con un JSON (se acepta envuelto en ```json) …
cat respuesta.json | npx c4diagram layout --stdin --out reservas.json
npx c4diagram convert reservas.json --out reservas.drawio
```

La pestaña **IA** del editor web hace lo mismo sin llamar a ningún servicio: "Copiar prompt para IA" y "Pegar JSON generado" (valida, aplica autolayout y carga o fusiona el modelo).

### Uso programático

```ts
import { generateDocument, autoLayoutDocument, toDrawio, validateDocument, deriveView } from 'diagramador-c4model/core';

const { document } = await generateDocument({ instruction: 'Un sistema de tickets…' }); // Claude + autolayout
const laid = await autoLayoutDocument(validateDocument(json).document, { direction: 'RIGHT', force: true });
const xml = toDrawio(laid, { locale: 'en' });
```

`core` no depende del DOM: funciona en Node y en el navegador.

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
| `autoLayout` | `viewId?`, `direction?`, `force?` |
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
  import { createC4Embed } from 'diagramador-c4model/embed'; // o dist/embed/c4-embed.global.js → window.C4Embed
  const embed = createC4Embed({
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

```
src/core/     modelo, esquema zod, derivación de vistas, autolayout ELK, export .drawio, IA (sin DOM)
src/cli/      comandos de c4diagram (commander)
src/embed/    protocolo postMessage y SDK de anfitrión
src/app/      editor React (Vite, React Flow, Semi UI, Tailwind)
schema/       JSON Schema del documento y del formato de generación
examples/     documento de ejemplo y página anfitriona de demostración
tests/e2e/    pruebas Playwright
```

## Decisiones de diseño

- **Modelo compartido + vistas** (como Structurizr): renombrar un contenedor lo actualiza en todas las vistas; cada vista es una página del `.drawio`.
- **La IA nunca produce coordenadas**: produce el modelo; ELK produce la geometría. Esto hace la generación robusta y el autolayout la pieza central del sistema.
- **ELK `layered` con `hierarchyHandling: INCLUDE_CHILDREN`** porque es el único motor JS que trata los boundaries como nodos compuestos.
- **Semi UI + Tailwind 4** son las mismas librerías que usa drawdb, lo que permite reproducir su estética (tabs tipo card, cards colapsables, grid de puntos, tarjetas con franja de color).
- **Niveles como vistas tipadas sobre un modelo único**, no diagramas independientes: así C1, C2 y C3 se mantienen coherentes entre sí y la navegación (doble clic, breadcrumb, enlaces de página en draw.io) se deriva de la relación vista ↔ alcance sin datos adicionales.

## Pendiente: prueba real de `generate` con la API de Anthropic

La generación con Claude está implementada y cubierta por pruebas con cliente simulado (`src/core/ai/generate.test.ts`) y por el test del CLI sin credenciales, pero **todavía no se ha ejecutado contra la API real** porque requiere una clave con créditos en la Consola de Claude (la suscripción de Claude.ai no incluye acceso a la API). Cuando exista la clave:

1. Guardarla fuera del repositorio: como variable de entorno `ANTHROPIC_API_KEY` (en Claude Code web, en los ajustes del entorno → *API credentials*). Nunca en el chat, en el código ni en git (`.gitignore` excluye `.env*`).
2. Ejecutar:
   ```bash
   npm run cli -- generate "Sistema de banca en línea con app web (React), API (Node.js), PostgreSQL y una pasarela de pagos externa" \
     --json examples/banca-ia.generated.json --out examples/banca-ia.generated.drawio
   npm run cli -- validate examples/banca-ia.generated.json
   ```
3. Comprobar que `validate` no reporta errores, que todas las vistas tienen coordenadas y que el `.drawio` abre en draw.io con una página por vista. Los archivos `*.generated.*` están ignorados por git.

## Fuera de alcance (v1)

Servidor MCP, exportación PNG/SVG desde el modo embebido, vistas de despliegue/código, importar `.drawio` → JSON, colaboración en tiempo real.
