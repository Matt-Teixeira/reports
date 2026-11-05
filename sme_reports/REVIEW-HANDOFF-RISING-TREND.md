# Review Request — "pressure rising" judged on a fitted trend

You are reviewing **uncommitted changes** in the working tree of branch `DEV`
of this repo (`/home/matt-teixeira/hep3/reports`), against HEAD `2e060cb`.

The working tree carries **two** uncommitted changes. This handoff covers
only the rising-rule change. See it with:

```
git diff 2e060cb -- sme_reports/compute/ sme_reports/render/narrative.js \
  sme_reports/dev/check_compute.js sme_reports/RULES.md
git diff 2e060cb -- sme_reports/render/fleet_model.js   # first two hunks only
```

**What is out of scope here:**
- The other change is explicit date-time report windows. It has its own
  handoff, `sme_reports/REVIEW-HANDOFF-DATETIME-WINDOWS.md`. Its files
  include `request_loader.js`, `periods.js`, `index.js`, `oneoff/*`,
  `render/model.js`, `render/chart.js` and `output/*`.
- In `render/fleet_model.js`, the `meta.window_span` hunk belongs to the
  windows change.
- `oneoff/jobs.config.json` and the untracked files at the repo root are
  unrelated.

This is a **correctness review**. The report owner made these decisions;
they are not under review:
- replace the old rule with a trend-based one;
- the thresholds (10% of headroom, r² ≥ 0.5);
- a spike that returns to normal is **not** reported.

What is under review:
- does the implementation do exactly that;
- does it leave every other verdict unchanged;
- can it misjudge an input the fleet probe didn't contain?

`sme_reports/RULES.md` is the spec, and this change edits §2 and the
"Trend wording" row of §4. Prior review rounds are in
`sme_reports/REVIEW-HANDOFF-*.md`.

## What the codebase does (one paragraph)

`sme_reports/` generates "Magnet Health" documents for MRI magnets from
Postgres telemetry:
- a one-page per-system **brief**;
- a multi-page **summary** whose **Needs Attention** list is the headline
  product.

Each system gets one **condition** (archetype), priority-ordered in
`compute/archetype.js`: compressor stop ongoing → stop recovered →
threshold exceeded → **pressure rising** → stable. Everything but stable
counts as attention (`conditions.js`).

The rules run on raw readings from `mag.*`/`edu.*`. Alert lines come from
`alert.models` (default rows) with OEM fallbacks. `alert.detections` is
**not** used by classification.

Vendors differ on pressure:
- **Siemens 4K** reports **absolute** PSIA (~15.3 at rest, band 14.4–16.4).
- **GE** reports gauge PSI (~1–3, line 5.2).
- **Philips** reports mbar (line ~80).

## The defect being fixed

**The old rising rule** (`archetype.js`): `rate_per_hr > 0.001` **and**
`last ≥ 0.6 × high_gt`. For a window with no compressor event, `rate_per_hr`
(`metrics.js`) is:

```
(window max − first reading) / hours from first reading to the max
```

**Why it is wrong:**
1. It can never be negative, so any wobble counts.
   - SME12471 went 15.30 → 15.31 PSIA in hour one and was then flat:
     "0.01/hr".
2. The 0.001/hr epsilon is in native units, so it means different things
   on PSI and on mbar.
3. 60% of 16.4 is 9.8. On absolute pressure the gate is always passed.
4. On gauge pressure it fails the other way: SME15804 climbed 1.03 → 2.43
   PSI over 30 days (r² 0.91) but never reached 3.12.

**Measured on the live fleet** (147 systems, rolling 30 days): the old
rule flagged 12, all flat Siemens magnets, and missed SME15799 and
SME15804.

## What changed

**`compute/metrics.js`**
- New `linear_trend(points)` computes a least-squares fit over every
  screened reading in the period. Time is centered and in hours.
