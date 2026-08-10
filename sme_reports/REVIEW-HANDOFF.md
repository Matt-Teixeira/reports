# Code Review Request — compressor multi-event clustering

> **STATUS: rounds 1 and 2 complete, all defects fixed.** Three review passes
> have run; every finding is fixed in the working tree and the sections below
> describe the current code. See the outcome sections at the bottom before
> re-reviewing, so you review what is there now rather than what was there
> then.

You are reviewing an uncommitted change on branch `DEV` of this repo
(`/home/matt-teixeira/hep3/reports`). Everything under review is in
`git diff` (11 files, ~570 insertions). Nothing is committed, so
`git diff` alone is the complete change set.

Read `sme_reports/RULES.md` (detection rules) and `sme_reports/HANDOFF.md`
(project state) for context. **There is no test framework** — the two check
scripts under `sme_reports/dev/` are plain `node:assert` and are the test
suite.

## What this codebase does

Generates single-system "Magnet Health Brief" PDFs for MRI magnets across four
vendor variants (Philips, GE, Siemens TIM, Siemens non-TIM). Each vendor's
compressor signal is normalized upstream in `data.js` into a boolean
`compressor_on` per capture row; everything downstream is vendor-agnostic.
These are **customer-facing** documents, so overstating or understating a
fault is the most costly class of bug here.

## The bug being fixed

`build_compressor_event()` in `compute/events.js` spanned **first stop → last
recovery across the entire report window**, collapsing separate incidents into
one event. After the default window moved to 30 days this began misfiring on
live systems. On SME01403: five off-runs spread over three weeks (~54.5 h of
real downtime) rendered as a single **518 h** event — a 9.5× overstatement —
which also collapsed the baseline to a single day and shaded most of the chart
orange. Separately, the field named `off_hours` was measuring *span*, not off
time.

## What the change does

1. `build_compressor_events(real_runs, {gap_ms, interval_ms})` replaces
   `build_compressor_event`. Real off-runs separated by more than
   `EVENT_GAP_MS` (48 h) of ON time become **separate events**.
2. `select_primary_event(events)` picks the one the report anchors on: an
   open (ongoing) event always wins; otherwise the largest `off_hours`, ties
   to the most recent. It returns the **same object reference** from the
   array — callers identify "other" events by identity (`ev !== primary`).
3. `off_hours` is summed off time per run: each run's reading span plus one
   median capture period (`median_interval_ms` in `compute/series.js`),
   that period capped at the actual time to recovery. Never measured to the
   next ON reading, and never past the last reading plus one period.
4. `model.js` exposes both `facts.compressor_event` (primary; anchors
   metrics, archetype, tile, narrative) and `facts.compressor_events` (all,
   chronological). Both charts shade every event.
5. `metric_facts(points, event, {other_events})` excludes points inside any
   *other* event's window + the existing 24 h thermal lag from the baseline,
   and yields a **null** `baseline_value` (plus null delta and rate) when
   exclusion leaves nothing clean.
6. Tile appends "+N other events"; narrative adds one summary sentence, drops
   a now-false "and has held since" claim, and qualifies the baseline range.
7. `describe_event_window()` fills a request-supplied `event_window` override
   with counts and duration recounted from the readings inside it, clipping
   runs that cross either boundary. A window with no OFF readings is not
   classified as a compressor stop.

## Deliberate decisions — do NOT report these as bugs

- **48 h gap threshold** is a judgment call, not derived. Argue with it if you
  think it's wrong, but flag it as a design question, not a defect.
- **`off_hours` is each run's reading span plus one median capture period.**
  Two rejected alternatives: measuring to the next ON reading inflated
  SME01403's "other events" total from 14.5 h to 73.5 h on sparse cadences;
  measuring reading-to-reading scored any single-reading run at zero. The
  current rule reproduces SME01403's known ground truth exactly (40.0 h
  primary, 14.5 h across the others, 54.5 h total). The trailing period is
  capped at the time to recovery so it can never exceed the stop-to-restart
  span.
- **The 4-hour-minimum rule is intentionally NOT implemented.** It is awaiting
  a human decision. It would slot into `classify_compressor_runs` as a per-run
  duration test. Do not implement it; do flag anything in the new code that
  would *block* adding it there later.
