# Architecture Review Request — modularity, config-driven vendors, extensibility

You are reviewing the committed state of branch `DEV` (HEAD `2fa616a`) of this
repo (`/home/matt-teixeira/hep3/reports`), specifically the `sme_reports/`
report engine. This is a **structural review, not a bug hunt**: assume the
code is correct (five check suites and several external review rounds stand
behind it — see the `REVIEW-HANDOFF-*.md` files). The question is whether the
STRUCTURE will hold up to the changes we know are coming, and what should
move before they arrive.

## What this codebase does

Generates customer-facing "Magnet Health" PDFs for ~865 systems (~163
actively reporting) from Postgres telemetry: a one-page per-system brief and
a multi-page summary document (internal fleet + scoped customer variants),
plus batch/summary/digest emails and DB-config-driven scheduled runs. Four
supported manufacturer variants today: Philips, GE, Siemens 4K (key
`SIEMENS`), Siemens 10K (key `SIEMENS_NON_TIM`), plus a vendor-agnostic
ENVIRONMENTAL (EDU) section. Non-negotiable invariants you must preserve in
any recommendation:

- **Never silent**: every system missing from a document is findable as a
  failure, data issue, or named exclusion; screens count what they drop.
- **Measured geometry**: pages are fixed 8.5×11in with `overflow:hidden`;
  column widths, row budgets, and the legend reservation are Chromium-measured
  constants gated by `dev/check_fleet.js` / `dev/check_chart.js`, not
  estimates. Any flexibility proposal must say who re-measures and when.
- **Stated vs judged**: judgments come only from configured limits
  (`alert.models`); channels without limits are stated, never colored.

## The changes we know are coming (review against these)

1. **New manufacturers.** The `systems` table already holds Hitachi, Canon,
   Toshiba, AmeriComp rows that today fail with "unsupported manufacturer".
2. **Manufacturer-level analysis changes** — a new channel for one vendor, a
   changed compressor inference, a vendor-specific detection rule.
3. **New analyses** — e.g. the deliberately-deferred EDU stuck-probe /
   probe-vs-room divergence detections, or a new derived metric with its own
   thresholds.
4. **New system types** — a second `report_type` beyond `magnet_health`
   (the request loader, fanout, and scheduled runner currently assume one).

## What to evaluate

### 1. The vendor-onboarding path (highest priority)

Walk "add manufacturer #5" end to end and enumerate EVERY file a new vendor
touches today. Our count includes at least: `vendors.js` (registry +
fallback thresholds), a `sql/*-series.sql` + `sql/units-*.sql`, a
`normalize.js` mapping, `data.js` routing, `render/fleet_model.js`
`SECTIONS` (column set + title), `render/fleet_page.js` `SECTION_W` (widths)
and possibly new cell renderers, `dev/solve_widths.js` `NEEDS`/`SETS`
(duplicating the column list a third time), legend entries, `RULES.md`
tables, and fixture enumeration in `dev/check_fleet.js` / `check_chart.js`.

- Is a **single vendor descriptor** feasible — one object declaring key,
  display title, SQL, normalizer, channel list (field, units, decimals,
  label, plausibility bounds, own-threshold source), column set, and
  measured width table — from which `SECTIONS`, `SECTION_W`, the solver
  sets, and the fixture enumeration derive? What breaks?
- Where does the "four keys" assumption leak? Known instance: the EDU
  section's legend-reservation ladder rests on "a record with `edu` always
  has a vendor section" (documented in `REVIEW-HANDOFF-EDU.md`); the
  hairline CSS rests on nth-child positions 4/6 holding for every column
  set. Find the others.
- The **unsupported-manufacturer posture**: today those systems fail loudly
  per-run, forever. Is there a structural middle (a "minimal vendor" that
  states identity + EDU + whatever channels normalize, judging nothing)
  that fits the stated-vs-judged rule, and what would it require?

### 2. The config/code boundary

