# CLAUDE.md

> ## ⚠️ MID-MERGE — this file describes the PRE-MERGE app (2026-08-31)
>
> `STAGING_docker` is taking the `PROD` branch's application work (109 commits:
> the `sme_reports/` Magnet Health Brief engine, scoped/customer summaries, EDU
> reporting, PDF rendering via headless Chromium, zip batch delivery) while
> keeping the docker/release paradigm. Until this banner is removed, sections
> below may describe either the pre- or post-merge state. Known deltas in
> flight:
>
> - a new run family `sme_report` (file mode and DB-config scheduled mode)
> - `puppeteer` + a baked Chromium and the `zip` binary become image
>   dependencies — the Dockerfile is no longer "gosu only"
> - PDF archiving is being deliberately disabled (no host archive path)
> - `reports_rw` needs three new grants (`alert.sme_report_sends` INSERT + its
>   sequence, `public.users` SELECT)
>
> Unchanged and reaffirmed: **no schedule is installed on this host, by
> decision.** See the hazard section below before running anything.

> **Migrated to the fleet dev/release paradigm 2026-08-26** (spec:
> `data_acquisition/docs/migration_CLAUDE.md`, Part 1). Structure-only:
> **no schedule was installed, by decision** — see the warning below before
> running anything. The editable tree is the dev clone `~/apps/reports`;
> `/opt/apps/reports` is `build-release.sh` output (owned svc, wiped and
> replaced on every release — never edit it in place).

**reports** is a Node.js run-once report mailer. Invoked as
`node index.js <report_family>`, it computes the current schedule slot
(`ccc-HH:mm` in America/New_York, e.g. `mon-08:00`), loads the subscriptions
for that family whose `alert.reports.email_schedule` marks that slot true,
builds per-user HTML reports from staging-DB queries, and emails them via
Office 365 SMTP. One extra family, `monday`, is a read-only Monday.com board
query. Run-once by design — it does its slot's work and exits; production
would mean an external schedule, and **none is installed on this host**:
the app had never run here before the migration (zero historical
`util.app_run_logs` rows), and scheduling it is a separate, explicit owner
decision — running families at live dt slots emails real customers, and
the legacy schedule (if any) lives on the pre-migration production host,
not here. New schedules go in the shared svc crontab per the paradigm.

## ⚠️ Do not run report families at live dt slots on this box

`alert.reports` on this staging DB holds real customer subscriptions
(heaviest: `mon-08:00`, 76 matches). A family invoked at a subscribed
half-hour mark sends real email. Safe invocations:

- any family at a **non-matching** minute → outcome `skipped`, exit 0, no
  email (this is the standard smoke test);
- `node index.js monday` → read-only board query, no email.

## Run outcome contract (run_outcome/v1) — keep

Every run ends with a terminal `run_outcome` INFO event and an honest exit
code: `0` success/skipped, `1` failed, `2` partial or self-log persistence
failure, `3` usage error. **ops-dashboard and incident-engine consume this**
(status derives from `warn_error_logs`; the outcome event is INFO on
purpose). Never regress to exit-0-on-failure, and never let the outcome event
land in `warn_error_logs`. (The `index.js` comments citing "DESIGN.md" refer
to the fleet audit docs in `data_acquisition` — this repo has no DESIGN.md.)

Other strengths to preserve through the migration:

- **Fail-closed TLS** in `utils/db/pg-pool.js` (`PG_SSLMODE=verify-full`,
  missing CA throws) — this app is the fleet's reference copy.
- **Least-privilege DB role** `reports_rw` (INSERT-not-SELECT on
  `util.app_run_logs` by design; provisioned by `db/setup-role.sql` with the
  root-only `/root/reports_rw_pw` password file — see the setup doc,
  "DATABASE ROLES").
- **No-default build ARGs** (host identity must come from `.env` or the build
  fails) and the **baked entrypoint** (`docker/entrypoint.sh` COPY'd into the
  image).

## Development & release workflow

```bash
# Dev — from the dev clone (~/apps/reports), as yourself
bash preflight-check.sh                 # expect ZERO warnings
bash build.sh                           # in-tree npm install + image reports:<you>
RUN_USER=<you> docker compose run --rm app node index.js <family>   # avoid :00/:30!

# Release — mirrors the clean tree to /opt/apps/reports as reports:svc
bash build-release.sh                   # refuses a dirty tree; stamps RELEASE_SHA

# Run the released copy — from /opt/apps/reports, RUN_USER omitted (svc)
cd /opt/apps/reports && docker compose run --rm app node index.js <family>
```

Logs: dev runs land in `./utils/logger/logs/` (gitignored); release runs in
`/opt/run-logs/reports/` (svc:docker). Read with `cat <file> | python3 -m
json.tool` — never open a run log in an editor.

## Docker / build / release (fleet paradigm — landed 2026-08-26)

The Part 1 pattern, adapted; each item verified at cutover:

- [x] `entrypoint.sh` repairs the log dir while root (only-if-root-owned)
- [x] image `reports:${USER_ID}` (`#RELEASE:USER_ID=svc` → `reports:svc`);
      `IMAGE_TAG` retired
- [x] `build.sh` — in-tree `npm install` as the host user + compose build;
      shared `/opt/resources/node_mod_cache/reports` mount retired
- [x] `build-release.sh` — clean-tree guard above the wipe, `#RELEASE:`
      transforms, `RELEASE_SHA` stamp into the deployed `.env`
- [x] boot provenance — `env_note` (USER_ID, LOGGER_MODE,
      RELEASE_SHA|`dev-tree`, report family) + boot console line
- [x] logger on the fleet `LOG_DIR` pattern — constant in-container path,
      `${LOG_DIR:-./utils/logger/logs}` mount that fails safe to the dev path
      (pre-migration logger fails UNSAFE: unknown `RUN_ENV` falls through to
      `/opt/run-logs/reports`)
- [x] SIGTERM/SIGINT flush-once handlers (kill test PASSED 2026-08-26: SIGTERM mid-run -> run_outcome failed, E_SIGNAL, exit 1, both sinks flushed)
- [x] `preflight-check.sh` — authenticated PG as `reports_rw` from a sibling
      container (verify-full, real CA path); Monday.com authenticated `me`
      query; Outlook presence-only (decision 2026-08-26, Acumatica
      precedent — an SMTP AUTH probe logs into production O365)
- [x] `uuid` declared in package.json (today it is an undeclared transitive
      dep required by `index.js` and `utils/logger/log.js`)

Cutover verified 2026-08-26: dev round-trip (skipped/exit 0, dev-tree log,
production dir untouched), guard negative test (dirty tree refused, DEST
untouched), kill test (E_SIGNAL, exit 1, both sinks flushed), release
round-trip (`reports-log.svc.*` in /opt/run-logs/reports, DB row
`282a60d|svc|skipped`), zero preflight warnings in both copies, zero
dev↔release drift. The retired `aux:staging` image and the orphaned
`/opt/resources/node_mod_cache/reports` cache dir await post-cutover
cleanup (owner sign-off).

## Known warts (kept deliberately — decided 2026-08-26)

- **`TWILIO_*` keys in `.env` are dead.** No twilio dependency and no twilio
  code anywhere in the repo. Kept per the keep-and-document default; do not
  build on them.
- **Commented `## PROD AZURE` block in `.env`.** Legacy Azure PROD `PG_*`
  values, commented out. `pg-pool.js` falls back `PGHOST || PG_HOST` (etc.),
  so *uncommenting* that block would silently point the app at Azure PROD —
  leave it commented; it exists only as an operator reference.
- **Rotation script: listed but inert by design.** reports appears in
  `/opt/resources/scripts/rotate-envs-20260817.sh`, but that script matches
  on the postgres **superuser** password value and this app connects as
  `reports_rw` — so a superuser rotation correctly never rewrites this
  `.env`. `reports_rw` rotation goes through `/root/reports_rw_pw` +
  `db/setup-role.sql` instead (setup doc, "DATABASE ROLES").
- **`utils/` museum.** `utils/db/sql/` still carries SQL for other apps
  (alert-processor, mmb-rpp, odd-jobs, aws-ff, preflight-check) and
  `utils/vpn|units|config-processor|sh` are unused here. **Note:** the live
  queries for this app live under BOTH `utils/db/sql/reports/` and
  `utils/db/sql/alert-notify/` (`index.js` imports both groups) — do not
  prune `alert-notify` as "another app's". Cleanup is deferred post-cutover
  per the fleet default; requires per-item sign-off.

## Environment variables

`APP_NAME`, `LOGGER_MODE` (+`#RELEASE:LOGGER_MODE=log`), `LOG_DIR`
(+`#RELEASE:LOG_DIR=/opt/run-logs/reports`), `USER_ID`
(+`#RELEASE:USER_ID=svc`), `PGHOST`, `PGPORT`, `PGUSER` (`reports_rw`),
`PGPASSWORD`, `PGDATABASE`, `PG_SSLMODE` (`verify-full`), `PG_SSL_PATH`,
`OUTLOOK_USER`, `OUTLOOK_PW`, `MONDAY_API_TOKEN`, `MONDAY_BOARD_ID`,
host-identity args (`DOCKER_GID`, `UID_0..2`). `RELEASE_SHA` is injected by
`build-release.sh` into the deployed `.env` only — never set by hand.
Retired 2026-08-26: `LOGGER`/`RUN_ENV` (→ `LOGGER_MODE`/`LOG_DIR`),
`IMAGE_TAG` (→ `USER_ID` tag), `RUN_USER` in `.env` (entrypoint defaults to
svc; dev runs pass it on the command line).

**This `.env` is the only copy of `OUTLOOK_PW` and `MONDAY_API_TOKEN`
anywhere on this host.** It is backed up outside `/opt/apps` before any
release wipe; keep that backup current if these credentials change.
