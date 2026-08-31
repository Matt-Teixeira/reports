# Code Review Request — pre-commit sweep of the full DEV tree

You are reviewing uncommitted work on branch `DEV` of this repo
(`/home/matt-teixeira/hep3/reports`). Nothing is committed or pushed; this
review is the last gate before the first commit series. Your findings will be
handed back verbatim to another assistant to fix, so make each one
self-contained and reproducible.

## What this codebase does

Generates customer-facing "Magnet Health" PDFs for ~163 MRI magnets across
four vendor variants (Philips, GE, Siemens TIM, Siemens non-TIM) from
Postgres telemetry: one-page per-system briefs, and a multi-page fleet
summary. The costliest class of bug is one that **silently misstates or omits
a system's state** — a wrong "ON", a missing system, an unfounded "urgent".

## Prior review rounds — what NOT to re-review

Three rounds already ran and every finding was fixed with a regression test:

1. **Compressor event clustering** (2 rounds) — see `REVIEW-HANDOFF.md`.
2. **Fleet summary v1** (1 round) — see `REVIEW-HANDOFF-FLEET.md`. Findings
   were: (a) quench invisible in the fleet table [fixed: quench overlay in
   `conditions.js`, QUENCH helium cell, tops severity]; (b) historical
   threshold peaks counted as urgent + reasons contradicted cells [fixed:
   `is_urgent` is now-based; reasons cite the triggering peak/min]; (c) null
   compressor + `event_window` override rendered ON [fixed: unconditional
   "no data", observed-events-only history]; (d) failure system IDs truncated
   [fixed: chunked rows]; (e) `band_state` null-coercion on low-only
   thresholds [fixed: guards + `breach_direction`]; (f) summary-only mode
   could succeed without a PDF [fixed: loader requires `summary_pdf`, render
   failure is fatal in that mode].

Do not re-litigate those designs — but **do verify the six fixes actually
hold** (each has assertions in `dev/check_fleet.js` or `dev/check_chart.js`;
confirm the assertion tests the failure mode and not a tautology).

## In scope — everything since, grouped by feature

The working tree is the release. `git diff` + untracked files. New files:
`conditions.js`, `compute/summary_facts.js`, `render/fleet_model.js`,
`render/fleet_page.js`, `dev/check_fleet.js`.

### 1. Data-quality criteria (`compute/summary_facts.js`, `render/fleet_model.js`)
- `PLAUSIBLE` per-channel physical bounds; a reading outside them is shown
  greyed with `‡` and **excluded from all status arithmetic** — flagged
  channels must never drive severity, attention, urgency, or percentages.
- `sensor_suspect`: ≥2 impossible channels at once, or ≥1 impossible
  alongside helium == 0 → "monitoring is down, not the magnet". One
  impossible reading alone never convicts (a quench really does read 0%).
- `left_censored`: an ongoing stop whose start predates the period (no prior
  ON reading). Split by magnet corroboration: warm-corroborated → `WARM /
  OFFLINE` (real, finished, not urgent); no thermal response → `NO SIGNAL`
  (a monitoring problem). **Nothing left-censored is ever urgent.**
- Third headline tier: `N data issues` beside attention/urgent.

### 2. Philips cable-error fix (`data.js`)
`cryo_comp_malf_value = −1` is a cable error, not a state → maps to `null`
(was: counted as OFF, producing false "off 738 h" claims). Companion fix in
`render/tiles.js`: null compressor renders "—", never green ON.

### 3. EDU compressor priority (`render/model.js`) — newest, least reviewed
Per-SYSTEM compressor source selection, priority order:
1. Scanner-reported channel (Philips malf, Siemens TIM status) when it
   yields ≥1 stateful reading.
2. EDU `comp_vib` (a vibration sensor ON the compressor — direct
   measurement) when ≥ `EDU_MIN_READINGS = 24` readings: **outranks** the GE
   coldhead inference, and **fills in** when a scanner channel yields zero
   stateful readings (the cable-error Philips trio turned out measurable).
