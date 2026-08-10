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

---

## Round-1 outcome (2026-08-10) — all four findings fixed

Verdict was DO NOT SHIP; every finding was reproduced, fixed, and given a
regression test. For re-review: verify each fix holds and that no fix
introduced a new defect.

| # | Fix | Where | Regression test |
|---|---|---|---|
| F1 | Two-tier density: narrative is built before the charts; pages whose flowed text (story + cards + banner) exceeds `COMPACT_AT = 1400` chars render the compact tier (smaller story/card faces; charts banner 100→92, plain 152→128). Other-events day list capped at 4 named days ("+N more"), so story length is bounded while counts/totals stay exact. Calibration: normal capacity cliff ≈ 1,600 chars (1,577 fit at 35px, 1,648 clipped 22px); of 150 live briefs only SME20122 crosses the threshold (its margin went 35→171px) | `render/model.js` (density), `render/page.js` (`COMPACT_CSS`), `render/narrative.js` (day cap) | `check_chart.js` "one-page geometry, measured in Chromium": two maximal fixtures (10 events, 6 flickers, 2 alarm runs, EDU; ± suspect banner) must select compact, and EVERY synthetic page is laid out in headless Chromium and must clear the footer by ≥12px; sub-line ellipsis asserted active on the overflowing fixture |
| F2 | Quench override moved INSIDE `offline_state`: it nulls the overlay VERDICT (`offline_kind`) for both documents while the censoring FACT (`left_censored`) survives, so the fleet history cell still reads "entire period" and `attention_reason` still leads with the quench | `compute/summary_facts.js`, `render/model.js` (local gate removed) | `check_chart.js` warm-fixture quench variant: both sides null the verdict, keep the fact, `effective_status` null, still urgent via the quench |
| F3 | One effective overlay: `facts.offline_kind` is nulled on the brief when the suspect conviction wins (same precedence as `conditions.effective_status`), so banner, tiles, story, and CURRENT card all speak in the suspect framing and the scanner-sourced compressor claim is suspended like every other claim | `render/model.js` | `check_chart.js` "suspect precedence": Philips off-all-period + impossible final capture → one verdict end-to-end, no "No compressor signal" anywhere, fleet label `sensor_suspect` |
| F4 | Every inferred compressor conclusion carries ᶜ — including the negatives ("No compressor eventsᶜ", "No compressor stopᶜ") and the deductions (flickerᶜ, cycled on/offᶜ, other stop eventsᶜ). Measured/scanner sources stay unmarked | `render/narrative.js` | `check_chart.js` "ᶜ provenance on every inferred narrative conclusion": one fixture per archetype on an EDU-less GE, plus a measured-EDU counterexample asserting zero marks on the whole page |

Also closed from the test-gap list: exact-24h stale boundary (strictly
more than 24 h), null-metric NOW channels through the degrade pass in both
modes, short-chart coordinate recomputation (x-labels at height − 6),
Philips temp-alarm tile suspended under conviction (inside the maximal
fixture), sub-line ellipsis verified in Chromium, and a fleet parity
assertion for the quench override. Still open, accepted: no suspect
fixture for the non-TIM cabinet tile (the tile shares the degrade path
asserted for temp-alarm), and `COMPACT_AT` is a calibrated constant rather
than a per-page measurement — the Chromium check re-measures the bound on
every run.

Live probes after the fixes (no-send pattern): SME20122 renders compact
with the suspect banner, 171px clear of the footer; SME20292 is unchanged
(normal tier, `OFFᶜ`, 61px). All three dev checks pass, including the new
Chromium geometry pass over nine synthetic pages.

---

## Round-2 outcome (2026-08-10) — both findings fixed

Round 2 verdict was DO NOT SHIP on a residual of the F2/F3 precedence
work plus one pre-existing narrative defect; both reproduced and fixed.

| # | Fix | Where | Regression test |
|---|---|---|---|
| R2-F1 | Censor-aware rendering is now independent of the overlay verdict: when `left_censored` holds but the verdict was suppressed (quench override, suspect precedence), the compressor tile and the ongoing story render neutral coverage wording — "off at every reading this period · start and downtime unknown" — consuming neither `event.start`, nor `off_hours`, nor the OPEN-event line. Observed ongoing stops are untouched | `render/tiles.js`, `render/narrative.js` | Both precedence fixtures (warm+quench variant, suspect-over-no-signal) now assert the RENDERED tile and story: no fabricated start, no hour count, no "Warming event OPEN", neutral wording present |
| R2-F2 | `facts.coldhead_baseline_max` gained a real producer: the warmest screened coldhead reading before the primary event (whole period when no event; null when no pre-event reading exists). The narrative's "coldhead at base temperature" renders only when that maximum sits under the vendor's warm line; `!= null` also rejects stubs that never produce the field | `render/model.js`, `render/narrative.js` | All-warm left-censor fixture asserts the claim is ABSENT; the recovered fixture (4.2 K pre-event) asserts the earned claim survives |

