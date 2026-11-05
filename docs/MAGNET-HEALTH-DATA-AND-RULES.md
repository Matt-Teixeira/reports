# Magnet Health Reports — Data & Rules Reference

**Purpose.** This document covers:
- every datapoint the Magnet Health reports use;
- where each datapoint comes from;
- how it is checked;
- how it is judged;
- where it appears.

It is the document the team uses to **agree** how and why we report on each
datapoint. When a rule here is wrong or unagreed, change it here first and
in the code second.

**Scope.** It covers the reports built by `sme_reports/`:
- the one-page **Magnet Health Brief** (one per system);
- the **Magnet Health Summary** (internal fleet document and
  customer-scoped versions);
- the **System Activity** pages;
- the summary and brief **emails**.

**Relationship to `sme_reports/RULES.md`.** RULES.md is the engineering
specification. It holds every edge case, the reasoning behind each fix, and
layout and delivery mechanics. This document is the agreed rule set,
organized by datapoint.
- Where they disagree, the code is what runs today.
- Raise the disagreement here.

Generated from the code on 2026-11-04 (branch `DEV`), including three
uncommitted changes:
- the trend-based "pressure rising" rule;
- explicit date-time report windows;
- the EDU vibration sensor as the primary compressor source on every
  vendor, with the scanner or coldhead as a per-reading backup (§5.1), and
  the System Activity page showing both compressor sources (§8);
- the EDU-off annotation: every EDU-reported stop is stated, then typed
  confirmed, unconfirmed or "may not be off" from the other data (§5.1).

### How to read the status column

Every rule carries one of these statuses:

| Status | Meaning |
|---|---|
| **Verified** | Checked against live fleet data and behaves as intended |
| **Decided** | Chosen by the report owner, with a date. Revisit deliberately, not casually |
| **Inherited** | Carried over from earlier code or a vendor constant. Consistent with the data, but **never formally signed off** |
| **Proposed** | A project assumption that is **awaiting domain review** (service engineering) |
| **Open** | A question this document raises for the team. See §10 |

---

## 1. Where the data comes from

The reports run **their own analysis on raw monitoring data**. They do
**not** decide anything from the alerting system's detections.

| Source | Tables | Used for |
|---|---|---|
| Magnet monitoring (raw readings) | `mag.philips_mri_monitoring_data_agg`, `mag.ge_mm3`, `mag.ge_mm4`, `mag.siemens`, `mag.siemens_non_tim` | Every magnet judgment: compressor, pressure, helium, coldhead, shield, cabinet, quench, temperature alarm |
| Display units | `mag.*_units` (per system) | The units each reading is shown and judged in |
| Environmental units (EDU) | `edu.v1`, `edu.v2`, `edu.v3`, chosen by `config.edu` | Room temperature, humidity and probes. **Also the compressor vibration sensor**, which is the **primary** compressor signal on every vendor where present (§5.1) |
| Data routing | `config.mag.pg_tables` | Which table a GE or Siemens system's data lives in |
| Alert limits | `alert.models` (`user_id = 'default'`, enabled) | The limits our analysis judges pressure and helium against |
| Identity | `systems` → `sites` → `customers`, `site_groups` | Names, locations, customer and site group |
| Alerting-system history | `alert.detections`, `alert.notifications`, `users` | **System Activity pages only**: what the alerting engine detected and who was notified. Displayed, never used to classify (§8) |

**Time basis.**
- Every reading is placed by its **capture time** (`capture_datetime`),
  never by the host clock.
- A report period selects readings with
  `capture_datetime BETWEEN start AND end`, so both ends are inclusive.
- The brief shows times in **UTC**.
- The System Activity pages default to **Eastern**, with a zone toggle.

---

## 2. Which systems are in a report

