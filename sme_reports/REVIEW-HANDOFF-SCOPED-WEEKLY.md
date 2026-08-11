# Code Review Request — scoped summaries and report periods (plan Phase A)

You are reviewing the committed series `66d0c97..4cd128a` (6 commits) on
branch `DEV` of this repo (`/home/matt-teixeira/hep3/reports`): the plan
document plus the four Phase A implementation commits and one hardening
commit. Review the range with `git diff 66d0c97..4cd128a` / `git log -p`.
Your findings will be handed back verbatim to another assistant to fix,
so make each one self-contained and reproducible.

## What this codebase does

Generates customer-facing "Magnet Health" PDFs for ~164 MRI magnets from
Postgres telemetry: one-page per-system briefs and a multi-page summary
document. The costliest class of bug is one that **silently misstates or
omits a system's state** — and, new with this series, one that **shows a
customer's user systems beyond their scope or drops systems from their
summary silently**.

## The context

This series is Phase A of `sme_reports/PLAN-SCOPED-WEEKLY.md` (commit 1
of the range — review the plan too; divergence between plan and code is a
finding). The product direction: the flagship deliverable becomes a
**7-day summary scoped per customer/user**, eventually driven by a
frontend-editable DB config (Phase B, not in this range). Phase A teaches
the existing engine scope and period through file-based requests only —
**absent the new request fields, output must be byte-identical** to
before, because today's production request files run through the same
loader nightly.

## Prior review rounds — what NOT to re-review

`REVIEW-HANDOFF.md`, `REVIEW-HANDOFF-FLEET.md`,
`REVIEW-HANDOFF-PRECOMMIT.md`, and `REVIEW-HANDOFF-BRIEF-PARITY.md`
(closed SHIP at round 5, 2026-08-10) cover the report engine's detection
rules, data-quality machinery, and the brief/fleet parity work. Do not
re-litigate those. DO flag a regression: this series refactored the
request loader every production run flows through.

## In scope, by commit

### 1. `cfbe254` — the plan document

`PLAN-SCOPED-WEEKLY.md`: decided design (user-scoped weekly flagship,
`alert.sme_reports` template rows, derived recipients, per-scope-set
rendering), Phase A/B breakdown, open items. Review it as the contract
the code claims to implement.

### 2. `95eaef1` — scope resolution (A1)

- `scope.js`: `validate_scope` (pure, **idempotent** — the loader
  canonicalizes and `resolve_scope` re-validates; the non-idempotent
  first version rejected its own output, caught by live probe),
  `rows_to_resolution` (pure), `resolve_scope` (lazy pg require so the
  DB-free dev checks can import the loader chain).
- `sql/scope-systems.sql`: one query, three null-guarded predicates
  (`customer_id`, `site_ids`, `system_ids`), joined through
  `customers → sites → systems`, `process_mag` only — deliberately the
  same three tables `get-system-identity.sql` reads.
- Loud-failure contract: zero resolved systems, unknown site ids, and
  non-mag system ids are FATAL request errors; resolution label + counts
  are logged and printed.
- `request_loader.js` refactor: the assembly half (`assemble`) extracted
  and shared; scoped requests return `{scoped, scope, raw}` and finish
  via `materialize_scoped_requests` after the caller resolves; `scope` +
  `reports[]` together is an error; `report_defaults` supplies
  recipients/output to synthesized entries and errors without a scope.

### 3. `da7ad8a` — the scoped, customer-facing summary (A2)

- `fleet_model.js`: `meta.scope` → scoped title
  (`Magnet Health Summary — <label>`), `vm.scope`;
  `group_failures(…, {customer_facing})` rewrites
  `/^no [A-Z_]+ monitor data\b/` → "no monitor data received".
- `fleet_page.js`: title in masthead/h1/`<title>`; cover sub gains the
  site count; rollup tiles read "% of these systems" when scoped.
  Exclusions stay stated on scoped documents (never-silent outranks
  tone — a deliberate deviation from the plan's first wording, recorded
  in RULES.md).
- `index.js`: scope threaded to the fleet build; scoped filenames
  `Avante-<slug>-Magnet-Health-Summary-<date>` (slug sanitized
  `[^A-Za-z0-9]+ → -`).
- `check_fleet.js`: scoped fixture (wording both ways: scoped document
  never says "fleet", internal document unchanged) and a second measured
  document — the Chromium geometry pass now loops over the internal
  fleet artifact AND a scoped artifact; the page-fullness guard applies
  to the internal document only (small customers legitimately produce
  sparse pages).

### 4. `e1deb53` — report period (A3)

- Top-level `lookback_days` (validated positive integer) injected as
  each report's window default; per-report `window` wins by spread
  order. `normalize_request` now records `window.lookback_days` — the
  period the window DEFAULTED from, **null when explicit dates were
  given** (a day count would be coincidence, not choice).
- Period tags where a weekly and a monthly could collide: `-7d` on
  fleet/scoped summary filenames and brief ARCHIVE filenames (out/ is
  overwrite-by-design scratch and stays untagged); "7-day" and the scope
  label in the summary email subject.
- Detection rules deliberately untouched; the left-censor never-urgent
  stance at 7 days is recorded in RULES.md as awaiting domain review.

### 5. `9a20a7e` + `4cd128a` — records sidecar (A4)

Summary builds persist the distilled per-system records
(`archive/summary-records-<slug><tag>-<date>.json`, gated by
`batch_email.archive_records`, default true, probes set false). History
capture only — no consumer yet. The write is isolated in its own
try/catch (`4cd128a`): a failed capture logs and never sinks delivery.

