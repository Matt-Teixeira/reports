# Code Review Request — brief parity with the fleet's data-quality rules

You are reviewing the committed series `8d2a611..1244115` (7 commits) on
branch `DEV` of this repo (`/home/matt-teixeira/hep3/reports`). Review the
range with `git diff 8d2a611..1244115` / `git log -p`. Your findings will be
handed back verbatim to another assistant to fix, so make each one
self-contained and reproducible.

## What this codebase does

Generates customer-facing "Magnet Health" PDFs for ~163 MRI magnets across
four vendor variants (Philips, GE, Siemens TIM, Siemens non-TIM) from
Postgres telemetry: one-page per-system briefs, and a multi-page fleet
summary. The costliest class of bug is one that **silently misstates or
omits a system's state** — a wrong "ON", a missing system, an unfounded
"urgent", or a confident number a sensor invented.

## The problem this series solves

The previous release added data-quality machinery at the fleet level only:
sensor-suspect conviction, the ‡ greyed-raw treatment, the ᶜ provenance
mark, left-censored stop overlays, and a DATA ISSUES tier. The one-page
per-system brief renders from the SAME model but had none of them, so the
two documents could contradict each other about the same system. Verified
live (SME20122, GE): the fleet said `DATA ISSUES · 158 impossible readings
— sensor suspectᶜ` with raw values greyed; the brief said `HELIUM 0.00%`
in red, "below the 50% alert level", and `PRESSURE NOW 1.218 PSI` — a
five-day-old reading shown as current with no flag. Full investigation:
`sme_reports/HANDOFF-BRIEF-PARITY.md` (commit 1 of this series).

The series closes that gap. The design intent everywhere: **the brief and
the fleet must reach the same verdict from the same facts, using the same
words** — enforced by shared helpers, shared vocabulary, and end-to-end
parity fixtures.

## Prior review rounds — what NOT to re-review

`REVIEW-HANDOFF.md`, `REVIEW-HANDOFF-FLEET.md`, and
`REVIEW-HANDOFF-PRECOMMIT.md` (3 rounds, 12 findings, all fixed with
regression tests) cover the fleet-side machinery this series builds on:
plausibility screening, suspect conviction rules, EDU source priority,
inference screening, the shield alias, left-censor classification. Do not
re-litigate those designs. DO flag it if this series **regressed** one of
them — several were refactored here (see "highest-risk changes").

## In scope, by commit

### 1. `8e5d0db` — sensor-suspect treatment on the brief (P1)

A convicted chain (`facts.last_suspect`, RULES.md §5) now:
- renders a grey **banner** between the sub-line and the tiles, labeled
  from `conditions.js` `STATUS_LABELS.sensor_suspect` + ᶜ, defining ᶜ and
  ‡ inline (the brief has no legend block);
- **suspends every tile judgment** (`degrade_tile` in `render/tiles.js`):
  flagged channels show their raw value greyed with ‡ ("outside plausible
  bounds — not judged"), clean channels keep their value but drop status
  colors ("sensor's claim — not judged"). Exception: an **EDU-measured
  compressor** (separate hardware, outside the convicted chain) stays
  confident — matching the fleet, which keeps the compressor cell on a
  suspect row;
- leads the story with a "Monitoring suspect:" paragraph and retitles the
  CURRENT card "(sensor's claims)";
- a recorded quench overrides the conviction entirely.

Channel flags were factored into `compute/plausible.js
last_raw_flags(raw_last, units, {shield_alias})`, now used by BOTH
`render/model.js` (brief) and `compute/summary_facts.js` (fleet).

`render/chart.js` gained a `height` parameter (default 152 = the exemplar
geometry; banner pages pass 100) — plot bottom and x-label rows are now
computed from it.

### 2. `abc8b81` — stale / out-of-bounds NOW flagging (P2)

`degrade_tile` now runs on EVERY brief, conviction or not, over the
now-value tiles (PRESSURE NOW, HELIUM, COLDHEAD, CABINET), priority order:
1. last raw reading outside bounds → raw greyed with ‡, judges nothing
   (the helium tile steps aside for a recorded quench);
2. clean but newest plausible reading > `STALE_MS` (24 h) older than the
   period end → sub-line prefixed "as of <day>";
3. suspect conviction → the P1 suspension (stale prefix composes).

### 3. `d7b928e` — ᶜ provenance marks on the brief (P3)

`compressor_source === "coldhead_ruo_value"` (the GE inference) marks the
tile value (`ONᶜ/OFFᶜ/RESTARTEDᶜ`), the CURRENT card, and the narrative
state words, with "(inferred from coldhead temperature)" parallel to the
existing EDU note. Measured (EDU) and scanner-reported states stay
unmarked. The brief's one legend line lands in the DATA NOTES card only on
pages that carry a mark; banner pages skip it (banner defines inline).

### 4. `0921652` — left-censor overlays on the brief (P4)

The classification was **extracted from `build_summary_facts` into a
shared `offline_state(facts)`** (`compute/summary_facts.js`), now called
by both documents. On the brief:
- `offline_kind === "warm"` → amber compressor tile `OFFᶜ` / "off entire
  periodᶜ · start predates the data" (label from
  `STATUS_LABELS.warm_offline`), story with no start time, no hour count,
  no "Warming event OPEN" line;
