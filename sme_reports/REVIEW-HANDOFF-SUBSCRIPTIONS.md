# Code Review Request — per-customer documents + subscription paradigm

You are reviewing the committed series `8e6dfaf..bd8c075` (2 commits) on
branch `DEV` of this repo (`/home/matt-teixeira/hep3/reports`): the
per-customer document paradigm (`cfd23c7`) and the subscription/
coalescing/concurrency rework on top of it (`bd8c075`). Review with
`git diff 8e6dfaf..bd8c075` / `git log -p`. Your findings will be handed
back verbatim to another assistant to fix, so make each one
self-contained and reproducible.

## What changed, in two paragraphs

**The document unit changed** (user decision): a `user_summary` no longer
produces one merged cross-customer document per user. The unit is now
**(customer × system-subset)** — each user's magnet scope is partitioned
by owning customer (`systems → sites → customers`), a multi-customer user
gets one document per customer, and a document can never contain two
customers' systems (forward-safe by construction). Delivery is **one
digest email per user** carrying all their customer PDFs — zipped when
more than one, split into "part n/N" emails only past the ~12 MB budget;
minimizing email count is the decided packaging priority.

**The audience model changed** (user decision): `alert.sme_reports` is
now the SUBSCRIPTION table. A `user_summary` row with **no scope**
subscribes its **author** — the frontend contract is one row per
subscribed user (`author`, kind, lookback, schedule, enabled), duplicate
authors across rows expected (row = report type × owner, the
alert.reports convention). Launch posture: nobody receives the weekly
without a row. All `user_summary` rows firing on a slot **coalesce**:
one audience, one plan, shared renders — while every user's sends rows
attribute to *their own* config row and honor *their own* `dry_run`
gate. Systems compute once per window via a per-run cache, and
`run_batch` gained an opt-in concurrency pool.

## Prior rounds — what NOT to re-review

`REVIEW-HANDOFF-SCHEDULED-RUNS.md` (closed SHIP-with-fixes-applied after
3 rounds / 12 findings) covers the scheduler's foundations: strict CLI,
per-recipient SMTP truth (`smtp_outcomes`), attempt-unique archives,
sends-table integrity boundaries, access re-checks. Do not re-litigate —
but this series REWROTE `run_user_summary` and touched `run_batch`, so
regressions against those reviewed properties are squarely in scope.
`PLAN-SCOPED-WEEKLY.md` records both decisions; doc/code divergence is a
finding.

## In scope, by commit

### 1. `cfd23c7` — per-customer documents + digest delivery

- `fanout.plan_documents(audience, system_customer)`: partitions each
  user's scope by owning customer; unit key = customer + canonical
  sorted subset; users sharing a (customer, subset) share one render;
  a system with no customer mapping fails loudly.
- `fanout.resolve_audience(users, mag_ids, allowed)`: optional named
  narrowing (case-insensitive); standing filters (active, notify_email,
  ≥1 magnet) always apply — a named user is never force-mailed past
  their own settings.
- `output/send_digest_email.js`: one email per user; single doc attaches
  directly, multiple zip (`zip -j` into `out/`), size-chunked parts past
  12 MB; returns per-part `{unit_keys, info, error}` so every DOCUMENT's
  sends row is graded from its own part's SMTP accepted list.