| Rule | Detail | Status |
|---|---|---|
| **Monitored magnets only** | A system is included only when `systems.process_mag = true`. This is the **only** flag checked, for both the fleet summary and customer-scoped summaries (`sql/mag-system-ids.sql`, `sql/scope-systems.sql`) | Verified |
| **`show_on_website` is ignored** | A system hidden from the website is still reported if `process_mag` is true. On 2026-11-04, 9 magnet systems were hidden but processed: 7 Trinity Health dummy systems (SME23437, 23465–67, 23469–70, 23473) and 2 real systems with data (SME10262 Renovo, SME15166 Chesapeake). The dummies appear as "failed — no monitor data" | **Open** |
| **Customer scope** | A customer summary takes the systems under `customers → sites → systems` for that customer (or for named sites or systems) that pass the rule above. Resolving to zero systems is an error, never an empty report | Verified |
| **Manufacturer** | `systems.manufacturer` (free text) is matched as follows: **Philips / GE / Siemens** get full analysis; **Hitachi, Canon, Toshiba, Americomp** get **limited coverage** (identity and EDU only, never judged); anything else is a **failure** (e.g. "TBD") | Verified |
| **Data routing** | GE: `config.mag` names `mmb_ge_mm3` or `mmb_ge_mm4`; with neither, try mm4 then mm3. Siemens: `mmb_siemens_non_tim` without `mmb_siemens` means a **10K** (shield-temperature) magnet; otherwise **4K** | Verified |
| **Exclusions** | A request may exclude named systems (e.g. RF/SC service-station magnets). Excluded systems are **named in the document** with the reason, never dropped silently | Verified |
| **No data** | A selected system with no readings in the period is a **failure** row naming the reason. Customer documents use approved wording ("no monitor data received"); internal documents show the raw reason | Verified |

---

## 3. The reporting period

| Rule | Detail | Status |
|---|---|---|
| **Rolling periods** | `7d`, `30d` (default), `90d`, `6mo` (180 days), or any day count. The period ends at the **end of today (UTC)** and starts at midnight UTC N days earlier, so a 30-day period spans 31 calendar days | Verified |
| **Explicit windows** | Any two instants (`--from`/`--to`, or `window.start`/`window.end`). A date covers the whole day; a date with a time is that exact moment. Times without a zone are read as Eastern in one-off reports and UTC in request files. Under 1 hour, or reaching into the future, is refused | Decided 2026-11-04 |
| **Scheduled reports** | Always rolling periods | Verified |
| **Detection rules do not depend on the period length**, except "pressure rising", which needs ≥24 h of readings | | Verified |

---

## 4. Checks applied to every reading before any rule

| Check | Rule | Status |
|---|---|---|
| **Plausibility bounds** | Readings outside these bounds are **excluded from every calculation** (peak, rate, condition, chart), and the brief says how many were excluded. Bounds by channel: pressure −10 to 10,000 mbar and −1 to 100 PSI; shield-as-primary 1 to 320 K; helium 0–100 % and 0–5,000 LTRS; coldhead and shield 1–320 K; cabinet −20 to 80 °C; EDU temperature −40 to 150 °F; humidity 0–100 % | **Proposed** (deliberately loose physics limits) |
| **Latest reading implausible** | Show the raw value greyed with **‡** and judge nothing on that channel: no colour, no limit, no condition | Verified |
| **Stale reading** | If a channel's newest good reading is **more than 24 h older than the period end**, the value is prefixed "as of <day>" (brief) or dimmed with its date (summary), and never passed off as current | Verified |
| **Sensor suspect** | Two or more impossible channels **in the same latest capture**, or one impossible channel plus 0 % helium in that capture, means the monitoring chain is faulty, not the magnet. The system moves to **Data issues**, with readings shown as the sensor's claims. **A recorded quench overrides this** | Verified |
| **Clock skew** | If the median difference between capture and host time is over 15 minutes, a data note is added. Capture time is always used | Verified |
| **Chart density** | More than 500 captures in the period: charts show a daily min/max band; otherwise every capture is plotted | Verified |

---

## 5. Datapoints

Each entry gives: the source per vendor, units, how it is judged, and where
it appears. "Vendor variant":
- **Siemens 4K** = absolute-pressure magnets (`mag.siemens`);
- **Siemens 10K** = shield-temperature magnets (`mag.siemens_non_tim`).

### 5.1 Compressor state

