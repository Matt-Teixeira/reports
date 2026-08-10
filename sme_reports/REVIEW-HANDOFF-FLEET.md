# Code Review Request — fleet summary PDF

You are reviewing uncommitted work on branch `DEV` of this repo
(`/home/matt-teixeira/hep3/reports`). Nothing is committed.

## Scope — read this first

The working tree contains **two separate features**. `git diff` plus the
untracked files shows both:

1. **Compressor event clustering** (`compute/events.js`, `compute/metrics.js`,
   `render/{chart,model,narrative,tiles,fmt}.js`, `dev/check_{compute,chart}.js`).
   **Already reviewed twice and fixed — OUT OF SCOPE.** See
   `sme_reports/REVIEW-HANDOFF.md` for that feature's handoff and the two
   rounds of findings. Do not re-review it.
2. **The fleet summary PDF** — this review. New files:
   `conditions.js`, `compute/summary_facts.js`, `render/fleet_model.js`,
   `render/fleet_page.js`, `dev/check_fleet.js` (~1,480 lines), plus edits to
   `index.js`, `request_loader.js`, `output/render_pdf.js`,
   `output/send_summary_email.js`, `output/send_batch_email.js`,
   `render/tiles.js` (exports only) and `render/model.js` (one new fact).

Read `sme_reports/RULES.md` §5 for the documented rules, and
`sme_reports/HANDOFF.md` for project background. **There is no test
framework** — `dev/check_*.js` are plain `node:assert` scripts, hand-run.

## What this codebase does

Generates one-page "Magnet Health Brief" PDFs for ~163 MRI magnets across four
vendor variants (Philips, GE, Siemens TIM, Siemens non-TIM), from Postgres
telemetry. These are **customer-facing** documents. The costliest class of bug
here is one that silently misstates or omits a system's state.

## What the fleet summary is and why

A batch run produced 163 per-system PDFs plus a summary **email** whose table
had three columns: system, site, condition. It was thin because of data
starvation, not choice — `run_one` computed the full `vm.facts` per system and
returned only 8 fields, so every metric died in scope.

The fleet summary is a **multi-page PDF** carrying brief but meaningful system
*state* (helium, primary metric, shield temp where it exists, coldhead,
cabinet, compressor state and history) — not just error conditions. It can
also run **alone**, skipping per-system rendering entirely, so it is cheap
enough to schedule. On live data: 150 systems, 12 pages, 603 KB, ~26 s.

## Architecture

```
run_one (index.js)
  └─ build_summary_facts(vm.facts, identity)   compute/summary_facts.js
       → one flat serializable record per system
          └─ build_fleet_model(records, failures)   render/fleet_model.js
               → rollup + attention list + failure grouping + PAGINATED chunks
                  └─ build_fleet_page(vm)   render/fleet_page.js
                       → multi-page HTML, one <div class="page"> per sheet
                          └─ render_pdf_document()   output/render_pdf.js
```

`conditions.js` holds the shared condition vocabulary (severity order, labels,
attention/urgent sets, colors) that the summary email, batch email and fleet
PDF all import, so they cannot drift.

## Decisions the user made — do NOT relitigate

1. **Metric columns**: native value with its own units, PLUS a dimensionless
   "% of that system's own alert line" that sorts across vendors. Pressure is
   mbar / gauge PSI / absolute PSIA / Kelvin depending on variant.
2. **Structure**: overview page(s), then one section per vendor variant,
   each carrying only the columns that variant actually has.
3. **Delivery**: both — `batch_email.summary_pdf` attaches the PDF in normal
   batch runs, and top-level `summary_only: true` skips per-system work.
4. **Severity**: `SEVERITY_ORDER` now matches `compute/archetype.js` priority
   (recovered stop outranks threshold exceeded), and recovered stops count
   toward "needs attention" (but are amber, and not "urgent").

## Bugs already found and fixed during development

Stated so you don't spend the review re-deriving them — and because the second
one says something about the tests.

- **The logo made the document 4.6 MB.** `assets/logo.js` is 412 KB of base64.
  Chromium re-embeds the image on every page it appears on, so a 9-page
  document cost ~520 KB per sheet. The lockup now rides the cover only;
  continuation pages carry a text wordmark. 4.6 MB → 586 KB.
