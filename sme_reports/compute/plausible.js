// Physical plausibility bounds, shared by the per-system model (which screens
// every point before metrics are computed) and the fleet summary (which greys
// and footnotes the raw values). Disconnected sensors emit numbers, not
// silence: a live system reported −3.625 PSI, 0.00% helium and a 382.8 K
// shield in one row — pressure below empty, a bone-dry tank, and a
// "cryogenic" shield hotter than boiling water. Bounds say what a reading
// CAN be, in that channel's units; anything outside is excluded from all
// status arithmetic and shown greyed with its raw value. Documented in
// RULES.md §5 — deliberately loose so only the absurd trips them.
const PLAUSIBLE = {
  pressure_mbar: { min: -10, max: 10000 },
  pressure_psi: { min: -1, max: 100 },
  primary_k: { min: 1, max: 320 }, // non-TIM shield-as-primary; room is ~293
  helium_pct: { min: 0, max: 100 },
  helium_ltrs: { min: 0, max: 5000 },
  coldhead_k: { min: 1, max: 320 },
  shield_k: { min: 1, max: 320 },
  cabinet_c: { min: -20, max: 80 },
  // EDU environmental channels (°F / %RH). An open probe input emits its
  // scale floor — a live unit reported −196.6 °F for a ROOM probe — so the
  // bounds are what a machine room can physically be, not what the sensor
  // can emit.
  edu_temp_f: { min: -40, max: 150 },
  edu_humidity_pct: { min: 0, max: 100 }
};

const outside = (v, b) => v !== null && v !== undefined && (v < b.min || v > b.max);

// Fail closed on unrecognized units: bounds are per-unit physics, and
// defaulting (PSI for pressure, LTRS for helium, as this dispatch once did)
// would screen a new unit's readings against another unit's physics —
// silently rejecting good data or admitting garbage. The recognized sets
// are the complete LIVE vocabulary (mag.*_units + alert.models, surveyed
// 2026-08-14: K/PSI/mBar pressure, %/LTRS helium; "mBar" is display-
// normalized to "mbar" before reaching here — a raw "mBar" indicates a
// normalization bypass and fails too).
const primary_bounds = (units) => {
  if (units === "mbar") return PLAUSIBLE.pressure_mbar;
  if (units === "K") return PLAUSIBLE.primary_k;
  if (units === "PSI") return PLAUSIBLE.pressure_psi;
  throw new Error(`no plausibility bounds for primary-metric units "${units}" (known: mbar, PSI, K)`);
};

const helium_bounds = (units) => {
  if (units === "%") return PLAUSIBLE.helium_pct;
  if (units === "LTRS") return PLAUSIBLE.helium_ltrs;
  throw new Error(`no plausibility bounds for helium units "${units}" (known: %, LTRS)`);
};

// Which channels' LAST RAW (pre-screen) reading is outside its bounds — the
// shared basis for the greyed-raw ‡ treatment on the fleet columns and the
// brief tiles, so the two documents can never disagree about which sensor is
// currently emitting garbage. `shield_alias` drops the non-TIM shield flag:
// that channel is one physical sensor aliased into the primary slot, and its
// flag would count one impossible reading as two.
const last_raw_flags = (raw_last, units, { shield_alias = false } = {}) => ({
  primary: outside(raw_last.pressure, primary_bounds(units.pressure)),
  helium: outside(raw_last.helium, helium_bounds(units.helium)),
  coldhead: outside(raw_last.coldhead_k, PLAUSIBLE.coldhead_k),
  shield: shield_alias ? false : outside(raw_last.shield_k, PLAUSIBLE.shield_k),
  cabinet: outside(raw_last.cab_temp, PLAUSIBLE.cabinet_c)
});

module.exports = {
  PLAUSIBLE,
  outside,
  primary_bounds,
  helium_bounds,
  last_raw_flags
};