- It returns `{ slope_per_hr, span_hours, fitted_rise (slope × span),
  fitted_start (fit value at the first reading), r2 }`.
- It returns null with fewer than 3 points, a span under 1 h, or zero time
  variance.
- `metric_facts` now also returns:
  - `trend`, the fit above;
  - `event_scoped`, which is `!!event`.

**`compute/judgments.js`**
- New `steady_rise(pressure, thr)`. With
  `headroom = thr.high_gt − trend.fitted_start`, it returns
  `{ rise, hours, share }` only when **all** of these hold:
  - `high_gt` is set;
  - `headroom > 0`;
  - `fitted_rise ≥ 0.10 × headroom`;
  - `r2 ≥ 0.5`.
- Constants: `RISING_HEADROOM_SHARE = 0.1` and `RISING_MIN_R2 = 0.5`.
- `trend_of(pressure)` is the tile wording and the fleet ↑/↓. New order:
  1. Without an event, a `steady_rise` returns "rising". This is checked
     **before** "easing", so a rising system can't show ↓.
  2. "Easing": last < 99.5% of peak. Unchanged.
  3. With an event, a positive event-ramp `rate_per_hr` returns "rising".
     Unchanged. This keeps the left-censored warm/no-signal verdict
     (`summary_facts.js` `warm_corroborated` reads
     `primary_trend === "rising"`) on its existing path.

**`compute/analyze.js`** (line ~267)
- After `metric_facts`, it sets
  `pressure.steady_rise = compressor_event ? null : steady_rise(pressure, thr)`.
- This is computed once. The classifier, tiles, arrows and summary record
  all read it.

**`compute/archetype.js`**
- The rising branch is now just `pressure && pressure.steady_rise`.
- The old constants are removed.

**`compute/summary_facts.js`**
- The record gains `primary_rise` and `primary_rise_hours`. Both are
  additive, and null unless there is a steady rise and the reading is
  plausible.

**Wording**
- `render/fleet_model.js` `attention_reason`: a rising row reads
  `he pressure up 1.056 PSI in 31 days, now 2.453`. Older records without
  `primary_rise` keep the old wording.
- `render/narrative.js` `pressure_rising` lead: "…is climbing steadily —
  up 1.056 PSI over 31 days."

## Evidence (live, dev VM; read-only; you can't reproduce this without the DB)

**Full-record diff over the fleet:** HEAD code (via `git stash`) vs this
change, rolling 30 days, 147 systems, comparing every system's summary
record.

| Field | Changed | How |
|---|---|---|
| archetype | 14 | 12 `pressure_rising → stable_healthy` (all Siemens); SME15799 and SME15804 `stable_healthy → pressure_rising` |
| primary_trend (arrow) | 18 | `rising → null`, all flat systems |
| offline_kind | 0 | |
| is_data_issue | 0 | |
| is_urgent | 0 | |
| is_attention | 14 | the archetype moves above; total 48 → 38 |

**Candidate rules tried before this one**, on two windows (rolling 30 days;
Oct 25–31 ET):
- the fitted slope with the old 60% gate: 0 rising (also misses the GE
  climbers);
- ≥5% of headroom: 5–6 rising;
- ≥10%: 3–4 rising;
- **≥10% with r² ≥ 0.5: SME15799 and SME15804 in both windows.**

**Systems whose peak approached the line but returned** now drop off the
list. This is the owner's decision.
- SME08716: peak 16.22 against 16.4.
- SME22365: peak 15.99.

## Invariants that must hold

- **Only the no-event rising judgment changed.** Every compressor-stop,
  threshold, offline (warm/no_signal), data-issue, quench and urgency
  verdict is identical for every input.
- **One answer.** The condition, the tile word, the fleet arrow, the
  record's `primary_rise` and the story lead can never disagree about
  whether a system is rising.
- **Never silent.** A system leaves the attention list only because its
  readings are flat or return to normal. A missing or degenerate fit must
  not quietly suppress a system the spec says is climbing.