| Vendor | Source | "Running" means | Status |
|---|---|---|---|
| Vendor | Primary source | Backup source | Status |
|---|---|---|---|
| Philips | **EDU `comp_vib_status`** (vibration `true` = running) | `cryo_comp_malf_value`: `0` running; `>0` stopped (alarm minutes); **`−1` = cable error = unknown**, never "off" | EDU primary: **Decided** 2026-11-04 (Matt Teixeira). `−1` rule verified live |
| GE | **EDU `comp_vib_status`** | `coldhead_ruo_value` **< 10 K**. This is an **inference** and is marked **ᶜ** on every page | EDU primary: Verified. Coldhead inference: **Inherited**, never signed off |
| Siemens 4K | **EDU `comp_vib_status`** | `compressor_status`: text `ON` | EDU primary: **Decided** 2026-11-04 (Matt Teixeira) |
| Siemens 10K | EDU `comp_vib_status` (the only source) | none | Verified |

**Which source wins, reading by reading.** The EDU vibration sensor is a
direct measurement of the compressor. It is also the sensor every default
compressor alert watches (`comp_vib_status equals false`), so judging it
means the report and the alerts read the same signal.
- **Every EDU reading is used.**
- **The backup fills EDU gaps.** A backup reading is used where no EDU
  reading falls within **45 minutes** of it. The scanner is never ignored
  when the EDU is silent.
- **A stale backup reading is never used.** A reading that repeats the
  previous reading's host timestamp is a frozen feed re-sending a
  snapshot.
- **Both checks look past the period's edges.** An EDU reading just before
  or after the period still covers a scanner reading near the edge, and the
  first scanner reading is compared with the one before the period. Those
  outside readings are never reported.
- **No EDU readings at all:** the backup channel is the whole signal, as
  before.
- A GE state inferred from an implausible coldhead reading counts as
  **unknown**, not "off".

**How a filled gap is shown.** The brief names the backup beside the EDU,
for example "per EDU vibration sensor; the magnet monitor's reading where
the EDU was silent". A coldhead-filled gap carries the **ᶜ** mark. The
System Activity page draws backup readings lighter in the Compressor strip.

**Why it changed (2026-11-04, refined 2026-11-05).** Before this, the
scanner's own channel won on Philips and Siemens 4K, and the EDU only took
over when that channel had fewer than 24 readings. On SME19528, Oct 26
2026, the Siemens status text read OFF for an hour while the EDU read
running. The report showed a stop that no alert could detect. The status
text then froze for four days while the EDU, and the alerts, kept
reporting. On 2026-11-05 Matt Teixeira added that the scanner must remain
a backup wherever the EDU has no data, which made the merge per reading.

**An EDU "off" is never overruled; it is annotated** (Decided 2026-11-05,
Matt Teixeira). When the EDU reads off, the report states the stop as read
and it stays a stop: it is listed, and an unrecovered one is urgent. Each
EDU-reported stop is then typed from the other data, in this order:
1. **The secondary compressor channel** (the scanner's own reading, or the
   GE coldhead inference): a fresh reading within 45 minutes of an EDU
   "off" reading. Did it read off, read running, or say nothing?
2. **The thermal channels:**
   - pressure (the primary metric) rising by at least 2% of its alert limit
     within 2 hours of the stop starting, against the median of the 2 hours
     before it, with at least two readings past the bar;
   - the coldhead reaching its warm bar (10 K on GE, 55 K on Siemens 4K) at
     any point in the stop.

   Only the 2 hours after the start count, so a multi-day stop cannot pass
   on the magnet's ordinary daily swing (SME16380 swings about 0.2 PSI a day
   against a 5.2 PSI limit). Stale readings, which repeat the previous host
   timestamp, count for nothing.

| Type | When | Shown as |
|---|---|---|
| **Confirmed** | the secondary channel also read off, or the magnet warmed | The stop as today, with no annotation |
| **May not be off** | the secondary channel read running **and** the magnet showed no warming | Brief: "**Based on other data, it may not have been off**: the magnet monitor read running and the magnet showed no warming at the stop." Summary and email reason start "may not be off ·" |
| **Unconfirmed** | anything else: no live secondary reading, or no live thermal data | Brief: "Other data does not confirm it: …" naming what is missing. Summary and email reason start "unconfirmed ·" |

