# Handoff — per-system brief parity with the fleet summary's data-quality rules

You are picking up work in `/home/matt-teixeira/hep3/reports` (branch `DEV`,
clean tree as of commit `8d2a611`). Read `sme_reports/RULES.md` first — it is
the rule-of-record — then `sme_reports/REVIEW-HANDOFF-PRECOMMIT.md` for how
the recent release was built and reviewed. This document scopes the NEXT
piece of work: an investigation already done, and implementations awaiting
decisions.

## The system in one paragraph

`npm start sme_report -- ./requests/<file>.json` renders one-page,
customer-facing "Magnet Health Brief" PDFs per MRI system (Philips / GE /
Siemens TIM / Siemens non-TIM) and, for batches, a multi-page fleet summary
PDF, from Postgres telemetry. Both documents render from the SAME
`build_render_model` (`sme_reports/render/model.js`) — the brief through
`render/page.js` + `render/tiles.js` + `render/narrative.js`, the fleet
through a distilled record (`compute/summary_facts.js`) into
`render/fleet_model.js` / `fleet_page.js`. Dev checks are hand-run
`node:assert` scripts: `node sme_reports/dev/check_compute.js`,
`check_chart.js` (brief/model level), `check_fleet.js` (fleet, includes real
Chromium geometry measurement). All pass at handoff. There is no test
framework and no mocking; live runs need `.env` + Postgres.

## What just changed (and flows into the brief automatically)

The recent release added, at the SHARED model layer:

- **Per-point plausibility screen** (`compute/plausible.js`): impossible
  readings are excluded from every metric, peak, trend, archetype, and chart
  before anything is computed. The brief's foot line says
  "N implausible readings excluded".
- **Inference screening**: GE compressor state inferred from a rejected
  coldhead reading is unknown, not "off".
- **Per-system compressor source priority**: EDU `comp_vib` (a vibration
  sensor on the compressor — measured) outranks the GE coldhead inference
  and fills in for starved scanner channels (< 24 stateful readings),
  symmetric 24-reading floor both ways. The narrative appends
  "(per EDU vibration sensor)" when EDU-sourced.
- **Philips malf −1 = cable error → unknown**, never OFF.
- Fleet-only concepts the brief does NOT have: sensor-suspect conviction,
  left-censored stop overlays (OFF ENTIRE PERIODᶜ / no signalᶜ), the ᶜ
  provenance mark, the ‡ greyed-raw-value treatment, and the DATA ISSUES
  tier.

## Investigation findings (verified on live data, 2026-08-10)

Three live briefs were rendered (probe request pattern below) and compared
against the same systems' rows in the fleet summary:

**1. SME20122 (Heart of Texas, GE) — THE REAL PROBLEM.** The fleet convicts
its sensor chain: `DATA ISSUES · 158 impossible readings — sensor suspectᶜ`,
raw values shown greyed (−3.625 PSI ✕, 383 K ‡). The BRIEF for the same
system claims, with full confidence: `COMPRESSOR OFF · off ~42.5 h`,
`HELIUM 0.00% below the 50% alert level` (red), `PRESSURE NOW 1.218 PSI`.
Two documents, same reader, opposite stories — the fleet says "monitoring is
down, not the magnet"; the brief reports a live helium emergency. The only
breadcrumb is the foot line's "158 implausible readings excluded".

**2. Stale "NOW" presented as current.** SME20122's `PRESSURE NOW 1.218 PSI`
is the last PLAUSIBLE reading — from **Aug 5**, five days before the report
— shown with no flag or timestamp. Pre-release the tile showed the raw
(garbage) current value; post-release it silently shows an old clean one.
The fleet's answer to the same problem is the greyed raw value with ‡. The
brief needs one of: the fleet's raw-greyed treatment, an "as of <date>"
caveat when the newest plausible reading is older than N hours, or a
sensor-suspect banner that reframes every tile (see item 1).

**3. No ᶜ provenance on the brief.** SME20292's fleet row reads `OFFᶜ`
(coldhead-inferred); its brief tile reads `COMPRESSOR OFF` unmarked, and its
narrative carries no inference caveat (narrative.js:17 only annotates the
EDU case). The ᶜ convention (RULES.md §6) currently stops at the fleet
document and summary email — but urgent recipients are pointed at the brief.

