# Code Review Request — scheduled DB-config runs (plan Phase B)

You are reviewing the committed series `9451a16..55046f4` (2 commits) on
branch `DEV` of this repo (`/home/matt-teixeira/hep3/reports`): the
`alert.sme_reports` DDL and the scheduled runner that fans it out. Review
with `git diff 9451a16..55046f4` / `git log -p`. Your findings will be
handed back verbatim to another assistant to fix, so make each one
self-contained and reproducible.

## What this changes, in one paragraph

Until now, every run was driven by a hand-edited request file whose
recipients were typed by hand. This series moves that to frontend-editable
DB rows (`alert.sme_reports`) and — for the flagship weekly `user_summary`
— **derives the audience from `public.users` at run time**: active,
`notify_email`, ≥1 magnet in their `system_list_cache`. Users with
identical magnet scopes share one rendered document; each user is emailed
individually after a send-time re-check of their CURRENT access. Every
delivery attempt writes an `alert.sme_report_sends` row. **This is the
highest-stakes change in the series: a bug here emails a customer's
magnet data to the wrong person, silently drops a customer from their
weekly, or mass-mails on a misconfigured row.** Review it with that
priority order.

## Context documents

- `sme_reports/PLAN-SCOPED-WEEKLY.md` — the decided design (§Decided
  design, §Phase B) and the v1 limits. Divergence between plan and code
  is a finding.
- `sql/sme_reports_config.sql` — the DDL, applied to the live DB by the
  user before this review. Its comments are contract documentation;
  contradiction between a comment and runner behavior is a finding.
- `sme_reports/RULES.md` — gained the "Scheduled (DB-config) runs" row.
- Prior rounds: `REVIEW-HANDOFF-SCOPED-WEEKLY.md` closed Phase A (3
  rounds, 11 findings). Do not re-litigate Phase A's scope/period/
  rendering design; DO flag regressions — `run_batch` was extracted from
  the middle of it.

## In scope, by commit

### 1. `105fb3b` — the DDL (B1)

Two tables, IF-NOT-EXISTS repeatable, one transaction. Safety posture:
`enabled` defaults false AND `dry_run` defaults true (a fresh frontend
insert is inert twice over); CHECK constraints encode the enum contract
and explicit-mode-requires-recipients.

### 2. `55046f4` — the runner (B2–B4)

- **`fanout.js`** — every decision, pure: `validate_config` (per-kind
  scope/recipient rules; unknown `options` keys rejected; v1
  not-implemented rejections for `briefs`, `include_briefs`,
  `exception_only`, and derived customer/fleet recipients),
  `resolve_audience`, `group_by_scope` (keyed by the same
  `scope_set_hash` the artifact filenames carry), `access_covers`
  (document ⊆ current cache), `config_to_raw` (rows translate into the
  SAME raw request shape file mode uses, then flow through the entire
  Phase A loader — scope materialization, effective-period rules,
  exclusions — unchanged).
- **`config_loader.js`** — thin SQL: slot match
  (`email_schedule ->> $1 = 'true'`, the alert.reports convention),
  audience pool, send-time cache refetch, sends insert. Lazy pg so
  DB-free checks import freely.
- **`run_batch`** extracted from `run_sme_report` (sme_reports/index.js):
  the whole per-batch engine (report loop, fleet build, batch emails) now
  shared by file mode and the scheduler. File mode's wrapper keeps
  loading, scope resolution, fatal logging, and the Chromium close.
- **`run_scheduled.js`** — slot mode + `--slot` / `--config <id>` /
  `--dry-run` overrides; per-row and per-group isolation with nonzero
  exit if any failed; user_summary renders per scope-group and emails
  per user post-re-check (`skipped_access`); customer/fleet deliver to
  explicit lists; dry runs do everything but SMTP and never archive
  history; a group failing before delivery writes error rows for its
  whole intended audience.
- **Root `index.js`** — no-file argument dispatches to the scheduler;
  file mode byte-unchanged.
