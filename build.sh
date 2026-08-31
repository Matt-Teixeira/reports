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
# PUPPETEER_SKIP_DOWNLOAD: the browser is BAKED INTO THE IMAGE (see
# Dockerfile), not installed per copy. Without this, puppeteer's postinstall
# pulls ~170 MB into the tree/HOME of this throwaway container -- bytes that
# build-release.sh would then mirror into /opt/apps on every release.
docker run --rm \
  -v "$(pwd)":/workspace -w /workspace \
  --user "$(id -u):$(id -g)" \
  -e NPM_CONFIG_CACHE=/tmp/.npm \
  -e PUPPETEER_SKIP_DOWNLOAD=true \
  node:lts npm install

# Derive the Chrome build from the puppeteer that npm just installed, rather
# than hand-maintaining a version in two places. The Dockerfile installs
# exactly this build, so bumping the puppeteer dependency moves the browser
# with it. Falls back to the compose default if the lookup fails (e.g. a
# puppeteer layout change) -- the build still succeeds, and the preflight
# browser-launch probe is what catches a genuine mismatch.
CHROME_VERSION="$(docker run --rm -v "$(pwd)":/workspace -w /workspace \
  --user "$(id -u):$(id -g)" -e NPM_CONFIG_CACHE=/tmp/.npm node:lts \
  node -p "require('puppeteer-core/lib/cjs/puppeteer/revisions.js').PUPPETEER_REVISIONS.chrome" 2>/dev/null || true)"
if [ -n "$CHROME_VERSION" ]; then
    export CHROME_VERSION
    echo "==> chrome build derived from installed puppeteer: $CHROME_VERSION"
else
    echo "==> WARNING: could not derive the Chrome build from node_modules/puppeteer-core;"
    echo "    falling back to the default pinned in docker-compose.yml."
fi

echo "==> docker compose build app (image reports:${USER_ID})"
docker compose build app

echo "==> done: reports:${USER_ID}"