**4. Left-censored stops: fleet-only.** A left-censored system's brief would
still headline `COMPRESSOR STOP — ONGOING` with a large off-hours figure
where the fleet says `OFF ENTIRE PERIODᶜ` (or data-issues it as
`no compressor signalᶜ`). No live case exists today (the station magnets are
excluded; SME11221 turned out EDU-measurable — its brief now correctly tells
a measured `recovered · 20 cycles` story), so this path is fixture-verified
only, but the disagreement is latent in the code paths.

**5. What is already coherent** (verified live, no action): EDU-sourced
briefs (SME11221 recovered-stop story matches fleet), the plausibility
screen's effect on charts/peaks (SME20122's chart no longer scaled to
garbage; EVENT PEAK sane), foot-line exclusion counts, clustering, the
brief email's "Data period" wording.

## Candidate work items (decide with the user before implementing)

P1. **Sensor-suspect treatment on the brief** — biggest honesty gap. Design
    question: a banner/overlay that reframes the page ("monitoring suspect —
    readings shown are the sensor's claims, not magnet state"), vs. per-tile
    greying with ‡ like the fleet, vs. both. Must fit the ONE-PAGE
    constraint (see below).
P2. **Stale-NOW flagging** — "as of Aug 5" (or raw-greyed) whenever the
    displayed reading is not from the newest capture; interacts with P1.
P3. **ᶜ marks on brief tiles/narrative** for coldhead-inferred compressor
    state, mirroring RULES.md §6 (and a legend line on the brief, which
    currently has no legend).
P4. **Left-censor overlays on the brief** — reuse `conditions.js` vocabulary
    (`effective_status`, STATUS_LABELS) so the two documents literally share
    the words.
P5. **Parity regression tests** — extend `check_chart.js` with a
    suspect-system fixture asserting the brief does NOT claim confident
    magnet state (whatever design is chosen), and a left-censored fixture
    for the brief path.

## Constraints and conventions you must keep

- **The brief is ONE page, hard** (`pageRanges: "1"`, `.page { height: 11in;
  overflow: hidden }`). Anything added must be measured in Chromium, not
  assumed — silent clipping was this project's worst historical bug. Follow
  `check_fleet.js`'s Range-based measurement pattern if you add geometry
  assertions for the brief.
- Shared vocabulary lives in `sme_reports/conditions.js`; the fleet, both
  emails, and any new brief overlay must use it — no drifting labels.
- Reader-facing text: "period" never "window"; "event span" for chart
  shading; "triggered"/"threshold exceeded", never "fired".
- Every rule change lands in `RULES.md` in the same edit (it is reviewed by
  the team and by external code review).
- Fixtures must mirror REAL shapes: push raw rows through
  `sme_reports/normalize.js` mappers rather than hand-building normalized
  series where practical; hand-built `facts` stubs must carry the full
  current contract (`raw_last`, `implausible`, `last_suspect`,
  `compressor_first_stateful_t`, …).
- `requests/fleet-summary.json` and other request files may carry REAL
  recipients — never run them for testing. Probe pattern (no email, no PDF):

  ```json
  { "reports": [ { "report_type": "magnet_health", "system_id": "SME20122",
      "recipients": ["dev@example.com"],
      "output": { "html": true, "pdf": false, "email": false, "archive": false } } ] }
  ```

  Output lands in `sme_reports/out/Avante-<SME>-Magnet-Health.html` (dated
  when PDFed). Live probe systems for each state today: SME20122 (sensor
  suspect), SME20292 (coldhead-inferred ongoing stop), SME22099 / SME11221
  (EDU-measured), SME15805/09/11 (cable-error scanner channel, EDU
  fallback).
- Commit style: short imperative subject; end the message with
  `Co-Authored-By:` for the assistant. External code review (Codex) rounds
  use handoff docs like `REVIEW-HANDOFF-PRECOMMIT.md` — write one if the
  change is substantial.

## Suggested opening move

Reproduce the SME20122 disagreement (fleet row vs brief) yourself, then take
P1's design question to the user with 2–3 concrete options (ASCII mockups of
the brief with a suspect banner vs greyed tiles help). Implement only after
they choose. P2 likely falls out of P1's design; P3/P4 are separable.
