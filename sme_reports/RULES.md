# Magnet Health Brief — Detection Rules

Every rule the report applies, the field it reads, and the constant behind it.
Roughly 50 rules total. Only two of them discard data — compressor rule 5
(flickers) and the plausibility screen in §5 (impossible readings) — and both
say what they dropped; the rest group, classify, or color.

Source of truth: `compute/events.js`, `compute/archetype.js`,
`compute/metrics.js`, `compute/series.js`, `compute/plausible.js`,
`compute/summary_facts.js`, `conditions.js`, `render/tiles.js`,
`render/model.js`, `normalize.js` (vendor row mapping), `data.js`.

## 1. Compressor state — the "suspect" checks

The compressor signal is vendor-specific; there is no single field.
Terminology: Siemens variants are named by magnet temperature — **4K**
(formerly "TIM") and **10K** (formerly "non-TIM"). Internal identifiers
(`SIEMENS_NON_TIM`, `mmb_siemens_non_tim`, config routing) keep the old
names; only reader-facing wording changed.

| Vendor | Field | Source table | "Running" means |
|---|---|---|---|
| Philips | `cryo_comp_malf_value` | `mag.philips_mri_monitoring_data_agg` | `= 0` running; `> 0` (alarm minutes) off; **`−1` (cable error) = state UNKNOWN**, treated as null — verified live: systems whose only readings are −1 are online and healthy, and mapping cable error to "off" manufactured month-long false stops (SME15805/09/11). Real stops read as climbing positive alarm-minutes |
| GE | EDU `comp_vib_status` **where the system has an EDU reporting it** (a direct measurement, per-system priority — 132 of 144 fleet systems have one); otherwise `coldhead_ruo_value` | `edu.v2`/`v3`, else `mag.ge_mm3`/`ge_mm4` | EDU: vibration `= true`. Fallback: `< 10 K` — an inference; GE scanners report no compressor column. Inferred rows carry the ᶜ mark |
| Siemens 4K | `compressor_status` | `mag.siemens` | text `= 'ON'` |
| Siemens 10K | `comp_vib_status` | `edu.v2` / `edu.v3` | vibration sensor `= true` |

**The EDU is primary, the vendor field is the backup, per reading**
(`compute/analyze.js`, 2026-11-05). Every EDU `comp_vib_status` reading is
used. A vendor reading stands in only where no EDU reading falls within
**45 minutes** of it, so an EDU outage never blanks a stretch the scanner
can still speak for. A vendor reading that repeats the previous reading's
`host_datetime` is a frozen feed re-sending a snapshot and never fills a
gap. Both checks see past the window's edges: `data.fetch_boundary_context`
fetches EDU readings within 2 h of each edge, and the latest vendor rows
before the window regardless of age (up to `BEFORE_ROWS` = 336, from the
same table, by a query derived from the series file in `sql/sql.js`).
Siemens 10K gets its shield rows' predecessor too, for the thermal stale
filter. The context is optional: a failed lookup never fails the report
(`boundary.js` `with_context_fallback`); it continues without context and
the run log's note records `boundary_context: "unavailable: …"`.
`analyze_system` uses them only for EDU proximity and the previous host time (an EDU reading at 23:40
covers a vendor reading at 00:10; a first in-window reading repeating the
last pre-window host time is stale). They never become readings, events or
chart points. Measured on a fixed 7-day window: no fleet verdict changed. A system with no EDU readings at all uses the vendor channel alone,
unchanged. The facts carry `compressor_source` (the primary: EDU whenever it
reported), `compressor_backup` (`{ source, readings, inferred }`, or null)
and `compressor_last_source`. The ᶜ mark applies when any reading came from
the GE coldhead inference (`compute/provenance.js` `comp_inferred`), and the
brief names the backup beside "per EDU vibration sensor". The System
Activity page draws backup readings lighter in the Compressor strip and
the vendor channel, every capture, as a second strip. Its expected-alert
rule for the compressor model follows the EDU only: a backup reading never
makes a compressor alert expected (`incident/timeline.client.js` `rule`). Every default
compressor alert model watches the EDU sensor, so the report judges the
signal the detections come from.

**An EDU "off" is never overruled; it is annotated** (`compute/corroborate.js`,
2026-11-05). Every event holding EDU off readings gets
`ev.corroboration = { type, secondary, thermal }`:
- `secondary`: the fresh vendor reading nearest each EDU off reading, within
  45 min. `off` if any read off, else `on` if any read running, else `none`.