3. GE coldhead inference (`coldhead_ruo_value ≥ 10 K` = off) as last resort.

`facts.compressor_source` is the *actual* source used, and drives the ᶜ mark
and the "(per EDU vibration sensor)" narrative note. Attack the boundaries:
the `vendor_stateful.length === 0` cliff (what about a scanner channel with
exactly 1 possibly-bogus reading vs 1,440 EDU readings?), sparse EDU just
above/below 24, EDU rows all-null `comp_vib`, EDU present but vendor is
Siemens non-TIM (whose *primary* source already is `edu_comp_vib` — must not
double-apply or regress).

### 4. Provenance marks (`conditions.js`, `render/fleet_page.js`, `render/fleet_model.js`)
Convention: **mark conclusions, never measurements.** `ᶜ` appears per-cell on
the compressor state word iff `compressor_source === "coldhead_ruo_value"`;
on overlay conditions (`OFF ENTIRE PERIODᶜ`, `no signalᶜ`, `sensor
suspectᶜ`); on corroborated attention reasons; `<sup>c</sup>` in the email.
Column headers are never marked. Unmarked = a reading or arithmetic on one.
Attack completeness both ways: any conclusion that renders unmarked, any
measurement that renders marked.

### 5. Exclusions (`request_loader.js`, `index.js`, `render/fleet_model.js`, `fleet_page.js`)
Top-level `exclude` / `exclude_note` in request JSON. Excluded systems are
**stated in the PDF** (cover count + `EXCLUDED BY REQUEST` section), never
silent. Invariant: requested = analyzed + no-report + excluded, exactly.

### 6. Naming, legend, terminology, gauge (`render/fleet_page.js`, `fleet_model.js`)
- Flat metric-named column headers per section (`HE PRESSURE`, `SHIELD
  TEMP`), `% OF LIMIT`, `PEAK OVER LIMIT`; alert limits in section headings
  with "(N differ)" for systems on non-default thresholds.
- Siemens TIM centered band (`is_centered_band`: `high_lt/high_gt ≥ 0.5`)
  renders a miniature gauge (dot position 0..1, clamped 0.03–0.97 for
  visibility, amber in the outer tenth) instead of a meaningless "93% of
  limit". Band rows sort by distance from band center. GE's floor alarm
  (`0.5–5.2 PSI`) is NOT a band — percentage stays valid there. Attack the
  classifier and the clamp (can a truly out-of-band reading look in-band?).
- Legend (`.legend.pin`, bottom of cover) replaced the verbose intro
  paragraph; defines period, % OF LIMIT, PEAK OVER LIMIT, WITHIN BAND,
  flicker, ‡/×, urgent, ᶜ, etc.
- Reader-facing text says "period" (never "window") and "event span" (chart
  shading). Code identifiers still say `window` — only rendered text changed.

### 7. Fleet round-1 fix fallout (`index.js`, `send_summary_email.js`, `conditions.js`)
Shared condition vocabulary; summary email and PDF render from the same
records and must not drift (tested in `check_fleet.js`).

## Context documents

- `sme_reports/RULES.md` — the rule-of-record. §5 data quality, §6
  corroboration & provenance (vendor vouching table, the ᶜ convention,
  provenance of constants). **Review the doc too**: a rule the code doesn't
  implement, or code behavior the doc doesn't state, is a finding.
- `sme_reports/REVIEW-HANDOFF.md`, `REVIEW-HANDOFF-FLEET.md` — prior rounds.
- `sme_reports/out/Avante-Fleet-Magnet-Health-2026-08-10.html` — a real
  render from live data today (144 systems, 13 pages). Open it; it is the
  fastest way to see what every rule produces. Its PDF twin was emailed today.

## How to run

No test framework; hand-run assert scripts, all DB-free:

