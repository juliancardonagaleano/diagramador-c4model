#!/usr/bin/env bash
# Publica la app compilada (dist/app) en la rama `gh-pages`, para GitHub Pages con
# origen "Deploy from a branch" → gh-pages / raíz. Útil cuando no se pueden ejecutar
# workflows de GitHub Actions. Uso: npm run deploy:pages
set -euo pipefail

root=$(git rev-parse --show-toplevel)
repo=$(basename "$root")
cd "$root"

# Pages sirve bajo /<repositorio>/; se puede sobrescribir con BASE_PATH.
BASE_PATH="${BASE_PATH:-/$repo/}" npm run build:app

wt=$(mktemp -d)
git worktree add --detach "$wt" >/dev/null
(
  cd "$wt"
  git checkout -q --orphan gh-pages
  git rm -rfq .
  cp -r "$root/dist/app/." .
  touch .nojekyll
  git add -A
  git commit -qm "Sitio compilado desde $(git -C "$root" rev-parse --short HEAD)"
  git push -f origin gh-pages
)
git worktree remove --force "$wt"
echo "Publicado en gh-pages. Origen de Pages: Settings → Pages → Deploy from a branch → gh-pages / (root)."