**On the System Activity page**, every type, confirmed included, gets a card
in a **Compressor stops** section. It shows the type, when the stop ran,
and the evidence line by line: how the second channel answered each EDU
"off" reading (off, running, no fresh reading, or only a frozen feed), the
pressure before and after the stop against its 2% bar, and the coldhead's
peak against its warm bar. A last line gives the reason for the type. Only
the stop's real off-runs are checked, never single-reading flickers inside
it.

A system's type is confirmed if any of its stops is confirmed, and "may not
be off" only if every stop is. When the brief's main stop is in doubt but
another stop confirms the period, the brief says so: "Another stop this
period is confirmed by other data." The rule covers EDU-reported stops only. A
stop seen only by the backup while the EDU was silent, and every stop on a
system with no EDU, reads as before with no type. The summary legend defines
both labels. Code: `compute/corroborate.js`.

**Layout cost.** On the tightest brief layout (compact, with a banner) the
annotation can add a story line. Those pages' charts went from 92 to 86 px,
and an axis whose value labels would then collide labels every other
gridline. Every other layout is unchanged.

**Measured (§11), fleet, 7 days to 2026-11-05.** 137 systems analyzed
(SME19034 left the fleet between runs: its `process_mag` was switched off in
the database). 35 switch source and 4 use backup readings, all GE with the
coldhead filling EDU gaps. Verdict and type changes:

| System | Before | After | Assessment |
|---|---|---|---|
| SME24237 Siemens | no compressor signal (scanner OFF all week) | stable | **Better.** The EDU read running and the coldhead stayed cold. The scanner channel is broken |
| SME18359 Siemens | stop, recovered | stable | **Better.** The scanner's "OFF" was a day-old snapshot repeated seven times |
| SME16380 GE | no compressor signal (data issue) | stop, recovered · **may not be off** | **As intended.** The EDU read off at every reading; the coldhead stayed at 4.2 K and pressure held. The stop is stated and the note says why it is doubtful |
| SME12152 GE | stop, ongoing | stop, ongoing · **may not be off** | **As intended.** EDU off 154 h with the coldhead at 4.2 K throughout. Pressure later rose to 2.7 PSI, still under its limit |
| SME01109 Siemens | stable | stop, recovered, 17 h · **unconfirmed** | **As intended.** The old verdict rested on a scanner feed frozen since Sep 1. The EDU chatters, and no live data can confirm or dispute it |
| SME15809 Philips | stop, recovered, 9 h | same · **unconfirmed** | Unchanged stop; the scanner is cable-errored and no live thermal data covers the start |
| SME11221, SME18354, SME20004 | stop | same · confirmed | The scanner also read off, or the magnet warmed |

**From readings to stops:**
1. Readings with no state are skipped.
2. Consecutive "off" readings form one run.
3. A run of 2 or more readings (about an hour or more) is a **real stop**.
4. An "off" run still going at the end of the period is always real.
5. A **single "off" reading** is real only if pressure (or the primary
   metric) **rose ≥2% of the system's alert limit within 2 h**. Otherwise
   it is a **flicker**: footnoted, never a condition.
6. Stops less than 48 h of running time apart are **one event**. Downtime
   sums the off time only.

**Off since before the period** (no running reading at all):
- if the magnet's body agrees (pressure over its limit, high severity, warm
  coldhead, or rising), it is **OFF ENTIRE PERIODᶜ**: listed, never urgent;
- otherwise it is **no compressor signalᶜ**: a data issue.

**Where it appears:**
- the brief compressor tile and timeline;
- the summary's compressor cell (`ON · 4 events · ~54.5 h off`);
- the condition;
- the System Activity page's compressor strips (§8).

**Constants:** 2% / 2 h flicker test, 48 h event gap and the 24-reading EDU
floor are **Proposed** (project constants, validated on fleet data).

