#!/usr/bin/env bash
# Preflight for reports — validates the environment the NEXT run will actually
# use. Fleet paradigm (data_acquisition/docs/migration_CLAUDE.md); adapted from
# monday's preflight. A clean run reports ZERO warnings: treat a persistent
# warning as a bug in the check itself, or it trains people to ignore output.
#
# Exit codes: 0 = pass (or warnings only), 1 = critical errors found.
set -u
cd "$(dirname "$0")"

ERRORS=0; WARNINGS=0; OKS=0
ok()    { echo "  OK    $*"; OKS=$((OKS+1)); }
warn()  { echo "  WARN  $*"; WARNINGS=$((WARNINGS+1)); }
error() { echo "  ERROR $*"; ERRORS=$((ERRORS+1)); }
info()  { echo "        $*"; }
section(){ echo; echo "== $* =="; }

# Read KEY= from .env, stripping quotes, dotenv-style inline comments and
# trailing whitespace. NEVER source an app .env (fleet lesson: bash mangles
# $$ and `set -a` exports the result over compose's own interpolation).
env_val() {
    grep "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- \
        | sed -e 's/[[:space:]]\+#.*$//' -e 's/[[:space:]]*$//' \
              -e "s/^['\"]//" -e "s/['\"]$//"
}

# ---------------------------------------------------------------- 1. host dirs
section "Host directories"
# Validate whatever LOG_DIR points at — the dir the next run will actually
# use — not a hardcoded path. Dev default is in-tree and gitignored (missing
# in a fresh clone; entrypoint.sh creates it on first docker run).
LOG_DIR_V="$(env_val LOG_DIR)"; LOG_DIR_V="${LOG_DIR_V:-./utils/logger/logs}"
if [ -d "$LOG_DIR_V" ] && [ -w "$LOG_DIR_V" ]; then
    ok "LOG_DIR $LOG_DIR_V writable ($(stat -c '%U:%G %a' "$LOG_DIR_V"))"
elif [ -d "$LOG_DIR_V" ]; then
    error "LOG_DIR $LOG_DIR_V exists but is not writable by $(id -un) ($(stat -c '%U:%G %a' "$LOG_DIR_V")) — the logger dies in createWriteStream"
else
    warn "LOG_DIR $LOG_DIR_V missing (entrypoint.sh creates the dev dir on first docker run; /opt/run-logs/reports must be pre-provisioned svc:docker 2775)"
fi

PG_SSL_PATH_V="$(env_val PG_SSL_PATH)"
if [ -n "$PG_SSL_PATH_V" ] && [ -r "$PG_SSL_PATH_V" ]; then
    ok "PG CA readable at $PG_SSL_PATH_V"
elif [ -n "$PG_SSL_PATH_V" ]; then
    error "PG CA missing/unreadable at $PG_SSL_PATH_V — pg-pool.js fails closed at require-time (verify-full)"
else
    error "PG_SSL_PATH empty — PG_SSLMODE=verify-full requires it (pg-pool.js fails closed)"
fi

# ------------------------------------------------------------------- 2. docker
section "Docker"
if docker ps >/dev/null 2>&1; then ok "docker daemon reachable"; else error "docker daemon not reachable as $(id -un)"; fi
if id -nG | grep -qw docker; then ok "$(id -un) is in the docker group"; else error "$(id -un) not in docker group"; fi
if docker compose version >/dev/null 2>&1; then ok "docker compose available"; else error "docker compose not available"; fi

USER_ID_V="$(env_val USER_ID)"
if [ -n "$USER_ID_V" ]; then
    if docker image inspect "reports:${USER_ID_V}" >/dev/null 2>&1; then
        ok "image reports:${USER_ID_V} present"
    else
        error "image reports:${USER_ID_V} missing — run: bash build.sh"
    fi
fi

# ----------------------------------------------------------------- 3. networks
section "Networks"
if docker network inspect pg_net >/dev/null 2>&1; then ok "network pg_net exists"; else error "network pg_net missing"; fi

# --------------------------------------------------------------------- 4. .env
section ".env"
if [ ! -f .env ]; then
    error ".env missing — copy .env.example and fill it in"
else
    REQUIRED="APP_NAME USER_ID LOGGER_MODE LOG_DIR
              PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PG_SSLMODE PG_SSL_PATH
              OUTLOOK_USER OUTLOOK_PW
              MONDAY_API_TOKEN MONDAY_BOARD_ID"
    for key in $REQUIRED; do
        v="$(env_val "$key")"
        if [ -z "$v" ]; then
            error ".env: $key is empty or missing"
        else
            case "$key" in
                *PW*|*PASSWORD*|*TOKEN*|*KEY*|*SECRET*) ok ".env: $key set (masked)" ;;
                *) ok ".env: $key=$v" ;;
            esac
        fi
    done

    # This app is the least-privilege-role pilot: anything else here means a
    # config regression, not a preference.
    [ "$(env_val PGUSER)" = "reports_rw" ] || warn ".env: PGUSER is '$(env_val PGUSER)', expected reports_rw (least-privilege role — see db/setup-role.sql)"
    [ "$(env_val PG_SSLMODE)" = "verify-full" ] || warn ".env: PG_SSLMODE is '$(env_val PG_SSLMODE)', expected verify-full (this app is the fleet's fail-closed TLS reference)"

    # The commented '## PROD AZURE' block is a kept wart (see CLAUDE.md):
    # pg-pool.js falls back PGHOST -> PG_HOST, so if that block is ever
    # uncommented while PGHOST goes empty, the app silently targets Azure PROD.
    if [ -z "$(env_val PGHOST)" ] && [ -n "$(env_val PG_HOST)" ]; then
        error ".env: PGHOST empty while PG_HOST is set — pg-pool.js would silently target PG_HOST ($(env_val PG_HOST))"
    fi

    # Dead keys kept by decision (2026-08-26) — informational, never a warning.
    for key in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_PHONE_NUMBER; do
        [ -n "$(env_val "$key")" ] && info ".env: $key set (dead key — no twilio code in this app; kept by decision)"
    done

    for retired in IMAGE_TAG RUN_USER LOGGER RUN_ENV; do
        grep -q "^$retired=" .env && warn ".env: retired key $retired still present — remove it (see .env.example)"
    done