- **Out of scope entirely**: parallel PDF rendering, archive growth policy,
  `npm test` wiring, the flicker-footnote decision, the summary-email part
  column. All are listed in `HANDOFF.md` as separate work.
- The summary email still reads "compressor stop — recovered" (singular) for a
  multi-event window. Known and accepted for this change.

## Where I most want your eyes

Report what you actually find, and say plainly which areas you examined and
believe are correct — a clean verdict on an area is useful signal here, not
filler.

1. **Clustering correctness** in `build_compressor_events`. Off-by-one on the
   gap comparison, the `prev.recovered_t || prev.end` fallback, whether a
   non-trailing run can ever lack `recovered_t`, and whether the
   capture-period term can double-count on irregular cadences.
2. **`select_primary_event` assumes only the last cluster can be open.** Is
   that invariant actually guaranteed by `find_off_runs`? If it can be
   violated, an ongoing stop could be silently demoted — the worst outcome
   this report can produce.
3. **Null-safety of the primary/list split.** `narrative.js
   baseline_sentence` dereferences `ev.start` inside a `.some()` callback and
   relies on `compressor_events` being `[]` exactly when `compressor_event` is
   null. Verify that invariant holds on every path, including the
   `request.event_window` override and all five archetypes.
4. **Null-baseline propagation** in `metric_facts` and its consumers. Every
   path that reads `baseline_value`, `delta_vs_baseline`, or `rate_per_hr`
   must tolerate null without rendering "—" where a number is load-bearing,
   or silently reading a null as zero.
5. **Single-event regression.** A window with one event must render
   essentially as before. Chart geometry should be byte-identical; only
   `off_hours` should shift.
6. **Anything the tests assert that is now wrong.** I rewrote assertions in
   `check_compute.js` that previously encoded the merge behavior. Verify the
   new numbers are actually right rather than just self-consistent — I could
   have written a test that agrees with a bug.

## Open questions I want an opinion on

- **A.** Primary selection ranks by off-hours. Should it rank by *severity*
  instead (peak pressure response), since the "EVENT PEAK" tile and the ramp
  rate are scoped to the primary event only? A short-but-hotter event
  currently loses to a long-but-cold one, and its peak then appears nowhere
  in the tiles. On SME01403 the longest event also had the peak, so this did
  not surface. Is that a real risk or a theoretical one?
- **B.** Is 48 h defensible as a single fleet-wide constant, or should the gap
  scale with capture cadence (which varies by vendor and by system)?
- **C.** *(Resolved in round 1 — "most significant" is gone; the story now
  says the timeline covers the primary event and the others are summarized.
  Re-open only if the new wording still overclaims.)*

## How to verify

```bash
node sme_reports/dev/check_compute.js    # compute-layer assertions
node sme_reports/dev/check_chart.js      # render checks + synthetic pages
```

Both pass on the current tree. The chart script writes eyeball-able pages to
`sme_reports/out/dev-synthetic-*.html`, including a new
`dev-synthetic-multi-event` fixture.

Live regeneration requires DB access and takes ~6 s/report:

```bash
npm start sme_report -- ./requests/sme01403.example.json   # multi-event case
npm start sme_report -- ./requests/sme19034.example.json   # single-event sentinel
```

SME01403 should now show four distinct events (primary ~39.5 h recovered
Jul 11, plus three others totaling ~12.5 h). SME19034 should be unchanged from
before this diff apart from at most a half-hour shift in `off_hours`.

---

# Output format — please follow this exactly

Your response gets pasted back into another agent's context verbatim, so make
it self-contained and paste-safe. No preamble, no restating this document.

Start with one line:

`VERDICT: <SHIP | SHIP WITH FIXES | DO NOT SHIP> — <one clause why>`

Then a `## Findings` section. **Ranked most severe first.** For each:

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

If a finding is a matter of taste rather than a defect, mark it `nit` and keep
it to two lines. **Do not pad the list.** Zero findings in a section is a
valid, useful answer — say "None." Report only what you verified against the
actual code; if you are inferring, say so in Confidence.

Then:

- `## Answers` — A, B, C from above, a short paragraph each, with a
  recommendation rather than a survey of options.
- `## Test gaps` — cases the two check scripts should cover and do not.
  Concrete case descriptions, not "add more tests."
- `## Ran` — exactly which commands you executed and their result, or
  "did not execute anything" if you only read code. Be honest here; the
  receiving agent will weight your findings by this.

