# Review Request — EDU-primary compressor state, scanner backup, EDU-off annotation

You are reviewing **uncommitted changes** in the working tree of branch `DEV`
of this repo (`/home/matt-teixeira/hep3/reports`), against HEAD `2e060cb`.

The working tree carries **three** uncommitted changes. This handoff covers
only the compressor-source change. The other two have their own handoffs
and are out of scope:
- trend-based "pressure rising": `REVIEW-HANDOFF-RISING-TREND.md`;
- explicit date-time windows: `REVIEW-HANDOFF-DATETIME-WINDOWS.md`.

Several files carry hunks from more than one change. The hunks in scope are
listed per file under "What changed"; ignore the rest. Also out of scope:
`sme_reports/ct/` (unrelated work in progress), `oneoff/jobs.config.json`,
and the untracked files at the repo root.

This is a **correctness review**. The report owner made these decisions;
they are not under review:
- the EDU vibration sensor (`comp_vib_status`) is the primary compressor
  source on every vendor;
- the vendor channel is a **per-reading backup** where the EDU is silent:
  Philips `cryo_comp_malf_value`, Siemens 4K `compressor_status`, or the GE
  coldhead inference;
- an EDU "off" is **never overruled**. The stop is stated and stays a stop
  (listed; urgent when unrecovered), then **typed** from the other data:
  confirmed, unconfirmed, or "may not be off";
- the System Activity page explains each type with its evidence;
- the constants: 45 min coverage, the flicker rule's 2% of limit within
  2 h, and the existing coldhead warm bars (GE 10 K, Siemens 55 K).

What is under review:
- does the implementation do exactly that;
- does it leave every other verdict unchanged;
- can it misjudge an input the fleet probe didn't contain?

The spec is `sme_reports/RULES.md` §1 (the paragraphs after the vendor
table), the ᶜ section, the provenance row "EDU-primary priority" and the
"One-page density" row. The team's rule set is
`docs/MAGNET-HEALTH-DATA-AND-RULES.md` §5.1 and §8.

## What the codebase does (one paragraph)

`sme_reports/` generates "Magnet Health" documents for MRI magnets from
Postgres telemetry:
- a one-page per-system **brief** (PDF/HTML);
- a multi-page **summary**, fleet-wide or per customer, whose **Needs
  Attention** list is the headline product;
- an optional **System Activity** HTML app (`incident/`) that plots the
  readings beside the alerting engine's detections and notifications.

Each system gets one condition (archetype), priority-ordered in
`compute/archetype.js`: compressor stop ongoing, stop recovered, threshold
exceeded, pressure rising, stable. Compressor stops come from off-runs in
a compressor-state stream (`compute/events.js`): two or more consecutive
off readings make a stop, and a single one is a flicker unless pressure
responds. The separate alerting engine (not in this repo) writes
`alert.detections`; its default compressor model on every system watches
the EDU only (`comp_vib_status equals false`).

## The defect being fixed

SME19528, Oct 26 2026. The Siemens status text read OFF for an hour while
the EDU read running. The report, which preferred the scanner channel,
showed a stop no alert could see. The status text then froze for four days
(one repeated `host_datetime`) while the EDU and the alerts kept reporting.
The owner then made the EDU primary, with the scanner as a backup where the
EDU is silent, and asked that an EDU "off" be stated but annotated when
other data disputes it.

## What changed