```
node sme_reports/dev/check_compute.js   # metrics/events/archetype units
node sme_reports/dev/check_chart.js     # per-system brief, model-level, incl. EDU priority
node sme_reports/dev/check_fleet.js     # fleet doc: content + REAL Chromium geometry measurement
```

All three pass at handoff. `check_fleet.js` launches headless Chromium and
measures row clipping and per-cell text truncation (Range-based, spans
resolved) — layout is verified by measurement, never by string presence.
Live DB runs need `.env` + Postgres and are likely unavailable to you; live
verification results are recorded in RULES.md §6 (e.g. SME22099 = 1,440 EDU
readings; the cable-error trio measurable via EDU; one of them, SME15809,
had a real 15 h stop that surfaced only through the EDU). Flag anything you
could not verify for lack of DB access rather than assuming it.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- Litres-unit helium cells omit the Δ (column width; the per-system brief
  carries it). Percent cells show it.
- `PLAUSIBLE` bounds are deliberately loose — only the absurd trips them.
- `EDU_MIN_READINGS = 24` (≈ half a day at 30-min cadence) is a heuristic
  floor, documented in RULES.md.
- `warm_corroborated` heuristic = breach/high severity, or warm coldhead, or
  rising trend.
- Pagination constants (`ROWS_PER_PAGE = 25`, first pages fewer) are
  conservative and geometry-checked, not tight.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, one sentence why.
2. **Findings** `F1..Fn`, ordered by severity (`blocker`/`major`/`minor`/
   `nit`), each with: file:line, a concrete failure scenario (inputs/state →
   wrong output a reader would see), suggested fix, and your confidence.
   A claim you could not reproduce or trace end-to-end gets `confidence:
   low` and says why.
3. **Prior-fix verification**: the six fleet-round-1 fixes above — HOLDS or
   BROKEN each, with the assertion (file:line) that convinced you.
4. **Ran**: the exact commands you executed and their results.
5. **Test gaps**: behaviors you judged correct but found unasserted.

---

## Round-1 outcome (2026-08-10) — all ten findings fixed

Verdict was DO NOT SHIP; every finding was reproduced, fixed, and given a
regression test. For re-review: verify each fix holds and that no fix
introduced a new defect.

| # | Fix | Where | Regression test |
|---|---|---|---|
| F1 | Symmetric 24-reading floor: a scanner channel keeps priority only with ≥ `EDU_MIN_READINGS` stateful readings; below that a sufficient EDU takes over | `render/model.js` (`use_edu`) | `check_chart.js` "one stray scanner reading", plus exact 23/24 boundary and all-null-EDU cases |
| F2 | `condition_cell_record` leads with an unmarked red QUENCH; batch email now grades the distilled record (`{...r.summary, archetype}`), not the bare archetype | `conditions.js`, `output/send_batch_email.js` | `check_fleet.js` "a quenched record can NEVER render healthy" |
| F3 | Bounds applied per point in the model BEFORE metrics (peak/min/trend/archetype/chart all clean); rejected counts reported on the brief; suspect = impossible COMBINATION in one capture, convicted on the LATEST capture; `implausible_count` now counts readings | `compute/plausible.js` (new), `render/model.js` (screen), `compute/summary_facts.js` | `check_chart.js` "plausibility screen runs per point"; `check_fleet.js` weeks-apart / recovered-chain cases |
| F4 | Left-censoring additionally requires coverage within 24 h of the period open (`compressor_first_stateful_t`); a late first OFF is an observed ongoing stop, urgent-eligible | `render/model.js`, `compute/summary_facts.js` | `check_fleet.js` "late first OFF" case |
| F5 | Orchestrator outer catch rethrows after logging; CLI wrapper sets `process.exitCode = 1` and still writes run logs | `sme_reports/index.js`, root `index.js` | `check_fleet.js` spawns the real CLI with a missing request file (env-guarded skip) |
| F6 | Loader returns `out_dir` resolved independently of surviving requests; build/send gates count exclusions as content; exclusion-only model/page renders and paginates | `request_loader.js`, `sme_reports/index.js` | `check_fleet.js` "all-excluded request" |
| F7 | Mixed band/percent sections get the neutral `VS ALERT LIMIT` header; single-mode keep `WITHIN BAND` / `% OF LIMIT` | `render/fleet_page.js` | `check_fleet.js` "mixed band modes" + gauge clamp assertions (3 %/97 % rims, amber) |
| F8 | Exclusion-only page counted in `page_count`; the old test asserting `page_count + 1` now requires equality and a matching last footer | `render/fleet_model.js` | `check_fleet.js` (updated block) |
| F9 | `esc()` in `email_theme.js`; every DB/error-derived string escaped in summary, batch, and per-report emails | `output/email_theme.js` + three senders | (escaping unit-visible in module; e2e email send untestable without SMTP) |
| F10 | "Data window" → "Data period" | `output/send_report_email.js` | source inspection |