- `offline_kind === "no_signal"` → the data-issue banner pattern
  (`NO COMPRESSOR SIGNALᶜ`), compressor tile `—`, and — unlike suspect —
  the other channels KEEP their judgments;
- quench overrides both; the suspect banner wins where both would apply;
  observed-late coverage (first stateful reading > 24 h after the period
  opens) stays a real, urgent-eligible ongoing stop.

### 5. `aea3649` — parity regression fixtures (P5)

Four sections appended to `dev/check_chart.js`, raw rows through the REAL
normalizers, each ending with a `build_summary_facts` parity assertion:
suspect conviction (the SME20122 shape + quench override), left-censored
warm, left-censored no-signal (Philips), stale + single-flag without
conviction. Verified the suspect fixture fails when the tile degradation
pass is disabled.

### 6. `1244115` — sub-line ellipsis

`.sub` ellipsizes instead of silently hard-clipping at the page edge on
long site names. Ellipsis over wrap was deliberate: every fact in the
truncated tail is stated elsewhere on the page, and a wrapped line would
cost height on exactly the tightest banner pages.

## Highest-risk changes — attack these first

1. **The `offline_state` extraction** (`compute/summary_facts.js`). The
   left-censor / warm / no-signal logic was inline in
   `build_summary_facts` and is now a separate function consuming `facts`
   directly. It must be behaviorally IDENTICAL to the old inline code for
   the fleet path (the old code used display values `p_now`/`coldhead_k`
   that mixed raw-when-flagged; the new code reads metric values gated by
   the same flags — confirm the gating makes them equivalent in every
   branch, including flagged-channel and null-metric cases).
2. **The `chart.js` height parameterization.** Every chart on every
   existing page must be pixel-identical at the default (a re-rendered
   non-suspect brief was diffed clean at review time — verify the geometry
   arithmetic: `plot.y0 = height − 26`, `label_y = height − 6`,
   viewBox height interpolation).
3. **`degrade_tile` ordering and edge cases** (`render/tiles.js`): flagged
   beats stale beats suspect-dim; the EDU compressor exception; the
   helium/QUENCH step-aside; `NOW_CHANNELS` getters against null metrics
   (`f.pressure` null, `f.coldhead` null…); a suspect system whose vendor
   tile set includes `temp_alarm` or `cabinet` (no live case existed —
   fixture coverage is GE/Philips only).