| File | In scope |
|---|---|
| `compute/analyze.js` | The compressor block: the per-reading merge (`edu_comp_rows`, `vendor_stateful`, `fresh`, `edu_near`, `backup_rows`); the corroboration block before `select_primary_event` (`stale`, `ctx` with its `*_stale` arrays, `in_real_run`, `off_rows`); the facts `compressor_backup`, `compressor_last_source`, `compressor_corroboration`, `compressor_secondary_label`, `compressor_secondary_running`; `views.secondary_compressor` |
| `compute/corroborate.js` | New file, all of it |
| `compute/provenance.js` | `comp_inferred` |
| `compute/summary_facts.js` | `compressor_backup`, `compressor_corroboration`, `primary_event.corroboration` |
| `index.js` | The `activity` payload only: the compressor rows' `b` flag, `compressor_stops`, `compressor_secondary_label`, `secondary_compressor` |
| `render/narrative.js` | `comp_via`, `comp_c`, `corrob_note`, and the four story leads that call it |
| `render/tiles.js` | The `comp_inferred` import and use; the suspect-banner compressor check (`compressor_last_source`) |
| `render/fleet_page.js` | `comp_inferred` in the compressor cell; the legend entry "may not be off · unconfirmed" |
| `render/fleet_model.js` | `CORROB_PREFIX` / `corrob_prefix` and their use in `attention_reason` |
| `render/model.js` | `chart_height`: 92 → 86 on compact pages with a banner |
| `render/chart.js` | y-axis label thinning (`Y_LABEL_MIN_GAP`) |
| `incident/activity.js` | `comp_label`; slot `comp_b` and `alt`, set only when present; `sources.alt`, `sources.backup`; `a.stops` |
| `incident/system_page.js` | `alt`, `backup`, `strip_note`, the extra table header; `VERDICT`, `stop_card`, `stops_section`; the `.stop*` and `.verdict` CSS in `PAGE_CSS` |
| `incident/timeline.client.js` | `ALT*`, `BK_LBL`, `COLS`, `strip()`, `compCell`, the compressor `rule` |
| `incident/timeline.js` | One CSS rule: `svg .bk` |
| `dev/check_compute.js`, `check_chart.js`, `check_fleet.js`, `check_system_pages.js` | Assertions added or changed for this change |
| `RULES.md`, `docs/MAGNET-HEALTH-DATA-AND-RULES.md` | The spec text above |

### How it works

1. **Merge** (`analyze.js`):
   - Every EDU reading with a state is used, tagged `src: "edu_comp_vib"`.
   - A vendor reading is used only where no EDU reading lies within 45 min
     of it, and only if it is fresh: its `host_t` does not repeat the
     previous vendor reading's.
   - With no EDU readings at all, the vendor channel is the whole signal
     exactly as before. Its stale readings are deliberately kept there.
2. **Events** come from the merged stream through the unchanged
   `find_off_runs` → `classify_compressor_runs` → `build_compressor_events`.