Also closed from the test-gap list: raw Philips `−1` now goes through the
REAL `normalize_philips` (normalizers extracted to `sme_reports/normalize.js`,
a pure module with no DB import); `off_count === 0` observed-events filter has
a direct assertion; fleet fixtures updated to the new facts contract
(`raw_last` / `implausible` / `last_suspect` / `compressor_first_stateful_t`).

Live 144-system run after the fixes: 13 pages, 0 clipped rows, 0 protected
truncations; headline 48 attention / 3 urgent / 2 data issues — the deltas vs
the pre-fix run are two genuinely fresh compressor stops (live data) and
SME11221 honestly reclassified to `no compressor signal` after its pressure
eased back within band (warm corroboration no longer holds).

---

## Round-2 outcome (2026-08-10) — both findings fixed

Round 2 verdict was DO NOT SHIP on two residuals of the F3 (plausibility)
work; both reproduced and fixed, with e2e regressions through the REAL
normalizers this time.

| # | Fix | Where | Regression test |
|---|---|---|---|
| R2-F1 | When the coldhead inference is the compressor source, rows whose coldhead reading fails the bounds get `compressor_on = null` BEFORE run detection — an implausible reading cannot drive its own derivative. Applied to `vendor_stateful` counting and event detection alike | `render/model.js` (`source_rows`) | `check_chart.js` "an implausible coldhead cannot drive inferred compressor state": raw `normalize_ge` rows → model → summary → `!is_urgent`, no event, rejections still counted |
| R2-F2 | Non-TIM `shield_k` treated as an alias of the primary slot: excluded from `CHANNEL_BOUNDS` (so `suspect_capture` and rejection counts see one channel), still filtered from the shield metric, and dropped from the fleet record entirely (`shield_k: null`, `data_flags.shield: false`) | `render/model.js`, `compute/summary_facts.js` | `check_chart.js` "non-TIM shield is ONE physical channel": raw `normalize_siemens_non_tim` rows → model → record → not suspect, `implausible_count` 1, one ✕ in `data_issue_readings` |

Live 144-system run after round 2: 49 attention / 2 urgent / 1 data issue,
13 pages, geometry clean. Notable: SME11221 moved from "no compressor
signalᶜ" (data issue) to a MEASURED `stop, recovered · off ~497 h` — its
scanner channel has < 24 stateful readings, so the symmetric floor handed the
question to its EDU, which had the whole story. The remaining data issue
(SME20122) is a GE whose two impossible channels are genuinely separate
physical sensors, convicted correctly. RULES.md §5 gained "Inference
screening" and "Channel identity" rules.

Remaining accepted gaps (unchanged from your list): no forced fleet-render
failure injection (the CLI missing-file test covers the exit path); email
bodies not constructed in tests (senders build and send in one function;
escaping is helper-tested); "Data period" wording asserted only by source.