- **40 of 150 systems were silently missing from a real sent PDF.** `.page` is
  a fixed 11in with `overflow: hidden`. The rows-per-page constants assumed
  single-line rows; real rows ran 2–3 lines because site, condition and
  compressor all wrapped. Every page overfilled and the surplus was clipped
  with no error. Fixed by making row height deterministic (`table-layout:
  fixed`, nowrap, ellipsis, fixed `tr` height), lowering the row budgets, and
  paginating the overview page too.

  **The test that should have caught it instead certified it.** It asserted
  "the PDF has as many sheets as the model said" — but the model *chose* the
  sheet count, so the assertion could only ever agree with itself. It passed
  while a quarter of the fleet vanished. `check_fleet.js` now lays the
  document out in Chromium and measures where content actually landed. Treat
  any assertion in that file that could be self-fulfilling as suspect.

## Where I most want your eyes

1. **`compute/summary_facts.js` null-safety across four vendors.** `facts.pressure`,
   `.helium`, `.coldhead`, `.shield`, `.cabinet`, `.temp_alarm`,
   `.compressor_event` can each be null; `baseline_value`,
   `delta_vs_baseline` and `rate_per_hr` were recently made nullable too.
   Any path that renders a null as a number, or a missing sensor as a healthy
   reading, is the worst outcome this document can produce.
2. **The centered-band heuristic** (`is_centered_band`, `CENTERED_BAND_RATIO =
   0.5`). Live GE systems carry a 0.5–5.2 PSI threshold pair — a floor alarm
   under a one-sided metric, where "% of the high line" is meaningful. Siemens
   TIM carries 14.4–16.4 PSIA where normal sits mid-band at ~15.3 and a
   percentage would call a healthy magnet "93% of line". The two are told
   apart by `high_lt / high_gt >= 0.5`. Is that ratio defensible, and does it
   misclassify any plausible threshold configuration?
3. **Pagination robustness.** `ROWS_PER_PAGE` / `ROWS_FIRST_PAGE` /
   `ATTENTION_*` / `FAILURES_PER_PAGE` are still hand-set constants validated
   by measurement. **The measurement runs against synthetic fixtures only** —
   I verified live data by hand, but nothing automated covers real site-name
   lengths or a vendor mix that differs from the fixture. How would you close
   that gap? Can any input still overflow?
4. **`index.js` orchestration.** `build_fleet_summary` catches all errors and
   returns null so a failure can't sink a batch — does that mask anything it
   shouldn't? Also check the `results` vs `attachable` split: the summary now
   receives ALL results, not just those with a PDF on disk (that filter was
   what made `summary_only` come back empty).
5. **Behavior changes to existing, shipped paths.** Adding recovered stops to
   `ATTENTION` changes the headline count on the summary email everyone
   already receives. `send_batch_email` now renders colored, labeled
   conditions instead of raw archetype strings. `render/model.js` gained a
   `shield` fact. `render/tiles.js` gained exports and a refactored
   `trend_word`. Are any of these regressions for existing consumers?
6. **`request_loader.js` `summary_only`.** It overrides per-report output to
   all-false. Does it interact badly with any existing request file, and is
   the `summary_only` + `batch_email` requirement enforced sensibly?
7. **HTML escaping.** `esc()` in `fleet_page.js` is the only escaping in this
   codebase — everything else interpolates raw. Site, customer and failure
   strings come from the database. Is every DB-sourced value escaped on every
   path, including the failure-reason regex in `group_failures`?

## Open questions I want an opinion on

- **A.** Eleven live systems report "compressor off ~736–745 h and not
  recovered" — the entire 30-day window. A magnet with no compressor for 31
  days would have quenched, so these are near-certainly dead sensors or
  decommissioned units, yet they dominate the urgent count. Should the fleet
  summary (or the detection layer) distinguish "off for the whole window" from
  a real stop? Where does that belong?
- **B.** One system reports −3.625 PSI, 0.00% helium and a 382.8 K shield —
  sentinel/garbage data rendered as a real recovered stop. Should there be a
  plausibility filter, and should such systems be quarantined into a
  data-quality section rather than listed as healthy or attention-worthy?
- **C.** The attention list is now shown in full (56 systems, ~3 pages) rather
  than truncated. Right call for a triage document, or should it cap?

## How to verify

```bash
node sme_reports/dev/check_compute.js   # clustering (out of scope, regression guard)
node sme_reports/dev/check_chart.js     # per-system brief (regression guard)
node sme_reports/dev/check_fleet.js     # this feature; renders a real PDF
```

All three pass on the current tree. `check_fleet.js` writes
`sme_reports/out/Avante-dev-fleet-summary-Magnet-Health.html` and
`Avante-dev-fleet-summary.pdf`.

Live runs need DB access. A no-send full-fleet run (builds the PDF, emails
nothing) is the useful one — copy `requests/fleet-summary.json`, set
`batch_email.summary` to `false`, keep `summary_pdf: true`, then:

```bash
npm start sme_report -- ./requests/<your-copy>.json
```

