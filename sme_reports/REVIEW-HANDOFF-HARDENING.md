# Code Review Request — fail-closed hardening series (architecture-review adoption)

You are reviewing committed changes on branch `DEV` of this repo
(`/home/matt-teixeira/hep3/reports`). This series implements the adopted
findings of the architecture review (`REVIEW-HANDOFF-ARCHITECTURE.md`,
reviewed baseline `2fa616a`) — the fail-closed hardening track first, then
the pure-analysis extraction, then limited coverage. Phases land as small
check-gated commits; each gets its own section here, and this header names
the commits in scope for the current round. Your findings will be handed
back verbatim to another assistant to fix — make each one self-contained
and reproducible. "No change needed" is a valid finding.

**Round 1 (Phases 0–1: `ea9352e`, `c74f616`, `4a727c9`) is complete — five
findings, all fixed in `13bfb8b` / `171fe00` / `e64fd97`; see the round-1
addendum near the end of this file.**

**Round 2 (Phases 2–5: `ef4b87e`, `c6937f1`, `88e7500`, `7439ff2`,
`3ef210b`) is complete — four findings, all fixed in `57990d7` /
`80cf9e0` / `24431e6` / `501c8ba`; see the round-2 addendum at the end of
this file.**

**Round 3 (Phases 6–8: `ae085fd`, `9a41190`, `0fe79c2`, `f386c3e`) is
complete — one substantive finding plus documentation cleanups, fixed in
`d11d4d3`; see the round-3 addendum at the end of this file.**

**Round 4 (Phases 10–13: `05e758e`, `29ef8db`) is complete — two P2
findings, both fixed in `521c22d`; see the round-4 addendum at the end of
this file. THIS SERIES IS COMPLETE: all four rounds closed, every finding
fixed same-round. The adoption outcome and the trigger-gated roadmap are
recorded in `REVIEW-HANDOFF-ARCHITECTURE.md`.**

## What this codebase does

Generates customer-facing "Magnet Health" PDFs for ~163 MRI magnets from
Postgres telemetry: one-page per-system briefs and a multi-page summary
document (internal fleet + scoped customer variants). The costliest bug
class silently misstates or omits a system's state; the second costliest is
geometry (`.page` is fixed 8.5×11in with `overflow:hidden`). Invariants:
never-silent, measured geometry, stated-vs-judged (see
`REVIEW-HANDOFF-ARCHITECTURE.md`).

## Phase 0 — parity harness (`dev/parity.js`, commit `ea9352e`)

Every later phase claims either "output-identical" or "output changes only
for these named systems". This harness is what makes that claim measured
rather than asserted, so its own honesty is the review target.

