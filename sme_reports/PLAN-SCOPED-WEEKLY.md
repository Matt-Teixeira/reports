# Plan — scoped weekly summaries and the `alert.sme_reports` config table

Drafted 2026-08-11. This is the working plan for the next feature series:
the 7-day, user-scoped Magnet Health Summary as the flagship customer
product, driven by a frontend-editable DB config (roadmap "Phase 4"),
with send-status recording. Decisions below were made with the user on
2026-08-11; open items are listed at the end.

## Decided design (summary)

- **Flagship product**: weekly (7-day) summary, scoped per USER — each
  recipient gets a fleet-summary-style document covering exactly the
  systems their `public.users.system_list_cache` grants, i.e. what they
  see in the app. "All within customer" and the internal all-fleet 30-day
  document remain as other `report_kind`s.
- **Config**: new sibling table `alert.sme_reports` (NOT an extension of
  `alert.reports`), copying its conventions — `author` =
  `users.email_address`, `cc_list`, and the same `email_schedule` JSONB
  slot grid (`"day-HH:MM": bool`, 30-minute steps) the existing cron
  slot-matcher uses.
- **Rows are templates that fan out at run time.** The flagship is ONE
  row (`user_summary`, scope all users, 7 days, derived recipients).
  Onboarding a customer or user requires no config change.
- **Recipients derived from `public.users`**: status `active`,
  `notify_email = true`, ≥1 mag-processed system in scope (100 users
  today). Explicit `recipients`/`cc_list` per row stay available.
- **Render granularity: per distinct scope-set.** Users with identical
  magnet scopes share one rendered document (46 distinct scopes across
  160 active mag users today). Multi-customer users get one document
  covering their whole visible fleet — same as the app.
- **Send-status recording (`alert.sme_report_sends`) lands in the same
  phase**, written from the fan-out send loop.
- **Safety defaults**: `enabled = false` and `dry_run = true` on new
  rows; send-time re-check of each recipient's current
  `system_list_cache` against the document's systems; per-scope-group
  failure isolation; the file-based probe pattern stays untouched.

Measured context (2026-08-11): 863 systems / 164 mag-processed; 120
customers; 510 sites; 482 users (252 active, 100 active+notifiable with
magnets); 46 distinct active magnet scopes; 87 users span multiple
customers; largest customer has 79 active users across 19 distinct
scopes.

---

## Phase A — the report engine learns scope and period

> **Status: COMPLETE 2026-08-11** — commits `95eaef1` (A1), `da7ad8a`
> (A2), `e1deb53` (A3), plus the A4 sidecar commit. Acceptance verified:
> all five dev checks pass (check_scope is new); the Lee Health probes
> rendered the scoped 30-day and 7-day summaries
> (`Avante-Lee-Health-Magnet-Health-Summary[-7d]-<date>`, no email) with
> scoped masthead, resolution line, and "% of these systems" wording;
> the identity audit closed clean (identity already reads
> customers/sites/systems); the internal fleet document is unchanged
> (fixtures assert its wording; the byte-level fleet fixtures pass
> untouched). The A1 live probe caught and fixed a double-validation
> bug the DB-free checks could not see.

Everything in Phase A is exercised through file-based requests and the
no-send probe pattern. No DB config, no behavior change to existing
production runs (absent the new request fields, output is identical).

### A1. Scope resolution

- New module `sme_reports/scope.js`:
  - `resolve_scope(db, scope)` → `{ system_ids, label, detail }`.
  - Accepted shapes: `{customer_id}`, `{site_ids: []}`,
    `{system_ids: []}`; resolution joins
    `public.customers → sites (customer_id) → systems (site_id)` and
    filters `process_mag = true`. `label` is the customer/site name for
    display; `detail` carries counts for the loud report.
  - Resolution is **loud, never silent**: the run log and the document
    cover state "scope: <label> — N systems (ids…)"; resolving to zero
    systems is a fatal request error, not an empty report.
- `request_loader.js`: accepts a top-level `scope`; when present,
  `reports[]` may be omitted and the loader synthesizes one
  `magnet_health` entry per resolved system (probe-pattern output flags
  supported as today). Explicit `reports[]` + `scope` is an error —
  one source of truth per request.
- **Identity audit** (small, load-bearing): verify the identity fields
  the reports display (customer_name, site_name, city/state) come from —
  or agree with — `public.customers/sites/systems`. If the current
  identity query reads another source, document the divergence and align
  the scoped path to the canonical three tables so the scope join and the
  displayed names can never disagree.

### A2. Scoped fleet-summary rendering

- `render/fleet_model.js` / `fleet_page.js`: view-model gains
  `scope_label` (null = unscoped/internal).
  - Title: `Fleet Magnet Health Summary` → `Magnet Health Summary —
    <label>` when scoped; cover sub-line carries the scope resolution
    count.
  - Rollup tiles: "% of fleet" → "% of these systems" (or plain counts)
    when scoped.
  - Small-N behavior: vendor sections already skip when empty; verify
    cover/rollup/attention layouts at N = 1–5 systems by measurement.
