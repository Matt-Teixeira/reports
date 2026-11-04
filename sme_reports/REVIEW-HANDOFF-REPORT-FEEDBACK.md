# Review Request — report feedback round (email grouping, activity order, brief timeline)

You are reviewing **uncommitted changes** in the working tree of branch `DEV`
of this repo (`/home/matt-teixeira/hep3/reports`), against HEAD `aa9ceff`.
See them with:

```
git diff aa9ceff -- sme_reports/
git status --short sme_reports/     # one new file: output/email_status.js
```

Ignore the untracked `AvanteConnected-NewMarketing.*` and `sme21284.html` at
the repo root; they are not part of this change.

This is a **correctness review**. The three changes answer reader feedback
on the shipped reports. The feedback itself is not under review. What is:
did the implementation keep the engine's invariants, and is anything now
wrong, missing, or clipped? Prior review rounds for this codebase are in
`sme_reports/REVIEW-HANDOFF-*.md`. `sme_reports/RULES.md` is the spec, and
this change edits it.

## What the codebase does (one paragraph)

`sme_reports/` generates "Magnet Health" documents for MRI systems from
Postgres telemetry:
- a one-page per-system **brief** (PDF + HTML);
- a multi-page **summary** document;
- interactive **System Activity** HTML pages/app (alert detections and
  notifications per capture slot);
- the **emails** that deliver them.

Pages are fixed 8.5×11in with `overflow:hidden`, so overflow clips
**silently**. Layout budgets are measured in Chromium and gated by the
`dev/check_*.js` suites.

## The feedback and what changed

### 1. Emails: "widen the table, it feels cramped — or go two columns"

**Files:** `output/email_status.js` (new), `output/send_summary_email.js`,
`output/send_batch_email.js`, `output/email_theme.js`

- The email shell goes from 640 to 800px (still `max-width:100%`).
- The single three-column table (every system, worst first) is replaced by
  a shared `status_html(results, { failures, reason_of })`, which renders
  three groups:
  - **FLAGGED**: a 4-column table (system, site, make, condition) holding
    `is_attention ∪ is_data_issue`, plus the batch's **failures** as
    "no report" rows. Failures used to be a separate table in the summary
    email.
  - **STABLE / HEALTHY**: a two-up grid, identity only.
  - **LIMITED COVERAGE**: the same two-up grid.
- Rows are ordered by `attention_sort`, as before.
- The summary email keeps its customer-whitelisted failure wording on
  scoped runs (`reason_of` → `customer_failure_reason`).
- The batch (briefs) email now uses the same block; it has no failures
  input.
- Judgment call: the reader suggested two side-by-side columns
  (flagged | healthy). We did not do that, because the groups are badly
  unbalanced (Intelas: 9 vs 28) and a short left column strands whitespace.

### 2. System Activity table: "sort most recent on top; group days into months"

**Files:** `incident/timeline.client.js`, `incident/timeline.js` (CSS)

- In `renderTable`, items are reversed, so days are newest first and slots
  within a day are newest first.
- When the slot span exceeds 31 days (`MONTHLY`), days nest under month
  rows (`tr.month`, `data-month` = `monthLabel` in the current zone). Only
  the newest month starts open.
- Month rows get click/keyboard toggles. The "Start where the compressor
  stopped" jump opens the target month. Expand all / Collapse all now
  covers months as well as days.
- This client runs both in standalone pages and in the System Activity app,
  which mounts one view per system.

### 3. Magnet Health Brief: "Timeline as bullets, timestamp → note; charts on the same time span"

**Files:** `render/narrative.js`, `render/page.js` (CSS),
`render/model.js` (density), `render/chart.js` (gridlines)

**Narrative.**
- Each `STORIES[archetype]` now returns `{ lead, entries }`. An entry is
  `{ t, label, html }`, built by `entry(t, html, label = fmt.ts(t))`.
- `timeline_html` sorts entries by `t` (stable) and renders:

  ```
  <p class="tl-lead"><b>Timeline (UTC):</b> lead</p>
  <ul class="tl"><li><span class="ts">label</span><span>note</span></li>…</ul>
  ```
- Timestamps moved out of the sentences into the label column. `peak_entry`
  dropped "at <ts>", `now_sentence` dropped "(<ts>)", and the flicker
  bullet is stamped at the first flicker with the others listed in its
  note.
- The "other events" sentence moved into the lead.
- `suspect_lead` still prefixes the story.
- New `readings_off` fixes "1 readings off".