Live probes after round 2: SME20292's observed stop keeps its real timing
("stopped Aug 10 03:45Z") and its base-temperature baseline claim is now
EARNED (pre-event coldhead at 4.3 K before warming to ~146 K); SME20122
unchanged (compact, banner, 171px). All three dev checks pass.

Remaining accepted gaps (unchanged from your list): non-TIM suspect
cabinet tile unasserted (shares the degrade path asserted for
temp-alarm); geometry coverage does not constrain arbitrary
`narrative_overrides` (hand-supplied prose is the requester's
responsibility, same stance as the fleet's request overrides); a single
compact tier (the Chromium check re-measures the bound every run and
would catch a page that outgrows it).

---

## Round-3 outcome (2026-08-10) — the finding fixed

Round 3 verdict was DO NOT SHIP on one blocker: the round-2 neutral
wording was categorically false for a valid OFF→ON→OFF boundary event
(one clustered event, cycles 2, five observed ON readings) — the
inherited `left_censored` predicate held whenever the first ON postdated
the event's start, and "off at every reading this period" rode on it.

| # | Fix | Where | Regression test |
|---|---|---|---|
| R3-F1 | `left_censored` now requires **no ON reading at all** — one observed ON falsifies every "entire period"/"every reading" claim on both documents (the fleet history cell reports measured hours instead of "entire period"). The boundary case became a new shared fact, **`start_truncated`** (`offline_state`): its trailing stop was observed and anchors the wording — tile "already off at first reading · off again <ts>", story "already off when the data begins … first seen running <ts>, then stopped again <ts> — off ~N h observed across N off-runs" — while the initial run's start and earlier downtime stay unclaimed. The stop remains urgent-eligible per the documented observed-stop stance. Events now carry `last_stop_t` (the final off-run's start), the observed anchor the event's boundary `start` would misstate. RULES.md §5 rows updated in the same commit | `compute/events.js` (`last_stop_t`), `compute/summary_facts.js` (`offline_state`), `render/model.js`, `render/tiles.js`, `render/narrative.js`, `RULES.md` | `check_chart.js` "start-truncated multi-cycle boundary event": end-to-end Philips OFF→ON→OFF (cycles 2) asserting tile and story wording, no categorical or fabricated-start claims, no left-censor overlay, fleet parity (`left_censored` false, ordinary ongoing condition, urgent), plus a quench variant asserting the wording survives verdict suppression |

Also closed from the round-3 gap list: the ON-recovery-then-open-stop
fixture (the R3-F1 fixture itself), the direct "already OFF at first
reading" vs "OFF at every reading" distinction (asserted in both
directions), and the no-event coldhead baseline counterexamples (a 15 K
excursion withholds "at base temperature"; a clean 4.2 K period earns
it). Still accepted: non-TIM cabinet suspect tile; `narrative_overrides`
geometry; live DB reruns are recorded in this doc rather than executed
by the reviewer.

Live probes after round 3: SME20122 (compact, suspect banner, 171px) and
SME20292 (normal, `OFFᶜ`, observed stop timing intact, 61px) unchanged.
All three dev checks pass.

---

## Round-4 outcome (2026-08-10) — both findings fixed

Round 4 verdict was DO NOT SHIP on two residuals of the round-3
start-truncated work: the `event_window` path and one missing provenance
mark.

| # | Fix | Where | Regression test |
|---|---|---|---|
| R4-F1 | Start-truncation now requires **boundary-state evidence**, not timestamp equality: `compressor_first_on_t > compressor_first_stateful_t` (the first stateful reading is itself OFF). A request-supplied `event_window` whose verbatim start coincides with an ON first reading was observed running at the boundary — no truncation claim, no self-contradicting story. `describe_event_window` now produces `last_stop_t` from its final clipped off-run, so a genuine OFF→ON→OFF override anchors on the observed trailing stop instead of "later in the period". RULES.md §5 gained the boundary-state-evidence sentence in the same commit | `compute/summary_facts.js`, `compute/events.js`, `RULES.md` | `check_chart.js` round-4 block: ON-boundary override → not truncated, no "already off" anywhere; OFF-boundary override → truncated, `last_stop_t` equal across BOTH event constructors and rendered on the tile ("off again Jul 1 10:00Z") |
| R4-F2 | The intervening "first seen running <ts>" conclusion carries `comp_c(f)` — it is a coldhead inference exactly like the state claims around it | `render/narrative.js` | GE-inference truncated fixture asserting ᶜ on all three conclusions ("already off when the data beginsᶜ", "first seen running …ᶜ", "stopped again …ᶜ"); the Philips scanner-reported fixture asserts the whole story carries no mark |

Also closed from the round-4 gap list: event_window start-truncated
coverage (both boundary states), `last_stop_t` verified across both event
constructors, and a GE-inference start-truncated fixture with a
no-mark counterexample. Still accepted: non-TIM cabinet suspect tile,
`narrative_overrides` geometry, and live DB reruns recorded here rather
than executed by the reviewer (both probes re-run after this round:
SME20122 compact/banner/171px, SME20292 normal/`OFFᶜ`/61px, unchanged).