- **`dev/check_config.js`** — sixth dev check, DB-free.

## Highest-risk areas — attack these first

1. **Wrong-recipient surfaces.** Grouping is keyed by the FULL sorted
   scope-set, so two users share a document only if their magnet sets are
   IDENTICAL — try to construct a case where a user receives a document
   containing a system outside their cache (grouping bug, hash collision
   handling, cache mutation between pool query and grouping, the re-check
   predicate's null/empty edges). The re-check refetches caches per
   GROUP; users appearing in two groups cannot exist (one scope-set per
   user) — verify.
2. **Silent-drop surfaces.** `resolve_audience` filters on
   `status === "active"` and `notify_email === true` — enumerate users
   the frontend would consider notifiable that this drops (status
   casing/whitespace? notify_email null-vs-false semantics?). A dropped
   user gets NO sends row (they were never in the audience) — is that
   the right observability posture, or should the audience computation
   be recorded?
3. **Mass-send / re-send surfaces.** No run locking: two processes firing
   the same slot double-send (legacy alert.reports has the same posture —
   but the blast radius is now customers). `--config <id>` runs a
   DISABLED row only with `--dry-run`, but runs an ENABLED row for real —
   assess whether operator affordances are foot-gun-shaped. Slot matching
   does no grid flooring (`tools/schedule_dt.js` formats the literal
   minute): a cron entry firing at 08:01 matches nothing and the weekly
   silently does not go out — exit 0, "no enabled report configs". Is
   silent-no-op the right behavior for a slot with zero matches?
4. **`run_batch` extraction equivalence.** File mode must behave
   identically: same fatal paths, same emails, same Chromium lifecycle
   (the close moved to entry points — verify no leak in either mode and
   no double-close).
5. **Sends-table integrity.** Statuses vs reality: if the email SENDS but
   `record_send` throws, the catch writes an error row for a delivered
   email (double-accounted). Dry-run/skip-path `record_send` failures
   propagate and fail the group. Judge whether these edges matter and
   what the right posture is.
6. **Config validation completeness** — anything a frontend could write
   that passes the DDL CHECKs and `validate_config` but misbehaves at
   run time (empty email_schedule, scope shapes, options.exclude with
   non-SME strings — the loader re-validates those — cc_list on derived
   rows going to every user's email?).

## Invariants that must hold

- A fresh `alert.sme_reports` row can never send email (two independent
  gates).
- A user never receives a document containing a system outside their
  CURRENT `system_list_cache` (derived paths; explicit recipients are
  the config author's deliberate choice and bypass the re-check by
  design).
- Every delivery attempt — including dry runs, skips, and group-level
  failures — is answerable from `alert.sme_report_sends`.
- One failing row/group never sinks the others; the process exits
  nonzero if ANY failed.
- File mode (`npm start sme_report -- ./requests/x.json`) is unchanged.
- Unknown config `options` are rejected, never ignored (DDL comment
  promise).

## How to run

```
node sme_reports/dev/check_config.js    # NEW, DB-free
node sme_reports/dev/check_scope.js
node sme_reports/dev/check_compute.js
node sme_reports/dev/check_chart.js     # Chromium
node sme_reports/dev/check_fleet.js     # Chromium + subprocess
```

All six pass at handoff. Live DB access is likely unavailable to you.
**Never enable a config row, never run `--config` against an enabled
row, and never run request files carrying real recipients.** Live results
at handoff (recorded): empty slot → "no enabled report configs", exit 0;
config row 1 (`customer_summary`, Lee Health scope, `enabled=false`,
`dry_run=true`, recipient `dev@example.com`) via `--config 1 --dry-run`
rendered `Avante-Lee-Health-bfd3299e-Magnet-Health-Summary-7d-2026-08-11`
and wrote exactly one sends row (`dry_run`, scope_hash `bfd3299e`,
document name) with zero emails. The row and its sends record remain in
the DB as the rollout's first artifacts.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- Explicit-recipient kinds skip the access re-check: those lists are the
  author's deliberate choice, exactly like today's request files.
- v1 rejections (briefs, include_briefs, exception_only, derived
  customer/fleet recipients) are loud errors, not features.
- No slot flooring and no run locking — inherited from the legacy
  alert.reports scheduler's posture; cron discipline is assumed.
- user_summary scope-groups recompute facts for shared systems; a
  per-run facts cache is a planned optimization, not built.
- The scheduled runner trusts `system_list_cache` (the frontend-owned
  resolution of `system_list_config`) rather than re-deriving access
  from the rule.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, one sentence
   why.
2. **Findings** `F1..Fn`, ordered by severity (`blocker`/`major`/
   `minor`/`nit`), each with: file:line, a concrete failure scenario
   (config/user state → wrong email, wrong recipient, or wrong record),
   suggested fix, and your confidence. A claim you could not reproduce
   or trace end-to-end gets `confidence: low` and says why.
3. **Refactor equivalence**: the `run_batch` extraction and the root
   `index.js` dispatch — EQUIVALENT or CHANGED for file mode, with the
   code path that convinced you.
4. **Fixture audit**: `check_config.js` — failure mode or tautology,
   per section.
5. **Ran**: the exact commands you executed and their results.
6. **Test gaps**: behaviors you judged correct but found unasserted.

---

## Round-1 outcome (2026-08-11) — all seven findings fixed (`924344c`)

Verdict was DO NOT SHIP; every finding fixed with regressions. For
re-review: verify each fix holds and no fix introduced a new defect.
**Note: the DDL gained `sme_report_sends.recipient_role` — the user must
re-run `sql/sme_reports_config.sql` (repeatable) before the next
scheduled/`--config` run.**

| # | Fix | Regression test |
|---|---|---|
| F1 (blocker) | `validate_config` rejects `cc_list` on `user_summary` rows — a derived CC would receive every scope-group's document with no access check | `check_config.js` cc rejection |
| F2 (blocker) | New `cli_args.js`: strict, anchored parsing BEFORE any run state; `--config abc`/`1junk`/`0`/missing/unknown args abort; file mode rejects scheduler flags; `run_scheduled` tests `config_id != null` | full CLI matrix in `check_config.js`; verified live: `--config abc` exits 1 with the parse message |
| F3 (major) | `group_by_scope` keys by the canonical sorted id set (`scope_set_key`); `scope_set_hash` widened to 16 hex and demoted to artifact/sends metadata | the real colliding pair (SME099875/SME122693) asserted as two distinct groups |
| F4 (major) | Per-recipient outcome tracking with separate SMTP/persistence/render boundaries: record-failure after a delivered email = persistence failure (fails the run, no fabricated error row); backfills cover only outcome-less recipients | boundary semantics documented in RULES; runner-level (accepted gap below) |
| F5 (major) | Explicit-path pre-delivery failures backfill error rows for the whole intended audience (To + CC) | same |
| F6 (major) | Every envelope recipient recorded with `recipient_role` (to/cc); DDL addendum `ADD COLUMN IF NOT EXISTS` | DDL re-validated via rollback against live tables |
| F7 (major) | Delivered documents archived under `…-run-<jobid8>.pdf` BEFORE sending; sends rows carry the immutable name; dry-run rows carry the scratch name | `archive_delivered` in `run_scheduled.js` |
| audit | options must be an object; recipients/cc deduplicated; `current_slot` format asserted | `check_config.js` |

Accepted gaps, unchanged in kind from your list: runner/send-status
semantics (F4/F5 flows) are not unit-tested — they live at the
SMTP/DB seam the checks deliberately do not cross; the two-gate,
dry-run-SMTP-suppression, and isolation behaviors are asserted by the
recorded live runs rather than fixtures; SMTP-success/record-failure
ambiguity is narrowed (no contradictory rows; run fails loudly) but a
full outbox/idempotency design is future work if it ever bites.

Live after fixes: all six dev checks pass; file-mode Lee Health probe
unchanged; `--config abc` aborts with exit 1 before any run state.