**Density (the risky part).** The compact-tier trigger (`COMPACT_AT`) used
raw character counts. It now counts lines, in story-line character units
(115 per line):
- each bullet is `ceil(len/88)` lines;
- the rx cards count as their **tallest** card (`ceil(heading/24) +
  ceil(body/33)`);
- a title that wraps (over 51 characters) adds 195;
- the banner counts as raw characters, as before.

The threshold moved from 1400 to **1700**. Calibration is recorded in the
`model.js` comment:
- 37 real 6-month Intelas briefs, forced onto the normal tier: the worst
  page clips at about 1,860, and 1,700 keeps it about 22px clear.
- Validated on **147 briefs as shipped** (Intelas + Piedmont, 6-month and
  7-day): every page clears the footer by **≥27.7px**.

**Charts.**
- The two charts already shared `x_domain` and `PLOT`; they were
  pixel-aligned before this change.
- Interior x ticks now draw a faint vertical gridline, so the alignment is
  visible.

## Invariants that must hold

- **Never silent:** every system in a batch appears in the email exactly
  once (one group, one row/cell), and every failure is named.
- **Customer-facing wording:** a scoped (customer) email never shows a raw
  failure message.
- **One page, no clipping:** every brief clears the footer by ≥12px on both
  tiers (checked by `check_chart`'s Chromium measurement).
- **Stated vs judged / the ᶜ mark:** every inferred compressor-state word
  in the story still carries `ᶜ`. Measured (EDU) and scanner-reported
  states stay unmarked.
- **Story honesty** (left-censored, start-truncated, warm/no-signal,
  quench/suspect precedence, RULES.md §5):
  - no fabricated start time or downtime;
  - no "OPEN" framing for unknown timing;
  - "every reading" only when `left_censored`;
  - "has held since" only when no later event exists;
  - the baseline claim only when earned.
- **System Activity:** a standalone page and an app view behave
  identically. Nothing binds to `document`/`window` (see the header
  comment in `timeline.client.js`). Every slot remains reachable.
- **File mode and scheduled runs:** unchanged except for presentation.

## Where to look hardest

1. **Fact parity of the story rewrite.** Diff old vs new `STORIES` branch
   by branch. Did any fact, mark, or qualifier from the old paragraph get
   lost or change meaning when its timestamp moved to the label? Watch:
   - the alarm's end time;
   - the cycling "through <ts>";
   - flicker lists and counts;
   - quench wording;
   - the no-signal story's baseline;
   - the start-truncated `last_stop_t == null` fallback (labelled "Later",
     `t = first_on_t + 1`).

   Can any entry get `t` null/undefined/NaN and break the sort or render
   "Invalid"?
2. **Sort semantics.**
   - Is "time order" ever wrong to show? For example: a peak inside the
     baseline span; the alarm entry stamped at `ta.start` while it spans a
     run; a flicker during the event.
   - The baseline label is a day range but sorts at `window_start`.
3. **Density measure.**
   - It parses `story_html` with regexes. What does a
     `narrative_overrides.story` containing its own `<ul>`/`<li>` do?
   - `Math.max(0, …[])` with override cards.
   - Is `text_len` (which doesn't decode entities) close enough?
   - Fonts: calibration ran on this VM's Chromium/fonts, the same host the
     PDFs render on. Flag it if you see a reason it wouldn't transfer.
   - Is there any input where the measure **under**counts (normal tier
     chosen, page clips) that the fixtures don't exercise? For example:
     many short bullets, a long banner, long tile captions (the tiles row
     varies 84–110px and is NOT in the measure; the threshold margin
     absorbs it).
4. **Email grouping.**
   - Can a record be in two groups or none? A quench on a
     `stable_healthy` archetype; `offline_kind` warm/no_signal; limited;
     an unknown archetype.
   - The FLAGGED count (attention + data issues + failures) vs the
     headline's tiers: confusing or contradictory?
   - Escaping: `make_of` and the site/system cells.
   - Outlook/Gmail: an 800px fixed-width table, `td width="50%"`, and
     the padded odd cell.
5. **Activity client state.**
   - `expandedMonths` / `expandedDays` are keyed by labels formatted in the
     zone at the time. What happens after a zone toggle (`renderAll`)?
     The day keys had this property before; months are new.
   - DST days.
   - A month with zero visible slots.
   - `MONTHLY` computed from `slots` at mount.
   - Keyboard handling on `tr.month`.
   - The app remounting a view: the state must reset, and there must be no
     listener leak.

## How to run (all DB-free; all pass at handoff)

```
cd /home/matt-teixeira/hep3/reports
npm run -s check:compute
npm run -s check:chart          # Chromium; writes synthetic pages to sme_reports/out/
npm run -s check:fleet          # Chromium; includes the new email_status block
npm run -s check:system-pages   # Chromium; includes newest-first + month checks
npm run -s check:oneoff
npm run -s check:scope
npm run -s check:config
```

New or changed assertions:
- `check_chart`: every model built is held to the timeline contract
  (summary line present; bullets parse; time order). The truncation checks
  now read bullets by label. The page-wrapper check is tier-aware.
- `check_fleet`: the email grouping block (order, membership, counts,
  failure wording, grid padding).
- `check_system_pages`: a 70-day fixture checks month rows, only the newest
  month open, newest-first slots, and expand/collapse of both levels.

**Do not send email.** One-off jobs are no-email unless `--email` is
passed; never pass it, and never run request files carrying real
recipients. Live DB access is likely unavailable to you. Static review plus
the check suites is the expected scope.

## Deliberate tradeoffs — not findings unless you can show concrete harm

- Grouped stacked sections rather than literal side-by-side columns in the
  email (see §1).
- More 6-month briefs now select the compact tier (Intelas: 31 of 37).
  Bullets cost height; the threshold is set for no clipping, not for
  maximum normal-tier use.
- The tiles row's variable height is absorbed by threshold margin rather
  than modelled.
- The timeline stays in UTC (as before); the activity pages have their own
  zone toggle.
- The "recovered" lead reads "The compressor stopped and recovered." even
  when other events exist; the other-events sentence follows it.

## Required output — give this back verbatim

1. **Verdict**: `SHIP` / `SHIP WITH FIXES` / `DO NOT SHIP`, with one
   sentence on why.
2. **Findings** `F1..Fn`, ordered by severity
   (`blocker`/`major`/`minor`/`nit`). Each one needs:
   - the file:line;
   - a concrete failure scenario (input/state → wrong email, wrong or
     missing story fact, clipped page, unreachable slot);
   - a suggested fix;
   - your confidence. A claim you could not trace end to end gets
     `confidence: low` and says why.
3. **Story parity table**: for each `STORIES` branch, `PRESERVED` or
   `CHANGED`, listing any fact or qualifier that changed.
4. **Density audit**: inputs you believe could clip on the normal tier, or
   `none found`, with reasoning.
5. **Ran**: the exact commands you executed and their results.
6. **Test gaps**: behaviors you judged correct but found unasserted.

---

## Round-1 outcome (2026-11-04) — SHIP WITH FIXES; all three findings fixed

Still uncommitted on `DEV` against `aa9ceff`. For re-review: verify each
fix holds and that no fix introduced a new defect.

| # | Fix | Regression test |
|---|---|---|
| F1 (minor) | `now_entry` → `now_entries` (`render/narrative.js`): the latest primary reading and the latest helium reading are each stamped with their own channel's `last.t`. They stay one bullet only when one capture carries both. | `check_chart.js` "latest readings carry their own channel's time": helium stops 6 h before pressure; asserts separate labels, and one bullet when the times match |
| F2 (minor) | `output/email_status.js`: STABLE / HEALTHY is earned by `archetype === "stable_healthy"`. Any other non-flagged, non-limited record is FLAGGED with a grey "not classified" condition. | `check_fleet.js` email block: unknown archetype and missing archetype are both flagged and "not classified", and nothing renders as "undefined" |
| F3 (minor) | `incident/timeline.client.js`: a zone change re-keys `expandedMonths` **and** `expandedDays` through the slots (`rekey`), so what was open stays open under its new label. Days had this flaw before this change. `dayLabel`/`monthLabel` take an optional zone. | `check_system_pages.js` SME10010: a period ending 02:00Z Oct 1 (September in Eastern); after switching to UTC, October and September are both open. Confirmed to fail with the fix disabled |

Not a finding: Codex's `check_fleet.js:1345` failure is the pre-existing
CLI fatal-exit test. It spawns the real entrypoint and needs the app's DB
environment; in a sandbox without it, the error text differs. It passes on
the dev VM. The Chromium (`setsockopt`) and `zip` (EPERM) failures were also
sandbox limits. All seven suites pass on the dev VM after these fixes.

## Round-2 outcome (2026-11-04) — SHIP, no findings

Codex re-checked all three Round-1 fixes and found no new defect. Its
sandbox could not launch Chromium, so the browser assertions (including the
SME10010 zone-change test) ran only on the dev VM, where all seven suites
pass.