### 5.2 Primary metric — helium pressure (shield temperature on Siemens 10K)

| Vendor | Source column | Units | Alert-limit fields (`alert.models`) | Fallback if none configured |
|---|---|---|---|---|
| Philips | `monitor_magnet_pressure_value` | mbar | `he_psi_avg_value`, `monitor_magnet_pressure_value` | > 100 mbar |
| GE | `he_pressure_value` | PSI (gauge) | `he_pressure_value` | > 5 PSI |
| Siemens 4K | `mag_psia_value` | PSIA (**absolute**, ~15.3 at rest) | `mag_psia_value` | band 14.4–16.4 |
| Siemens 10K | `shield_temp_value` | K | `shield_temp_value` | > 100 K |

**How it is judged:**
- **Threshold exceeded:** the period's **peak** ≥ the high limit, or its
  **minimum** ≤ the low limit (band systems).
- **Pressure rising:** see §7. A steady climb toward the limit.
- **Urgent:** only if the **current** reading is outside its limit or at
  high severity. A peak that has since settled is listed, not urgent.

**Display:**
- **% of limit** for one-sided limits.
- A **band gauge** where the low limit is ≥50% of the high limit, i.e. a
  centred band like Siemens 14.4–16.4. A percentage would call a healthy
  15.3 PSIA "93% of limit".
- A limit that came from the vendor fallback is marked **\***.

**Trend word** ("rising" ↑ / "easing" ↓):
- With a compressor stop: the climb from the pre-stop baseline.
- Without one: "rising" only for a steady climb (§7); "easing" when the
  current reading is under 99.5% of the peak.

**Around a stop:** the event's peak includes the **24 h after the
compressor restarts**, because pressure keeps climbing.

**Where it appears:**
- brief: first chart, PRESSURE NOW and EVENT PEAK tiles, timeline;
- summary: value and % of limit / band columns, condition;
- emails.

| Point | Status |
|---|---|
| Limits from `alert.models` with OEM fallback | Verified |
| Philips limits may be configured on `he_psi_avg_value` but are applied to the plotted `monitor_magnet_pressure_value` | **Open** |
| A configuration with only medium-severity rows falls back to the OEM limit | **Open** (pending domain review) |
| GE fallback is 5 PSI, while configured GE limits are typically 5.2 | **Open** |

### 5.3 Helium level

| Vendor | Source column | Units |
|---|---|---|
| Philips | `helium_level_value` | from `mag.philips_mri_monitoring_data_units` (normally %) |
| GE | `he_level_value` | from `mag.ge_mm3_units` / `ge_mm4_units` |
| Siemens 4K / 10K | `he_level_1_value` (4K falls back to `he_level_2_value` when level 1 is empty) | % or LTRS per system |

**Limits.** Only `less_than` rows in `alert.models` on the helium field.
**There is no OEM fallback:** a system without configured helium limits is
**stated, never judged**. A limit is applied **only when its units match
the system's display units**, so a % limit is never applied to a reading in
litres.

**How it is judged:**

| Condition | Colour |
|---|---|
| Below the high-severity limit | red |
| Below the medium limit | amber |
| More than **0.2 below its baseline** | "level falling", amber only where a limit applies |

A **quench** always shows red.

**Helium does not affect "Needs Attention".** A magnet below its helium
limit, with steady pressure and a running compressor, is classified
**stable**. Helium only colours the tile and the summary cell.

**Where it appears:**
- brief: second chart, HELIUM tile;
- summary: helium cell with its change over the period.

| Point | Status |
|---|---|
| Unconfigured helium is not judged | Verified |
| Low helium is not an attention condition | **Open** |
| The 0.2 "falling" step applies in the system's own units: 0.2 percentage points, or **0.2 litres** on LTRS systems | **Open** |

### 5.4 Coldhead temperature

| Vendor | Source | Warm when |
|---|---|---|
| GE | `coldhead_ruo_value` (K, base ~4 K) | ≥ 10 K |
| Siemens 4K | `cold_head_sensor_1_value` (K, base ~40–46 K) | ≥ 55 K |
| Philips, Siemens 10K | not reported | — |

