# IArk - DIAgrams como servicio: API por módulo, manifiesto de federación y el sitio (editor C4, banco de trabajo de
# módulos y shell) en un solo proceso Node, sin GitHub Actions ni servidor web aparte.
#
#   docker build -t iark-diagrams .
#   docker run --rm -p 8787:8787 iark-diagrams
#   curl http://localhost:8787/api/modules
#
# Para llamar a la API desde el navegador desde otro origen: añade --cors https://mi-app.example al comando.
FROM node:22-alpine AS build
WORKDIR /app
# Los workspaces (packages/*) deben existir antes de `npm ci`.
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund
COPY . .
# Compila la biblioteca, el CLI (dist/cli) y el sitio (dist/app), y deja solo las dependencias de producción.
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/cli ./dist/cli
COPY --from=build /app/dist/app ./dist/app
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:8787/api/modules >/dev/null || exit 1
ENTRYPOINT ["node", "dist/cli/index.js", "serve", "--host", "0.0.0.0", "--port", "8787", "--static", "dist/app"]