fi

# ---------------------------------------------------------------- 5. app files
section "Application files"
for f in index.js package.json Dockerfile docker/entrypoint.sh docker-compose.yml build.sh build-release.sh; do
    if [ -f "$f" ]; then ok "$f present"; else error "$f missing"; fi
done
for d in jobs tools email sql utils/db utils/logger; do
    if [ -d "$d" ]; then ok "$d/ present"; else error "$d/ missing"; fi
done
if [ -e utils/.git ]; then error "utils/.git exists — utils must be app-owned, not a nested repo"; else ok "utils/ is app-owned (no nested .git)"; fi

# --------------------------------------------------------------------- 6. deps
section "Dependencies"
if [ -d node_modules ] && [ -n "$(ls -A node_modules 2>/dev/null)" ]; then
    ok "root node_modules present ($(ls node_modules | wc -l) entries)"
else
    error "root node_modules missing or empty — run: bash build.sh"
fi

# ------------------------------------------------- 7. external services (AUTH)
section "External services (authenticated checks)"

# The Postgres auth test MUST run from a sibling container on pg_net, never
# via `docker exec <pg_container> psql`: pg_hba trusts local and loopback, so
# an exec'd psql succeeds with a deliberately WRONG password (that path hid a
# rotated password for three weeks on a sibling app). This mirrors how the app
# connects (utils/db/pg-pool.js): verify-full with the CA from PG_SSL_PATH,
# mounted read-only into the check container at the same path.
PGHOST_V="$(env_val PGHOST)"; PGPORT_V="$(env_val PGPORT)"; PGUSER_V="$(env_val PGUSER)"
PGPASSWORD_V="$(env_val PGPASSWORD)"; PGDATABASE_V="$(env_val PGDATABASE)"
PG_SSLMODE_V="$(env_val PG_SSLMODE)"; PG_SSLMODE_V="${PG_SSLMODE_V:-verify-full}"
if [ -z "$PGPASSWORD_V" ]; then
    error "PGPASSWORD empty in .env — cannot verify PostgreSQL authentication"
elif ! docker image inspect postgres:16 >/dev/null 2>&1; then
    # An unverified check must never look like a passing one.
    warn "postgres:16 image absent — PostgreSQL auth NOT verified"
    info "Fix: docker pull postgres:16   (needed only for this check)"
else
    PG_OUT=$(docker run --rm --network pg_net \
        -v /opt/resources/ssl:/opt/resources/ssl:ro \
        -e PGPASSWORD="$PGPASSWORD_V" -e PGSSLMODE="$PG_SSLMODE_V" \
        -e PGSSLROOTCERT="$PG_SSL_PATH_V" \
        -e PGCONNECT_TIMEOUT=10 \
        postgres:16 \
        psql -h "$PGHOST_V" -p "$PGPORT_V" -U "$PGUSER_V" -d "$PGDATABASE_V" \
             -tAc "SELECT 'ok'" 2>&1)
    if [ "$(echo "$PG_OUT" | tail -1 | tr -d '[:space:]')" = "ok" ]; then
        ok "PostgreSQL auth OK (sibling-container ${PG_SSLMODE_V} connection as $PGUSER_V)"
    elif echo "$PG_OUT" | grep -qi "password authentication failed\|no password supplied"; then
        error "PostgreSQL rejected PGPASSWORD from .env — likely a rotated credential"
        info "Fix: reports_rw rotates via /root/reports_rw_pw + db/setup-role.sql (setup doc, DATABASE ROLES); update BOTH copies' .env (dev clone + release)"
    elif echo "$PG_OUT" | grep -qi "certificate\|SSL"; then
        error "PostgreSQL SSL failure: $(echo "$PG_OUT" | head -2)"
    else
        error "PostgreSQL check failed: $(echo "$PG_OUT" | head -2)"
    fi
