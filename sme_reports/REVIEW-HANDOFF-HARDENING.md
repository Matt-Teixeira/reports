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
findings, all fixed in `13bfb8b` / `171fe00` / `e64fd97`; see the addendum
at the end of this file. The next round's scope will be stated here when
Phase 2 lands.**

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
