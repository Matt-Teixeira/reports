# Code Review Request — visual refresh of the summary document

You are reviewing **uncommitted working-tree changes** on branch `DEV` of this
repo (`/home/matt-teixeira/hep3/reports`). Review with `git diff` (plus the
untracked files listed below). Your findings will be handed back verbatim to
another assistant to fix, so make each one self-contained and reproducible.

## What this codebase does

Generates customer-facing "Magnet Health" PDFs for ~163 MRI magnets across four
vendor variants (Philips, GE, Siemens TIM, Siemens non-TIM) from Postgres
telemetry: one-page per-system briefs, and a multi-page summary document that
renders in two variants from one codebase — the internal all-fleet document and
the scoped customer-facing variant, which is the flagship weekly deliverable.

The costliest class of bug is one that **silently misstates or omits a system's
state**. In this series specifically, the costliest bug is **geometry**: `.page`
is a fixed 8.5×11in with `overflow: hidden`, so content past the bottom is
clipped with no error, and that class of bug once dropped 40 of 150 systems off
page bottoms with every assertion green.

## What this series does

A **restyle** of the summary document. Semantics, wording, condition colors and
every data rule are unchanged; no compute file was touched. Three things
changed visually, plus one structural move requested by the product owner.

| Change | Where |
|---|---|
| Table chrome: navy header slab → white header with a navy under-rule; zebra fill removed in favor of per-row hairlines; horizontal cell padding `.05in → .035in` | `render/fleet_page.js` CSS |
| Rollup tiles: grey tubs → white cards capped by a rule in **the same** `c.color` their count already uses | `render/fleet_page.js` CSS + `overview_body` |
| SITE column widened by a measured reallocation; `CELLS` weights moved to a ~100–300 scale | `render/fleet_page.js` `CELLS` |
| **Legend moved from the cover to the bottom of the last page** | `fleet_page.js` (`LEGEND`, `build_fleet_page`), `fleet_model.js` (`LEGEND_ROWS`, `reserve_tail`), `RULES.md` |

Constants re-derived by measurement: `ATTENTION_FIRST_PAGE 15 → 24` (the legend
no longer claims the cover's bottom), and the new `LEGEND_ROWS = 12`.
`ROWS_PER_PAGE` / `ROWS_FIRST_PAGE` are deliberately **unchanged**: vertical
padding and `tbody tr { height: .28in }` were held fixed precisely so the row
budget would not need re-deriving. Vendor row height moved 32.2px → 32.7px from
the border change, and 25-row pages still measure 96% fill.

## Where to look hardest

1. **`reserve_tail` in `fleet_model.js`.** The legend is `position: absolute`
   pinned above the last page's footer, so the last page must not also be a
   full table. `reserve_tail` re-splits the final chunk of whichever page group
   ends the document. Please attack:
   - the group-selection ladder (sections → exclusion page → failures → data
     issues → overview). Is "sections are last whenever any exist" actually
     true of `build_fleet_page`'s page order in every case?
   - the exclusion branch: when `excluded && !failure_pages.length` an
     exclusion page is pushed and deliberately gets **no** reservation, on the
     grounds that a heading plus one line always leaves room. Is that true for
     a long `exclude` id list with a long `exclude_note`? That text wraps.
   - when exclusions ride the **last failures page** (`failure_pages.length`
     truthy), the reservation is computed for the failures group but the
     exclusion block is appended to that page afterward, adding height the
     12-row budget did not account for. I suspected a real gap here and then
     built the case: no vendor sections, 34 distinct-reason failures, 40
     excluded ids with a deliberately long note. It holds — the last page
     measures 66% fill with 270px of slack, because a 12-row failures table is
     far short of a full page. So the reservation is adequate *today* by a wide
     margin, but nothing asserts it, and the margin is incidental rather than
     designed. Worth a view on whether it should be explicit.
   - `page_count` is computed after the re-split, but verify the split cannot
     desynchronize footers (`page N of M`).
2. **`LEGEND_ROWS = 12` is a single number for a legend whose height is not
   fixed.** It is measured against the current legend at the current font size.
   Nothing asserts the legend actually FITS the reserved room — the geometry
   pass asserts content does not overrun `.pin`, which catches it from the
   content side only. Is there a case where the legend itself is taller than 12
   rows' worth (e.g. a narrower page, a longer term)?
3. **Column widths.** `dev/solve_widths.js` solves the `CELLS` weights against
   per-section measured needs with 4px of headroom. The needs table in that
   file is a **snapshot of live data on 2026-08-12**. Consider: what happens
   next week when a site name, a compressor history string, or a helium value
   renders wider? SITE absorbs nothing — it is already over — so the failure
   mode is a protected column (`COMPRESSOR`, `CONDITION`) starting to
   ellipsise. `check_fleet` only measures the synthetic fixture, so it catches
   this only if the fixture's values are at least as wide as live ones. Are
   they? I widened the fixture's attention list but not its cell contents.

   **This already bit once, and it is the best worked example of the risk.**
   The `line` column has three possible headers — `% OF LIMIT` (54px),
   `WITHIN BAND` (66px), and `VS ALERT LIMIT` (74px), the last worn when a
   section MIXES centered-band rows with one-sided ones. Neither the fixture
   nor a single-customer probe produced a mixed section, so I sized the column
   at 178 units and shipped a header truncated by 5px into a real customer
   document (Senator International — the seven RF/SC service stations the
   internal document excludes, which is why nothing else surfaced it). Fixed by
   sizing `line` for the widest header it can ever wear (212 units, costing
   SITE ~11px) and by giving the measured fixture one banded row per vendor so
   all four sections now render the mixed header. Verified the new fixture
   fails on the old width: `{"VS ALERT LIMIT (header)": 4}`.
   **Please look for the same shape of mistake elsewhere** — any column whose
   header or content varies by data rather than by vendor. `CONDITION` is the
   one I would check first: its labels come from `conditions.js` and overlay
   states, and I sized it at 110px from observed data, not from the longest
   label the vocabulary can produce.
4. **The gate's coverage.** I changed the fixture (records 28–43 became
   attention-bearing) because with ~20 attention rows it never filled the cover
   and could not see `ATTENTION_FIRST_PAGE` regressions — the previous value
   measured 100% full with **one pixel** spare on the live document while
   `check_fleet` reported green. Check that this fixture change did not weaken
   any other assertion that depended on the old condition mix.