fi

# Monday.com: a read-only `me` query proves the token AUTHENTICATES — a
# non-empty token proves nothing (the Redis-NOAUTH lesson). Uses curl from the
# host; the token travels in a header, never in process args visible to ps.
MONDAY_TOKEN_V="$(env_val MONDAY_API_TOKEN)"
if [ -z "$MONDAY_TOKEN_V" ]; then
    error "MONDAY_API_TOKEN empty — cannot verify Monday.com auth"
elif ! command -v curl >/dev/null 2>&1; then
    warn "curl not available — Monday.com auth NOT verified"
else
    MB_OUT=$(curl -sS --max-time 15 -X POST https://api.monday.com/v2 \
        -H "Content-Type: application/json" \
        -H @<(printf 'Authorization: %s\n' "$MONDAY_TOKEN_V") \
        -d '{"query":"query { me { id name } }"}' 2>&1)
    if echo "$MB_OUT" | grep -q '"me":{"id"'; then
        ok "Monday.com auth OK (read-only me query)"
    elif echo "$MB_OUT" | grep -qi "not authenticated\|Unauthorized\|invalid token"; then
        error "Monday.com rejected MONDAY_API_TOKEN: $(echo "$MB_OUT" | head -c 200)"
    else
        error "Monday.com check failed: $(echo "$MB_OUT" | head -c 200)"
    fi
fi

# Outlook SMTP: presence-only by decision (2026-08-26, Acumatica precedent) —
# an SMTP AUTH probe logs into production Office 365. The operator-approved
# email round-trip smoke (matt-only test subscription) exercises the real login.
info "Outlook SMTP: presence-only (OUTLOOK_* checked above); real login exercised by the approved email smoke test"

# ----------------------------------------------- release currency (fleet-wide)
# FLEET-FINDINGS §4.1: two sessions shipped a release believing it contained
# work that existed only in the dev tree. Currency is a continuous property —
# check it on every preflight, from either copy.
section "Release currency"
if [ -d .git ]; then
    REL_DIR="/opt/apps/$(basename "$(pwd)")"
    REL_SHA="$(grep '^RELEASE_SHA=' "$REL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"[:space:]")"
    HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
    if [ -z "$HEAD_SHA" ]; then
        warn "cannot read git HEAD here — release currency not checked"
    elif [ -z "$REL_SHA" ]; then
        warn "no RELEASE_SHA at $REL_DIR/.env — release copy missing or never released"
    elif [ "$(git rev-parse --quiet --verify "$REL_SHA^{commit}" 2>/dev/null)" = "$HEAD_SHA" ]; then
        ok "release copy is current (RELEASE_SHA=$REL_SHA = HEAD)"
        [ -n "$(git status --porcelain 2>/dev/null)" ] && info "note: this tree has uncommitted changes — they are in NO release"
    else
        BEHIND="$(git rev-list --count "$REL_SHA..HEAD" 2>/dev/null)"
        if [ -n "$BEHIND" ] && [ "$BEHIND" -gt 0 ] 2>/dev/null; then
            warn "release copy is $BEHIND commit(s) behind HEAD (RELEASE_SHA=$REL_SHA) — /opt/apps runs OLD code until build-release.sh"
        else
            warn "deployed RELEASE_SHA=$REL_SHA is not an ancestor of HEAD (rebase? branch switch?) — verify what /opt/apps is running"
        fi
    fi
else
    REL_SHA="$(env_val RELEASE_SHA)"
    if [ -n "$REL_SHA" ]; then
        ok "release copy stamped RELEASE_SHA=$REL_SHA"
    else
        error "no RELEASE_SHA in this .env — this copy was not produced by build-release.sh"
    fi
fi

# ------------------------------------------------------------------ 8. summary
section "Summary"
echo "  $OKS ok, $WARNINGS warnings, $ERRORS errors"
if [ "$ERRORS" -gt 0 ]; then
    echo "  RESULT: FAIL"
    exit 1
fi
[ "$WARNINGS" -gt 0 ] && echo "  RESULT: PASS (with warnings — a clean run should report zero)"
[ "$WARNINGS" -eq 0 ] && echo "  RESULT: PASS"