**How it is judged:**
- warm → red tile and summary cell; otherwise "steady at base temperature";
- no `alert.models` limit exists;
- it is used as **corroboration** for the GE compressor inference (§5.1)
  and for "off entire period".

**Status:**
- GE 10 K is **Inherited**: healthy GE coldheads cluster at 4.0–4.6 K and
  warm ones at 50 K+.
- Siemens 55 K is **Inherited**. One magnet sat at 53.7 K, just under the
  bar, so the exact value matters.

### 5.5 Shield temperature (GE)

- **Source:** `shield_si410_value` (K) on GE. On Siemens 10K the shield is
  the primary metric (§5.2).
- **Judgment:** **stated, not judged**. It appears in the summary's SHIELD
  column with no colour.
- **Status:** **Open**. Should it carry a limit or corroborate stops?

### 5.6 Cabinet temperature (Siemens 10K)

- **Source:** `cca_cab_temp_value` (°C).
- **Judgment:** against the system's **own** `cca_cab_temp_warn_value` /
  `cca_cab_temp_alarm_value` reported on each row: amber at or above warn,
  red at or above alarm.
- **Where it appears:** the brief CABINET tile and summary cell.
- **Not an attention condition.**
- **Status:** Verified.

### 5.7 Quench (Philips)

- **Source:** `quenched_state = 1`.
- **Judgment:** a quench is an **overlay** on whatever the condition is.
  The system **always counts as attention and urgent**, sorts to the top,
  and shows QUENCH in red, even if its pressure looks normal.
- It overrides "sensor suspect", because missing a real quench is the
  costlier error.
- **Status:** Verified.
- No other vendor reports a quench flag.

### 5.8 Compressor temperature alarm (Philips)

- **Source:** `cryo_comp_temp_alarm_state > 0` (alarm minutes).
- **Judgment:** the TEMP ALARM tile reads TRIGGERED, with the run's start,
  end and reading count. Repeat triggers are counted. Where an EDU exists,
  the timeline states the room temperature while the alarm was active.
- **Not an attention condition.**
- **Status:** Verified; **Open** whether it should be an attention
  condition.

### 5.9 Room environment

| Source | Channels | Units |
|---|---|---|
| EDU (`edu.v1`/`v2`/`v3` per `config.edu`) | room temperature, room humidity, probe 0, probe 1 (`edu.v1` probes 1/2 are mapped to 0/1) | °F, %RH |
| Philips scanner | `tech_room_temp_value` | °C |

**How it is judged:**
- **No limits are configured**, so these are **stated, never judged**.
- They are screened against the plausibility bounds first. An open probe
  input reports −196.6 °F, which must never become the room's minimum.
- A **stale** channel (no reading for 24 h) is dimmed with its date and
  never treated as the current room state.

**Where it appears:**
- the summary's **ENVIRONMENTAL (EDU)** section, sorted hottest room
  first;
- the brief's data notes;
- Philips tech-room temperature appears only as a range in the brief's
  data notes.

**Status:** Verified; **Open** whether the room channels should carry
limits.

---

## 6. Alert limits

| Rule | Detail | Status |
|---|---|---|
| Source | `alert.models` rows with `user_id = 'default'`, `enabled`, operator `greater_than` or `less_than`, on the fields in §5.2 / §5.3. Per-user copies of the models are ignored | Verified |
| Severity | **High** drives red, the chart's limit line and the condition. Any other severity is treated as **medium**, which only softens a tile to amber | Verified |
| Several rows | The most conservative wins: the lowest `greater_than`, the highest `less_than` | Verified |
| Fallback | **Per channel.** Pressure with no high-severity row uses the vendor's OEM value (§5.2, marked \*). Helium with no row is **not judged** | Verified |
| Units | A limit row whose units conflict with another row for the same channel fails that system's report loudly. A helium limit in different units from the reading is not applied | Verified |

---

## 7. Conditions and "Needs Attention"

**Each analyzed system gets exactly one condition.** The first match wins:

| # | Condition | Rule | Attention | Urgent |
|---|---|---|---|---|
| 1 | **Compressor stop — ongoing** | A real stop (§5.1) with no recovery by the end of the period | yes | yes, unless "off entire period" |
| 2 | **Compressor stop — recovered** | A real stop that recovered | yes | no |
| 3 | **Peak over limit** | Primary-metric peak ≥ the high limit, or minimum ≤ the low limit | yes | only if the **current** reading is still outside |
| 4 | **Pressure rising** | No real stop, **and** a steady climb (see below) | yes | no |
| 5 | **Stable / healthy** | None of the above | no | no |

**"Pressure rising"** (Decided 2026-11-04). A straight line is fitted
through every reading in the period. It counts as rising only if all of
these hold:
- the line climbs **at least 10% of the room left below the high limit**;
- the line fits the readings well (**r² ≥ 0.5**);
- there are **at least 24 h** of readings.

**What the rule means:**
- A spike that comes back to normal is **not** reported unless it crosses
  the limit (condition 3).
- It replaced "(peak − first) per hour > 0.001 and ≥60% of the limit".
  Across 146 systems over 30 days, the old rule flagged 12 flat Siemens
  magnets and missed 2 GE magnets that were climbing.
- The 10%, 0.5 and 24 h values were calibrated on one fleet snapshot.
  They are **Open** for review as more history accumulates.

**Overlays and tiers** (applied on top of the condition):
- **Quench** (§5.7): always attention and urgent.
- **Data issue**: sensor suspect (§4) or no compressor signal (§5.1).
  Removed from the attention list and counted separately, as a monitoring
  problem rather than a magnet problem.
- **Off entire period**: listed amber, never urgent.
- **Limited coverage**: other manufacturers (§2). Identity and EDU only,
  never judged.
- **Failure**: no report could be built. Every failed system is named.

**Not attention conditions today:**
- helium level (§5.3);
- coldhead (§5.4), except as corroboration;
- cabinet (§5.6);
- temperature alarm (§5.8);
- room environment (§5.9).

The headline reads: "N systems analyzed — N need attention, N urgent,
N data issues".

---

## 8. Data from the alerting system (System Activity pages)

The System Activity pages show what **the alerting system** did. They sit
beside our own analysis and never change it.

| Data | Source | Shown as |
|---|---|---|
| Alert models | `alert.models` (`user_id = 'default'`) | The list of what the alerting engine watches for this system |
| Detections | `alert.detections` for those models, captured **or** inserted within the period | Markers per capture slot (30-minute slots); the detail pane shows the raw detection |
| Notifications | `alert.notifications` whose `detected_alert_models` include the system's models, updated within the period | Who was notified and by what channel (email/SMS status) |
| Recipients | `users` (name, status, customer access) | Recipient names. **Customer copies remove Avante staff addresses**; internal copies keep them, labelled |
| Readings | The same screened readings as the brief | Swimlane charts beside the detections |
| Compressor stops | Each EDU-reported stop's type and evidence (§5.1) | A card per stop: confirmed, unconfirmed or "may not be off", with the second channel's answers, the pressure and coldhead numbers against their bars, and the reason |
| Compressor | The merged state the report judged (§5.1), plus the **backup channel as it reported** when the EDU is primary | Two strips: **Compressor** (the judged state, with backup readings drawn lighter and labelled in the tooltip, table and detail pane) and a second strip named for the backup: **Magnet monitor** or **Coldhead (inferred)**. A matching column appears in the slot table and the detail pane. The two sensors can disagree, and the caption says which one the compressor alert watches |

A **detection is not a notification**: notify frequency and suppression sit
between them. There is no separate "notify" table.

---

## 9. Data fetched but not used

These columns are read from the database and then never used in any
report. Each one is either a gap to fill or a column to stop fetching.