**Do not run `requests/fleet-summary.json` as-is** — it emails three real
people.

---

# Output format — please follow this exactly

Your response gets pasted back into another agent's context verbatim, so make
it self-contained and paste-safe. No preamble, no restating this document.

Start with one line:

`VERDICT: <SHIP | SHIP WITH FIXES | DO NOT SHIP> — <one clause why>`

Then a `## Findings` section, **ranked most severe first**. For each:

```
### F<n> — <short claim, under 15 words>
- **Severity**: blocker | major | minor | nit
- **Location**: <path>:<line>
- **Claim**: one sentence stating the defect.
- **Failure scenario**: concrete inputs or state → the wrong output. Name real
  values. If you cannot construct one, say so and downgrade the severity.
- **Fix**: the specific change, with a code snippet if it is short.
- **Confidence**: high | medium | low — and what you did to check (read the
  code / traced a path / ran the script / could not verify).
```

Mark taste-level items `nit` and keep them to two lines. **Do not pad the
list** — "None." is a valid, useful answer. Report only what you verified
against the actual code; if you are inferring, say so in Confidence.

Then:

- `## Checked and clean` — which areas you examined and believe are correct.
  Be specific; a clean verdict on a named area is real signal here.
- `## Answers` — A, B, C above, a short paragraph each, with a recommendation
  rather than a survey of options.
- `## Test gaps` — concrete cases `check_fleet.js` should cover and does not.
  Pay particular attention to assertions that could be self-fulfilling.
- `## Ran` — exactly which commands you executed and their result, or
  "did not execute anything" if you only read code. The receiving agent will
  weight your findings by this.

---

# Round 1 outcome

All six findings were reproduced and fixed. Reproductions confirmed each one
before any code changed; the same probes now return the corrected values.

1. **F1 — quench could disappear (blocker).** `quenched` was distilled but
   never consumed. A quenched magnet with normal pressure classified
   `stable / healthy` and the word "quench" appeared nowhere. Quench is now an
   **overlay** on the archetype rather than a value of it: `is_attention()`
   and `is_urgent()` both honour it, quenched systems sort to the top of the
   attention list with the reason "quench state recorded in the window", and
   the helium cell reads QUENCH in red.
2. **F2 — historical breaches counted as urgent.** `threshold_exceeded` fires
   on the window's peak. Urgency is now computed from the **current** reading
   (`is_urgent`: unrecovered stop, quench, or a live breach), and the reason
   is built from the peak or window minimum that actually triggered the
   classification — it used to quote the current band state and print
   "he pressure within its alert band" as the reason a system needed
   attention. Live effect: the urgent set changed composition, dropping a
   settled breach and picking up a system currently reading below its floor.
3. **F3 — missing compressor data could render ON.** `compressor_on === null`
   now reads "no data" unconditionally. Additionally, only events with
   observed OFF readings count as history, so a hand-supplied `event_window`
   can no longer contribute "1 evt · 0.0h" on a system with no compressor
   channel.
4. **F4 — failure ids were ellipsised away.** Groups now expand into rows of
   six ids each, with the shared reason stated once. The 17-system fixture
   renders all 17 ids; a test asserts every input id appears.
5. **F5 — low-only threshold read as a breach.** `band_state` requires both
   lines (a single-sided config is not a band), and the new
   `breach_direction()` tests each line independently, so nothing is compared
   against a null.
6. **F6 — summary-only could succeed with no deliverable.** `summary_only`
   now requires `batch_email.summary_pdf` at load time, and a fleet-render
   failure is fatal in that mode instead of sending the thin email alone.

**Two test fixtures were wrong, which is worth its own note.** The synthetic
`pressure`/`helium` objects lacked `all`, and the synthetic events lacked
`off_count` — both fields that real `metric_facts` and `build_compressor_events`
output always carry. The fixtures had drifted from the shapes they stand in
for, which is exactly the gap your "preserve a sanitized snapshot of real
distilled records" item points at. They now match the real shapes.

**New tests:** quench overlay (attention, urgency, sort order, rendering);
urgent-vs-listed for eased and live breaches on both the high and low side;
single-sided threshold matrices for `band_state` and `breach_direction`; every
failure id surviving to the page; null compressor state with an event present;
and breach rendering keeping the percentage where one exists.

**Still open — your test-gap list is not yet closed.** In particular the
163-system fixture still produces only ~5 attention rows, so
`ATTENTION_FIRST_PAGE` and continuation geometry are exercised by the live
run and not by the suite, and there is still no sanitized real-record
snapshot. Answers A and B (whole-window-off events, implausible telemetry)
are unimplemented design questions, not defects, and are being carried to the
user.
