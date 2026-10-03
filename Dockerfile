# IArk - DIAgrams como servicio: API por módulo, manifiesto de federación y el sitio (editor C4, banco de trabajo de
# módulos y shell) en un solo proceso Node, sin GitHub Actions ni servidor web aparte.
#
#   docker build -t iark-diagrams .
#   docker run --rm -p 8787:8787 iark-diagrams
#   curl http://localhost:8787/api/modules
#
# Para llamar a la API desde el navegador desde otro origen: añade --cors https://mi-app.example al comando.
# Para guardar proyectos y compartirlos entre personas (servidor autoalojable): monta la carpeta de trabajo y la de los
# tokens, y pasa IARK_WORKSPACE e IARK_TOKENS. La imagen escucha en 0.0.0.0, así que con IARK_WORKSPACE y sin IARK_TOKENS
# `iark serve` se niega a arrancar. Los tokens se crean con `docker run --rm -v <carpeta>:/tokens --entrypoint node
# iark-diagrams dist/cli/index.js auth create <nombre> --role admin --tokens /tokens/tokens.json` (ver el README,
# «Servidor para varias personas»).
# El puerto de dentro sale de la variable PORT (8787 por defecto) y lo usan igual el servidor y el HEALTHCHECK:
# para cambiarlo, `-e PORT=9000` (y publícalo con `-p 9000:9000`), no `--port`.
FROM node:22-alpine AS build
WORKDIR /app
# Los workspaces (packages/*) deben existir antes de `npm ci`.
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
COPY . .
# Compila la biblioteca, el CLI (dist/cli) y el sitio (dist/app), y deja solo las dependencias de producción: las del
# frontend (react, Semi UI, xyflow…) son devDependencies porque Vite ya las empaqueta en dist/app.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/cli ./dist/cli
COPY --from=build /app/dist/app ./dist/app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/api/modules" >/dev/null || exit 1
# `sh -c` solo expande $PORT; `exec` deja a node como proceso 1 (recibe SIGTERM) y "$@" añade los argumentos de `docker run`.
ENTRYPOINT ["sh", "-c", "exec node dist/cli/index.js serve --host 0.0.0.0 --port \"${PORT:-8787}\" --static dist/app \"$@\"", "iark"]