What it does: transforms a request JSON (pins one explicit-date window into
every entry; forces `batch_email.summary/attachments/zip/archive_records`
off), writes it beside the witnesses as `request.parity.json`, loads it
through the NORMAL loader (`load_requests` / `materialize_scoped_requests`
— validation behaves exactly as a real run), then post-load forces every
report's `output` to `{html: !summary_only, pdf: false, email: false,
archive: false, out_dir}` and runs `run_batch`. Witnesses: per-system brief
HTML, fleet summary HTML, `records.json` (ordered `results[i].summary` +
failures — the sidecar shape minus `generated_at` and filesystem paths).

### Where to look hardest

1. **Can it silently send email or archive?** The transform forces
   `summary:false, attachments:false, archive_records:false` and post-load
   `email:false` per report. Attack the ordering: post-load output forcing
   happens AFTER `assemble` already applied batch-member forcing
   (`pdf:true, email:false`) — confirm no path reads the pre-forced output
   flags before the overwrite, and that `run_batch`'s email branches
   (`batch_email.summary`, `batch_email.attachments`) can't fire with both
   false. `write_records_sidecar` must be unreachable
   (`archive_records:false` is the only gate — verify).
2. **Witness completeness.** Is HTML + records.json a sufficient witness
   for "output-identical"? Known accepted gaps: PDFs excluded (render
   timestamps), `vm.facts` not captured directly until the Phase 7
   extraction exposes `analyze_system` (records.json is facts-derived via
   `build_summary_facts`; brief HTML is facts-derived via the renderers).
   If you see a fact that reaches neither witness, name it.
3. **Determinism honesty.** The pinned window makes series queries
   repeatable; the header states the residual drift (same-calendar-day
   requirement — artifact names carry the run date; late-arriving
   telemetry; `alert.models` edits between runs). Is anything else
   nondeterministic that the header does not admit? (Chart SVGs, sort
   ties, `Promise.all` ordering into `slots[i]` — the worker writes by
   index so order should hold; check.)
4. **The scoped path.** `report_defaults.window` injection for scoped
   requests rides `materialize_scoped_requests`' spread. RESERVED_DEFAULTS
   blocks only `system_id`/`report_type` — confirm `window` in
   report_defaults is legitimate and reaches `window_of` as explicit dates
   (lookback_days: null, empty period tag).
5. **Env loading.** The harness loads the root `.env` itself
   (`dotenv.config({path: …/../../.env})`) because the check suites never
   needed DB. Confirm this can't fight an already-set environment
   (dotenv does not override existing vars — is that the right behavior
   here?).

### What I verified, and how

- Two back-to-back runs of `requests/batch-test-6.json` (11 systems, live
  DB): all witnesses byte-identical (`diff -r --exclude='*.pdf'` clean).
- `requests/scoped-test-piedmont.json` (scoped, summary-only): resolves 43
  systems, writes fleet HTML + records.json with 38 records and 5 real
  failures captured as witness content; no brief HTML (summary-only shape).
- No emails sent in any run (delivery forced off by construction).
- All five check suites pass:
  `node sme_reports/dev/check_{scope,config,compute,chart,fleet}.js`.

### Deliberately not done

- No `--facts` capture mode yet: capturing `vm.facts` pre-extraction would
  need require-cache patching; records.json + brief HTML are the witnesses
  until Phase 7 exposes `analyze_system` and makes facts capture trivial.
- No PDF diffing (timestamps), no log-event persistence (`writeLogEvents`
  is not called — parity runs are dev probes, not deliverable runs).
- The harness is dev-only: no production module changed in this phase.

## Phase 1 — per-channel threshold resolution (commits `c74f616`, `4a727c9`)

The architecture review's verification surfaced a live bug: `data.js`'s
`fetch_thresholds` decided DB-vs-fallback on **pressure high rows alone**
(`if (p.high_gt === null && p.high_lt === null) return thr;`) and returned
the whole OEM fallback — silently discarding a system's configured helium
limits — and helium carried no `source` in either path while pressure's
`thr_source` was rendered as if it covered the row.

Commit `c74f616` moves the resolution logic VERBATIM into
`compute/thresholds.js` (`resolve_thresholds(rows, vendor)`), because the
pure core cannot live in `data.js` — requiring it loads the pg pool, which
reads env + SSL cert at module load, and the check suite is DB-free.
`fetch_thresholds` now queries and delegates. Byte-identical by parity.

Commit `4a727c9` is the fix: each channel resolves independently, each with
its own `source`. Pressure with no high row → OEM fallback
(`oem_constant`); helium with no configured row → nothing
(`{low_high:null, low_med:null, units:null, source:"none"}` — no OEM
helium constant exists; stated-vs-judged says an unconfigured channel is
stated, never judged). Summary records gain additive `he_thr_source`.
RULES.md §3 states the per-channel rule.

### Blast radius (measured before the change, live alert.models)

9 systems carry rows the old gate discarded: SME01867, SME10239, SME15805,
SME15811, SME15816, SME16414, SME16421, SME16422, SME20487. Four actively
report (SME15805/11/16, SME20487 — Philips, helium-only configs). Verified
old-vs-new on SME15805 via the parity harness (baseline worktree at
`c74f616`): its helium reads 40.0%, below its configured-but-discarded 50%
alert — the brief tile flips amber "level falling" → red "below the 50%
alert level", and `helium_low_high` goes null → 50 in the record. That is
the entire diff for that system. The 11-system test batch is HTML-identical
with only the additive `he_thr_source` key in records.json.

### Where to look hardest

1. **The preserved pressure predicate.** Med-only pressure configs still
   fall back to OEM (med rows discarded) — deliberately unchanged, flagged
   in RULES.md as pending domain review. Three non-reporting systems
   (SME16414/21/22) carry such rows. If you think preserving that is wrong
   NOW (rather than as a separate domain decision), argue it.
2. **`he_thr_source` semantics.** It reports RESOLUTION provenance,
   deliberately independent of the units-match gate that can still null
   `helium_low_high` (a %-limit against an LTRS reading). So a record can
   say `he_thr_source: "default_models"` while carrying no applied limit.
   Is that the right contract, or should application-provenance be a third
   state (`configured_units_mismatch`)?
3. **`he_configured` scope.** It flips on any non-pressure-field
   `less_than` row that parses — the same predicate that folds a row into
   `he`. Confirm no row shape can set it without contributing values (or
   vice versa).
4. **Consumers of the helium shape.** `render/tiles.js` (`he_thr_applies`),
   `compute/summary_facts.js:284`, `render/model.js` — all read
   `low_high/low_med/units`; the new `source` key is additive. Confirm
   nothing iterates the helium object's keys or deep-equals it (sidecar
   diffing tools included).
5. **The `*` mark stayed pressure-only** (`fleet_page.js` `thr_source ===
   "oem_constant"`). Open wording decision for the user, deliberately NOT
   taken in this phase: whether the legend should say "no configured
   pressure alert model", and whether helium-fallback rows deserve a mark.
   Flag if you think shipping the fix without the legend rewording
   misleads.

### What I verified, and how

- All five check suites green after each commit.
- check_compute pins: OEM fallback on no rows, conservative merge,
  unparseable rows skipped, band configs, mBar casing, helium
  `greater_than` ignored (configures nothing), helium-only kept +
  pressure independent fallback, pressure-only → helium `none`, med-only
  pressure falls back WITHOUT dragging helium down, both-configured
  provenance.
- Parity: test batch HTML byte-identical; records.json diff is exactly
  one additive `he_thr_source` per record. SME15805 old-vs-new diff is
  exactly the helium tile + two record fields (shown above).

## Phases 6–8 — the pure-analysis extraction (round 3 scope)

Architecture-review finding 2: analysis was embedded in rendering
(`build_render_model` did screening→facts AND svg/copy/layout in one
function), `index.js` built tiles/narrative/charts even for summary-only
runs, and `compute/summary_facts` imported judgments from `render/tiles`
— the one compute→render cycle. These four commits unwind that, moving
code VERBATIM wherever possible.

### Phase 6 — `ae085fd`: judgments move

`p_severity` / `trend_of` moved verbatim to `compute/judgments.js`;
`tiles.js` re-exports both for compatibility; `summary_facts` imports
from compute. `he_suffix` deliberately stays in tiles (display
formatting, render-only consumers). The compute package now imports
NOTHING from render — grep `require("../render` under `compute/` to
confirm.

### Phase 7 — `9a41190`: analyze_system extraction

`build_render_model`'s analysis half (its old lines 58–376: plausibility
screen, suspect conviction, compressor-source arbitration, events,
metric facts, EDU stats, the facts literal, archetype, offline overlays)
moved to `compute/analyze.js` with THREE renames only:
`request.window`→`window`, `request.event_window`→`event_window`,
`identity.system_id`→`system_id`. Threshold/units fallback defaulting
moved in with it (analysis owns threshold semantics). Returns
`{ facts, views: { mode, p_points, he_points } }` — views carries the
screened chart-point arrays privately; `facts.chart_mode` deliberately
STAYS a fact (archived sidecars serialize facts-derived records; the
shape must not change). `build_render_model` is now a wrapper:
analyze → destructure locals → presentation half (unchanged).