5. **Two variants.** Every change must hold for both the internal and scoped
   documents. `check_fleet` lays out both. The scoped variant's cover is now
   sparse by design (whitespace collects at the foot); confirm nothing depends
   on the legend being on page 1.

## What I verified, and how

All five checks pass:

```
node sme_reports/dev/check_scope.js
node sme_reports/dev/check_config.js
node sme_reports/dev/check_compute.js
node sme_reports/dev/check_chart.js
node sme_reports/dev/check_fleet.js     # 13 pages, 622 KB
```

Plus live probe renders of **both** variants against the production database
(no email, no archival — the probe pattern), measured in Chromium and
screenshotted:

| Document | Result |
|---|---|
| Internal fleet, 144 systems, 30d | 12 pages (was 13). Cover 97% fill / 28px slack at 24 attention rows. Vendor pages peak at 96% / 42px. No row clipped, no content overrunning a footer |
| Scoped Lee Health, 5 systems, 7d | 2 pages. Cover 37% fill with the whitespace at the foot rather than mid-page |

Per-column measurement (`dev/colbudget.js`) across the live fleet document, a
scoped customer document, and the mixed-section customer: SITE is the **only**
over-budget column, at 62–69px allotted against 177–198px needed. Every
protected column clears with ≥3.9px headroom. Baseline for comparison: SITE was
52–58px. It still ellipsises; what it bought is the second line (city, state),
which previously truncated too and now renders in full on every row.

A further 10 real customer documents were measured (produced by an operator
`--config 2` run against this code): every page under 90% fill, no protected
column truncating, legend fitting every last page. Three of them exercise the
zero-analyzed-systems path (all systems failed) — cover renders the loud
resolution line and "No systems produced data", with the legend on page 2.

## Deliberately not done

- **SITE still truncates.** The product owner's explicit instruction was to
  accept truncation rather than surrender a column or a line of data. The
  alternatives measured and rejected: folding the trend arrow into the reading
  (~18px, needs a RULES.md change), and putting site and city on one line
  (gains vertical density, makes horizontal truncation *worse*).
- **The per-system brief is untouched.** Out of scope per the visual-refresh
  handoff; `check_chart` still passes unchanged.
- **`email_theme.js` is untouched.** No palette value changed — the PDF's new
  neutrals (`#DCE4EB`, `#E6EAEE`) are rule colors, not brand colors. The
  summary email keeps its zebra striping deliberately: border rendering is
  unreliable across mail clients in a way it is not in Chromium, so the PDF's
  hairline treatment should not be ported there. Please push back if you
  disagree.

## New untracked dev tools

`dev/measure.js` (per-page fill + ellipsis census), `dev/colbudget.js`
(allotted-vs-needed per column per section), `dev/shoot.js` (screenshot each
`.page`), `dev/solve_widths.js` (solves `CELLS` against measured needs). None
are wired into the gate; they are the measuring instruments behind the numbers
above. Judge whether any of them should become assertions instead.

## Known risk I want a second opinion on