- `run_user_summary` became two-phase: render each unit once (isolated —
  one customer's bad data cannot sink the rest), then deliver per user
  with per-document access re-checks; **partial delivery is deliberate**
  (a failed unit writes an error row while the user's other documents
  still ship).
- `sql/mag-system-customers.sql` + `load_audience_pool` now returns the
  system → customer map.

### 2. `bd8c075` — subscriptions, coalescing, concurrency, cache

- `validate_config`: scope-absent `user_summary` canonicalizes to
  `{users: [author]}` (author must be an email). Named/all_users
  variants remain as pilot/admin tools.
- `fanout.coalesce_user_rows(cfgs)`: same-slot user_summary rows group
  by identical (lookback, options); each coalition carries `allowed`
  (null when an all_users row is present), `owner_of(email)` (the row
  that NAMED the user, first by id, else the all_users row) and
  `dry_run_of(email)`. Duplicate subscriptions → first row by id, one
  delivery.
- Unresolved named subscribers get an **error sends row** stating why
  (attributed via `owner_of`) — no silent nothing.
- `run_batch(…, {concurrency, cache})`: worker pool over the request
  list (results stay in request order; per-system failures isolated as
  before); the cache maps `system|window_start|window_end` → result OR
  failure, shared across all units in a scheduled run. **Default
  concurrency 1 and no cache = file-mode path unchanged.**
- `run_scheduled`: user_summary rows collected and coalesced after the
  explicit-kind loop; `RENDER_CONCURRENCY = 4`; documents archive
  LAZILY at first live delivery (mixed dry/live coalitions archive only
  what ships); coalition failure attributes to every member row's id.

## Highest-risk areas — attack these first

1. **The customer boundary.** Try to construct a unit whose systems span
   two customers (stale/mutated `system_customer` map between plan and
   render? `resolve_scope({system_ids})` re-resolving to a different
   set?). The tests assert the invariant at plan time — attack the gap
   between plan time and render time.
2. **Shared mutable results.** The per-run cache and the unit dedup hand
   the SAME result objects (including `r.summary` records) to multiple
   `build_fleet_model` calls and digest-count graders. If anything in
   that pipeline mutates a record (sorting copies vs sorting in place,
   overlay assignment, pagination), one customer's document could bleed
   state into another's. Trace it — this is the classic aliasing bug
   shape.
3. **Coalescing attribution.** Mixed dry/live coalitions: a dry
   subscriber and a live subscriber sharing a (customer, subset) unit —
   verify the dry user gets `dry_run` rows naming the SCRATCH filename
   while the live user gets `sent` rows naming the ARCHIVED name, and
   that `raw_cfg.dry_run = !any_live` gates history sidecars sensibly.
   all_users + named rows in one coalition: attribution and dry gating
   for users covered by both.
4. **Digest zip collisions.** `Magnet-Health-Summaries-<date>.zip` is
   written into the SHARED `out/` per user, sequentially overwritten
   between per-user sends. Today sends are strictly sequential and
   nodemailer reads the attachment at send time — verify that holds
   through `send_with_retry`, and judge whether the shared name is a
   latent race if delivery ever parallelizes.
5. **`run_batch` pool equivalence.** Concurrency 1 must be
   byte-equivalent to the old loop for file mode (ordering of results,
   failures, log events). At concurrency 4: failure isolation, the
   cursor loop's bounds, cached-failure replay (same message per
   document), and DB pool pressure (4 concurrent × several queries per
   system against pg-promise's default pool).
6. **Per-part SMTP grading.** `send_digest_email` maps unit_keys per
   part; a part that throws vs a part whose info rejects the recipient;
   `smtp_outcomes` on the single recipient per part; sends rows per
   DOCUMENT (a user with 11 docs in one accepted email gets 11 `sent`
   rows — deliberate; judge the semantics).
7. **Subscription resolution edges.** Author case drift between
   `alert.sme_reports.author` and `public.users.email_address`;
   the unresolved-subscriber error row (config attribution, no
   scope_hash); a subscription whose author has magnets under ZERO
   customers vs the plan's no-mapping failure.

## Invariants that must hold

- No rendered document ever contains two customers' systems.
- A user receives only documents whose systems their CURRENT cache
  covers (per-document re-check); explicit-recipient kinds unchanged.
- Every document delivery attempt — sent, error, skipped, dry — is one
  sends row attributed to the correct config row; no recipient/document
  pair ever carries contradictory rows.
- Nobody is emailed without either a subscription/named/all_users
  resolution AND passing the standing filters; nobody is force-mailed
  past `status`/`notify_email`.
- File mode (`npm start sme_report -- ./requests/x.json`) is unchanged —
  including `run_batch` at default options.
- Fresh rows stay inert (enabled false + dry_run true, DDL defaults).

## How to run

```
node sme_reports/dev/check_config.js    # subscriptions, coalescing, plans, CLI
node sme_reports/dev/check_scope.js
node sme_reports/dev/check_compute.js
node sme_reports/dev/check_chart.js     # Chromium
node sme_reports/dev/check_fleet.js     # Chromium + subprocess
```

All six pass at handoff. Live DB likely unavailable to you. **Never
enable rows, never run `--config` against an enabled row without
`--dry-run`, never run request files with real recipients.** Live state
at handoff (recorded): row 1 = customer_summary (Lee Health →
matt.teixeira@avantehs.com, live); row 2 = the first true subscription
row (author matt.teixeira@avantehs.com, scope NULL, live). Live
evidence: the per-customer pilot resolved "1 user → 11 customer
documents" (11 customers own all 164 mag systems; the author's cache
covers all of them), dry rows verified, then the REAL digest delivered —
one email, one zip, 11 customer PDFs, 11 `sent` rows graded from SMTP's
accepted list, 11 attempt-unique archived documents. The
subscription-shaped row re-verified by forced dry run afterward.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- Subscribers must still pass `status='active'` AND `notify_email` —
  the subscription is not (yet) treated as overriding the coarse notify
  flag; unresolved subscribers are surfaced via error rows instead.