## Highest-risk areas — attack these first

1. **Loader refactor equivalence.** `assemble()` was extracted from
   `load_requests` and `lookback_days` injection now maps over the
   report list before normalization. Every existing production request
   file (explicit `reports[]`, `batch_email`, `exclude`, `summary_only`)
   must behave identically. Attack the injection's interaction with
   per-report `window` overrides, `exclude` + scope ordering, and the
   single-request (no `reports[]`) form.
2. **Cross-customer leakage surface.** The scope SQL's null-guarded
   predicates (`$1::text IS NULL OR …`) — can any parameter combination
   return a WIDER set than requested? `rows_to_resolution`'s missing-id
   detection collapses "unknown site" and "site with zero mag systems"
   into one error — is that ever wrong? Multi-customer `system_ids`
   scopes label every customer; verify nothing renders one customer's
   label over another's systems.
3. **Escaping and injection.** Scope labels are DB-sourced customer
   names flowing into HTML (`esc()` on title/h1/masthead — verify every
   sink), filenames (slug sanitation), email subjects, and log lines.
   `Smith & Sons <script>` is an existing fixture pattern — extend the
   attack to scoped fields.
4. **Customer-facing tone completeness.** The reason rewrite is anchored
   (`^no [A-Z_]+ monitor data`) — enumerate the other error strings a
   scoped document can carry (`unsupported manufacturer …`, thrown
   identity/DB errors) and judge whether any leaks internal detail a
   customer shouldn't see. The DATA ISSUES tier deliberately stays.
5. **Period-tag completeness.** Enumerate every artifact written per
   run (out/ html+pdf, archive pdf, sidecar json, email subjects) and
   check the weekly/monthly same-day collision matrix. Note the DECIDED
   exception: out/ files are untagged scratch.
6. **The scoped geometry pass.** The measurement loop change in
   `check_fleet.js` (two documents, fullness guard fleet-only) — verify
   the loop actually measures both files and that per-file assertion
   messages identify the failing document.

## Invariants that must hold

- Absent `scope`/`lookback_days`/`report_defaults`, loader output and
  rendered documents are unchanged — production request files are live
  consumers of this code path.
- Resolution and exclusion are never silent; every system missing from a
  scoped document is findable as a failure, an exclusion, or was never
  in scope (and the cover states the scope's counts).
- Shared vocabulary and rules land in RULES.md in the same commit
  (this series added §5 rows: "Report period", "Scoped (customer-facing)
  summary"). Doc/code divergence is a finding.
- Reader-facing text: "period" never "window"; "triggered" never
  "fired".
- The internal fleet document is byte-unchanged by scoped rendering.

## How to run

```
node sme_reports/dev/check_scope.js     # NEW: scope + loader contract, DB-free
node sme_reports/dev/check_compute.js
node sme_reports/dev/check_chart.js     # Chromium (needs browser permission)
node sme_reports/dev/check_fleet.js     # Chromium + subprocess permission
```

All five pass at handoff. Live DB runs need `.env` + Postgres and are
likely unavailable to you. **Never run request files carrying real
recipients** (`requests/fleet-summary.json`, `requests/batch-*.json`).
The safe probe shape for scoped runs (no email, no archive):

```json
{ "scope": { "customer_id": "C027932" }, "lookback_days": 7,
  "summary_only": true,
  "batch_email": { "recipients": ["dev@example.com"], "summary": false,
    "summary_pdf": true, "attachments": false, "archive_records": false } }
```

Live results at handoff (recorded, since you likely cannot rerun):
customer C027932 resolves "Lee Health — 5 systems (4 sites, 1
customer)"; the scoped 30-day and 7-day documents rendered with scoped
masthead, resolution line, "% of these systems", `-7d` filename tag, and
"Aug 4 – Aug 11" period; the sidecar wrote 5 records × 57 fields and
parsed back. Flag anything you could not verify for lack of DB access
rather than assuming it.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- Scope resolution filters `process_mag` only — this pipeline reports on
  magnets; other modalities are out of scope by design.
- Exclusions render on scoped documents (deviation from the plan's first
  wording): never-silent outranks tone.
- out/ artifacts carry no period tag — that directory is
  overwrite-by-design scratch; only archive names and subjects must be
  collision-proof.
- `validate_scope` accepts and returns its own canonical form
  (idempotence chosen over strictness after the live-probe bug).
- The sidecar has no consumer yet; capture-before-consumer is the point.
- The unused `roles`/`user_site_groups` machinery and everything
  recipient-related is Phase B; nothing in this range reads
  `public.users`.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, one sentence
   why.
2. **Findings** `F1..Fn`, ordered by severity (`blocker`/`major`/
   `minor`/`nit`), each with: file:line, a concrete failure scenario
   (inputs/state → wrong output a reader or customer would see),
   suggested fix, and your confidence. A claim you could not reproduce
   or trace end-to-end gets `confidence: low` and says why.
3. **Refactor equivalence**: the `assemble()` extraction and the
   `lookback_days` injection — EQUIVALENT or CHANGED for pre-existing
   request shapes, with the code path that convinced you.
4. **Fixture audit**: `check_scope.js` and the scoped additions to
   `check_fleet.js` — failure mode or tautology, each.
5. **Ran**: the exact commands you executed and their results.
6. **Test gaps**: behaviors you judged correct but found unasserted.
