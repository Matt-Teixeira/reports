# Code Review Request — ENVIRONMENTAL (EDU) section + per-system probe diagnosis

You are reviewing **uncommitted working-tree changes** on branch `DEV` of this
repo (`/home/matt-teixeira/hep3/reports`). Review with `git diff` plus the one
untracked file (`requests/scoped-test-piedmont.json`). The prior series
(summary restyle, customer ids, per-section widths, chart label layout) is
already committed as `7bb49e8`, `e40ce4e`, `528f8a4`, `5d2e8ec` — its handoff
with three review-round addenda is `REVIEW-HANDOFF-VISUAL-REFRESH.md`. Your
findings will be handed back verbatim to another assistant to fix, so make
each one self-contained and reproducible.

## What this codebase does

Generates customer-facing "Magnet Health" PDFs for ~163 MRI magnets from
Postgres telemetry: one-page per-system briefs, and a multi-page summary
document (internal fleet variant + scoped customer variant, one codebase).
The costliest bug class is one that **silently misstates or omits a system's
state**; the second costliest is **geometry** — `.page` is fixed 8.5×11in with
`overflow:hidden`, so overflow clips without error.

## What this series does

Product direction: the summary document stays a **clean, representative
dataset**; the per-system brief carries **machine-specific diagnosis**.

| Change | Where |
|---|---|
| **ENVIRONMENTAL (EDU) section** in the summary: every analyzed system whose EDU hardware (`config.edu` → `edu.v1/v2/v3`) reported this period, one vendor-agnostic table (room temp, humidity, probe 0/1, °F / %RH), hottest room first, last reading over period range, no judgments (no thresholds exist) | `compute/summary_facts.js` (`edu` block), `render/fleet_model.js` (`edu_section`, reserve ladder, `page_count`), `render/fleet_page.js` (`edu_cell`, `SECTION_W.EDU`, page loop, legend entry) |
| **EDU plausibility screen**: readings outside physical bounds (`edu_temp_f` −40..150 °F, `edu_humidity_pct` 0..100) dropped before stats, counted per channel | `compute/plausible.js` (new bounds), `render/model.js` (`edu_channel_stats`, screened `alarm_room_temp`) |
| **Brief DATA NOTES names probe findings per channel**: clean range + "(N implausible readings excluded)"; all-garbage → "no plausible readings (N excluded) — sensor fault likely"; silent → "no readings this period". Two clean probes keep the old compact "probes A–B / C–D °F" form | `render/narrative.js` |
| Test batch grew to 10 systems with `summary`/`summary_pdf` enabled; a scoped Piedmont test request added | `requests/batch-test-6.json`, `requests/scoped-test-piedmont.json` |

The fleet record keeps only `edu.rejected` as a TOTAL; the per-channel split
exists only where the diagnosis is stated (the brief).

## Where to look hardest

1. **The reserve ladder gained a head** (`fleet_model.js`). The EDU section
   renders after the vendor sections, so when it exists it ends the document
   and takes the `LEGEND_ROWS` reservation. The code claims "an EDU section
   can only exist when vendor sections do" (its members are a subset of
   analyzed rows). Attack that: a record whose `vendor_key` matches none of
   the four `SECTIONS` entries would sit in NO vendor section while still
   able to carry `edu`. Today `resolve_vendor` can only produce the four
   known keys — verify that, because if the claim fails, exclusion
   ride-along placement (`failure_pages.length && sections.length`) and the
   ladder both mis-place the legend.

2. **The fixture-uniqueness page arithmetic is still hand-summed**
   (`check_fleet.js`, `first_section`). This series fixed its omission of
   `data_issue_pages` (it balanced only by coincidence before), but
   `exclusion_pages` is *still* not in the formula — fine today because the
   163-record fixture carries no exclusions, and silently wrong the day
   someone adds them. Consider whether it should be derived from the model
   (`page_count` minus section pages) instead of summed by hand.

3. **The bounds themselves** (`plausible.js`). −40..150 °F is deliberately
   loose so only the absurd trips it: a live probe reading 121–129 °F
   (equipment-adjacent) survives, a −196.6 °F open-input default dies. If
   you can name a legitimate machine-room reading outside these bounds, or
   garbage inside them that matters, say so. Note the wording contract:
   the brief says "implausible", NOT "open-sensor" — the screen knows a
   reading broke bounds, not why (a shorted 200 °F probe trips the same
   bound). Check nothing reintroduces the causal overclaim.

