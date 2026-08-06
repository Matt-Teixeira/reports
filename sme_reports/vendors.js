// Per-manufacturer constants for the single-SME Magnet Health Brief.
//
// Pressure/helium ALERT THRESHOLDS are loaded per system from alert.models
// (user_id='default', enabled) — see data.fetch_thresholds(). The `fallback`
// values here are the OEM service-line constants used only when a system has
// no default model rows. `model_fields` lists the alert.models field_name
// values that carry each metric's thresholds.
//
// Adding a vendor means: one entry here, one series SQL file in
// sme_reports/sql/, and one normalizer branch in sme_reports/data.js.

// Every vendor names a PRIMARY escalation metric that drives the first chart,
// the NOW/EVENT PEAK tiles, the alert line(s), and the archetypes. For
// magnet-monitored vendors that's He pressure; Siemens non-TIM has no
// pressure channel, so shield temperature takes the slot. Internally the
// normalized series always carries the primary metric in the `pressure`
// field; `primary` holds the display strings.
const VENDORS = {
  PHILIPS: {
    key: "PHILIPS",
    primary: {
      name: "He pressure",
      heading: "HE PRESSURE",
      tile_now: "PRESSURE NOW",
      zero_anchor: true
    },
    pressure: {
      units: "mbar",
      decimals: 0,
      model_fields: ["he_psi_avg_value", "monitor_magnet_pressure_value"],
      fallback: { high_gt: 100, high_lt: null }
    },
    helium: {
      units: "%",
      decimals: 1,
      model_fields: ["helium_level_value"]
    },
    // cryo_comp_malf_value semantics per mag DDL: -1=cable error, 0=OK,
    // >0=alarm minutes. Compressor is considered running/OK only at 0.
    compressor: { source: "cryo_comp_malf_value", ok_value: 0 },
    tiles: ["compressor", "pressure_now", "event_peak", "temp_alarm", "helium"]
  },
  GE: {
    key: "GE",
    primary: {
      name: "He pressure",
      heading: "HE PRESSURE",
      tile_now: "PRESSURE NOW",
      zero_anchor: true
    },
    pressure: {
      units: "PSI",
      decimals: 3,
      model_fields: ["he_pressure_value"],
      fallback: { high_gt: 5, high_lt: null }
    },
    helium: {
      units: "%",
      decimals: 2,
      model_fields: ["he_level_value"]
    },
    // mag.ge_mm3 / ge_mm4 carry no direct compressor state column, so the
    // compressor is inferred from the coldhead: < warm_k means the coldhead
    // is at base temperature (compressor running).
    compressor: { source: "coldhead_ruo_value", cold_threshold_k: 10 },
    coldhead: { warm_k: 10 },
    tiles: ["compressor", "coldhead", "pressure_now", "event_peak", "helium"]
  },
  SIEMENS: {
    key: "SIEMENS",
    primary: {
      name: "He pressure",
      heading: "HE PRESSURE",
      tile_now: "PRESSURE NOW",
      // Absolute PSIA band — non-zero-anchored domain comes from the band
      // handling in scales.pressure_domain.
      zero_anchor: true
    },
    pressure: {
      // mag_psia_value is ABSOLUTE pressure (~15.3 PSIA at baseline); the
      // default alert model is a band (e.g. high: >16.4 or <14.4 PSI).
      units: "PSI",
      decimals: 2,
      model_fields: ["mag_psia_value"],
      fallback: { high_gt: 16.4, high_lt: 14.4 }
    },
    helium: {
      // Units vary per system (% or LTRS) — resolved from mag.siemens_units.
      units: "%",
      decimals: 1,
      model_fields: ["he_level_1_value"]
    },
    // compressor_status is a literal text state ('ON' when running).
    compressor: { source: "compressor_status" },
    // Siemens cold_head_sensor_1 runs ~40-46 K at base (a different sensor
    // than GE's ~4 K coldhead RUO); no default alert model exists for it.
    coldhead: { warm_k: 55 },
    tiles: ["compressor", "coldhead", "pressure_now", "event_peak", "helium"]
  },
  SIEMENS_NON_TIM: {
    key: "SIEMENS_NON_TIM",
    // Older Siemens magnets: no pressure channel at all. Shield temperature
    // is the warm-event signal and takes the primary-metric slot (~41-59 K
    // at base; alert.models default alerts >100 K high / >90 K medium).
    primary: {
      name: "Shield temp",
      heading: "SHIELD TEMP",
      tile_now: "SHIELD NOW",
      zero_anchor: false
    },
    pressure: {
      units: "K",
      decimals: 1,
      model_fields: ["shield_temp_value"],
      fallback: { high_gt: 100, high_lt: null }
    },
    helium: {
      units: "%",
      decimals: 1,
      model_fields: ["he_level_1_value"]
    },
    // No compressor state in mag data — the EDU vibration sensor is the
    // compressor signal (same source alert.models' default compressor
    // model watches: comp_vib_status equals false).
    compressor: { source: "edu_comp_vib" },
    tiles: ["compressor", "pressure_now", "event_peak", "cabinet", "helium"]
  }
};

// Threshold shape used everywhere downstream. high_* drive the red chart
// line(s), tile "bad" status, and the threshold_exceeded archetype; med_*
// only soften tile colors (warn).
const fallback_thresholds = (vendor) => ({
  pressure: {
    units: vendor.pressure.units,
    high_gt: vendor.pressure.fallback.high_gt,
    high_lt: vendor.pressure.fallback.high_lt,
    med_gt: null,
    med_lt: null,
    source: "oem_constant"
  },
  helium: { low_high: null, low_med: null, units: null }
});

// systems.manufacturer is free text ("Philips", "GE Medical", ...); match loosely.
const resolve_vendor = (manufacturer) => {
  const m = String(manufacturer || "").toUpperCase();
  if (m.includes("PHILIPS")) return VENDORS.PHILIPS;
  if (m.includes("GE")) return VENDORS.GE;
  if (m.includes("SIEMENS")) return VENDORS.SIEMENS;
  return null;
};

module.exports = { VENDORS, resolve_vendor, fallback_thresholds };
