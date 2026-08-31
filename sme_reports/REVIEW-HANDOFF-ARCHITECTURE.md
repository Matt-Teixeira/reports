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

---

## Adoption outcome (recorded 2026-08-14, series complete)

The findings above were verified claim-by-claim, triaged, and implemented
as the check-gated series recorded in `REVIEW-HANDOFF-HARDENING.md` (four
review rounds, sixteen commits `ea9352e`..`521c22d`, every round's
findings fixed same-round). Summary of dispositions:

**Adopted and landed:**
- **Parity harness** (`dev/parity.js`): pinned-window byte-diff witnesses
  (brief HTML, fleet HTML, records, and production-pass facts via a
  dev-only run_one observer) — every refactor claim below was measured.
- **Finding 1 (fail-open routing), narrowed then hardened:** the "silently
  queries Siemens tables" scenario was blocked by two accidental
  loud-failure seams; all lookups now fail closed BY DESIGN (series,
  units, widths, plausibility bounds), the fleet vendor partition is a
  runtime assertion, and VENDORS ≡ units_queries is check-pinned.
- **Finding 7 (per-channel thresholds) — the one live bug:** configured
  helium limits were silently discarded on systems without pressure
  models (4 reporting systems; SME15805 was showing amber over a breached
  50% helium alert). Per-channel resolution with per-channel provenance;
  units resolve order-independently and conflicting units fail closed.
- **Finding 2 (analysis in rendering):** pure `compute/analyze.js`
  extracted verbatim; the compute→render import cycle broken
  (`compute/judgments.js`); summary-only runs never touch a renderer
  (43-system scoped run ~15s). `{facts, views}` is the seam future report
  types consume.
- **Finding 4 (condition registration), partially:** ARCHETYPES is a
  closed registry classify validates against at runtime; SEVERITY_ORDER ≡
  ARCHETYPES and story coverage are executable checks; narrative fails
  named. The full findings[]/definition-registry redesign stays
  trigger-gated (below).
- **Finding 8 (duplication register), corrected then landed:** one
  STALE_MS, one is_inferred (a CLOSED provenance registry after round 2),
  one GE warm_k, EDU accumulator order-safe, solver SETS derived from
  SECTIONS while measured NEEDS stay independent. Codex's "fleet_page is
  a fourth copy" was wrong (it consumes; SECTION_W was already
  assertion-guarded); the real gap was the unimported solver.
- **Finding 6 (limited coverage), implemented** per user decisions: closed
  token-boundary allowlist (Hitachi/Canon/Toshiba/Americomp), identity +
  EDU records that are stated and never judged (explicit is_limited gates
  everywhere), a measured-geometry LIMITED section closing the document,
  counts beside — never inside — the analyzed tally, loud brief refusal.
  Live effect today: SME16940 (Canon) converts from a standing per-run
  failure into a stated row.

**Declined, as the review itself recommended:** geometry to config; a
universal declarative engine for adapters/cell renderers; the
duplications that ARE the safety mechanism (measured expectations vs CSS,
RULES.md prose vs constants, curated copy).

**Documented-only, with named triggers:**
- **Channel registry** — trigger: the next new magnet channel, or a third
  threshold metric (e.g. the deferred EDU detections' thresholds).
- **Condition/finding definition registry + central reducer** — trigger:
  the stuck-probe / probe-vs-room divergence detections.
- **Vendor descriptors** (the data.js/normalize/SQL branches collapse
  into registry entries) — trigger: vendor #5 graduating from limited to
  full support; port the existing four and prove parity first.
- **Report adapter / first-class report_type** (cache key, artifact
  names, sidecar + sends columns via ADD COLUMN IF NOT EXISTS, and the
  fanout coalition key codex round-0 missed) — trigger: a second report
  type commissioned.
