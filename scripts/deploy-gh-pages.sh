#!/usr/bin/env bash
# Publica la app compilada (dist/app) en la rama `gh-pages`, para GitHub Pages con
# origen "Deploy from a branch" → gh-pages / raíz. Es el método de despliegue del proyecto (sin
# GitHub Actions). Uso: npm run deploy:pages
set -euo pipefail

root=$(git rev-parse --show-toplevel)
repo=$(basename "$root")
cd "$root"

# Pages sirve bajo /<repositorio>/; se puede sobrescribir con BASE_PATH.
BASE_PATH="${BASE_PATH:-/$repo/}" OUT_DIR=dist/pages npm run build:app

wt=$(mktemp -d)
tmp_branch="gh-pages-deploy-$$"
git worktree add --detach "$wt" >/dev/null
# Rama huérfana temporal: así no choca con una rama local `gh-pages` de un despliegue anterior.
trap 'git worktree remove --force "$wt" 2>/dev/null || true; git branch -D "$tmp_branch" >/dev/null 2>&1 || true' EXIT
(
  cd "$wt"
  git checkout -q --orphan "$tmp_branch"
  git rm -rfq .
  cp -r "$root/dist/pages/." .
  touch .nojekyll
  git add -A
  git commit -qm "Sitio compilado desde $(git -C "$root" rev-parse --short HEAD)"
  git push -f origin "$tmp_branch:gh-pages"
)
echo "Publicado en gh-pages. Origen de Pages: Settings → Pages → Deploy from a branch → gh-pages / (root)."