3. **Corroboration** (`corroborate.js`) runs only when the EDU is primary,
   and only for events with at least one EDU off reading inside the event's
   **real** off-runs. Single-reading flickers inside the span are excluded.
   - `secondary`: for each EDU off reading, the nearest fresh vendor reading
     within 45 min. The result is `off` if any read off, else `on` if any
     read running, else `none`.
   - `thermal` is `warming` if either:
     - pressure rose in the 2 h after `ev.start`, measured against the
       **upper** median of the 2 h before (or the event's first 3 points),
       with ≥ 2 readings ≥ `high_gt × 2%` above it, or the only reading;
     - any plausible fresh coldhead reading during the event reached
       `warm_k`.

     It is `steady` if those windows held fresh readings, else `unknown`.
   - `type`: `confirmed` if secondary is off or thermal is warming;
     `doubtful` if secondary is on and thermal is steady; else
     `unconfirmed`.
   - `detail`: the evidence. It holds the counts (`sec_off`, `sec_on`,
     `sec_missing`, and `sec_stale`, meaning only a frozen reading was
     nearby), the pressure numbers and the coldhead numbers, with frozen
     flags.
4. **Downstream wording.** Archetype, attention and urgency are untouched.
   - The brief adds one lead sentence for doubtful and unconfirmed stops,
     and nothing for confirmed ones.
   - The summary and email reason starts "may not be off ·" or
     "unconfirmed ·".
   - The summary legend defines both.
5. **Provenance.** ᶜ applies when the primary source or a backup is the
   coldhead inference (`comp_inferred`). "Per EDU vibration sensor" names
   the backup when one filled gaps.
6. **Activity page.**
   - The Compressor strip shows the merged state, with backup slots drawn
     lighter and labelled.
   - The vendor channel, every capture, is a second strip with its own
     table column.
   - A **Compressor stops** section holds one card per EDU-reported stop:
     the type, Eastern times, one evidence line per channel, and the
     reason.
7. **Layout.** On the tightest brief tier (compact, with a banner) the
   charts went 92 → 86 px so the doubtful note fits. A y-axis whose labels
   would sit under 11 px apart labels every other gridline.

## Evidence (live, dev VM, read-only; not reproducible without the DB)

Old rule (scanner priority, swapped in memory at module load) against the
new one, whole fleet, 7 days to 2026-11-05, 137 systems:
- **Source changes.** 35 systems switch source; 4 use backup readings (GE,
  coldhead filling EDU gaps).
- **SME24237 and SME18359 go to stable.** One had a scanner stuck OFF all
  week; the other's scanner replayed a day-old snapshot seven times.
- **SME16380 and SME12152 are typed doubtful.** Their EDU read off for days
  while the coldhead held 4.2 K and pressure held.
- **SME01109 and SME15809 are typed unconfirmed.** SME01109's scanner feed
  has been frozen since Sep 1; SME15809's Philips scanner is cable-errored.
- **SME11221, SME18354 and SME20004 are typed confirmed.**
- **Every other system's condition is unchanged.**

Rendered and checked on the live 7-day fleet app (internal) and on the
Piedmont customer copy (external): every type renders, with no page errors
and no sideways scroll at 390 px. The customer copy carries no Avante staff
address.

## Invariants that must hold

- A system with no EDU readings in the period gets exactly the
  compressor stream, events and wording it had before.
- An EDU reading is never displaced by a vendor reading.
- A stale vendor reading never fills an EDU gap.
- Corroboration never changes an archetype, the attention list, urgency,
  off-hours or event count. It only adds a type and wording.
- A backup-only stop, where the EDU was silent, carries no type.
- The activity page's expected-alert rule never counts a backup reading as
  an expected compressor alert.
- No ᶜ is dropped from a state that rests on the coldhead inference.

## Where to look hardest

- **`edu_near` binary search.** It assumes `edu_comp_rows` is time-ordered.
  The `edu.*` queries order by `capture_datetime`. Is that true on every
  path into `analyze_system`, including dev fixtures and `event_window`
  requests?
- **Mixed-source runs.** An off-run can hold EDU and backup readings, and a
  recovery can come from a backup reading (SME16380 recovered on a coldhead
  reading after the EDU went silent). The owner accepted that: the stop is
  annotated rather than re-ruled. Check off-hours, `offline_state`
  (left-censor, start-truncated) and the narrative's branches on such runs.
- **`stale_times`.** It treats any repeated non-null `host_t` as stale.
  Probes showed no repeats in Philips aggregate rows, and isolated repeats
  on 14 GE mm3 systems. A single repeat drops one backup or thermal reading.
- **The upper median.** One high glitch before a stop can raise the
  baseline and hide a real rise (the stop stays listed, typed doubtful or
  unconfirmed). One low glitch cannot fake a rise.
- **`describe_event_window`.** Events from explicit event windows also get
  a corroboration record. Do their `start`/`end`, and `in_real_run`, suit
  `corroborate_event`?
- **`overall_type`.** It is confirmed if any event is, and doubtful only if
  all are. The fleet reason prefix reads the system type, while the brief
  note reads the primary event's type. Can they disagree in a way a reader
  would misread?
- **Chart label thinning.** Confirm that no existing chart at 100, 128 or
  152 px changes. It should only trigger at 86 px, or on domains that were
  already overlapping.
- **Payload size.** Slots carry `alt` and `comp_b` only when set. A 6-month
  page has about 8,760 slots, and the app is chunked by bytes.
- **The customer copy.** Its stop cards name mag tables, as the existing
  data subtitle already does. Is any wording wrong for a customer?

## How to run (all DB-free; all pass at handoff)

```
cd /home/matt-teixeira/hep3/reports
npm run check:oneoff && npm run check:scope && npm run check:config \
  && npm run check:compute && npm run check:fleet && npm run check:chart \
  && npm run check:system-pages
```

Key assertions for this change:
- **`check_compute`.** The corroboration matrix, the 2 h window (a late
  rise is not a response), glitch resistance, the stale filter, and the
  `detail` evidence including frozen flags.
- **`check_chart`.**
  - Gap filling: the scanner fills a 30 h EDU gap and its stop counts,
    while the EDU overrules the scanner where both read.
  - A stale backup is not used.
  - An inferred backup adds the ᶜ.
  - A backup-only stop has no type.
  - The maximal page carries the doubtful note and clears the footer by
    ≥ 12 px.
- **`check_fleet`.** The reason prefixes, and that confirmed or untyped
  stops read as before.
- **`check_system_pages`.**
  - The second strip, backup flags, and absent flags adding no bytes.
  - The stop cards for all three types.
  - The expected-alert rule, with markers switched on in Chromium.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- A "may not be off" stop still raises attention and, unrecovered, urgency.
  That is the owner's decision, and it is open with the team.
- A vendor-only system keeps judging stale vendor readings. Frozen-feed
  detection in the reports is a separate open question.
- The card times are fixed in Eastern time and don't follow the page's zone
  toggle.
- The stuck-scanner case (SME24237) no longer shows as a data issue; it now
  reads stable, because the EDU is live and the magnet is cold.
- The alerting engine is unchanged and still watches only the EDU.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, with one
   sentence on why.
2. **Findings** `F1..Fn`, ordered by severity
   (`blocker`/`major`/`minor`/`nit`). Each one needs:
   - the file:line;
   - a concrete failure scenario (EDU and vendor reading series plus
     thresholds → wrong condition, wrong type, wrong wording, wrong ᶜ, or a
     changed verdict on a system that should not change);
   - a suggested fix;
   - your confidence. A claim you could not trace end to end gets
     `confidence: low` and says why.
3. **Verdict-isolation audit**: for each of
   - compressor stop (ongoing, recovered),
   - threshold exceeded,
   - pressure rising,
   - offline warm / no_signal,
   - data issue / sensor suspect,
   - quench,
   - urgency,

   `UNCHANGED` or `CHANGED`, with the code path that proves it, for a
   system with no EDU and for one with an EDU.
4. **Misjudgment audit**: reading shapes you believe the merge or the
   corroboration misjudges, or `none found`, with reasoning. Cover EDU
   gaps at the period edges, frozen feeds, glitches and short windows.
5. **Ran**: the exact commands you executed and their results.
6. **Test gaps**: behaviors you judged correct but found unasserted.

---

## Round-1 outcome — one finding, fixed

| # | Fix | Regression test |
|---|---|---|
| P2 | The activity timeline's expected-alert rule counted a backup-only OFF reading (`comp_b`) as an expected compressor alert, though the compressor model watches the EDU. `incident/timeline.client.js` `rule` now requires `s.comp === false && !s.comp_b`. It was latent: System Activity pages ship with `show_missed: false`. | `check_system_pages.js` renders a page with the markers switched on, holding one undetected EDU off slot and four backup-only off slots, and asserts exactly one expected slot. **Confirmed to fail with the fix disabled** (5 expected slots) |

After round 1 the owner added the **Compressor stops** section (the
`detail` evidence, `a.stops`, `stop_card`, `stops_section`). Building it
found and fixed one more defect: corroboration had counted flicker
readings inside a stop's span (SME01109 showed 79 EDU off readings against
the stop's own 36). It now uses the real off-runs only (`in_real_run`). On
the live fleet, no system's type changed. Re-review: verify the round-1
fix holds, and review the Compressor stops section as new code.

## Round-2 outcome — SHIP WITH FIXES; all three findings fixed

| # | Fix | Regression test |
|---|---|---|
| F1 (major) | `data.js` `fetch_boundary_context` fetches 2 h each side of the window (vendor before; EDU before and after), strictly outside it, in parallel with the other pulls (`index.js`). `analyze_system` takes it as `context` and uses it only for EDU proximity (`edu_ts` merges boundary EDU times, sorted) and freshness (`prev_host` compares the first in-window stateful vendor reading with the last pre-window one; `stale_times` gets the last pre-window row). Boundary readings never enter `rows`, events, counts or charts. `render/model.js` passes `context` through. | `check_chart.js` "Window edges": (a) your scenario — an EDU reading 20 min before the window covers scanner OFF readings at 00:10 and 00:20; (b) a first in-window scanner reading repeating the pre-window host time is stale, leaving one off reading, a flicker. Each also asserts the defect without context, and that capture counts are unchanged. **Confirmed to fail with the fix disabled**, (a) and (b) separately |
| F2 (minor) | `incident/system_page.js` `stop_card`: the count uses `detail.edu_off`; when the stop's `off_count` is larger, the card reads "5 off readings (2 from the EDU, 3 from the magnet monitor where the EDU was silent)". | `check_system_pages.js`: a mixed stop card. **Confirmed to fail with the fix disabled** |
| F3 (minor) | Aggregation rule kept. `render/narrative.js` `corrob_note`: when the primary stop is doubtful or unconfirmed but the period's type is confirmed, the note adds "Another stop this period is confirmed by other data." — the reason the summary shows no qualifier. | `check_chart.js` "Mixed verdicts": a 20 h doubtful primary stop and a 3 h confirmed one. **Confirmed to fail with the fix disabled** |

**Fleet re-check** (live, dev VM, fixed window Oct 29 – Nov 5, 137
systems): with and without boundary context, **no system's verdict, type,
event count, off-hours or backup count differs**. F1 is an edge case the
current fleet did not hit.

**Your environment's failed checks** (`spawnSync zip EPERM`, Chromium
`setsockopt`) are sandbox limits there. All seven suites pass on the dev VM
after these fixes, including the Chromium layout and page checks.