The legend now sits at the bottom of the last page **by product instruction**.
On a short scoped document that relocates the whitespace from the cover's
middle to the final page's middle — better, because the flagship first page is
now clean, but not free. An alternative not implemented: let the legend flow
directly after the last content instead of pinning it to the page bottom, so
the gap closes entirely. That is a product call, not a correctness one, but if
you see a correctness argument either way, say so.

## Addendum (2026-08-13): customer ids and per-section widths

Product asked for two additions after this handoff was written; they ride the
same series and are in the working tree with everything above.

1. **Brief sub-line shortened, site id leads.** The brief's sub-line is now
   `<site_id> · customer · make modality · city, state · <period span>` —
   the capture count and analyzed date were dropped (both stated elsewhere:
   footer and header). `get-system-identity.sql` now also selects
   `systems.site_id`. The `check_chart` max fixture's customer name was
   lengthened so the sub-line ellipsis assertion still exercises overflow.

2. **`cus_sys_id` in the vendor tables' SYSTEM column.** Where present
   (534 of 865 systems), the customer's own id leads the cell in bold with
   the SME id beneath in small grey. Ids run 3–19 chars; rather than
   truncate, the id line steps its font 8pt → 7pt → 6pt using a measured
   char-width table (`render/assets/charw8.js`, generated by
   `dev/gen_charw.js` — worst sum-vs-render kerning error 1.25px, covered
   by `KERN_MARGIN` 2.5).

3. **`CELLS` weights became per-section `SECTION_W` pixel tables.** The
   shared weight table made 9-column GE the binding constraint and paid
   every other section's overshoot out of SITE. Solving per section
   (`dev/solve_widths.js`, rewritten to plain per-section arithmetic)
   releases it: SITE content px went 69→95 (Philips), 68→76 (Siemens TIM),
   68→87 (non-TIM), and 62→53 in GE — the one deliberate regression, traded
   for a 74px SYSTEM column that fits GE's common 13-char digit tags in
   full at 6pt. The 19-char tail (~30 systems fleet-wide) ellipsises in GE
   only; the SME id beneath never does. `check_fleet`'s geometry pass now
   measures the two SYSTEM lines separately: the SME line joins the
   never-truncate set, the customer-id line is asserted to clip EXACTLY as
   often as the fixture predicts (4 rows fleet, 0 scoped), so both a width
   regression and a fixture that stops exercising overflow fail loudly.

Attack surface for review: the tier decision happens at build time from
summed char widths while truth happens at layout time in Chromium — the
margin between them is measured, not proven. (`SECTION_W` completeness and
its sum-to-720 invariant are asserted in `check_fleet` alongside the column
ordering, so drift there fails loudly.)

## Addendum review round 1 (codex) — outcome

Three findings, all fixed and re-verified (all five check suites green):

1. **P1 — compressor history could truncate** (Philips 93px vs a valid
   "ON 10 evt · 100.0h" needing ~107). Fixed structurally: the cell became
   the standard two-line form (state bold on top, history in the shared
   small-grey second line), and the history text is now **capped** —
   "99+ evt" past 99, integer hours from 100h, "999+h" past 999 — so the
   widest possible line is the measured 78px "99+ evt · 999+h" and the
   column width is a closed claim, not a bet on the data. `SECTION_W`
   re-solved: every SITE widened further (GE 53→70px content, now above
   its pre-refresh 62). Fixture records 28–39 render every capped form in
   every vendor section, so the geometry gate measures them.
2. **P2 — non-ASCII ids could pick too large a tier** (fallback 10px vs
   Щ ≈ 14.1px). Fallback is now 16px/char — above the widest measured
   ASCII glyph, wide Cyrillic, and fullwidth-CJK 1em — so an unknown
   character can only step the font down, never let an overwide id pass.
   Fixture record 0 carries an 8-char Cyrillic id; it renders whole at 6pt
   under the exact-clip-count assertion.
3. **P3 — exclusion content could run under the pinned legend.** Three
   layers: the loader now **bounds the inputs** (≤100 removed ids, note
   ≤240 chars — fatal request errors, tested in `check_scope`); the block
   rides the failures page **only when vendor sections follow** (legend
   elsewhere), taking its own page otherwise (`fleet_model` and
   `fleet_page` carry the mirrored condition); and the geometry gate now
   measures `.note`/`.lead`, verified against a third measured document —
   an all-excluded run at the bound maxima (100 ids + 239-char note beside
   the pinned legend). The original repro (163 ids + 300-repeat note) was
   re-run against the new gate logic and is detected (content 1013px vs
   787 usable); the loader bound keeps it from ever rendering.

Side effect worth reviewing: the second-line style rule generalized from
`.site .m, .sys .m` to `td .m`, which now also styles the DATA ISSUES
readings second line 7pt grey (it previously matched no rule and inherited
8pt). Intended — it is the same idiom — but it is a visual change to that
section.

## Addendum (2026-08-13, later): brief chart labels