- **Customer-facing tone pass** (scoped documents only; the internal
  document keeps current wording):
  - NO REPORT PRODUCED reasons drop internal table names
    (`mag.ge_mm3` → "no monitor data received this period").
  - EXCLUDED BY REQUEST section renders only on unscoped internal runs
    (scoped runs select systems positively; there is nothing to
    exclude).
  - DATA ISSUES stays — it is honest and customers should see it — with
    wording reviewed for a customer reader.
- Filenames: scoped documents are
  `Avante-<scope-slug>-Magnet-Health-Summary-<period-tag>-<date>`;
  slug sanitized from `label`; collision-proof against the internal
  fleet document.
- Every wording rule lands in RULES.md in the same change; geometry
  verified in Chromium via `check_fleet.js` fixtures (scoped variant,
  small-N variant).

### A3. Period parameter (`lookback_days`)

- Request top-level `lookback_days` (default 30) feeds each report's
  window default; per-report `window` overrides still win (existing
  loader semantics).
- Period tag in filenames and email subjects whenever
  `lookback_days ≠ 30` (e.g. `-7d`); the fleet document heading/legend
  already render actual dates, so no wording changes needed there.
- Known follow-up flagged for domain review, NOT changed in this series:
  the left-censor "amber, never urgent" stance is calibrated for 30-day
  windows; at 7 days left-censoring becomes routine (any stop older than
  the window). Current behavior is kept; the service-engineer question
  is recorded in RULES.md §6 provenance style.

### A4. Fixtures, sidecar, probes

- `check_fleet.js`: scoped fixture (subset of systems; scoped title, %
  wording, no exclusions section, geometry) and a 7-day fixture (period
  dates, filename tag).
- `scope.js` resolution mapping tested as a pure function over stubbed
  rows (DB-free, existing check-script pattern); the SQL itself verified
  by live probe.
- **Distilled-records sidecar**: each fleet/scoped summary run archives
  `summary-records-<tag>-<date>.json` (the per-system
  `build_summary_facts` records) beside the PDF. No consumer yet — this
  is deliberate history capture so "changes since last report" can be
  built later without waiting for data to accumulate.
- Live probes (html-only, no send): scoped request for one customer_id;
  7-day unscoped request; both compared against the standard 30-day
  output for the same systems.

**Phase A acceptance:** all three dev checks pass with the new fixtures;
a scoped 7-day probe renders a correct, measured, customer-toned
document; an unchanged request file produces byte-equivalent output
(modulo live data).

---

## Phase B — DB config, fan-out, send status

> **Status: BUILT 2026-08-11**, rollout in progress. B1 DDL applied by
> the user and verified. B2–B4 implemented (`fanout.js` pure logic,
> `config_loader.js` thin SQL, `run_batch` extracted and shared,
> `run_scheduled.js`, CLI slot mode + `--slot/--config/--dry-run`).
> B5: `dev/check_config.js` passes (six dev checks now); rollout ladder
> steps 1–2 done live — empty slot no-ops with exit 0, and config row 1
> (customer_summary, Lee Health, disabled + dry_run) rendered
> `Avante-Lee-Health-bfd3299e-…-7d-…` and wrote a `dry_run` sends row
> with zero emails. Remaining: step 3 (flip a row to real send at
> internal test addresses), step 4 (enable the derived user_summary
> audience), and the cron entry for the weekly slot.
>
> Noted optimization for later: user_summary scope-groups recompute
> facts for systems shared across groups; a per-run facts cache would
> cut the weekly render time substantially. Not built — correctness
> first, measured cost later.
>
> v1 runner limits (validated loudly, documented in the DDL comments):
> `briefs` kind, `include_briefs`, `exception_only`, and DERIVED
> recipients for customer/fleet summaries are rejected as
> not-yet-implemented rather than silently narrowed.

### B1. Schema (migration file `sql/sme_reports_config.sql`)

```sql
CREATE TABLE alert.sme_reports (
  id             SERIAL PRIMARY KEY,
  author         TEXT NOT NULL,            -- users.email_address
  enabled        BOOLEAN NOT NULL DEFAULT false,
  dry_run        BOOLEAN NOT NULL DEFAULT true,
  report_kind    TEXT NOT NULL,            -- user_summary|customer_summary|fleet_summary|briefs
  scope          JSONB,                    -- {"all_users":true}|{"customer_id":..}|{"site_ids":[..]}|{"system_ids":[..]}
  lookback_days  INTEGER NOT NULL DEFAULT 7,
  options        JSONB NOT NULL DEFAULT '{}',  -- include_briefs, exception_only, output flags…
  recipient_mode TEXT NOT NULL DEFAULT 'derived', -- derived|explicit
  recipients     TEXT[],
  cc_list        TEXT[],
  email_schedule JSONB NOT NULL,           -- "day-HH:MM": bool, same grid as alert.reports
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE alert.sme_report_sends (
  id          BIGSERIAL PRIMARY KEY,
  config_id   INTEGER REFERENCES alert.sme_reports(id),
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  slot        TEXT,                        -- the fired schedule slot
  recipient   TEXT NOT NULL,
  scope_hash  TEXT,                        -- identifies the scope-group document
  document    TEXT,                        -- archived filename
  status      TEXT NOT NULL,               -- sent|error|skipped_access|dry_run
  error       TEXT
);
```