For re-review: verify the three fixes, and that `context` cannot leak into
any reading, count or chart.

## Round-3 outcome — SHIP WITH FIXES; the one finding fixed

| # | Fix | Regression test |
|---|---|---|
| F1 (major) | The vendor predecessor is no longer bounded by 2 h. `sql/sql.js` derives, from each vendor series file, a query for the latest `BEFORE_ROWS` (336) rows strictly before the window (`< $2 … ORDER BY capture_datetime DESC LIMIT 336`); the derivation fails at load if a file's shape changes. `data.fetch_boundary_context(identity, window, vendor, source)` runs after the series fetch, reads the **same table** the window came from (`source`, so GE's mm4/mm3 fallback cannot diverge), normalizes like the series, and returns the rows in time order. EDU context stays at 2 h each side (the proximity rule is 45 min). | `check_compute.js` "before-window vendor queries": every vendor table has one, with no lower bound, newest first, bounded, the same table and the same columns as its series file. `check_chart.js` "Window edges" (c): a predecessor 79 h older than the window, followed by a stateless row, still exposes the frozen first reading (this documents that the analysis ignores age; the defect was in the fetch). **Live** (dev VM, SME19528): a window starting inside its frozen stretch catches the first reading repeating its predecessor's host time; a window starting after its 79 h data gap finds that predecessor |