| Vendor | Column | Note |
|---|---|---|
| Philips | `he_psi_avg_value` | Fetched, and accepted as a limit field (§5.2), but never plotted or judged |
| Philips | `cryo_comp_press_alarm_state` | Compressor **pressure** alarm. Never reported (the temperature alarm is) |
| GE | `water_flow_value`, `water_temp_value` | Chiller water flow and temperature |
| GE | `cdc1_value`, `hdc_value` (mm3 only) | |
| Siemens 4K | `he_status` | |
| Siemens 4K | `he_level_2_value` | Used only when `he_level_1_value` is empty |

---

## 10. Open questions for the team

Each needs an owner and a decision. Record the decision and its date in the
relevant section above.

1. **Which flag removes a system from reports?** Today only `process_mag`
   counts.
   - Option 1: keep that, and set `process_mag = false` on dummy systems.
   - Option 2: also honour `show_on_website = false`. This would also
     drop SME10262 and SME15166, which have real data. (§2)
2. **Should low helium make a system "Need Attention"?** Today it never
   does. (§5.3)
3. **Helium "falling" threshold:** 0.2 in the system's own units. Is 0.2
   litres meaningful on LTRS systems? (§5.3)
4. **GE compressor inference (coldhead < 10 K)** has never been signed off
   by service engineering. (§5.1, §5.4)
5. **Siemens coldhead warm bar (55 K):** one magnet sat at 53.7 K. Is the
   bar right? (§5.4)
6. **Plausibility bounds** are deliberately loose physics limits that have
   never been reviewed. (§4)
7. **Philips limits on `he_psi_avg_value`:** they are applied to
   `monitor_magnet_pressure_value`. Should the average be the plotted
   metric, or should those limits be ignored? (§5.2)
8. **Medium-only pressure configurations** fall back to the OEM limit.
   Should a medium limit stand on its own? (§5.2)
9. **GE OEM fallback:** 5 PSI against the usual configured 5.2. (§5.2)
10. **Pressure-rising constants** (10% of headroom, r² 0.5, 24 h) need
    review against more history. (§7)
11. **Should the temperature alarm, cabinet temperature, shield
    temperature or room environment** affect attention, or carry limits?
    (§5.5–§5.9)
12. **Unused data** (§9): should we report the Philips compressor pressure
    alarm, or the GE water flow and temperature?
13. **"Off entire period" is never urgent.** That is reasonable for a
    30-day report. Is it right for a 7-day report? (§5.1)
14. **Flicker test on a frozen magnet feed.** A single EDU "off" counts
    as a stop only if pressure rises afterwards. When the magnet feed is
    frozen (SME19528, Oct 26–30 2026), pressure cannot rise, so every
    "off" reads as a flicker. Should repeated flickers, or flickers during
    Frozen Host Data, count as a stop? (§5.1)
15. **No alert watches a scanner's own compressor channel.** The report
    now uses the scanner as a backup where the EDU is silent. The alerting
    engine does not: its compressor models watch only the EDU. Should a
    default alert model watch Siemens `compressor_status` and Philips
    `cryo_comp_malf_value`, for when the EDU is silent? This is an
    `alert.models` change in production, outside `sme_reports/`. (§5.1)
16. **Decided 2026-11-05** (§5.1): a handoff between compressor sources
    no longer needs its own rule. An EDU "off" is stated and typed from the
    secondary channel and the thermal data. Whether a "may not be off" stop
    should still raise attention, and whether an unrecovered one should
    still be urgent, is open: today both do.
17. **Frozen magnet feeds are not detected by the reports.** The alerting
    engine raises Frozen Host Data. The reports judge whatever the frozen
    feed repeats: SME01109 read "stable" for two months on one snapshot
    from Sep 1. Should a repeated host timestamp make the magnet channels
    stale, or a data issue? (§4, §5.1)

---

## 11. Changing a rule

1. **Propose it here.** State the datapoint, the current rule, the
   proposed rule and why.
2. **Measure it.** Run the old and new rules across the whole fleet over
   the same period. List every system that changes condition, and confirm
   nothing else moved. This is how the pressure-rising rule was changed on
   2026-11-04.
3. **Decide.** Mark the rule **Decided** with the date and who agreed it.
4. **Implement it.** Change the code and its checks (`sme_reports/dev/`),
   update `sme_reports/RULES.md`, and update this document.