---

# Round 1 outcome

Two reviews ran independently (one internal, one external). Both reached
DO NOT SHIP. All findings below are fixed in the working tree.

**Agreed by both reviews, fixed:**

1. **Ongoing events accrued unobserved downtime.** Open runs were measured to
   `request.window.end`, which the loader sets to `endOf("day")` — a stop two
   hours before the last capture reported ~15 h off, most of it in the future.
   Open events now stop at the last reading; `window_end` survives only as the
   chart domain and page headers.
2. **The baseline could be a value from the window it had just excluded.**
   When exclusion consumed every clean pre-event point, `base_v` fell back to
   `all.first.v`, producing "rose from 200.0 to a peak of 45.0 mbar" on a
   warming magnet. `baseline_value` is now null in that case, with
   `delta_vs_baseline` and `rate_per_hr` dropping out with it, and the
   narrative, tiles, and chart labels all say so. `fmt.signed(null)` renders
   "—" instead of "+0.0".
3. **A test codified defect 2** (`check_compute.js`). Replaced with assertions
   that all three derived values are null.
4. **Multi-event fixture comments drifted** from the values the code produced.
   The interval fix made the comments correct; durations are now asserted.

**Found by one review only, resolved:**

5. **`off_hours` was zero for any single-reading run**, so a real cycling
   incident scored 0 and lost primary selection to a shorter stop. Fixed by
   the capture-period rule described above.
6. **A single trailing dropout can still outrank a much larger recovered
   event.** Kept deliberately — an ongoing stop leading is the same alert bias
   as rule 4 — but the story no longer calls the primary "the most
   significant", since it is the longest and not necessarily the worst.

**A defect the new tests exposed, also fixed:** a request `event_window`
override rendered "undefined readings off" and "off ~NaN h", because a
hand-supplied window carries no counts. `describe_event_window()` now derives
counts from the real runs inside the override.

**Still open — needs a decision, deliberately not implemented:** ranking
recovered events by threshold excursion rather than duration (question A).
The external review recommended it; it needs an event-local peak per candidate
before selection. Today the EVENT PEAK tile and ramp rate are scoped to the
primary, so a short-but-hotter event's peak appears nowhere.

**New tests added:** 48 h boundary (exactly 48 h clusters, beyond splits);
single-reading run duration; ongoing stop stops accruing at the last capture
while the window runs later; null-baseline propagation; both override forms
rendering with no `undefined`/`NaN`/`null`; multi-event fixture durations.

---

# Round 2 outcome

A second external pass returned SHIP WITH FIXES with two majors. Both are
fixed.

1. **The capture-period padding could exceed the observed stop.** With mostly
   hourly captures, a dense burst — OFF at 10:01 and 10:04, recovery at
   10:06 — took the 60-minute median and reported 1.05 h off for a five-minute
   event, contradicting the rule's own "never past the last reading" claim.
   The trailing period is now capped at the actual time to recovery
   (`run_off_ms` in `compute/events.js`); the reproducer now returns exactly
   the 5-minute span. An unrecovered run has nothing to cap against and still
   takes the full period.
2. **The override ignored runs crossing its boundaries.** `describe_event_window`
   selected runs by start time alone, so a run starting before the window was
   dropped entirely and one running past the end was charged in full. It now
   re-counts off readings from the series within the clipped interval and caps
   duration at both boundaries. The reproducer went from 1 cycle / 8 readings
   / 8 h to 2 cycles / 9 readings / 9 h, all hand-verified.

**Also fixed, from the same review's test gaps:** an override window with no
OFF readings previously implied a measured "~0.0 h" stop. `classify()` no
longer returns a compressor-stop archetype for an event with zero observed off
readings, and the tile says "no OFF readings in the specified event window".

**Test gaps closed:** irregular-cadence cap; runs crossing the override start
and end; empty override window; `median_interval_ms` convention on an even
number of unequal gaps; a full-page render with null pressure and helium
baselines asserting no tile, marker, story, or card carries an implicit zero;
and pinned single-event rect geometry.

**Still open — the one deliberate deferral:** ranking recovered events by
threshold excursion rather than duration (question A). Both external passes
recommended it. It needs an event-local peak per candidate before selection,
which is a design change rather than a defect fix.