- Row count is tiny; no special indexes beyond the PKs and
  `sme_report_sends (config_id, run_at)`.
- Constraint checks (`report_kind`, `recipient_mode`, `lookback_days >
  0`) as CHECKs so frontend writes fail loudly.

### B2. Config loader and invocation modes

- `sme_reports/config_loader.js`:
  - `current_slot(now)` — floor to the 30-minute grid, matching the
    existing `formatted_dt()` convention exactly (shared helper, not a
    copy).
  - `load_slot_configs(db, slot)` — enabled rows where
    `email_schedule ->> slot = 'true'`.
  - `config_to_request(row, resolved)` — translates a row + resolved
    scope into the SAME normalized request object `normalize_request`
    produces, so everything downstream (engine, checks, probe parity)
    is shared. Validation failures are per-row, logged, and never sink
    other rows.
- Invocation:
  - `npm start sme_report -- ./requests/x.json` — file mode, unchanged.
  - `npm start sme_report` (no file) — slot mode: match, fan out, run.
  - `npm start sme_report -- --slot mon-08:00 [--config <id>] [--dry-run]`
    — operator overrides for testing a specific slot/row without waiting
    for cron.

### B3. Audience resolution and fan-out

- `sme_reports/fanout.js`, pure functions over injected rows (DB-free
  testable, thin SQL wrappers):
  - `resolve_audience(users, mag_ids, row)` — active, `notify_email`,
    non-empty magnet scope, optionally narrowed by the row's scope
    (e.g. a `user_summary` row scoped to one customer's users).
  - `group_by_scope(audience)` — key = sorted magnet-scope ids; returns
    `[{scope_hash, system_ids, users}]`.
- Run loop per config row: for each scope-group → build the scoped
  summary (Phase A engine; `include_briefs` from `options` when that
  ride-along is enabled later) → send each user their group's document →
  one `sme_report_sends` row per recipient. Per-group try/catch: one
  group's failure is recorded and does not sink the remaining groups;
  the run exits nonzero if any group failed (cron visibility, matching
  the existing delivery-integrity rule).

### B4. Send path and safety

- **Send-time access re-check**: immediately before each send, refetch
  the recipient's `system_list_cache`; if the document's systems are no
  longer a subset, skip with status `skipped_access` — access revoked
  between render and send must not leak a wider document.
- `dry_run` rows execute the full pipeline — resolution, render,
  archive, sends rows with status `dry_run` — with no SMTP call.
- Email subjects carry scope label + period tag; scoped summary emails
  reuse `email_theme.js`; every DB-derived string HTML-escaped (existing
  rule).

### B5. Checks, rollout, review

- New dev script `sme_reports/dev/check_config.js`: slot computation,
  row→request translation (valid + each invalid shape), audience
  filtering, scope-grouping (incl. multi-customer users and the
  identical-scope dedup), access re-check logic — all on stubbed rows.
- Live rollout sequence:
  1. Apply DDL (see open item 1).
  2. Seed one `user_summary` row, `enabled = true, dry_run = true`,
     slot = a near-term test slot; run slot mode; verify renders,
     archive, and `sme_report_sends` rows; confirm zero emails.
  3. Flip `dry_run` off with `recipient_mode = 'explicit'` pointed at
     internal test addresses; verify received documents.
  4. Enable derived recipients for a single small customer's users;
     then the full audience.
- A REVIEW-HANDOFF doc for external (Codex) review at the end of each
  phase — Phase A is render-rule-heavy, Phase B is delivery-heavy; they
  review better separately.

**Phase B acceptance:** slot mode drives the full weekly from one DB
row; `check_config.js` + the three existing checks pass; a dry-run
against the real audience produces 46 scope-group documents and ~100
`dry_run` send rows with zero emails; send-status visible in the table.

---

## Open items

1. **How DDL reaches the database** — RESOLVED 2026-08-11: repeatable
   migration file in the repo, applied by the user. `sql/
   sme_reports_config.sql` carries the DDL (IF NOT EXISTS throughout,
   single transaction), run/verify/rollback/grant instructions in its
   header, and was validated against the live database via a rolled-back
   transaction. Phase B's live rollout ladder starts once it is applied.
2. **Left-censor urgency at 7 days** — domain review by service
   engineers; current stance kept until then.
3. **Briefs ride-along** — `options.include_briefs` is designed in but
   ships default-off; enabling is a product call after the weekly is
   stable.
4. **"Changes since last report"** — deferred; Phase A's sidecar makes
   it buildable later.
5. **Frontend form** for `alert.sme_reports` rows — outside this repo;
   the CHECK constraints and this document define the contract.
