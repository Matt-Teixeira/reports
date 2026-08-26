#!/usr/bin/env bash
# Build for reports: deps + image. Fleet paradigm
# (data_acquisition/docs/migration_CLAUDE.md Part 1).
#
#   1. npm install at the project root, run inside a throwaway node:lts
#      container as the CALLING host user, so node_modules lands IN-TREE with
#      ownership matching the host (no shared cache dir — each copy owns its
#      deps).
#   2. docker compose build app. All build args (USER_ID, DOCKER_GID,
#      UID_0/1/2) are interpolated by compose from .env — host identity lives
#      only there, and the Dockerfile ARGs have no defaults on purpose, so a
#      missing value fails the build instead of baking a wrong uid.
set -euo pipefail
cd "$(dirname "$0")"

# Read USER_ID from .env WITHOUT sourcing it: sourcing an app .env exports
# every value over compose's own interpolation and mangles anything bash
# expands ($$ became a PID on monday). compose reads .env itself; the guard
# only needs the one key.
USER_ID="$(grep -E '^USER_ID=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]' | tr -d "'\"")"

: "${USER_ID:?USER_ID is not set — add it to .env (drives the image tag reports:\$USER_ID)}"

echo "==> npm install (in-tree, as $(id -un))"
docker run --rm \
  -v "$(pwd)":/workspace -w /workspace \
  --user "$(id -u):$(id -g)" \
  -e NPM_CONFIG_CACHE=/tmp/.npm \
  node:lts npm install

echo "==> docker compose build app (image reports:${USER_ID})"
docker compose build app

echo "==> done: reports:${USER_ID}"
