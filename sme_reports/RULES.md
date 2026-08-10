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

| Vendor | Field | Source table | "Running" means |
|---|---|---|---|
| Philips | `cryo_comp_malf_value` | `mag.philips_mri_monitoring_data_agg` | `= 0` running; `> 0` (alarm minutes) off; **`−1` (cable error) = state UNKNOWN**, treated as null — verified live: systems whose only readings are −1 are online and healthy, and mapping cable error to "off" manufactured month-long false stops (SME15805/09/11). Real stops read as climbing positive alarm-minutes |
| GE | EDU `comp_vib_status` **where the system has an EDU reporting it** (a direct measurement, per-system priority — 132 of 144 fleet systems have one); otherwise `coldhead_ruo_value` | `edu.v2`/`v3`, else `mag.ge_mm3`/`ge_mm4` | EDU: vibration `= true`. Fallback: `< 10 K` — an inference; GE scanners report no compressor column. Inferred rows carry the ᶜ mark |
| Siemens TIM | `compressor_status` | `mag.siemens` | text `= 'ON'` |
| Siemens non-TIM | `comp_vib_status` | `edu.v2` / `edu.v3` | vibration sensor `= true` |

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
| `pressure rising` | rate > 0.001/hr **and** current ≥ 60% of the alert line |
| `stable / healthy` | none of the above |

## 3. Thresholds

Not hardcoded — pulled per system from `alert.models`
(`user_id = 'default'`, enabled, operator `greater_than` / `less_than`).

| Vendor | Primary metric field | Helium field |
|---|---|---|
| Philips | `he_psi_avg_value`, `monitor_magnet_pressure_value` | `helium_level_value` |
| GE | `he_pressure_value` | `he_level_value` |
| Siemens TIM | `mag_psia_value` | `he_level_1_value` |
| Siemens non-TIM | `shield_temp_value` | `he_level_1_value` |

- **High** severity drives the red chart line, tile colors, and classification;
  **medium** only softens a tile to amber.
- Where multiple rows exist, the most conservative wins (lowest
  `greater_than`, highest `less_than`).
- OEM constants are used only when a system has no default models.
- Display units come from `mag.*_units` per system.

## 4. Per-field rules

| Field / concern | Rule |
|---|---|
| Helium thresholds | Applied only when `threshold_units` matches the system's display units (LTRS systems are not judged against % thresholds) |
| Helium status | Below high alert → red; below medium → amber; drop >0.2 pts vs baseline reads "falling" |
| Event peak scope | Extends **24 hrs past recovery** — pressure keeps climbing after a restart (SME19034 peaked 16 hrs after the compressor came back). Peak/rate anchor on the primary event; the baseline additionally excludes every *other* event window + the same 24 hr lag |
| Request `event_window` override | The hand-supplied start/end are used verbatim, but cycles, readings, and off-hours are recounted from the readings **inside** it — a run crossing either boundary contributes only its in-window part. A window containing no OFF readings reports "no OFF readings in the specified event span" and is not classified as a compressor stop, and contributes no history to the fleet compressor cell |
| Missing baseline | If exclusion leaves no clean pre-event reading, the baseline is **null** — never the first reading, which may sit inside an excluded event. Delta-vs-baseline and ramp rate drop out with it and the page says so, rather than reporting a rise from a value the magnet never rested at |
| Rate | Only calculated over ramps longer than 30 min |
| Temp alarm (Philips `cryo_comp_temp_alarm_state`) | Active when >0; contiguous runs counted so re-fires are reported as re-fires |
| Quench (Philips `quenched_state`) | `= 1` |
| Coldhead warm | GE ≥10 K; Siemens ≥55 K (different sensor, different baseline) |
| Cabinet temp (non-TIM `cca_cab_temp_value`) | Judged against the system's own `cca_cab_temp_warn_value` / `_alarm_value` reported on each row |
| Stale / flagged NOW on the brief | Every now-value tile (PRESSURE NOW, HELIUM, COLDHEAD, CABINET) applies two checks, conviction or no conviction. A channel whose **last raw reading fails its plausibility bounds** shows that raw value greyed with **‡** and judges nothing — the fleet columns' exact treatment, so the two documents show the same number for the same broken sensor. A clean channel whose **newest plausible reading is >24 h older than the period end** prefixes its sub-line with "as of <day>" rather than passing an old reading off as current (pre-release the tile showed the raw garbage; post-screen it silently showed an old clean value — both wrong). The prefix composes with the sensor-suspect claim wording; the helium tile steps aside for a recorded quench |
| No compressor state | A period with zero compressor readings from ANY source — scanner channel null/cable-error and no sufficient EDU (see EDU priority, §6) — renders the tile as **"— / no compressor state reported"** — never a green ON, which is a health claim fabricated from no data |
| Clock skew | Median \|capture − host\| > 15 min gets a data note; charts always use capture time |
| Chart mode | >500 captures in the window renders a daily min/max band; otherwise every capture is plotted |
| Trend wording | Current < 99.5% of peak reads "easing" |