Two product requests against the per-system brief's charts, in the same
working tree:

1. **Threshold lines renamed for every manufacturer.** "PHILIPS ALERT — 80
   mbar" / "GE ALERT — 5 PSI" became "UPPER LIMIT — 80 mbar" and (for
   banded metrics) "LOWER LIMIT — 14.4 PSI": the limits come from OUR
   alert.models rows, and a vendor's name on the line read as an OEM
   specification. With upper/lower explicit, the >/< glyphs were dropped.
   (`render/model.js` threshold_lines; all label assertions updated.)

2. **Chart labels are laid out, not just emitted** (`render/chart.js`).
   SME01403 shipped with "peak 74 · Jul 26" printed straight through the
   threshold label — both were fixed-position constants. Every text now
   occupies a measured box (same charw8 table as the fleet tables; the few
   non-ASCII glyphs labels use are pinned, unknown chars fall back wide);
   axis labels and the start label enter as immovable blockers; marker
   annotations try mirrored sides and larger offsets; threshold labels
   (most movable — they can sit anywhere on their line) place last, in two
   passes: first avoiding the series stroke as a soft obstacle, then
   ignoring it — a label across the data line is legible, a label across
   another label is not, and the final fallback is the historical spot, so
   layout can only improve on the old behavior.

   Verified by a new Chromium-measured audit in `check_chart`: every
   synthetic page's charts plus three adversarial charts must contain NO
   overlapping `<text>` pairs. Adversarial (a) reproduces SME01403
   faithfully — 275-mbar start stretching the domain to [0,300], peak
   under the line at the threshold label's historical x, late spike
   fouling the first relocation choice — because the first fix passed a
   looser fixture while the real chart regressed (the relaxed second pass
   above is what that taught).

   Attack surface: box estimation vs Chromium truth is the same measured
   gamble as the fleet id tiers (kerning margin), and the audit only sees
   the fixtures' geometries.

## Addendum (2026-08-13, later still): ENVIRONMENTAL (EDU) section

Product asked for an environmental section in the summary document: every
analyzed system whose EDU hardware (`config.edu` → `edu.v1/v2/v3`) reported
this period gets a row, regardless of vendor. One table — the channels
(room temp, humidity, probe 0/1, °F / %RH) are identical across EDU
generations. Sorted hottest room first. Each channel cell is the last
reading over the period range in the shared grey second line. No alert
limits exist for these channels, so the section states readings and judges
nothing; the legend says so.

Mechanics: `summary_facts` carries a distilled `edu` block (null = no row);
`build_fleet_model` builds `edu_section` inline (not in `SECTIONS` — no
condition/limit machinery); it renders after the vendor sections, ends the
document, and therefore carries the legend reservation (`reserve_tail`
ladder gained a head). `SECTION_W.EDU` gives SITE ~338px — the one table
where site names mostly survive whole — and `cell_site` skips its 30-char
server cap there. The first live render surfaced an open-probe scale
default (−196.6 °F) becoming a period minimum, so EDU channels are now
screened against new `plausible.js` bounds (`edu_temp_f` −40..150,
`edu_humidity_pct` 0..100) with drops counted (`edu.rejected`) and the
exclusion stated in the legend; `check_chart` asserts the screen, and the
`check_fleet` fixture gives every 5th record EDU data (probe-less,
humidity-less, and wide-range shapes included) through the measured
geometry pass. The fixture-uniqueness assertion's page arithmetic also got
fixed in passing — it had omitted `data_issue_pages` and only balanced by
coincidence; EDU systems now assert exactly 2 section appearances, others 1.

Follow-on (same day): per product, the fleet summary stays the clean
screened dataset and the BRIEF carries the machine-specific diagnosis. EDU
drops are now counted per channel (`edu.rejected = {room_temp, humidity,
probe_0, probe_1, total}`; the fleet record keeps only the total), and the
brief's DATA NOTES names findings per channel instead of dropping silent
lines: a screened channel shows its clean range plus "(N implausible
readings excluded)", an all-garbage channel reads "no plausible readings
(N excluded) — sensor fault likely", and a silent channel reads "no
readings this period" — the old line required BOTH probes to report before
mentioning either, so a dead probe vanished. The wording is deliberately
"implausible", never "open-sensor": the screen knows a reading broke
physical bounds, not why — a shorted probe reading 200 °F trips the same
bound as an open input at its scale floor, and naming a cause the data
cannot establish would misdiagnose it (REVIEW-HANDOFF-EDU.md carries this
as a contract). Two clean probes keep the compact "probes A–B / C–D °F"
form. `check_chart` covers partial-garbage, all-garbage, and silent-probe
shapes. Verified live on SME19034, whose two probes carry 19 and 30
intermittent implausible readings respectively — both now stated beside
clean ranges.