4. **Property-order dependency** (`render/model.js`). `edu_rejected` is
   mutated by the four `edu_channel_stats` calls evaluated inside the
   object literal, then read by the `rejected` property below them. JS
   guarantees property evaluation order, but a reorder (alphabetizing,
   destructuring refactor) silently zeroes the counts. Cheap to harden if
   you think it's worth a finding.

5. **DATA NOTES growth vs the one-page budget.** The annotations lengthen
   the EDU line; density tiering (`COMPACT_AT`) counts card bodies, so the
   mechanism absorbs it, but **no measured page fixture renders the
   worst-case annotation string** (three faulted channels at once). The
   maximal fixtures' EDU is clean. If you think the worst case can tip a
   page past the footer, demand a fixture.

6. **Both summary variants gained the section** — internal fleet AND the
   scoped customer document (same code path, deliberate). The summary
   EMAIL body was deliberately NOT touched (it lists conditions only).
   Push back if either call seems wrong.

7. **Sorting and null shapes** (`fleet_model.js` `edu_members`). Sort is
   room-temp-last desc with `-Infinity` for a null channel, tie on system
   id. Channel cells dash on null. The fixture covers probe-less,
   humidity-less, and wide-range shapes — check the sort is stable and
   that a row with NO room temp but live probes lands sensibly (bottom).

## What I verified, and how

All five checks pass:

```
node sme_reports/dev/check_scope.js
node sme_reports/dev/check_config.js
node sme_reports/dev/check_compute.js
node sme_reports/dev/check_chart.js    # EDU screen + all three annotation shapes
node sme_reports/dev/check_fleet.js    # 14 pages; EDU table through the measured geometry pass
```

`check_fleet`'s 163-record fixture gives every 5th record EDU data; the
rendered EDU table goes through the Chromium geometry pass (row clipping,
protected columns, footer/legend margins). Live renders against production
data, screenshotted and eyeballed:

| Document | Result |
|---|---|
| 10-system batch summary (`requests/batch-test-6.json`) | EDU section lists the 9 EDU-equipped systems; SME19034's probe ranges clean after the screen (were −196.6-poisoned before it) |
| SME19034 brief | DATA NOTES: "probe 0 58.1–76.4 °F (19 implausible readings excluded) · probe 1 71.8–129.4 °F (30 implausible readings excluded)" — the diagnosis the fleet table deliberately omits |
| Scoped Piedmont HealthCare summary | EDU section renders in the customer variant |

## Deliberately not done

- **No stuck/flatline or probe-vs-room divergence detection.** Those need
  domain-reviewed heuristics; only the unambiguous findings ship (bounds
  breach, silent channel).
- **No thresholds/coloring on EDU channels.** None are configured; the
  section states, the legend says so.
- **The EDU section has no per-row capture counts or source table** — the
  brief's DATA NOTES carries counts; the fleet row stays lean.

## Review round 1 (codex) — outcome

Two findings, both fixed and re-verified (all five suites green):

1. **P2 — stale EDU values were indistinguishable from current readings.**
   `edu_channel` now keeps `last_t`; a channel whose last plausible reading
   is >24h before the period end (the brief tiles' existing staleness line)
   is a different claim everywhere it appears: the fleet cell dims and
   carries "as of <day>" in place of the range, the hottest-room sort
   demotes stale rooms to rank with the unknowns (an old hot reading can no
   longer top the HVAC list), and the brief's DATA NOTES appends
   "stopped <day>" — sharing one parenthetical with the exclusion count,
   and breaking the compact combined-probes form so the finding names its
   probe. Fixtures: check_fleet record 10 carries the page's HOTTEST room
   reading five days stale — it must sort below every fresh room and render
   its as-of date; check_chart adds an early-stopping room channel, and its
   pre-existing fixtures (whose EDU data genuinely ends >24h before their
   windows) now truthfully carry "stopped" clauses through the measured
   geometry.
2. **P3 — the older handoff quoted the rejected causal wording.** The
   visual-refresh addendum now quotes the implemented strings and states
   the "implausible, never open-sensor" contract with its rationale,
   pointing here.