## 5. Fleet summary

One multi-page PDF covering every system in a batch run, separate from the
per-system briefs. Built from a distilled record per system
(`compute/summary_facts.js`); the per-system view model never crosses into it.

| Concern | Rule |
|---|---|
| Severity order | Same priority as the classification in §2: ongoing stop → recovered stop → threshold exceeded → rising → stable. An unrecognized condition sorts **last**, never first |
| Needs attention | Everything except `stable / healthy`. A recovered compressor stop still cost the magnet hours of warming, so it counts — but it reads amber, not red, and does not count as **urgent** (ongoing stop or live threshold breach) |
| Naming | The **% OF LIMIT** column is present tense — the current reading as a share of the limit. The **PEAK OVER LIMIT** condition is past tense and fires on the window's peak, so a row can carry it while currently reading well under. The two deliberately do not share a word, and the same label is used on the overview, the vendor tables and the summary email |
| Reader-facing terminology | Rendered text never says "window" — most readers picture glass. The report's date range is the **period** (defined in the legend, with the actual dates in the heading and every footer); a compressor event's shaded interval on the charts is an **event span**. "Window" survives only in code identifiers and this document |
| Legend | A bordered three-column glossary pinned to the bottom of the cover defines every term and mark the document uses without inline explanation — including per-system vocabulary (flicker) a reader meets on the briefs. It fully replaced the prose paragraph that preceded it; nothing is explained twice |
| Metric-named header | The value column is titled by its datum — **HE PRESSURE**, or **SHIELD TEMP** on non-TIM where "pressure" would be a lie — with **% OF LIMIT** beside it and hairlines fencing the pair. Units live in the section heading (the alert limit names them); the column has no room for "HE PRESSURE (PSI)". Helium, coldhead and cabinet carry their **own** limits, expressed as color, and the legend says so. An earlier design spanned a group banner over a "NOW" sub-column; once the column carries the metric name itself, the banner was redundant and the header flattened to one row |
| Where the limit is stated | Each section heading names the limit its percentages divide by (`alert limit >5.2 PSI, floor 0.5`, or `alert band 14.4–16.4 PSI` for a centered band), repeated on continuation pages, with a count of systems measured against something else — those rows print their own limit inline. Units live there too rather than in the column header, which has no room |
| Cross-vendor comparison | Native reading with its own units, plus a dimensionless **% of that system's own high alert line**, which is the only pressure figure comparable across mbar / gauge PSI / absolute PSIA / K |
| Two alert lines | A low line at **< 50% of the high line** is a floor alarm under a one-sided metric (GE 0.5–5.2 PSI), so the percentage still applies. At or above that ratio it is a centered band (Siemens 14.4–16.4 PSIA, normal ~15.3) where a percentage would call a healthy magnet "93% of line" — those rows draw a **miniature band gauge** instead: a dot positioned between the system's own two alert edges under a **WITHIN BAND** column title, centered = healthy, amber in the outer tenth, and self-relative so no own-limit bracket is needed. Banded rows sort by distance from band center, mirroring % OF LIMIT's worst-first. A breach in either direction outranks the gauge and reads **over**/**under** in red. A section MIXING banded and one-sided rows titles the column **VS ALERT LIMIT** — WITHIN BAND over a percentage cell (or % OF LIMIT over a gauge) would lie about half its rows; each cell already shows which display it is |
| OEM-default thresholds | Marked with `*`: the percentage is against a vendor constant, not a configured line |
| Vendor sections | One section per variant, carrying only channels that variant has — Philips has no coldhead, only non-TIM has cabinet temp, shield temp exists only for GE and non-TIM. No column is dashes all the way down |
| Quench | Recorded independently of the primary metric, so a quenched magnet can carry a normal pressure and classify `stable / healthy`. It is an **overlay** on the archetype, not a value of it: a quenched system always counts as attention and as urgent, sorts to the top of the attention list, and states QUENCH in its helium cell. The summary and batch emails grade the same distilled record, so their condition cells lead with an unmarked red QUENCH too — an email can never call a quenched magnet "stable / healthy" while its own headline counts it urgent |
| Urgent vs listed | `threshold exceeded` fires on the window's **peak**, so it is historical. Urgency is about **now**: an unrecovered stop, a quench, or a reading currently outside its own line. A system that spiked and has since settled is listed, not urgent, and its reason cites the peak that triggered it rather than the current value |
| Breach direction | Each alert line is tested independently, so a config with only one side cannot be compared against a null (which coerces to zero and calls every healthy reading a breach). Where a percentage exists it is shown in red — 194% carries the magnitude that "over" does not; the word is used only when there is no number |
| Failure identity | Grouped failure rows expand into fixed-size chunks of system ids so every failed system stays named. Cells cannot wrap, so one row per group would ellipsise most of the ids away — and naming them is the section's whole purpose |
| Summary-only runs | Require `batch_email.summary_pdf`: the fleet document is the only output, so a run without it produces nothing. A rendering failure is fatal in that mode, and soft only for normal batches where per-system briefs are still valid deliverables |
| Exclusions | A top-level `exclude` list in the request file drops systems before any DB pull — e.g. the seven RF/SC service-station magnets, which are real hardware but not fleet. Never silent: the loader reports what it removed, the cover sub-line counts it, and the document names every excluded id with the request's note. Every system missing from the report is findable as a failure, a data issue, or a named exclusion |
| Left-censored stops | An ongoing stop with **no ON reading before it began**, on a channel whose **coverage starts within 24 h of the period opening**, was never observed starting — it predates the period and its true start is unknown. (A channel silent until hour 199 that then reads OFF is an observed-late ongoing stop with an unknown start — real, and urgent-eligible — NOT "off the entire period".) The magnet's body decides what it is: thermal corroboration (current breach, high severity, warm coldhead, or rising trend) → **OFF ENTIRE PERIOD** (amber, listed, never urgent — after a month off the magnet is already warm; nothing is left to page anyone about); no response at all → **no compressor signal**, a data issue. An observed stop stays urgent however long it has run. Its compressor cell reads "entire period", never a fabricated hour count |
| Inference screening | A derived value is only as good as the reading it was derived FROM: a GE compressor state inferred from an implausible coldhead reading is **unknown**, not "off" — the rejected reading cannot manufacture a stop or urgency through its derivative |
| Channel identity | Siemens non-TIM has ONE physical shield sensor mapped into both the primary slot and `shield_k`. For plausibility accounting the alias does not exist: the reading is filtered from both metrics but counted once, shown once, and can never combine with itself into a sensor-suspect conviction |
| Plausibility bounds | Per channel, in its own units — proposals for domain review: pressure −10..10000 mbar / −1..100 PSI; primary-as-temperature 1..320 K; helium 0..100 % / 0..5000 LTRS; coldhead & shield 1..320 K; cabinet −20..80 °C. Applied **per point, before any metric**: an impossible reading three weeks ago cannot own the period's peak, trip PEAK OVER LIMIT, drive the archetype, or reach the chart. Rejected counts are stated on the brief ("N implausible readings excluded"). A channel whose latest raw reading is outside bounds keeps that **raw value**, renders greyed with ‡, and judges nothing — no breach, severity, percentage, or threshold coloring |
| Sensor suspect | One impossible reading is a flag, not a conviction — 0.00 % helium alone is what a real quench reports, and a +22-point helium jump is usually a refill. **Two+ impossible channels in the SAME capture**, or one impossible channel alongside bone-dry helium in that same row, convicts the monitoring chain — two impossible readings weeks apart prove nothing about each other. Conviction rides the **latest capture**: a garbage row three weeks ago followed by clean data is history, not a current outage. Convicted systems move to **DATA ISSUES** with all raw readings shown (✕ on the failed ones). A recorded quench overrides suspect — missing a real quench is the costlier error |
| Sensor suspect on the brief | The per-system brief applies the same conviction (`last_suspect`) with the same override (a recorded quench wins): a grey bordered **banner between the sub-line and the tiles** — labeled with `conditions.js`'s shared `sensor data suspect` + ᶜ — states the rejected-reading count, that the latest capture combines impossible values, and that the values below are the sensor's claims; it defines ᶜ and ‡ inline (the brief has no legend). Every tile then suspends judgment: a channel whose last raw reading failed its bounds shows that **raw value greyed with ‡** ("outside plausible bounds — not judged", the fleet's exact treatment); clean channels keep their value but render grey with "sensor's claim — not judged" — 0.00% helium on a convicted chain must not shout a red emergency. The one exception is an **EDU-measured compressor** (separate hardware, outside the convicted chain): its tile stays confident, matching the fleet, which keeps the compressor cell on a sensor-suspect row. The story leads with a **Monitoring suspect** paragraph and the CURRENT card reads "(sensor's claims)". Channel flags come from one shared helper (`compute/plausible.js` `last_raw_flags`) so the brief tiles and the fleet columns can never disagree about which sensor is emitting garbage |
| Data issues tier | The headline reads "N need attention, N urgent, **N data issues**". Data issues are monitoring problems, not magnet problems: they leave the attention list and the archetype rollup buckets (a dead signal no longer inflates "STOP, ONGOING") and get their own section listing system, problem, and raw readings |
| Compressor cell | State **plus** history: `ON · 4 events · ~54.5 h off`. A system with no compressor readings at all reads **no data**, never `ON` |
| Dense-table wording | Vendor tables use abbreviated condition labels and an arrow for trend (↑ rising, ↓ easing), and merge helium level with its delta. Every cell is one line: a cell that wraps changes row height, and row height is what pagination is computed from. SYSTEM, CONDITION and COMPRESSOR must never ellipsise — a truncated system id makes a row unidentifiable |
| Delivery integrity | A fatal run error — bad request file, failed fleet render in summary-only mode, failed send — exits nonzero so a scheduler can see it; per-system failures stay isolated and never sink the batch. An all-excluded request still produces (and counts the page for) the document naming its exclusions. Every DB- or error-derived string is HTML-escaped before entering an email body |
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
| Siemens TIM | `compressor_status` text | reported | coldhead (warm ≥ 55 K); position in the absolute-pressure band |
| Siemens non-TIM | EDU `comp_vib_status` | **measured** — a vibration sensor on the compressor, though on separate (EDU) hardware; absent entirely on EDU1 units | shield temp (this vendor's primary metric); cabinet temp |

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
  (measured) outranks the inference and fills in when a scanner channel
  yields almost nothing (fewer than 24 stateful readings) (the cable-error Philips trio turned out fully measurable
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
| EDU-over-inference priority | **Verified live**: SME22099 carries 1,440 comp_vib readings (dense as the mag data); SME15805/09/11 — unreadable via their cable-errored scanner channel — each carry ~1,440 too, and 15809's EDU exposed a real 15 h stop the inference era missed. The 24-reading floor is **symmetric**: a nearly-empty EDU cannot displace dense inference, and a nearly-empty scanner channel (< 24 stateful readings) cannot displace a sufficient EDU — one stray malf reading is not coverage |
| The causal-chain model itself | **General cryogenics knowledge, not any project document.** Corroborated empirically: the fleet's bimodal coldhead clustering, and predictions later verified against ground truth (cable-error systems healthy, station magnets warm-and-settled). The right reviewers are the service engineers who stand next to these magnets |