Inventory what is DB-config-driven today (per-system thresholds in
`alert.models`, mag table routing in `config.mag`, EDU routing in
`config.edu`, scheduled runs in `alert.sme_reports`, units from `mag.*_units`)
versus hardcoded in the repo (plausibility bounds, the 24h staleness line,
display caps like "99+ evt"/"999+h", column sets, section titles, condition
vocabulary, legend text, narrative wording).

- For each hardcoded class: should it move to config? Judge by who changes
  it (operator vs developer), how often, and what guarantee it sits under.
  A width moving to config, for example, silently escapes the
  measured-geometry gate — say so explicitly where a migration would trade
  safety for flexibility, and what compensating check would restore it.
- Where per-vendor constants live in code (`vendors.js` warm_k values,
  fallback thresholds), is the layering right — DB override first, code
  constant as documented fallback? Is that pattern applied consistently?

### 3. The channel/analysis model

A "channel" today is smeared across: `normalize.js` (field mapping),
`plausible.js` (bounds), `render/model.js` (stats + screening),
`compute/summary_facts.js` (record shape), `render/tiles.js` (brief tile),
`render/narrative.js` (notes wording), `render/fleet_page.js` (cell
renderer + width), `conditions.js` (if it can drive a condition), legend,
RULES. The EDU work added four channels and touched most of that list.

- Could channels be **declarative** — a spec consumed by the screen, the
  stats, the record, the cell, and the notes — without flattening the real
  differences (helium's unit-dependent thresholds, the compressor's
  vendor-specific inference, aliased sensors like 10K's shield-as-primary)?
- For **new detections** (stuck probe, divergence): is there a natural seam
  where a detection registers itself (condition key, label, color, cell
  treatment, brief wording) or does each new one re-touch `conditions.js`,
  `fleet_model`, `fleet_page`, `narrative`, and the fixtures? Recommend the
  seam, not the detection.

### 4. Duplication registers

Name every place the same fact is written twice and what keeps them in sync
today (usually an assertion). Known: column sets (SECTIONS vs solver SETS),
widths (SECTION_W vs solver NEEDS output), the exclusion placement condition
(`fleet_model` + `fleet_page`, sync-by-comment), vendor enumeration in
fixtures, RULES.md prose restating code constants. Recommend which should
collapse to one source and which duplications are load-bearing (a check
deliberately restating a constant IS the guarantee).

### 5. Report-type extensibility

`request_loader.js`, `fanout.js`, `run_scheduled.js`, and the artifact/email
naming all assume `report_type: "magnet_health"`. Sketch what a second
report type needs: where the type dispatch belongs, what is genuinely
shared (windows, scoping, audience resolution, sends accounting, archival)
versus magnet-specific, and whether the scheduled-runs contract
(`alert.sme_reports` options validation) can carry a type field without
breaking the "unknown keys are rejected" rule.

## What NOT to do

- **This is a READ-ONLY review. Change no files.** Do not implement,
  refactor, patch, scaffold, or "demonstrate" any recommendation in the
  working tree — no matter how small or obviously correct it seems. You may
  run the check suites and read/render/measure anything; the repo must be
  byte-identical when you finish, and your report should state that it is.
  Illustrative sketches (a proposed descriptor shape, a config schema)
  belong INSIDE your findings as prose or fenced snippets, never as edits.
  Implementation happens later, as its own reviewed, check-gated series —
  by someone reading your findings cold.
- No line-level findings (naming, style, micro-perf) unless they block a
  structural recommendation.
- No proposals that weaken the invariants above without naming the
  compensating control.
- No big-bang rewrite plans. Prefer migrations that can land as the same
  kind of reviewable, check-gated series this repo already uses.

## Deliverable

Ranked structural findings, highest leverage first. For each: the friction
today (with the concrete file list a change touches), the proposed
structure, the migration path (what moves first, what check guards it), and
what it deliberately does NOT solve. Where you conclude the current
structure is already right — e.g. if the duplication IS the safety
mechanism — say so explicitly; "no change needed" is a valid finding here.