- `RENDER_CONCURRENCY = 4` and the 12 MB chunk budget are project
  constants, not adaptive.
- Unit renders are sequential (the cache makes repeat systems cheap);
  only per-system computation inside a unit is parallel.
- The digest zip lives in shared `out/` under a date-based name;
  per-user sends are strictly sequential today.
- No run locking (inherited posture); cron discipline assumed.
- `coalesce_user_rows` groups by exact (lookback, JSON.stringify of
  options) — semantically-equal-but-differently-ordered options objects
  would split coalitions (inefficient, never incorrect).

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, one sentence
   why.
2. **Findings** `F1..Fn`, ordered by severity, each with: file:line, a
   concrete failure scenario (config/user/SMTP state → wrong document,
   wrong recipient, wrong record, or crash), suggested fix, confidence.
3. **Equivalence**: `run_batch` at default options vs the old loop —
   EQUIVALENT or CHANGED for file mode, with the path that convinced
   you.
4. **Fixture audit**: the new `check_config.js` sections (subscriptions,
   coalescing, per-customer plan, users-scope pilot) — failure mode or
   tautology, each.
5. **Ran**: exact commands and results.
6. **Test gaps**: behaviors you judged correct but found unasserted.

---

## Round-1 outcome (2026-08-11) — fixed (`258cfeb`), one deliberate stance

Verdict was DO NOT SHIP; five findings fixed outright, one split into a
fix plus a recorded design stance. For re-review: verify each fix holds
and judge the F4 disposition on its merits.

| # | Disposition | Fix | Regression |
|---|---|---|---|
| F1 (critical) | fixed | `zip` updates rather than replaces: new dependency-free `fresh_zip` module — stale target removed, per-send uuid path, cleanup after the awaited send, recipient still sees the clean filename. Same latent defect fixed in `send_batch_email` | DB-free check: two builds at one path → the second archive contains ONLY the second file set |
| F2 (high) | fixed | resolutions carry current `customer_ids`; a unit render rejects when ownership moved between plan and render | `check_scope.js` asserts `customer_ids` on resolution; the render guard is runner-level |
| F3 (high) | fixed | live units archive at RENDER time, pre-SMTP (archive failure = pre-delivery unit failure); `record_unit` is persistence-only; skipped/error rows never archive and name no document | code-path restructure; live dry-run re-verified |
| F4 (major) | **part fixed, part deliberate** | the swallowed `.catch(() => {})` is gone — a failed unresolved-subscriber insert is a counted persistence failure that FAILS the coalition. Unresolved subscribers themselves WARN + record error rows + surface in return counts but do NOT fail the run: a deactivated subscriber is user state, and a weekly-red cron until someone edits a row is alert fatigue, not signal. Challenge this stance with a concrete harm if you disagree | warning + counted persistence failures |
| F5 (major) | fixed | liveness is PER UNIT: all-dry units write no sidecar and archive nothing inside mixed coalitions | code-path; coalesced `dry_run_of` fixtures already cover the gates |
| F6 (moderate) | fixed | digest counts: systems = produced + failed; failures render "N status unavailable", never a reassuring zero | rendering change in `send_digest_email` |

