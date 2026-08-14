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

**Current review round: Phase 0 — commit `ea9352e` (one new dev file).**

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
