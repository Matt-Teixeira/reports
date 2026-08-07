# Magnet Health Brief — Detection Rules

Every rule the report applies, the field it reads, and the constant behind it.
Roughly 25 rules total. Only one of them discards data (compressor rule 5);
the rest group, classify, or color.

Source of truth: `compute/events.js`, `compute/archetype.js`,
`compute/metrics.js`, `compute/series.js`, `render/tiles.js`, `data.js`.

## 1. Compressor state — the "suspect" checks

The compressor signal is vendor-specific; there is no single field.

| Vendor | Field | Source table | "Running" means |
|---|---|---|---|
| Philips | `cryo_comp_malf_value` | `mag.philips_mri_monitoring_data_agg` | `= 0` (per DDL: −1 = cable error, 0 = OK, >0 = alarm minutes) |
| GE | `coldhead_ruo_value` | `mag.ge_mm3` / `ge_mm4` | `< 10 K` — inferred; GE has no compressor column |
| Siemens TIM | `compressor_status` | `mag.siemens` | text `= 'ON'` |
| Siemens non-TIM | `comp_vib_status` | `edu.v2` / `edu.v3` | vibration sensor `= true` |

Five rules run over those readings, in order:

1. **Null readings are skipped** — they carry no state, so they neither start
   nor break a run.
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

Flickers are excluded from the event window, the condition classification, and
the summary attention list. They appear only as a footnote on the tile and in
the story.

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
| Event peak scope | Extends **24 hrs past recovery** — pressure keeps climbing after a restart (SME19034 peaked 16 hrs after the compressor came back) |
| Rate | Only calculated over ramps longer than 30 min |
| Temp alarm (Philips `cryo_comp_temp_alarm_state`) | Active when >0; contiguous runs counted so re-fires are reported as re-fires |
| Quench (Philips `quenched_state`) | `= 1` |
| Coldhead warm | GE ≥10 K; Siemens ≥55 K (different sensor, different baseline) |
| Cabinet temp (non-TIM `cca_cab_temp_value`) | Judged against the system's own `cca_cab_temp_warn_value` / `_alarm_value` reported on each row |
| Clock skew | Median \|capture − host\| > 15 min gets a data note; charts always use capture time |
| Chart mode | >500 captures in the window renders a daily min/max band; otherwise every capture is plotted |
| Trend wording | Current < 99.5% of peak reads "easing" |