4. **Banner precedence and one-page geometry.** Suspect > no-signal >
   none; `chart_height = banner ? 100 : 152`. The page is `height: 11in;
   overflow: hidden` with an absolutely-positioned footer — overflow clips
   SILENTLY. Chromium measurements at review time: SME20122 (suspect,
   banner) 35px clear of the footer; SME20292 61px; synthetic suspect
   fixture 67px; healthy pages 44–93px. There is no automated geometry
   check for the BRIEF (only the fleet has one, in `check_fleet.js`) — if
   you judge 35px too thin for story-length variance, or think a
   long-story suspect page could clip, that is a finding (suggested fix
   direction: a Range-based brief geometry check like `check_fleet.js`'s).
5. **ᶜ completeness both ways** (P3/P4): any conclusion the brief renders
   unmarked, or any measurement it renders marked, is a finding. Check the
   narrative paths not exercised by fixtures (recovered-with-cycles,
   `other_events_sentence`, flicker wording on an inferred source).

## Invariants that must hold (from RULES.md and the scope doc)

- The brief is ONE page, hard. Layout claims are proven by measurement,
  never assumed.
- Shared vocabulary comes from `conditions.js` (`STATUS_LABELS`,
  `effective_status`); the brief must never restate a label in its own
  words.
- Reader-facing text: "period" never "window"; "event span" for chart
  shading; "triggered"/"threshold exceeded", never "fired".
- RULES.md changes land in the same commit as the rule change — review the
  doc against the code: a documented behavior the code lacks, or code
  behavior the doc omits, is a finding. This series added three RULES.md
  entries (§4 stale/flagged NOW, §5 suspect-on-brief, §5 left-censor-on-
  brief) and one §6 bullet.
- A recorded quench overrides every data-quality overlay, everywhere.
- Flagged channels never drive severity, attention, urgency, or
  percentages — on either document.

## How to run

No test framework; hand-run assert scripts, all DB-free:

```
node sme_reports/dev/check_compute.js
node sme_reports/dev/check_chart.js     # includes the new parity fixtures
node sme_reports/dev/check_fleet.js     # fleet content + Chromium geometry
```

All three pass at handoff. Live DB runs need `.env` + Postgres and are
likely unavailable to you. **Never run request files that carry real
recipients** (`requests/fleet-summary.json`, `requests/batch-*.json` email
real people). The safe probe pattern is `requests/dev-probe-sme20122.json`
(html only, no pdf/email/archive). Live renders from review time are in
`sme_reports/out/`: `Avante-SME20122-Magnet-Health.html` (suspect banner
page) and `Avante-SME20292-Magnet-Health.html` (OFFᶜ inferred page) beside
the fleet document `Avante-Fleet-Magnet-Health-2026-08-10.html` — opening
the brief and the fleet row for the same system is the fastest way to see
what parity means here. Flag anything you could not verify for lack of DB
access rather than assuming it.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- `STALE_MS = 24 h` is a project constant (matches the left-censor grace
  span); staleness is judged against the period end, not wall-clock now.
- Banner pages render 100-high charts (vs 152) to buy the banner's room —
  less plot resolution on exactly the pages whose data is least trusted.
- On a convicted page, in-bounds readings (0.00% helium) render dim with
  "sensor's claim", NOT ‡ — ‡ is reserved for readings outside bounds,
  same as the fleet.
- The EDU-measured compressor stays confident (red OFF) on a convicted
  page — separate hardware; matches the fleet's suspect row.
- Suspect banner wins over the no-signal banner when both would apply.
- The DATA NOTES legend line uses one generic wording ("ᶜ = concluded —
  inferred or corroborated, not directly measured") rather than
  per-cause variants.
- Sub-line truncation is ellipsis, not wrap (rationale in commit
  1244115).
- No live left-censored system existed at review time — those paths are
  fixture-verified only, through the real normalizers.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, one sentence
   why.
2. **Findings** `F1..Fn`, ordered by severity (`blocker`/`major`/`minor`/
   `nit`), each with: file:line, a concrete failure scenario (inputs/state
   → wrong output a reader would see), suggested fix, and your confidence.
   A claim you could not reproduce or trace end-to-end gets `confidence:
   low` and says why.
3. **Refactor equivalence**: `offline_state` extraction and `chart.js`
   height parameterization — EQUIVALENT or CHANGED each, with the code
   path that convinced you.
4. **Fixture audit**: the four new `check_chart.js` sections — for each,
   does it test the failure mode or a tautology?
5. **Ran**: the exact commands you executed and their results.
6. **Test gaps**: behaviors you judged correct but found unasserted.