- **Vendor neutrality.** The same rule gives the same meaning on absolute
  PSIA, gauge PSI, mbar and shield temperature (Siemens 10K primary).
- **Older archived records** (no `primary_rise`) still render.

## Where to look hardest

1. **Silent suppression.** Find inputs where a genuinely climbing magnet
   now reads stable:
   - a data gap mid-period, so the fit runs over uneven spacing;
   - a step change (flat, jump, flat): r² may be under 0.5 even though
     the level really moved;
   - a climb only in the last few days of 30, which is a small share of a
     whole-period fit;
   - a climb that began before the period (`fitted_start` already high,
     so headroom is small and the share is large — is that right?);
   - quantized readings (Siemens 0.01 steps);
   - implausible readings: screened before the fit (`analyze.js`
     `screen`)?
2. **Spurious rises.** The windows change lets an operator ask for a
   1-hour to few-day window. On short spans, can noise or a daily cycle
   produce r² ≥ 0.5 and ≥10% of headroom?
   - Consider GE diurnal swings and Philips mbar noise.
   - Is a minimum span or minimum absolute rise needed?
3. **The `event_window` override.** With a hand-supplied `event_window`
   containing **no** OFF readings, `compressor_event` is non-null with
   `off_count === 0`:
   - `classify` skips the stop branches (it is "not observed");
   - `analyze` sets `steady_rise = null` because `compressor_event` is
     truthy.

   Under HEAD such a system could still be "rising"; now it cannot. Is
   that reachable outside dev overrides, and should the guard use the
   classifier's `observed` predicate instead?
4. **`trend_of` order.** The no-event `steady_rise` check now runs before
   "easing". Confirm no event-scoped input changes word, and that the
   brief tile (`render/tiles.js` `trend_word`) and the fleet arrow
   (`render/fleet_page.js:296`) read the same function.
5. **`headroom` edge cases.**
   - `fitted_start` above `high_gt` while the readings stay under it: can
     a fit extrapolate there?
   - `high_gt` null with only `high_lt` (low-line-only configs): never
     rising. Is that right?
   - `med_gt`-only configs fall back to the OEM line (`thresholds.js`).
6. **Wording.** `fmt.num` decimals per vendor. "31 days" for the rolling
   30-day period: it is accurate, since the period is 30 days back from
   midnight plus today. `span_words` under 48 h. Any path where
   `primary_rise` is set but the row isn't `pressure_rising`? `analyze`
   nulls it with an event, and threshold_exceeded outranks rising.
7. **Numerics** in `linear_trend`: centering, `sxx === 0`, and
   `syy === 0` returns r² 0.

## How to run (all DB-free; all pass at handoff)

```
cd /home/matt-teixeira/hep3/reports
npm run -s check:compute        # new block: "pressure rising: a steady climb toward the line"
npm run -s check:chart          # Chromium; its SME99013 rising fixture still classifies rising
npm run -s check:fleet          # Chromium
npm run -s check:system-pages   # Chromium
npm run -s check:oneoff
npm run -s check:scope
npm run -s check:config
```

The new assertions in `check_compute.js` are modelled on the live shapes:

| Fixture | Expected |
|---|---|
| SME12471 blip | old rate fires; new rule says stable, no ↑ |
| SME08716 spike to 16.22 | stable |
| SME15804 steady GE climb | rising, rise ≈ 1.4, share 0.3–0.4 |
| rising with last dipped 1% under the peak | still "rising", not "easing" |
| rise under 10% of the room | not rising |
| noisy climb (r² < 0.5) | not rising |
| no upper line | not rising |
| already over the line | not rising |
| event ramp | keeps "rising" |
| `linear_trend` guards | — |

**Do not send email.** Never pass `--email`, and never run request files
carrying real recipients. Live DB access is likely unavailable to you.
Static review plus the check suites is the expected scope.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- **A spike that returns to normal is not reported.** It is reported only
  if it crosses the line (threshold exceeded). This is the owner's
  decision.