Where to look hardest:
1. **The verbatim claim.** Diff `compute/analyze.js` against the old
   model.js body (git show `9a41190^:sme_reports/render/model.js`). Any
   drift beyond the three renames is a finding.
2. **The views boundary.** The presentation half now reads
   `mode/p_points/he_points` from views and everything else from facts.
   Confirm nothing in the presentation half re-derives an analysis fact
   locally (it would silently fork from analyze's version), and that
   views never leaks into anything serialized.
3. **The no-data error.** Its message must be byte-exact
   (`fleet_model` failure grouping and `customer_failure_reason`
   pattern-match it) — check_compute pins it with an anchored regex;
   confirm the pin actually matches the grouping regexes.
4. **`analyze_system`'s contract.** `window` must expose
   `.start.toMillis()` / `.end.toMillis()` (luxon DateTimes from the
   loader). Is that contract stated clearly enough for the next caller
   (the future report-adapter work)?

### Phase 7b — `0fe79c2`: parity --facts witness

`--facts` writes `facts-<id>.json` per system from a fresh
fetch + `analyze_system` pass — the direct analysis witness the Phase 0
handoff section promised. Two --facts runs verified byte-identical; the
mode changes no other witness. Look at: the fetch block repeats
`run_one`'s pulls — acceptable dev-only duplication, or worth a shared
helper? (Deliberate choice: production `run_one` stays untouched by the
witness path.)

### Phase 8 — `f386c3e`: summary-only skips rendering

`run_one` calls `analyze_system` directly when html/pdf/email are all
off; render-producing paths unchanged; email-without-pdf still routes
through the render path so its validation error survives. Deliberate
narrowing, stated in RULES.md §5: presentation-side failures can no
longer fail a summary-only record (story coverage is check-gated
instead — round-2 F2's registry). The 43-system scoped run drops to
~15s. Look at: the `renders` predicate
(`html || pdf || email`) — is there any output combination where the
analysis-only path would skip a validation or side effect the render
path performs? (`archive` is gated inside the pdf block, so
archive-without-pdf was already a no-op — confirm.)

### Verification (this round)

- All five suites green after each commit.
- Parity per commit: `requests/batch-test-6.json` AND
  `requests/scoped-test-piedmont.json` byte-identical (HTML, fleet HTML,
  records.json), plus facts-level witnesses from `0fe79c2` onward
  (two --facts runs byte-identical).
- check_compute pins the extracted surface directly: facts shape smoke,
  views shape, resolved defaults, and the anchored no-data message.

## Phases 10–13 — limited coverage (round 4 scope)

Product decisions signed off by the user (phase 9): limited systems run
wherever scope resolves them; the allowlist is Hitachi/Canon/Toshiba/
Americomp; no per-system brief exists (loud named refusal). Survey
2026-08-14: SME16940 (Canon, EDU, process_mag=true) is the only live
qualifier; Toshiba×10/Hitachi/Americomp are process_mag=false; "TBD" and
"Artshu" rows exist and MUST stay unknown.

### Where to look hardest

1. **Stated-vs-judged, adversarially.** A limited record must not be able
   to acquire a color, condition, count, or urgency ANYWHERE: the fleet
   attention list/rollup/urgent counts, the summary email tiers and cell,
   the scheduled-runner grading (`run_scheduled` imports
   `is_attention`/`is_urgent` — limited records flow through scheduled
   summary units now). `conditions.js` gates explicitly via `is_limited`;
   find a consumer that grades by archetype without the gate.
2. **The three-way manufacturer gate.** unknown ≠ limited must hold under
   adversarial strings ("Canonical Imaging"? — `includes("CANON")`
   matches! Is loose substring matching over the allowlist acceptable, or
   a finding?). A supported vendor whose pulls fail must stay a failure.
3. **The partition.** Limited rows: exactly one place (LIMITED section);
   never in vendor sections, EDU section, attention, data issues,
   rollups, or `total`. The EDU reserve-ladder claim ("EDU members ⊆
   vendor-sectioned rows") must survive limited rows carrying `edu`.
4. **The per-run-shape split.** The same system is a stated row in a
   summary-only run and a named failure in a briefs batch (deliberate,
   RULES.md §5). Argue if you think that inconsistency is a trap — e.g.
   scheduled `include_briefs` configs would flip SME16940 between row and
   failure across config rows.
5. **Geometry.** MANUFACTURER need measured at 81px (colbudget; the
   first guess truncated and check_fleet's Chromium pass caught it —
   the gate works). The limited fixtures ride the 163-system fixture
   (now 15 pages) through the full geometry pass. Check the heading
   wrap: the section title + note wraps to two lines on the live render
   — acceptable or a finding?
6. **Wording (user sign-off pending).** Section title "LIMITED COVERAGE —
   OTHER MANUFACTURERS", heading note "environmental readings only — no
   magnet monitoring adapter", legend entry, cover clause "N limited
   coverage", email clause "carry environmental readings only", refusal
   error and its whitelist wording. Flag anything misleading.

### What I verified, and how

- All five suites green; the extended 163+3 fixture (full EDU / no EDU /
  stale room channel) passes the Chromium geometry pass at 15 pages.
- check_fleet pins: stated-never-judged end to end (grading, cell,
  sort), the manufacturer-then-id sort, exactly-once appearance of
  limited ids in the document, the stale-EDU dim rule in the limited
  table, and SECTION_W coverage for LIMITED.
- check_config pins the classify matrix including the live junk strings.
- Parity: batch = 11 additive `assessment_status` keys + one legend
  line; scoped Piedmont = additive keys only (SME16940 is not in that
  scope).
- Live render: a 3-system summary containing SME16940 produces a 4-page
  document — cover "2 systems analyzed — 2 need attention, 1 limited
  coverage", the limited row stated with its real EDU readings
  (MacNeal Hospital, Berwyn IL), zero failures.

## Review round 1 (codex) — outcome

Five findings, all verified and fixed; all five suites green after each
fix; parity re-run on both standing requests.

1. **P1 — unconfigured helium was still colored and judged**
   (`tiles.js`). Fixed in `13bfb8b`: the tile derives `judged` from the
   same two gates the fleet uses (limits resolved AND units matching the
   display) and renders neutral **ink** otherwise, keeping the measured
   wording verbatim; a recorded quench keeps its red (recorded event, not
   a threshold judgment). Deliberate choice, open to round 2: the WORDING
   ("no loss · no quench", "level falling") stays — both are measured
   statements (delta arithmetic, quench state); only the color was the
   judgment. Measured blast radius: 5 reporting systems with no helium
   config (SME10231/11247/12083/15166/15809) plus units-mismatched
   systems — the standing test batch caught SME18635/SME20004 (LTRS under
   % limits) flipping good/warn → ink, matching the fleet's existing
   "LTRS systems are not judged against % thresholds" rule. Fleet HTML
   and records byte-identical. check_chart pins every arm. RULES.md §4
   states the gate.
2. **P1 — threshold units depended on unordered row order**
   (`compute/thresholds.js`). Fixed in `171fe00`: units resolve from the
   SET of row-supplied units per channel; conflicting units THROW (fail
   closed — one system's report fails loudly, the batch survives). Live
   alert.models surveyed 2026-08-14: zero conflicts, so the throw can
   only fire on new misconfiguration. check_compute pins
   permutation-identity and both conflict throws in both orders.
3. **P1 — reused parity out-dir could hide a soft fleet-render failure**
   (`dev/parity.js`). Fixed in `e64fd97`: non-empty out-dir refused;
   witness manifest asserted after the run (brief HTML per successful
   result, fleet HTML whenever the request builds the summary document).
   Guard verified live: rerunning into a used directory aborts.
4. **P2 — documented worktree command was incomplete** (`dev/parity.js`
   header). Fixed in `e64fd97`: provisioning documented (cp `.env`,
   symlink `node_modules` + `utils`, run both sides from the main repo
   root — `PG_SSL_PATH` is cwd-relative).
5. **P2 — parity probe left zero-byte logger files** (`dev/parity.js`).
   Fixed in `e64fd97`: `run_log` is built locally as
   `{run_id, log_events: []}` — `addLogEvent` only pushes onto the array,
   so that shape is the whole contract; no stream is ever opened.

Post-fix parity: the 11-system batch is byte-identical except the two
units-mismatch tiles named in finding 1 (the finding's own fix); the
scoped Piedmont run differs from its Phase-0 baseline by exactly the 38
additive `he_thr_source` keys (one per record). The `*` legend wording
question from Phase 1 remains parked with the user.

## Phases 2–5 — fail-closed hardening (round 2 scope)

All output-identical (parity-proven per commit). The architecture-review
findings behind them are F1/F8 in `REVIEW-HANDOFF-ARCHITECTURE.md`.

### Phase 2 — fail-closed routing and lookups (`ef4b87e`, `c6937f1`)

- `data.js` `fetch_series`: the final else that routed ANY unmatched
  vendor key to the Siemens tables is now an explicit `SIEMENS` branch
  plus a named throw. `fetch_units` guards the `units_queries` lookup
  (was: `db.any(undefined)` → unattributable "Invalid query format").
- `render/fleet_page.js` `section_table` throws on a missing `SECTION_W`
  entry (was: NaN widths into a fixed `overflow:hidden` page).
- `compute/plausible.js` `primary_bounds`/`helium_bounds` throw on
  unrecognized units instead of defaulting to PSI/LTRS bounds. The
  recognized set is the complete LIVE vocabulary, surveyed 2026-08-14
  across all four `mag.*_units` tables and `alert.models`
  (K/PSI/mBar→mbar pressure; %/LTRS helium).
- `check_config` pins `VENDORS` ≡ `units_queries` key sets.

Look hardest at: (a) the bounds throw is reachable from `run_one` per
system — confirm a novel unit string fails that one system's report and
not the batch, on every call path (`model.js` screening, `last_raw_flags`,
`summary_facts`); (b) whether any fixture or minor caller still passes
unit strings outside the recognized set (suites pass, but you may find an
unexercised path); (c) the raw-"mBar" stance — bounds treat it as a
normalization bypass and throw; is every entry point actually normalizing?

### Phase 3 — runtime fleet partition assertion (`88e7500`)

`build_fleet_model` asserts sectioned === rows.length after sectioning and
throws naming every stray system + vendor_key. Throwing soft-fails only
the summary document (`build_fleet_summary` isolates it). Written over the
section list so the future limited-coverage section extends it.
check_fleet pins the thrown message. Look hardest at: the failure mode —
soft-failing the WHOLE summary document on one stray row is deliberate
(never-silent outranks partial delivery); argue if you disagree. Also:
`condition_rollup` above the assertion still counts stray rows before the
throw fires — confirm no partial artifact can escape.

### Phase 4 — executable checks for comment-only invariants (`7439ff2`)

- `narrative.js` exports `STORY_KEYS`; check_compute asserts every
  `SEVERITY_ORDER` condition has a story and (via a shape matrix) that
  `classify` only produces `SEVERITY_ORDER` members. The render-time
  TypeError on an unregistered archetype is now check-gated; the lookup
  itself stays unguarded by design (a guard would hide the bug the check
  now catches loudly).
- check_fleet renders all four {records, failures} permutations with
  exclusions and pins rendered page count + footers to `vm.page_count`
  (the exclusion-placement duplicate pair, previously comment-synced).
- `dev/solve_widths.js` SETS now DERIVE from `fleet_model` SECTIONS +
  the newly shared `EDU_COLUMNS` export; NEEDS stays hand-authored (it
  is the measurement — deriving it would be tautological); check_fleet
  pins NEEDS ↔ derived columns; `require.main` guard makes the module
  requireable; CLI output byte-identical to the pasted SECTION_W.

Look hardest at: the classify shape matrix — does it cover every return
path (including the `event_window` no-OFF-readings shape)? And whether
deriving SETS could mask a fleet_model mistake (the counter-argument: the
measured NEEDS and the Chromium geometry pass are the independent halves,
and both remain).

### Phase 5 — duplication collapses (`3ef210b`)

One `compute/staleness.js` STALE_MS (three sites; THERMAL_LAG_MS and
DAY_MS deliberately NOT merged — same number, different meanings); one
`compute/provenance.js` `is_inferred` for the ᶜ mark (five sites, 4-value
vocabulary documented); GE's 10 K boundary down to one field
(`coldhead.warm_k`, `cold_threshold_k` deleted, normalize.js reads the
shared field, check_config pins the dependency); EDU channel stats
computed into named locals before the facts literal (property-order
hazard removed). RULES.md names the shared helpers.

Look hardest at: require-cycle safety of the new compute modules
(fleet_page → fleet_model → compute/staleness; tiles → both — all
leaf-only, but verify); and whether any consumer of the OLD
`vendor.compressor.cold_threshold_k` survives anywhere (grep says only
the historical comment).

## Review round 2 (codex) — outcome

Four findings, all verified and fixed; all five suites green; parity
byte-identical on the test batch after the fixes.

1. **P1 — a partition violation could still resolve into a successful,
   silent delivery.** `build_fleet_summary` caught every error into a bare
   null; a normal batch then sent the summary email (attachment quietly
   absent), delivered briefs, and exited 0. Fixed in `57990d7`:
   `build_fleet_summary` returns `{pdf_path, error}`; the summary email
   opens with a red statement that the requested document could not be
   generated (`fleet_failure_note` in `email_theme.js` — scoped/customer
   wording carries no raw error, the whitelist stance; the internal
   variant carries the escaped message); file-mode `run_sme_report` throws
   AFTER all authorized deliverables have gone out, so cron sees nonzero.
   summary_only's hard failure and run_scheduled's per-unit
   `fleet_pdf_path` check are unchanged. check_fleet pins the note's
   statement, escaping, and scoped no-raw-error stance.
2. **P2 — the classify matrix did not guard future return paths.** Fixed
   in `80cf9e0`: `ARCHETYPES` is now a closed, priority-ordered registry
   in `compute/archetype.js`; `classify` validates its own output at
   runtime (named error at the source, even on unexercised paths);
   check_compute asserts `SEVERITY_ORDER` equals the registry exactly
   (keys AND order — the "MUST match" comment made executable);
   `build_narrative` throws a named error instead of a bare TypeError —
   deliberately still a throw, not a fallback.
3. **P2 — unknown compressor provenance failed open as "measured".**
   Fixed in `24431e6`: `compute/provenance.js` is a closed registry
   (reported / measured / inferred); `source_kind` throws on anything
   unregistered and `is_inferred` resolves through it; check_config
   validates every vendor source through the registry before the
   inferred→warm_k dependency check.
4. **P2 — empty unit strings bypassed the bounds guards.** Fixed in
   `501c8ba`: `fetch_units` distinguishes absent (NULL → vendor default)
   from blank (fails closed, naming system and channel);
   `resolve_thresholds` trims row-supplied units (whitespace variants of
   one unit are one unit) while a blank stays "absent" there —
   deliberately, since a unitless threshold row is meaningful. Live
   survey 2026-08-14: no blank or padded units exist anywhere, so no
   live system is affected.

Codex additionally confirmed: the mBar path normalizes before bounds
dispatch, unknown-unit throws stay isolated per system, the partition
assertion emits no partial artifact, the Phase 5 modules introduce no
require cycle, and no `cold_threshold_k` consumer survives.

## Review round 3 (codex) — outcome

One substantive finding plus documentation cleanups, fixed in `d11d4d3`;
all five suites green; parity verified on both request shapes.

1. **P2 — `--facts` did not capture the facts of the production pass.**
   The harness re-fetched and re-analyzed after `run_batch`; a pinned
   window is not a database snapshot, so the facts witness could disagree
   with the artifacts of its own run, and the duplicated fetch block could
   drift from `run_one`. Fixed: `run_one` gains a dev-only `on_facts`
   observer (threaded through `run_batch`'s opts; production callers never
   pass it; cache hits skip it and the harness never uses a cache). The
   harness now writes the EXACT facts objects the run computed, and fails
   loudly if any successful result produced none. Verified: the batch's
   observer-captured facts are byte-identical to the re-fetch era's
   (same-day), and the scoped summary-only shape emits facts through the
   analysis-only branch (38 files).
2. **Documentation cleanups (non-blocking):** `summary_facts` and
   `provenance` comments now attribute the plausibility screen and the
   EDU override to `compute/analyze`; `narrative`'s STORY_KEYS comment no
   longer describes the (now named-error) lookup as unguarded.

Codex additionally verified: the extracted analysis body is
line-for-line identical after the three documented renames, compute has
no render dependency, and the summary-only output predicates preserve
every existing combination.

## Review round 4 (codex) — outcome

Two P2 findings, both fixed in `521c22d`; all five suites green; batch
parity byte-identical.

1. **P2 — the limited allowlist was not actually closed.** Substring
   matching classified "Canonical Imaging" as limited (contains CANON) —
   the exact unknown→limited downgrade the gate forbids. Fixed:
   token-boundary matching (uppercase, split on non-alphanumerics);
   "Canon Medical Systems" still matches on its own token. check_config
   pins the adversarial negatives ("Canonical", "Canonical Imaging",
   "Americomputer", "Toshibapro" → unknown). `resolve_vendor`'s loose
   matching for SUPPORTED vendors is deliberately untouched — changing it
   could reclassify live systems and is a separate decision.
2. **P2 — limited-only summaries claimed "no data this period".** The
   document window derived from assessed rows only. Fixed: the period
   comes from every successful record; check_fleet pins a limited-only
   document showing real dates and the "No systems analyzed · 1 limited
   coverage" cover split.

Codex additionally confirmed the limited partition and grading guards
sound, and the round-3 facts observer correct.