- `thermal`: `warming` if pressure rose ≥ 2% of `high_gt` in the 2 h after
  the event start (baseline: upper median of the 2 h before, else of the
  event's first 3 points; ≥ 2 points past the bar, or the only point), or
  any plausible coldhead ≥ `vendor.coldhead.warm_k` during the event.
  `steady` if those windows hold fresh readings, else `unknown`. Rows
  repeating the previous `host_datetime` are excluded.
- `type`: `confirmed` (secondary off, or warming); `doubtful` (secondary on
  and steady); else `unconfirmed`.

`facts.compressor_corroboration` is the system type (confirmed if any event
is, doubtful only if all are). The archetype, attention and urgency are
unchanged: the type only annotates. The brief adds a lead sentence for
doubtful ("Based on other data, it may not have been off: …") and
unconfirmed stops, and nothing for confirmed ones. The fleet and email
reason (`render/fleet_model.js` `attention_reason`) starts "may not be off ·"
or "unconfirmed ·", ahead of the fleet cell's 46-character truncation, and
the legend defines both. Backup-only stops and vendor-only systems carry no
type. The corroboration runs on the off readings of the event's REAL
off-runs only (the ones `off_count` counts), never on flickers inside its
span. It also returns `detail`: `edu_off`, `sec_off`, `sec_on`,
`sec_missing`, `sec_stale` (no fresh scanner reading, only a frozen one),
`pressure` (`baseline`, `peak`, `epsilon`, `readings`, `above`, or null),
`pressure_frozen`, and `coldhead` (`max`, `warm_k`, `readings`, `frozen`;
null where the vendor has no warm bar). The System Activity page renders it
as a **Compressor stops** section (`incident/system_page.js`
`stops_section`), one card per EDU-reported stop in the window: the type,
the times in Eastern, a one-line lead, one line per channel with its
numbers against their bars (a frozen channel is called frozen, not silent),
and the reason for the type. The section is absent when the window holds no
EDU-reported stop. When the brief's primary stop is doubtful or unconfirmed but the
period is confirmed (another stop is), the note adds "Another stop this
period is confirmed by other data.", because the summary reason carries the
period's type and shows no qualifier. A stop card whose off readings
include backup readings splits its count ("5 off readings (2 from the EDU,
3 from the magnet monitor where the EDU was silent)"). The 2 h window is
the flicker rule's constant held to the stop's
start: measured over a whole multi-day stop, SME16380's ordinary ~0.2 PSI
daily swing passed for warming. SME19528 is
the case that forced it: on Oct 26 2026 its Siemens status text read OFF for
an hour while the EDU read running, so the report showed a stop no alert
could see. The status text then froze, `host_datetime` stuck for four days,
while the EDU kept reporting. The two sensors can disagree, and the activity
page draws both.

Six rules run over those readings, in order:

1. **Null readings are skipped** — they carry no state, so they neither start
   nor break a run. A GE state whose coldhead reading failed the §5
   plausibility bounds is treated as null here (Inference screening): a
   rejected reading cannot drive its derivative.
2. **Consecutive "off" readings are grouped into runs.** A run is one event,
   not N events.
3. **Run of 2+ readings (≥1 hr) → accepted as real.** No further checking.
4. **Trailing run with no recovery → accepted as real.** A drop at the end of
   the window could be the start of an ongoing stop, so it is never
   suppressed.
5. **Single-reading run → suspect, must be corroborated.** Take the last
   primary-metric reading before the drop, find that metric's peak within
   **2 hours** after it, and require a rise of **≥2% of that system's own high
   alert threshold** (≈1.6 mbar on an 80 mbar Philips line, ≈0.1 PSI on a
   5.2 PSI GE line). Responded → real. No response, or no threshold configured
   to scale against → **flicker**.

6. **Real runs more than 48 h of ON time apart are separate events**
   (`EVENT_GAP_MS`; the gap is next stop minus previous recovery, and a gap
   of exactly 48 h stays one event). Each event's `off_hours` is summed off
   time across its runs — not the first-stop-to-last-recovery span — where
   each run counts its reading span **plus one median capture period**, so a
   single-reading stop counts as one period rather than zero. That trailing
   period is **capped at the actual time to recovery**, so a dense burst of
   captures inside an otherwise sparse series can never report more downtime
   than elapsed between the stop and the restart. Downtime is never measured
   to the next ON reading (on sparse cadences that charges the whole ON gap
   to the event) and, for an ongoing stop, never past the last reading plus
   one period — so it cannot accrue window-end or future hours.
   The report anchors on the **primary** event: an ongoing event always wins
   (alert bias); otherwise the longest, ties going to the most recent. The
   primary is the longest, *not* necessarily the worst — the story says so
   rather than calling it the most significant. All events are shaded on the
   charts and counted on the tile and in the story.

Corroboration — which channels vouch for a compressor claim, per vendor, and
what each constant rests on — is consolidated in §6.

Flickers are excluded from the event windows, the condition classification, and
the summary attention list. They appear only as a footnote on the tile and in
the story. Because clustering runs on real runs only, a flicker can never
bridge two events.

## 2. Condition classification

Priority-ordered; first match wins.

| Condition | Rule |
|---|---|
| `compressor stop — ongoing` | event with no recovery |
| `compressor stop — recovered` | event with recovery |
| `threshold exceeded` | peak ≥ high alert line, or min ≤ low line on band-alerted metrics |
| `pressure rising` | no observed compressor stop, and a **steady climb toward the line**: the least-squares line through every reading in the period rises by **≥10% of the room left below the high alert line** (line − where the fit starts), with **r² ≥ 0.5**, over **at least 24 h** of readings |
| `stable / healthy` | none of the above |

**Pressure rising — why this rule** (decided 2026-11-04, `compute/judgments.js`
`steady_rise`). The previous rule — (peak − first reading) / hours to the
peak > 0.001/hr, and current ≥ 60% of the alert line — was measured against
the whole fleet over the rolling 30 days: it flagged 12 of 146 systems, every
one a flat Siemens 4K magnet, and missed two GE magnets climbing steadily.

- **Peak − first is not a trend.** It can never be negative, so any wobble
  counts: SME12471 went 15.30 → 15.31 PSIA in its first hour and was flat for
  the rest of the week — "0.01/hr". The fitted line ignores a bump that comes
  back down.
- **60% of the line cannot fail on absolute pressure.** Siemens 4K reports
  PSIA (~15.3, atmosphere included) under a 16.4 line, and 60% of 16.4 is
  9.8. On gauge pressure it fails the other way: SME15804 climbed 1.03 →
  2.43 PSI in 30 days (r² 0.91) and stayed under 60% of 5.2. Measuring the
  rise against the room left to the line means the same on every vendor.
- **Under a day is not a trend.** A few quantized steps fit a perfect line:
  Siemens 16.35 → 16.36 → 16.37 PSIA within an hour is "40% of the room"
  to 16.4. Short explicit windows still report stops and breaches; they
  never call a rise (review F2, 2026-11-04).
- **"No observed stop" is the classifier's own test.** A hand-supplied
  `event_window` holding no OFF readings is not a stop, so the steady rise
  decides both the condition and the trend word (review F1).
- **A peak that returns to normal is not reported.** A spike that comes back
  down (SME08716 touched 16.22 against 16.4 and returned to 15.5) is a rise
  only if it crosses the line, as `threshold exceeded`. Decided with the
  report owner, 2026-11-04.

Effect at adoption (rolling 30 days): 12 systems left the attention list,
SME15799 and SME15804 joined it (48 → 38); offline-state, data-issue and
urgency verdicts unchanged across the fleet.

## 3. Thresholds

Not hardcoded — pulled per system from `alert.models`
(`user_id = 'default'`, enabled, operator `greater_than` / `less_than`).

| Vendor | Primary metric field | Helium field |
|---|---|---|
| Philips | `he_psi_avg_value`, `monitor_magnet_pressure_value` | `helium_level_value` |
| GE | `he_pressure_value` | `he_level_value` |
| Siemens 4K | `mag_psia_value` | `he_level_1_value` |
| Siemens 10K | `shield_temp_value` | `he_level_1_value` |

- **High** severity drives the red chart line, tile colors, and classification;
  **medium** only softens a tile to amber.
- Where multiple rows exist, the most conservative wins (lowest
  `greater_than`, highest `less_than`).
- Fallback is **per channel** (`compute/thresholds.js`), each carrying its
  own provenance: pressure with no configured **high** row falls back to the
  vendor OEM constant (`oem_constant`; med-only configs also fall back —
  deliberately unchanged, pending domain review); helium with no configured
  row falls back to **nothing** (`none` — no OEM helium constant exists, so
  an unconfigured helium is stated, never judged). One channel's fallback
  never discards the other channel's configured rows — the pre-fix
  all-or-nothing gate silently dropped configured helium limits on systems
  without pressure models (live: SME15805/11/16, SME20487).
- Display units come from `mag.*_units` per system.

## 4. Per-field rules

| Field / concern | Rule |
|---|---|
| Helium thresholds | Applied only when `threshold_units` matches the system's display units (LTRS systems are not judged against % thresholds) |
| Helium status | Below high alert → red; below medium → amber; drop >0.2 pts vs baseline reads "falling". Colors exist **only where a configured limit applies** (rows resolved, units matching the display): unconfigured or units-mismatched helium keeps its measured statements — level, delta, "falling" — in neutral ink, matching the fleet cell's neutrality on a null limit. A recorded quench keeps its red regardless: it is a recorded event, not a threshold judgment |
| Event peak scope | Extends **24 hrs past recovery** — pressure keeps climbing after a restart (SME19034 peaked 16 hrs after the compressor came back). Peak/rate anchor on the primary event; the baseline additionally excludes every *other* event window + the same 24 hr lag |
| Request `event_window` override | The hand-supplied start/end are used verbatim, but cycles, readings, and off-hours are recounted from the readings **inside** it — a run crossing either boundary contributes only its in-window part. A window containing no OFF readings reports "no OFF readings in the specified event span" and is not classified as a compressor stop, and contributes no history to the fleet compressor cell |
| Missing baseline | If exclusion leaves no clean pre-event reading, the baseline is **null** — never the first reading, which may sit inside an excluded event. Delta-vs-baseline and ramp rate drop out with it and the page says so, rather than reporting a rise from a value the magnet never rested at |
| Rate | Only calculated over ramps longer than 30 min |
| Temp alarm (Philips `cryo_comp_temp_alarm_state`) | Active when >0; contiguous runs counted so re-fires are reported as re-fires |
| Quench (Philips `quenched_state`) | `= 1` |
| Coldhead warm | GE ≥10 K; Siemens ≥55 K (different sensor, different baseline) |
| Cabinet temp (10K `cca_cab_temp_value`) | Judged against the system's own `cca_cab_temp_warn_value` / `_alarm_value` reported on each row |
| One-page density (brief) | The brief is one page with `overflow:hidden` — overflow clips silently — and its prose is bounded but variable (ten events, six flickers, and two alarm runs are all legitimate in one period). Pages whose flowed content exceeds a measured capacity threshold (`COMPACT_AT` in `render/model.js`, calibrated in Chromium against the normal layout's real cliff on 74 real briefs) switch to a **compact tier**. The measure counts **lines**, not characters: each timeline bullet as the whole lines it fills in its narrow column, the rx cards as their **tallest** card (they sit side by side), the banner, and a title that wraps to a second line: smaller story/card faces and shorter charts (banner pages 100→86 — was 92 until the doubtful-stop note joined the lead, 2026-11-05; at that height a y-axis whose labels would sit under 11 px apart labels every other gridline, `render/chart.js` — plain 152→128; the default chart geometry is otherwise pixel-identical to the exemplars). The other-events day list names at most 4 days ("+N more") so story length stays bounded — the event count and total off-hours stay exact. Verified by measurement on every `dev/check_chart.js` run: two maximal natural fixtures must select the compact tier, and every synthetic page must clear the footer by ≥12px in a real Chromium layout |
| Brief timeline | The story is a lead line — **Timeline (UTC):** and what the period amounts to (the condition, other events, an OPEN warming event) — then **one bullet per moment**, timestamp → note, sorted by time: baseline span, stop, alarm, peak, recovery, first flicker, latest readings. Timestamps sit in their own column so the reader scans the left edge for when; sorting puts a peak that followed the recovery after it. A narrative override (`narrative_overrides.story`) replaces the block wholesale |
| Chart time axis | The pressure and helium charts share one `x_domain` (the period) and one plot geometry, and draw a faint vertical gridline at each interior date tick — the gridlines fall on the same columns in both charts, so they read as layers over one time axis |
| Stale / flagged NOW on the brief | Every now-value tile (PRESSURE NOW, HELIUM, COLDHEAD, CABINET) applies two checks, conviction or no conviction. A channel whose **last raw reading fails its plausibility bounds** shows that raw value greyed with **‡** and judges nothing — the fleet columns' exact treatment, so the two documents show the same number for the same broken sensor. A clean channel whose **newest plausible reading is >24 h older than the period end** prefixes its sub-line with "as of <day>" rather than passing an old reading off as current (pre-release the tile showed the raw garbage; post-screen it silently showed an old clean value — both wrong). The prefix composes with the sensor-suspect claim wording; the helium tile steps aside for a recorded quench |
| No compressor state | A period with zero compressor readings from ANY source — scanner channel null/cable-error and no sufficient EDU (see EDU priority, §6) — renders the tile as **"— / no compressor state reported"** — never a green ON, which is a health claim fabricated from no data |
| Clock skew | Median \|capture − host\| > 15 min gets a data note; charts always use capture time |
| Chart mode | >500 captures in the window renders a daily min/max band; otherwise every capture is plotted |
| Trend wording | With a compressor event: current < 99.5% of peak reads "easing", else a positive event ramp reads "rising" (unchanged). Without one: a steady rise (§2) reads "rising" — and wins over "easing", so a rising system never wears ↓ — else current < 99.5% of peak reads "easing" |

## 5. Fleet summary

One multi-page PDF covering every system in a batch run, separate from the
per-system briefs. Built from a distilled record per system
(`compute/summary_facts.js`); the per-system view model never crosses into it.

| Concern | Rule |
|---|---|
| Severity order | Same priority as the classification in §2: ongoing stop → recovered stop → threshold exceeded → rising → stable. An unrecognized condition sorts **last**, never first |
| Needs attention | Everything except `stable / healthy`. A recovered compressor stop still cost the magnet hours of warming, so it counts — but it reads amber, not red, and does not count as **urgent** (ongoing stop or live threshold breach) |
| Naming | The **% OF LIMIT** column is present tense — the current reading as a share of the limit. The **PEAK OVER LIMIT** condition is past tense and fires on the window's peak, so a row can carry it while currently reading well under. The two deliberately do not share a word, and the same label is used on the overview, the vendor tables and the summary email |
| Email status block | The summary and batch emails share one status block (`output/email_status.js`), grouped by what the reader does next. **FLAGGED** is one **card** per system that needs attention, is urgent, has a data issue, or produced no report: a left bar in the condition's color, the condition as the card's heading, then system · site · make, then the summary document's own **WHY** (`fleet_model` `attention_reason` / `data_issue_reason`, so the email and the attachment explain a system the same way — the WHY is supplementary and is dropped, never the email, if a record cannot be worded). A no-report card states the audience's reason: the customer whitelist on scoped runs, the raw message on internal ones. **STABLE / HEALTHY** and **LIMITED COVERAGE** follow as compact identity lists under headings that carry the label every item would otherwise repeat. Cards sort by `attention_sort`, the fleet document's order. **Layout is fluid, with no media queries** (Gmail and Outlook drop or mangle them): the shell is a div capped at 800px and otherwise screen-wide (a `width="800"` table with `max-width:100%` did not shrink — every phone got an 808px page to scroll sideways); a card is one full-width cell, so it has no columns to squeeze; the lists split by **halves** into two inline-block columns capped at half the content width — side by side on a wide screen, stacked on a phone, and in sorted order either way. Classic Outlook (Word renderer) ignores those widths, so conditional "ghost" tables give it the fixed 800px shell and the two columns. Measured on every `check_fleet` run in Chromium at 375 / 600 / 1000px: no sideways scroll, two columns at desktop width, one ordered column at phone width |
| System Activity table | Capture slots list **newest first** — days, and slots within a day; a reader opens the page to see what is happening now. A period longer than 31 days folds its days into **month** groups: only the newest month starts open, every day starts collapsed, and **Expand all / Collapse all** open or fold both levels. A collapsed month or day still shows its marker totals |
| Reader-facing terminology | Rendered text never says "window" — most readers picture glass. The report's date range is the **period** (defined in the legend, with the actual dates in the heading and every footer); a compressor event's shaded interval on the charts is an **event span**. "Window" survives only in code identifiers and this document |
| Legend | A bordered glossary pinned to the bottom of the **last page** defines every term and mark the document uses without inline explanation — including per-system vocabulary (flicker) a reader meets on the briefs. It is **categorical** (reformat reference, 2026-08-14): three captioned columns — **A value** / **A mark on a value** / **A status label** — each entry a bold term over its description, so a reader looks a term up by what KIND of thing it is; the stale value·date rule lives under marks (not inside the EDU entry) and the own-limit bracket inside % OF LIMIT. The box measures 396.6px in Chromium, so the legend page carries at most `LEGEND_ROWS = 7` table rows (was 12 beside the old packed column-flow box). It fully replaced the prose paragraph that preceded it; nothing is explained twice. It closes the document rather than riding the cover: reference material belongs behind the findings, and pinning it to the bottom of a SHORT cover — a five-system scoped summary carrying one attention row — stranded a band of white in the middle of the page instead of collecting it at the foot. The last page's row budget is reduced by `LEGEND_ROWS` and a section whose final chunk would fill that page is re-split, so content can never run into it |
| Environmental (EDU) section | Every analyzed system whose **EDU hardware** (`config.edu` → `edu.v1/v2/v3`) reported this period gets a row in one shared **ENVIRONMENTAL (EDU)** section closing the data, regardless of vendor — the channels (room temp, humidity, probe 0/1, °F / %RH) are the same across EDU generations. Sorted **hottest room first** (environmental data is read to find the room needing the HVAC call). Each channel cell is last reading over the period range on the second line. **No alert limits are configured for these channels, so the section states readings and judges nothing** — no color, and the legend says so. Channels are **screened against EDU plausibility bounds first** (`plausible.js` `edu_temp_f` −40..150 °F, `edu_humidity_pct` 0..100): an open probe input emits its scale floor (−196.6 °F on a live unit), which must never become a channel's period minimum; drops are counted on the record (`edu.rejected`) and the legend states the exclusion. A **stale channel** — last plausible reading >24h before the period end, the same line the brief tiles' "as of" prefix draws — renders **dimmed with its reading's date beside the value** — the period range keeps its line, because the data the sensor produced while it ran is good data and is never hidden — never drives the hottest-room sort (it ranks with the unknowns), and the brief's EDU note appends "stopped <day>": an old reading must never pass as the room's current state. A system without an EDU (or whose EDU produced nothing) simply has no row; the section is absent when nobody reported. It ends the document, so it carries the legend reservation |
| Limited coverage (`assessment_status`) | Every distilled record carries `assessment_status`: **assessed** (full magnet analysis) or **limited_coverage** (`compute/summary_facts.js` `build_limited_record`). A limited system is one whose manufacturer matches the closed allowlist (`vendors.js` `LIMITED_MANUFACTURERS`: Hitachi, Canon, Toshiba, Americomp) — identified hardware with **no magnet data adapter**. Its record is identity + EDU environmental statements only: no archetype, no thresholds, no condition, no urgency — stated, never judged, enforced explicitly (`conditions.js` `is_limited` gates attention/urgent/data-issue/cell paths; `fleet_model` partitions limited rows out of every judged surface before any grading runs). The fleet document renders them in a **LIMITED COVERAGE — OTHER MANUFACTURERS** section closing the document after EDU (it takes the legend reservation when present); the cover counts them **beside** the analyzed tally ("N systems analyzed … M limited coverage"), never in it; their EDU readings live in the limited table, not the EDU section (whose reserve ladder rests on EDU members ⊆ vendor-sectioned rows). Unknown manufacturers stay hard failures — **unknown ≠ limited** (the systems table carries "TBD" rows), and a supported vendor whose data pulls fail stays a **failure**, never downgraded. **No per-system brief exists**: a brief-producing request fails loudly with a named error, worded on customer documents via the failure whitelist ("limited coverage — no per-system report exists; included in summary documents only"); in summary-only shapes the same system is a stated row. The summary email counts and words the split the same way ("every analyzed system below; N limited-coverage systems carry environmental readings only") |
| Metric-named header | The value column is titled by its datum — **HE PRESSURE**, or **SHIELD TEMP** on 10K where "pressure" would be a lie — with **% OF LIMIT** beside it and hairlines fencing the pair. Units live in the section heading (the alert limit names them); the column has no room for "HE PRESSURE (PSI)". Helium, coldhead and cabinet carry their **own** limits, expressed as color, and the legend says so. An earlier design spanned a group banner over a "NOW" sub-column; once the column carries the metric name itself, the banner was redundant and the header flattened to one row |
| Where the limit is stated | Each section heading names the limit its percentages divide by (`alert limit >5.2 PSI, floor 0.5`, or `alert band 14.4–16.4 PSI` for a centered band), repeated on continuation pages, with a count of systems measured against something else — those rows print their own limit inline. Units live there too rather than in the column header, which has no room |
| Cross-vendor comparison | Native reading with its own units, plus a dimensionless **% of that system's own high alert line**, which is the only pressure figure comparable across mbar / gauge PSI / absolute PSIA / K |
| Two alert lines | A low line at **< 50% of the high line** is a floor alarm under a one-sided metric (GE 0.5–5.2 PSI), so the percentage still applies. At or above that ratio it is a centered band (Siemens 14.4–16.4 PSIA, normal ~15.3) where a percentage would call a healthy magnet "93% of line" — those rows draw a **miniature band gauge** instead: a dot positioned between the system's own two alert edges under a **WITHIN BAND** column title, centered = healthy, amber in the outer tenth, and self-relative so no own-limit bracket is needed. Banded rows sort by distance from band center, mirroring % OF LIMIT's worst-first. A breach in either direction outranks the gauge and reads **over**/**under** in red. A section MIXING banded and one-sided rows titles the column **VS ALERT LIMIT** — WITHIN BAND over a percentage cell (or % OF LIMIT over a gauge) would lie about half its rows; each cell already shows which display it is |
| OEM-default thresholds | Marked with `*`: the percentage is against a vendor constant, not a configured line |
| Vendor sections | One section per variant, carrying only channels that variant has — Philips has no coldhead, only 10K has cabinet temp, shield temp exists only for GE and 10K. No column is dashes all the way down |
| Quench | Recorded independently of the primary metric, so a quenched magnet can carry a normal pressure and classify `stable / healthy`. It is an **overlay** on the archetype, not a value of it: a quenched system always counts as attention and as urgent, sorts to the top of the attention list, and states QUENCH in its helium cell. The summary and batch emails grade the same distilled record, so their condition cells lead with an unmarked red QUENCH too — an email can never call a quenched magnet "stable / healthy" while its own headline counts it urgent |
| Urgent vs listed | `threshold exceeded` fires on the window's **peak**, so it is historical. Urgency is about **now**: an unrecovered stop, a quench, or a reading currently outside its own line. A system that spiked and has since settled is listed, not urgent, and its reason cites the peak that triggered it rather than the current value |
| Breach direction | Each alert line is tested independently, so a config with only one side cannot be compared against a null (which coerces to zero and calls every healthy reading a breach). Where a percentage exists it is shown in red — 194% carries the magnitude that "over" does not; the word is used only when there is no number |
| Failure identity | Grouped failure rows expand into fixed-size chunks of system ids so every failed system stays named. Cells cannot wrap, so one row per group would ellipsise most of the ids away — and naming them is the section's whole purpose |
| Summary-only runs | Require `batch_email.summary_pdf`: the fleet document is the only output, so a run without it produces nothing. A rendering failure is fatal in that mode, and soft only for normal batches where per-system briefs are still valid deliverables — soft but **stated**: the summary email opens by naming the missing document and the run exits nonzero after delivery. Summary-only records are produced by the analysis layer alone (`compute/analyze`) — tiles, narrative, and charts are never built, so a presentation-side failure cannot fail a summary-only record; story/condition coverage is check-gated instead (`check_compute`) |
| Report period (`lookback_days` / `period`) | A batch-level `lookback_days` (7 for the weekly customer product; 30 default; 180 for the 6-month review) sets every report's window default; a per-report `window` — its own lookback or explicit dates — still wins. The batch's period for tags and subjects is the **EFFECTIVE** one, derived from the normalized windows after overrides — never the top-level default. A **summary batch must share one normalized analysis window** — identical `{start, end}`, not merely the same lookback: two 7-day windows ending days apart union into a heading span neither system was analyzed for (mixing is a fatal request error, not a mislabeled artifact). An **explicit window** (`window.start`/`window.end`, or one-off `--from`/`--to`; [ONEOFF.md](ONEOFF.md) "Windows") is tagged by its two ends in its own zone (`-20261001-to-20261031`, `-20261009T1400-to-20261011T1800`) and worded by its span on every surface (`periods.js` `span_text`) — never by a day count, which would be coincidence, and never untagged, which collided with the same day's 30-day artifacts; it never writes a history sidecar; zero fails validation rather than silently becoming 30; an **all-excluded run keeps the period of its excluded candidates**, so a weekly and a monthly exclusion document for the same scope can never share artifact names. Non-default periods **tag every artifact name and email subject** (`-7d` on fleet/scoped/brief archive filenames, "7-day" in the summary subject). Spans are NAMED in one shared vocabulary (`periods.js`): a span's day count, its filename tag and its subject wording live in a single entry, so a document and the email announcing it can never word the period differently — the tags and labels this table has always described are that module's output, unchanged for 7, 30 and any unnamed day count. **`period` is the named spelling of `lookback_days`** — `"6mo"` / `"90d"` / `"7d"` / a day count — accepted anywhere `lookback_days` is (batch level or inside a `window`); the two are ONE setting, so carrying both is a fatal request error rather than a precedence rule between numbers that may disagree, and an unrecognized name fails rather than falling back to 30 days and silently reporting the wrong span. The **6-month** period (`6mo` = 180 days) tags `-6mo` rather than `-180d` — a reader should not have to do arithmetic on a filename. Detection rules are period-agnostic; the left-censor never-urgent stance at 7 days is flagged for domain review in §6 terms and deliberately unchanged |
| One-off (operator-run) reports | `npm run report -- <job>` runs a job from a hand-edited config (`sme_reports/oneoff/`, documented in [ONEOFF.md](ONEOFF.md)): a customer summary by customer id, briefs for named SMEs, or the internal fleet document, on any period. The layer is **compositional only** — it builds the same raw request a request file describes and hands it to the same loader, batch runner, renderers and senders; it owns no rendering, sending, or period logic of its own, and nothing scheduled calls it. Defaults differ from the scheduled product in exactly two deliberate ways: **nothing is emailed** unless asked (the summary document is still built, so an exploratory run is safe), and **no history sidecar is written** (`archive_records` false — exploring a 6-month window must not deposit rows in the scheduled product's records series). Arguments and config keys are strictly parsed, unknown keys rejected, before any run state exists |
| Scoped (customer-facing) summary | A request-level `scope` (`{customer_id}` / `{site_ids}` / `{system_ids}`) resolves through `customers → sites → systems` (mag-processed only) — the same tables the identity query reads, so the join and the displayed names share one source. Resolution is **loud, never silent**: zero systems, unknown site ids, or non-mag system ids are fatal request errors, and the resolution (label + site/system counts) is logged and stated on the cover. The scoped document titles itself **"Magnet Health Summary — <label>"**, its rollup reads "% of these systems" (never "fleet"), and its **cover states the resolution, not just the survivors**: N systems in scope · N analyzed · N failed · N excluded · N sites. Customer-facing failure wording is a **whitelist, never a rewrite**: known classes map to reader-appropriate facts ("no monitor data received…", "unsupported system configuration"), everything else collapses to "report could not be generated" — raw errors stay in the run log and on the internal document; the scoped summary email shares the same classifier and names the scoped document in its attachment line. Exclusions stay stated on scoped documents — never-silent outranks tone. The scope is the **only authority on which systems run**: `report_defaults` cannot carry `system_id`/`report_type`, and materialized ids are asserted against the resolution. Artifact identity is **slug + scope-set hash** (`Avante-<slug>-<hash8>-Magnet-Health-Summary-<date>`): two scopes under one customer label can never overwrite each other's documents or history sidecars, and a label with no ASCII word characters gets a `Scoped-<hash8>` fallback — never the internal fleet name. The internal document is byte-unchanged by all of this |
| Exclusions | A top-level `exclude` list in the request file drops systems before any DB pull — e.g. the seven RF/SC service-station magnets, which are real hardware but not fleet. Never silent: the loader reports what it removed, the cover sub-line counts it, and the document names every excluded id with the request's note. Every system missing from the report is findable as a failure, a data issue, or a named exclusion. The statement is **bounded at the loader** (≤100 removed ids, note ≤240 chars — fatal request errors beyond) because it renders verbatim in one block that, on an all-excluded run, shares its page with the pinned legend; the block rides the failures page only when vendor sections follow (the legend then closes the document elsewhere), and takes its own page otherwise |
| Left-censored stops | An ongoing stop with **no ON reading at all**, on a channel whose **coverage starts within 24 h of the period opening**, was never observed starting — it predates the period and its true start is unknown. "Entire period" is a categorical claim and ONE observed ON reading falsifies it: an OFF→ON→OFF boundary event is instead **start-truncated** — its trailing stop was observed, anchors the wording (`last_stop_t`, the final off-run's start, produced by BOTH event constructors including the `event_window` override path), stays urgent-eligible, and only the initial run's start and earlier downtime are unknown. Truncation requires **boundary-state evidence**, not timestamp equality: the first stateful reading must itself be OFF (the first ON postdates it) — a request-supplied `event_window` whose start coincides with an ON first reading was observed running at the boundary, and nothing about its start is unknown. (A channel silent until hour 199 that then reads OFF is an observed-late ongoing stop with an unknown start — real, and urgent-eligible — NOT "off the entire period".) The magnet's body decides what it is: thermal corroboration (current breach, high severity, warm coldhead, or rising trend) → **OFF ENTIRE PERIOD** (amber, listed, never urgent — after a month off the magnet is already warm; nothing is left to page anyone about); no response at all → **no compressor signal**, a data issue. An observed stop stays urgent however long it has run. Its compressor cell reads "entire period", never a fabricated hour count |
| Inference screening | A derived value is only as good as the reading it was derived FROM: a GE compressor state inferred from an implausible coldhead reading is **unknown**, not "off" — the rejected reading cannot manufacture a stop or urgency through its derivative |
| Channel identity | Siemens 10K has ONE physical shield sensor mapped into both the primary slot and `shield_k`. For plausibility accounting the alias does not exist: the reading is filtered from both metrics but counted once, shown once, and can never combine with itself into a sensor-suspect conviction |
| Plausibility bounds | Per channel, in its own units — proposals for domain review: pressure −10..10000 mbar / −1..100 PSI; primary-as-temperature 1..320 K; helium 0..100 % / 0..5000 LTRS; coldhead & shield 1..320 K; cabinet −20..80 °C. Applied **per point, before any metric**: an impossible reading three weeks ago cannot own the period's peak, trip PEAK OVER LIMIT, drive the archetype, or reach the chart. Rejected counts are stated on the brief ("N implausible readings excluded"). A channel whose latest raw reading is outside bounds keeps that **raw value**, renders greyed with ‡, and judges nothing — no breach, severity, percentage, or threshold coloring |
| Sensor suspect | One impossible reading is a flag, not a conviction — 0.00 % helium alone is what a real quench reports, and a +22-point helium jump is usually a refill. **Two+ impossible channels in the SAME capture**, or one impossible channel alongside bone-dry helium in that same row, convicts the monitoring chain — two impossible readings weeks apart prove nothing about each other. Conviction rides the **latest capture**: a garbage row three weeks ago followed by clean data is history, not a current outage. Convicted systems move to **DATA ISSUES** with all raw readings shown (✕ on the failed ones). A recorded quench overrides suspect — missing a real quench is the costlier error |
| Sensor suspect on the brief | The per-system brief applies the same conviction (`last_suspect`) with the same override (a recorded quench wins): a grey bordered **banner between the sub-line and the tiles** — labeled with `conditions.js`'s shared `sensor data suspect` + ᶜ — states the rejected-reading count, that the latest capture combines impossible values, and that the values below are the sensor's claims; it defines ᶜ and ‡ inline (the brief has no legend). Every tile then suspends judgment: a channel whose last raw reading failed its bounds shows that **raw value greyed with ‡** ("outside plausible bounds — not judged", the fleet's exact treatment); clean channels keep their value but render grey with "sensor's claim — not judged" — 0.00% helium on a convicted chain must not shout a red emergency. The one exception is an **EDU-measured compressor** (separate hardware, outside the convicted chain): its tile stays confident, matching the fleet, which keeps the compressor cell on a sensor-suspect row. The story leads with a **Monitoring suspect** paragraph and the CURRENT card reads "(sensor's claims)". Channel flags come from one shared helper (`compute/plausible.js` `last_raw_flags`) so the brief tiles and the fleet columns can never disagree about which sensor is emitting garbage |
| Left-censored stops on the brief | The brief applies the same classifier (shared `offline_state`, quench overrides) instead of headlining `COMPRESSOR STOP — ONGOING` with a fabricated hour count. **Corroborated warm** → amber compressor tile `OFFᶜ` / "off entire periodᶜ · start predates the data" (amber, matching the fleet's never-urgent stance) and a story that leads "The compressor was off the entire periodᶜ — already off at the first compressor reading…", with no start time, no hour count, and no OPEN-event alarm line. **No signal** → the data-issue banner pattern ("NO COMPRESSOR SIGNALᶜ — …the signal, not the compressor, is the likely fault"), compressor tile `—` / "no compressor signalᶜ", and unlike sensor-suspect the other channels keep their judgments — only the compressor channel is convicted. Labels come verbatim from `conditions.js` STATUS_LABELS; the CURRENT card states the overlay instead of ON/OFF. When the overlay verdict is **suppressed** (quench override, suspect precedence) the censoring FACT still renders: "off at every reading this period · start and downtime unknown", never a fabricated start or hour count. A **start-truncated** event (OFF→ON→OFF from the boundary) is narrated from its observed facts — "already off when the data begins … first seen running <ts>, then stopped again <ts>" — with observed off-hours, never "every reading" or "entire period" |
| Data issues tier | The headline reads "N need attention, N urgent, **N data issues**". Data issues are monitoring problems, not magnet problems: they leave the attention list and the archetype rollup buckets (a dead signal no longer inflates "STOP, ONGOING") and get their own section listing system, problem, and raw readings |
| Compressor cell | State **plus** history: `ON · 4 events · ~54.5 h off`. A system with no compressor readings at all reads **no data**, never `ON` |
| Dense-table wording | Vendor tables use abbreviated condition labels and an arrow for trend (↑ rising, ↓ easing), and merge helium level with its delta. No cell ever WRAPS — row height is what pagination is computed from — but a cell may carry a fixed small-grey second line (site's city/state, system's SME id under a customer id, compressor's event history, data-issue passing readings), all styled by one shared rule. The compressor history is **capped text** so its column width is a closed claim: counts past 99 read "99+", hour totals lose their half-hour decimal from 100h and read "999+h" past 999 (exact figures live on the brief). SYSTEM, CONDITION and COMPRESSOR must never ellipsise — a truncated system id makes a row unidentifiable. Where a system has a **customer id** (`systems.cus_sys_id`), the SYSTEM cell leads with it in bold with the SME id beneath in small grey — the customer's own tag outranks ours on a customer page. The id line steps its font 8pt → 7pt → 6pt (measured, `charw8`) to render in FULL rather than truncate; only an id too wide even at 6pt for its section's column ellipsises, and the SME id beneath always stays whole |
| Scheduled (DB-config) runs | `npm start sme_report` with no file argument matches the current slot (shared `tools/schedule_dt.js`, the alert.reports convention) against **`alert.sme_reports`** template rows and fans out; `--slot` / `--config <id>` / `--dry-run` are the operator overrides. A `user_summary` row with **no scope is a SUBSCRIPTION: the audience is the row's author** — the frontend contract is one row per subscribed user, owned by them (duplicate authors across rows are expected, as in alert.reports); `{"users": […]}` names a set (pilots/admin) and `{"all_users": true}` is the admin-wide tool. All variants resolve against `public.users` (active, `notify_email`, ≥1 magnet) — standing filters still apply, nobody is force-mailed past their opt-out — and a **named subscriber who does not resolve gets an error sends row** stating why, never a silent nothing — and never fails the run, whether alone or beside valid subscribers (an `all_users` row resolving to nobody stays fatal: that is a config aimed at an empty universe). The customer boundary is checked **three times**: at planning (the ownership map), at resolution (current `customer_ids` must equal the planned customer), and again **post-render for EVERY unit — dry included** — a document is never archived, shipped, or even named by a dry-run row under a stale customer identity. Archival is gated on **eligibility**: only units with at least one live, access-eligible recipient (per the send-time cache snapshot) archive their PDF **and** their history sidecar (both deferred past the checks), still before any SMTP; skipped and error rows archive nothing and name no document. **SMTP truth is isolated from telemetry**: only the send itself can produce a delivery failure — logging failures after an accepted send are best-effort noise, never error rows. Digest zips are built at **private per-send unique paths** (the recipient sees the clean name), and cleanup is best-effort — a cleanup failure never changes a send outcome. All `user_summary` rows firing on one slot **coalesce** (per identical lookback+options): one audience, one document plan, shared renders across subscribers, while each user's sends rows attribute to **their own** config row and honor **their own** `dry_run` gate. Within a coalition, systems compute **once per window** (a shared per-run cache) and `run_batch` runs systems **concurrently** (worker pool; file mode unchanged at concurrency 1). The **document unit is (customer × system-subset), never a cross-customer merge**: each user's magnet scope is partitioned by owning customer (`systems → sites → customers`), a multi-customer user gets one document per customer, and a document is forward-safe by construction. Users sharing a (customer, subset) share one rendered document. Delivery is **one digest email per user** carrying all their customer documents — zipped when more than one, split into "part n/N" emails only when the attachments outgrow the message budget (minimizing email count is the packaging priority); each document's sends row is graded from its part's SMTP accepted list. A **send-time re-check** of the recipient's current `system_list_cache` (and status) skips, per document, anything their access no longer covers (`skipped_access`). **Partial delivery is deliberate**: one customer's failed document yields an error row for that unit while the user's other documents still go out. New rows are **inert by construction** (`enabled` false + `dry_run` true); dry runs execute everything but SMTP and never archive. A derived (`user_summary`) row **rejects `cc_list`** — a CC would receive every scope-group's document with no access check. CLI arguments are **strictly parsed before any run state exists**: a typo'd `--config` aborts, it can never fall through to the live slot batch. Every ENVELOPE recipient — To and CC — gets one **`alert.sme_report_sends`** row per attempt (sent / error / skipped_access / dry_run, with `recipient_role`), carrying the scope hash and the **archived, run-unique document name** (`…-run-<id>.pdf`, copied before sending — out/ is scratch and a same-day rerun must not change what a sends row names; dry-run rows carry the scratch name of what WOULD have sent). SMTP, persistence, and rendering are **separate error boundaries**: a record-write failure after a delivered email is a persistence failure that fails the run — it never fabricates an "error" row for a sent message — and failure backfills cover only recipients with no recorded outcome, so no recipient ever carries contradictory rows. A row or group that dies before delivery still writes error rows for its whole intended audience. Grouping identity is the **canonical id set, never the hash** (a real 8-hex collision existed; the hash — now 16 hex — is artifact metadata). Isolation: a failing row never sinks other rows, a failing scope-group never sinks other groups, and the process exits nonzero if ANY failed. Config `options` are a contract — unknown keys are rejected, never ignored. `options.system_pages` (`true` / `"internal"` / `"external"`, customer_summary and fleet_summary rows only — rejected on user_summary) adds the per-system **System Activity pages** — packaged per `options.system_pages_format` (`"app"`, the default: one file per zip part listing every flagged system; or `"pages"`: one file per system) — built by `run_batch`, zipped, part 1 on the row's summary email and parts 2..N as follow-ups to the same envelope; zips are removed after delivery, dry or live. The row's whole envelope must pass `incident/page_policy.js` — the **pilot gate** (only the listed pilot addresses) and, for internal pages, **@avantehs.com only** — checked at validation (dry rows too) and again at send time, where a refusal withholds the pages but not the summary |
| Delivery integrity | A fatal run error — bad request file, failed fleet render in summary-only mode, failed send — exits nonzero so a scheduler can see it; per-system failures stay isolated and never sink the batch. An all-excluded request still produces (and counts the page for) the document naming its exclusions. Every DB- or error-derived string is HTML-escaped before entering an email body |
| Cover lead | The cover's lead sentence ("155 systems analyzed — 106 need attention, 3 urgent, 1 limited coverage.") wraps to two lines once the counts grow, and the cover's attention-row budget used to assume one line: found live on the first 6-month fleet document (2026-08-14), the wrapped sentence pushed the last attention row 8px past the footer, clipped silently by `overflow:hidden`. The cover therefore **RESERVES** the second line unconditionally (`ATTENTION_FIRST_PAGE` 24 → 23) rather than predicting each document's lead width — the row budget stays a constant, with no font metric in the render path and no way for a future edit to the wording to reintroduce the clip. It costs one attention row on covers whose lead does fit; that row is the price of never clipping one. The reservation is sound only while two lines is the CEILING, so `check_fleet` asserts it (the longest sentence the counts can produce, four digits in every clause, measures ~1007px against a 1440px two-line budget) and measures a real wrapped-lead cover in Chromium every run. The sentence is composed in one place (`render/lead.js`) so the page and the checks read one definition. Period-independent — a long attention list is what wraps it; a 6-month window only makes long lists ordinary |
| Pagination | Deterministic: rows are chunked in JS into fixed 8.5×11in pages, so page count is known before rendering and Chromium never chooses a break. The logo lockup appears on the cover only — Chromium re-embeds the image on every page it appears on, which costs ~520 KB per sheet |

## 6. Corroboration and provenance

One physical chain underlies every rule in this document: the **compressor**
drives the **coldhead** (base ~4 K), the coldhead keeps the **helium** liquid
(~4.2 K), and liquid helium keeps vessel **pressure** low and the **shield**
cold. Break any link and every channel downstream warms or rises together —
which is why no single reading is ever trusted alone, and why the same
cross-checking pattern repeats across all four vendors.

### How each vendor's compressor claim is vouched for

| Vendor | Compressor signal | Directness | Corroborating channels |
|---|---|---|---|
| Philips | `cryo_comp_malf_value` | reported by the system (`0` OK, `>0` alarm minutes; `−1` cable error = unusable) | He pressure response; temp alarm |
| GE | EDU `comp_vib_status` where present (**measured** — a vibration sensor on the compressor itself); else **inferred** from `coldhead_ruo_value ≥ 10 K` | per-system: measured for the ~132 systems with an EDU; an inference for the rest — a failed coldhead under a running compressor reads identically in that one channel | He pressure, shield temp and helium level; a real stop shows all three moving in lockstep (SME20292: coldhead 4→146 K, pressure 0.94→2.71 PSI, shield 43→138 K over 9 h) |
| Siemens 4K | `compressor_status` text | reported | coldhead (warm ≥ 55 K); position in the absolute-pressure band |
| Siemens 10K | EDU `comp_vib_status` | **measured** — a vibration sensor on the compressor, though on separate (EDU) hardware; absent entirely on EDU1 units | shield temp (this vendor's primary metric); cabinet temp |

### Where corroboration is itself a rule

| Rule | What must agree before the report believes it |
|---|---|
| Flicker (§1 rule 5) | A single-reading "off" counts only if the primary metric rose ≥2% of the alert limit within 2 h — a real stop warms the magnet; a sensor blip does not |
| Left-censored split (§5) | "Off all period" is a real, finished stop only if the magnet's body agrees (current breach, high severity, warm coldhead, or rising trend). A calm, cold magnet under an "off" signal convicts the signal, not the compressor |
| Sensor suspect (§5) | Channels convict each other: two or more impossible readings at once means the monitoring chain is down, not the magnet — one impossible reading alone may be a catastrophe telling the truth |
| GE compressor state (§1) | The inference above — and every GE "OFF" this report prints inherits its caveat |

### The ᶜ mark — provenance made visible on the page

A raw reading claims nothing beyond itself — "15.51" needs no provenance
mark. State words do: they can look measured while being concluded. The fleet
document therefore marks **conclusions, and only conclusions**, with a
superscript **ᶜ**; everything unmarked is a direct reading or arithmetic on
one. The mark appears exactly where the foundation is inference or
corroboration:

- **ONᶜ / OFFᶜ** per row wherever the state is the coldhead inference — a GE
  system without an EDU. Compressor source is per-SYSTEM: EDU vibration
  (measured) is primary over the inference and over every scanner channel,
  reading by reading, with the vendor channel filling EDU gaps; a system
  whose gaps were filled by the coldhead carries the mark (the cable-error Philips trio turned out fully measurable
  via EDU — one of them had a real 15 h stop hiding behind "no data").
  Measured and scanner-reported states are unmarked; on today's fleet that
  splits 132 unmarked to 12 marked.
- Overlay condition labels — **OFF ENTIRE PERIODᶜ**, **no signalᶜ**,
  **sensor suspectᶜ** — which are corroborated deductions by construction.
- Corroboration-derived reasons ("magnet already warmᶜ", "no magnet
  responseᶜ"). An observed stop's reason ("compressor off ~9.5 h") is
  unmarked: its off-runs were read, not concluded.
- The summary email's condition cells carry the same mark, so the two views
  cannot disagree about foundations.
- The per-system **brief** carries the same mark wherever it states a
  coldhead-inferred compressor state: the tile value (**ONᶜ / OFFᶜ /
  RESTARTEDᶜ**), the CURRENT card, and the narrative's state words
  ("the compressor stoppedᶜ … (inferred from coldhead temperature)").
  Measured (EDU) and scanner-reported states stay unmarked. The brief's one
  legend line lives in the DATA NOTES card, only on pages that carry a mark;
  a sensor-suspect banner defines ᶜ and ‡ inline instead.

The legend defines the mark in one line. Marking everything "d" was
considered and rejected: ~1,500 marks per document on cells nobody doubts
would train readers to ignore the one mark that matters.

Which sources count as inferred is ONE shared predicate
(`compute/provenance.js` `is_inferred`) consumed by the brief tiles, the
narrative's state words, and the fleet compressor cell — the surfaces
cannot disagree about which states are concluded rather than read. The
24h staleness line is likewise one shared constant
(`compute/staleness.js` `STALE_MS`) behind the tiles' "as of" prefix, the
EDU "stopped <day>" clause, and the fleet EDU section's dimmed cells.

### Provenance — what each constant rests on

Three kinds of foundation, deliberately distinguished so future readers know
which claims are measured, which are inherited, and which await a domain
sign-off:

| Constant / claim | Foundation |
|---|---|
| GE `< 10 K` = running | **Inherited** from pre-project code; consistent with fleet data (healthy GE coldheads cluster at 4.0–4.6 K, warm ones at 50 K+, nothing lives between) — never formally blessed by service engineering |
| Philips `−1` = cable error → state unknown | Database DDL comment, then **verified live**: SME15805/09/11 read only −1 for a month while online and healthy |
| Flicker 2% / 2 h, 48 h event gap, centered-band ratio 0.5, capture-period downtime rule | **Project constants**, validated against live fleet behavior and exemplar reports during development |
| Siemens coldhead warm ≥ 55 K (and its use as left-censor corroboration) | **Inherited** vendor constant; note SC-Station 2 sat at 53.7 K — 1.3 K under the bar — and classified differently from its warmer siblings, so the bar's exact value matters and deserves review |
| Plausibility bounds (§5) | **Domain-physics assumptions** (a cryogenic shield cannot read 382.8 K; gauge pressure cannot read −3.6 PSI), deliberately loose; proposals for domain review |
| EDU-primary priority | **Verified live**: SME22099 carries 1,440 comp_vib readings (dense as the mag data); SME15805/09/11 — unreadable via their cable-errored scanner channel — each carry ~1,440 too, and 15809's EDU exposed a real 15 h stop the inference era missed. Since 2026-11-04 the EDU also outranks scanner-reported channels (SME19528: a Siemens status-text stop no alert could see, then a frozen feed). Since 2026-11-05 the merge is per reading: EDU wherever it reported, the fresh vendor reading where no EDU reading lies within 45 minutes. Fleet measurement, 7 days to 2026-11-05, with the EDU-off annotation: 35 systems switch source, 4 use backup readings; SME24237 and SME18359 go to stable (scanner stuck, scanner stale), SME16380 and SME12152 become "may not be off", SME01109 and SME15809 "unconfirmed" (docs/MAGNET-HEALTH-DATA-AND-RULES.md §5.1) |
| The causal-chain model itself | **General cryogenics knowledge, not any project document.** Corroborated empirically: the fleet's bimodal coldhead clustering, and predictions later verified against ground truth (cable-error systems healthy, station magnets warm-and-settled). The right reviewers are the service engineers who stand next to these magnets |