**Fleet re-check** (live, fixed window Oct 29 – Nov 5, 137 systems): with
the new context against none, **no differences**. Full fleet run: 27 s.

For re-review: verify the fix, that `context` still cannot leak into any
reading, count or chart, and that the extra query cannot fail a report (an
empty result means no predecessor).

## Round-4 outcome — SHIP WITH FIXES; both findings fixed

| # | Fix | Regression test |
|---|---|---|
| F1 (major) | New pure module `boundary.js` `with_context_fallback`: a rejected boundary lookup (vendor predecessor or either EDU edge) returns `{ context: null, context_error }`. `index.js` uses it, warns on the console, and records `boundary_context: "unavailable: …"` (or `"ok"`) in the run log note. The report continues without context, exactly as a window with no neighbouring readings. | `check_compute.js` "boundary context is optional": a rejecting fetch yields `context: null` and the error message, and `analyze_system` with that context classifies normally. The suite's closing line now waits for this async check |
| F2 (minor) | `sql/sql.js` `series_before` gains `mag.siemens_non_tim`; `data.js` normalizes it with `normalize_siemens_non_tim`. A 10K system's first in-window shield reading is judged against its predecessor's host time. | `check_compute.js`: every `source` that `data.fetch_series` can name has a before-window query (read from `data.js`). `check_chart.js` "Siemens 10K": a shield feed frozen before the window; without context its first reading passes as live (`thermal: steady`), with context it is stale (`thermal: unknown`, `pressure_frozen: true`). **Live** (SME01136): 336 predecessor rows fetched, the last one just before the window |

Test gap 3 closed: `check_chart.js` "Window edges" asserts that pressure and
helium chart-point timestamps are identical with and without context.

**Fleet re-check** (live, dev VM, both runs side by side on a closed window,
Oct 27 – Nov 2, 137 systems): with context against none, **no differences**
in verdict, type, thermal class, event count, off-hours or backup count, and
no context lookup failed. Correction: the round-2 and round-3 re-checks used
a window running to the end of the current day; round 3's two runs were
minutes apart, so live data could have moved between them. This closed
window replaces them.

For re-review: verify both fixes, and that nothing else changed.

## Round-5 outcome (2026-11-05) — SHIP

No findings. Codex's one remaining test gap (an end-to-end rejection of the
boundary lookup in `run_one`) was checked once on the dev VM, outside the
repo: with `data.fetch_boundary_context` replaced by a function that throws,
a real one-off brief for SME16380 printed
`SME16380: boundary context unavailable, continuing without it: simulated
connection reset` and still produced its PDF and HTML. It is not a
committed test, because `run_one` needs the database.