- **The thresholds are calibrated on one fleet snapshot** (two windows,
  late October 2026). They are named constants in `judgments.js`, to be
  revisited with more history.
- **"Easing" is unchanged:** last < 99.5% of peak. On flat Siemens
  magnets this can still show ↓ after a returned spike. That is accurate,
  if minor.
- **With a compressor event, the event-anchored ramp still decides.** The
  rate and the "rising" word come from it, as before. A stop always
  outranks a rise.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, with one
   sentence on why.
2. **Findings** `F1..Fn`, ordered by severity
   (`blocker`/`major`/`minor`/`nit`). Each one needs:
   - the file:line;
   - a concrete failure scenario (a reading series plus thresholds →
     wrong condition, wrong arrow, wrong wording, or a changed
     non-rising verdict);
   - a suggested fix;
   - your confidence. A claim you could not trace end to end gets
     `confidence: low` and says why.
3. **Verdict-isolation audit**: for each of
   - compressor stop (ongoing, recovered),
   - threshold exceeded,
   - offline warm / no_signal,
   - data issue,
   - quench,
   - urgency,

   `UNCHANGED` or `CHANGED`, with the code path that proves it.
4. **Suppression/spurious audit**: reading shapes you believe this rule
   misjudges, or `none found`, with reasoning, including short windows.
5. **Ran**: the exact commands you executed and their results.
6. **Test gaps**: behaviors you judged correct but found unasserted.

---

## Round-1 outcome (2026-11-04) — SHIP WITH FIXES; both findings fixed

Still uncommitted on `DEV` against `2e060cb`. For re-review: verify each
fix holds and that no fix introduced a new defect.

| # | Fix | Regression test |
|---|---|---|
| F1 (minor) | `compute/analyze.js`: the steady-rise judgment and the trend word now use the **classifier's own "observed stop" predicate**, `compressor_event && compressor_event.off_count !== 0`, stored as `pressure.event_observed`. `steady_rise` is null only with an observed stop. `trend_of` (`compute/judgments.js`) reads `steady_rise` first and uses the event ramp only when `event_observed`. `metrics.js` no longer emits `event_scoped`; nothing reads a second notion of "event". | `check_compute.js` "rising-trend review F1", through `analyze_system` with a Philips no-OFF `event_window`: (a) a steady climb is not an observed stop, classifies `pressure_rising`, and the trend word is "rising"; (b) a ramp inside the override that comes back down is not `pressure_rising` and has no "rising" word, although its override ramp rate is positive. **Confirmed to fail with the fix disabled** (`event_observed = !!compressor_event` → `AssertionError: no OFF readings: not an observed stop`) |
| F2 (minor) | `compute/judgments.js`: `RISING_MIN_SPAN_HOURS = 24`. A fit over less than a day of readings is never a steady rise. Short explicit windows still report stops and breaches. RULES.md §2 records the minimum and the reason. | `check_compute.js`: Codex's case (16.35/16.36/16.37 PSIA within an hour, r² > 0.9) is not a rise; a 23.5 h steady climb is not; a 24 h one is |

**Fleet re-check** (live, dev VM, rolling 30 days, 147 systems):
- Every system's archetype, trend word, offline kind, attention, data-issue
  and urgency is **identical** to the version reviewed in round 1.
- Only `primary_rise` changed, on SME01404 and SME11139. It is now null:
  both are `compressor_stop_recovered`. This is the intended
  observed-stop guard, and neither one's wording or verdict changed.

Not findings (sandbox limits, as in earlier rounds):
- Chromium could not launch (`setsockopt`), affecting check_chart and
  check_system_pages.
- `zip` EPERM affected check_config.
- The `check_fleet.js` CLI fatal-exit assertion needs the app's DB
  environment.

All seven suites pass on the dev VM after these fixes.