Live after fixes: the subscription dry run re-renders "1 user → 11
customer documents", 11 rows recorded; all six dev checks pass including
the fresh-zip and customer_ids regressions.

---

## Round-2 outcome (2026-08-11) — all five findings fixed (`3e7f411`)

Verdict was DO NOT SHIP; all five fixed (each a refinement of a round-1
fix, none contested).

| # | Fix |
|---|---|
| R2-F1 | The customer boundary is checked a THIRD time, post-render immediately before archiving: the unit's systems re-resolve and their current customer must equal the planned one. Planning → resolution → pre-archive; the residual window is the seconds between the final check and SMTP, accepted in lieu of DB-level locking |
| R2-F2 | `send_batch_email` adopts `fresh_zip` at a private per-send unique path (clean recipient-facing name, best-effort cleanup) — the concurrent rebuild-under-an-in-flight-send race is closed for both senders |
| R2-F3 | Cleanup is best-effort in its own try/catch and can never convert an SMTP-accepted delivery into error rows; transporter construction moved inside the try so its failure cannot leak the private zip |
| R2-F4 | Archival is gated on eligibility: with the send-time cache snapshot loaded first, only units with ≥1 live access-eligible recipient archive (still pre-SMTP); all-ineligible units archive nothing |
| R2-F5 | Unresolved policy is coalition-independent: all-unresolved named coalitions warn + record + return success, identical to a mixed coalition; `all_users` resolving to nobody stays fatal |

Accepted gaps (unchanged in kind): no orchestration-level
`run_user_summary` test; ownership mutation mid-render, archive-timing
vs recheck, cleanup-failure-after-accept, and concurrent zip builders
are code-path-verified but not fixture-simulated — they sit at DB/
filesystem/SMTP seams the DB-free checks deliberately do not cross.
RULES.md documents the three-check boundary, eligibility-gated
archival, and the unresolved policy.

---

## Round-3 outcome (2026-08-11) — all four findings fixed (`63da943`); series closed

Verdict was SHIP WITH FIXES; all four fixed, none contested.

| # | Fix |
|---|---|
| R3-F1 | SMTP truth isolated from telemetry in BOTH senders: only the send itself (and transporter construction) can produce a delivery failure; success/partial logging runs afterward in its own best-effort boundary, error-path logging is best-effort too — a logging failure after an accepted send can never fabricate error rows |
| R3-F2 | History sidecars DEFERRED like the PDFs: `write_records_sidecar` extracted/exported, auto-persistence suppressed at unit render, and the eligibility step writes the sidecar (best-effort) only for units approved for archival — an all-ineligible unit archives neither PDF nor sidecar |
| R3-F3 | The post-render ownership recheck runs for EVERY successful unit, dry-only included; only `archive_delivered` is gated on live eligibility — a dry-run row can no longer name a document rendered under stale ownership |
| R3-F4 | `send_batch_email` transporter construction inside the try/finally, matching the digest sender — its failure cannot leak the private zip |

Verified live: the subscription dry run re-renders 1 user → 11 customer
documents with ZERO new sidecars (the 11 on disk carry the real pilot
send's 16:44 UTC timestamps, untouched by every dry run since — the
deferred-archival semantics demonstrated on real data). All six dev
checks pass. **The per-customer + subscription series is
review-complete**; remaining accepted gaps are the orchestration-seam
fixtures listed above and the residual final-check-to-SMTP ownership
window (documented design tradeoff).
