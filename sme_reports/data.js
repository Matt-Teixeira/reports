const db = require("../utils/db/pg-pool");
const {
  get_system_identity,
  philips_series,
  ge_mm3_series,
  ge_mm4_series,
  siemens_series,
  siemens_non_tim_series,
  get_default_thresholds,
  get_mag_routing,
  units_queries,
  edu_config,
  edu_series
} = require("./sql/sql");
const { VENDORS, resolve_vendor, fallback_thresholds } = require("./vendors");

// Fetches system identity + vendor time series and normalizes vendor rows to
// one canonical shape so everything downstream is vendor-agnostic:
//   { t, host_t, pressure, helium, compressor_on, coldhead_k, shield_k, temp_alarm, quenched }
// t/host_t are epoch ms; missing values are null.

const num = (v) => (v === null || v === undefined ? null : parseFloat(v));
const ms = (v) => (v ? new Date(v).getTime() : null);

const normalize_philips = (rows, vendor) =>
  rows.map((r) => {
    const malf = num(r.cryo_comp_malf_value);
    return {
      t: ms(r.capture_datetime),
      host_t: ms(r.host_datetime),
      pressure: num(r.monitor_magnet_pressure_value),
      pressure_avg: num(r.he_psi_avg_value),
      helium: num(r.helium_level_value),
      compressor_on: malf === null ? null : malf === vendor.compressor.ok_value,
      coldhead_k: null,
      shield_k: null,
      temp_alarm: num(r.cryo_comp_temp_alarm_state) > 0,
      // Alarm-state value is minutes per the mag DDL (0=OK, >0=alarm minutes).
      temp_alarm_minutes: num(r.cryo_comp_temp_alarm_state),
      room_temp_c: num(r.tech_room_temp_value),
      quenched: num(r.quenched_state) === 1
    };
  });

const normalize_siemens_non_tim = (rows) =>
  rows.map((r) => ({
    t: ms(r.capture_datetime),
    host_t: ms(r.host_datetime),
    // Primary-metric slot: non-TIM has no pressure channel; shield
    // temperature is the warm-event signal (see vendors.SIEMENS_NON_TIM).
    pressure: num(r.shield_temp_value),
    pressure_avg: null,
    helium: num(r.he_level_1_value),
    compressor_on: null, // comes from the EDU vibration sensor, not mag data
    coldhead_k: null,
    shield_k: num(r.shield_temp_value),
    cab_temp: num(r.cca_cab_temp_value),
    cab_warn: num(r.cca_cab_temp_warn_value),
    cab_alarm: num(r.cca_cab_temp_alarm_value),
    temp_alarm: null,
    temp_alarm_minutes: null,
    room_temp_c: null,
    quenched: null
  }));

const normalize_siemens = (rows) =>
  rows.map((r) => {
    const status = r.compressor_status;
    return {
      t: ms(r.capture_datetime),
      host_t: ms(r.host_datetime),
      pressure: num(r.mag_psia_value),
      pressure_avg: null,
      helium: num(r.he_level_1_value) !== null
        ? num(r.he_level_1_value)
        : num(r.he_level_2_value),
      // compressor_status is text: 'ON' when running; any other non-null
      // literal is treated as not running; null carries no information.
      compressor_on: status == null ? null : String(status).toUpperCase() === "ON",
      coldhead_k: num(r.cold_head_sensor_1_value),
      shield_k: null,
      temp_alarm: null,
      temp_alarm_minutes: null,
      room_temp_c: null,
      quenched: null
    };
  });

const normalize_ge = (rows, vendor) =>
  rows.map((r) => {
    const coldhead = num(r.coldhead_ruo_value);
    return {
      t: ms(r.capture_datetime),
      host_t: ms(r.host_datetime),
      pressure: num(r.he_pressure_value),
      pressure_avg: null,
      helium: num(r.he_level_value),
      compressor_on:
        coldhead === null
          ? null
          : coldhead < vendor.compressor.cold_threshold_k,
      coldhead_k: coldhead,
      shield_k: num(r.shield_si410_value),
      temp_alarm: null,
      temp_alarm_minutes: null,
      room_temp_c: null,
      quenched: null
    };
  });

const fetch_identity = async (system_id) => {
  const rows = await db.any(get_system_identity, [system_id]);
  if (!rows.length) throw new Error(`system ${system_id} not found`);
  return rows[0];
};

// config.mag pg_tables per system resolves which mag table a system's unit
// writes to (e.g. 'mmb_ge_mm4' vs 'mmb_ge_mm3', 'mmb_siemens' vs
// 'mmb_siemens_non_tim'). Returns the flattened list, or [] when unconfigured.
const fetch_mag_routing = async (system_id) => {
  const rows = await db.any(get_mag_routing, [system_id]);
  return rows.flatMap((r) => r.pg_tables || []);
};

// Resolves the concrete vendor for a system: manufacturer string first, then
// config.mag routing to split Siemens TIM vs non-TIM. Returned routing is
// reused by fetch_series to pick GE tables.
const resolve_system_vendor = async (identity) => {
  const base = resolve_vendor(identity.manufacturer);
  if (!base)
    throw new Error(
      `unsupported manufacturer "${identity.manufacturer}" for ${identity.system_id} (PHILIPS, GE, SIEMENS)`
    );
  if (base.key === "GE" || base.key === "SIEMENS") {
    const routing = await fetch_mag_routing(identity.system_id);
    if (
      base.key === "SIEMENS" &&
      routing.includes("mmb_siemens_non_tim") &&
      !routing.includes("mmb_siemens")
    )
      return { vendor: VENDORS.SIEMENS_NON_TIM, routing };
    return { vendor: base, routing };
  }
  return { vendor: base, routing: [] };
};

const fetch_series = async (identity, window, vendor, routing = []) => {
  const params = [
    identity.system_id,
    window.start.toISO(),
    window.end.toISO()
  ];

  let rows;
  let source;
  let series;
  if (vendor.key === "PHILIPS") {
    rows = await db.any(philips_series, params);
    source = "mag.philips_mri_monitoring_data_agg";
    series = normalize_philips(rows, vendor);
  } else if (vendor.key === "GE") {
    if (routing.includes("mmb_ge_mm3") && !routing.includes("mmb_ge_mm4")) {
      rows = await db.any(ge_mm3_series, params);
      source = "mag.ge_mm3";
    } else if (routing.includes("mmb_ge_mm4")) {
      rows = await db.any(ge_mm4_series, params);
      source = "mag.ge_mm4";
    } else {
      // Unrouted system: try mm4 first, fall back to mm3.
      rows = await db.any(ge_mm4_series, params);
      source = "mag.ge_mm4";
      if (!rows.length) {
        rows = await db.any(ge_mm3_series, params);
        source = "mag.ge_mm3";
      }
    }
    series = normalize_ge(rows, vendor);
  } else if (vendor.key === "SIEMENS_NON_TIM") {
    rows = await db.any(siemens_non_tim_series, params);
    source = "mag.siemens_non_tim";
    series = normalize_siemens_non_tim(rows);
  } else {
    rows = await db.any(siemens_series, params);
    source = "mag.siemens";
    series = normalize_siemens(rows);
  }

  return { vendor, source, series: series.filter((r) => r.t !== null) };
};

// Per-system alert thresholds from alert.models defaults (user_id='default',
// enabled). Falls back to the vendor's OEM constants when no rows exist.
// Multiple rows for the same operator/severity keep the most conservative
// value (lowest greater_than, highest less_than).
const fetch_thresholds = async (system_id, vendor) => {
  const fields = vendor.pressure.model_fields.concat(vendor.helium.model_fields);
  const rows = await db.any(get_default_thresholds, [system_id, fields]);

  const thr = fallback_thresholds(vendor);
  const p = {
    units: vendor.pressure.units,
    high_gt: null,
    high_lt: null,
    med_gt: null,
    med_lt: null,
    source: "default_models"
  };
  const he = { low_high: null, low_med: null, units: null };

  const keep_min = (cur, v) => (cur === null ? v : Math.min(cur, v));
  const keep_max = (cur, v) => (cur === null ? v : Math.max(cur, v));

  for (const r of rows) {
    const v = parseFloat(r.threshold);
    if (Number.isNaN(v)) continue;
    if (vendor.pressure.model_fields.includes(r.field_name)) {
      if (r.threshold_units) p.units = r.threshold_units;
      if (r.operator === "greater_than") {
        if (r.severity === "high") p.high_gt = keep_min(p.high_gt, v);
        else p.med_gt = keep_min(p.med_gt, v);
      } else {
        if (r.severity === "high") p.high_lt = keep_max(p.high_lt, v);
        else p.med_lt = keep_max(p.med_lt, v);
      }
    } else if (r.operator === "less_than") {
      if (r.threshold_units) he.units = r.threshold_units;
      if (r.severity === "high") he.low_high = keep_max(he.low_high, v);
      else he.low_med = keep_max(he.low_med, v);
    }
  }

  // Normalize display casing ("mBar" -> "mbar") to match the report style.
  p.units = p.units === "mBar" ? "mbar" : p.units;

  if (p.high_gt === null && p.high_lt === null) return thr;
  return { pressure: p, helium: he };
};

// Display units from the vendor's mag.*_units row (e.g. Siemens helium can be
// LTRS instead of %). Missing rows fall back to the vendor defaults.
const fetch_units = async (system_id, vendor) => {
  const rows = await db.any(units_queries[vendor.key], [system_id]);
  const row = rows[0] || {};
  const pressure = row.pressure_units || vendor.pressure.units;
  return {
    helium: row.helium_units || vendor.helium.units,
    // Normalize display casing ("mBar" -> "mbar") to match the report style.
    pressure: pressure === "mBar" ? "mbar" : pressure
  };
};

// EDU (environmental data unit) — vendor-independent room/probe temp and
// humidity telemetry. config.edu.file_name identifies which edu.* table the
// system's unit writes to (all values are °F / %):
//   "v2_edu2" (EDU2 hardware) -> edu.v2
//   "v3_edu"  (EDU3 hardware) -> edu.v3
//   "v2_edu"  (EDU1 hardware) -> edu.v1  (per config.edu.pg_tables)
const EDU_TABLE_BY_FILE = { v2_edu2: "v2", v3_edu: "v3", v2_edu: "v1" };

// Missing config or data yields an empty series — environmental data is
// supplemental and must never fail the report.
const fetch_edu_series = async (system_id, window) => {
  const cfg = await db.any(edu_config, [system_id]);
  const table = cfg.length ? EDU_TABLE_BY_FILE[cfg[0].file_name] : null;
  if (!table) return { edu_source: null, edu: [] };

  const rows = await db.any(edu_series[table], [
    system_id,
    window.start.toISO(),
    window.end.toISO()
  ]);
  return {
    edu_source: `edu.${table}`,
    edu: rows
      .map((r) => ({
        t: ms(r.capture_datetime),
        room_temp_f: num(r.room_temp_value),
        humidity_pct: num(r.room_humidity_value),
        probe_0_f: num(r.temp_probe_0_value),
        probe_1_f: num(r.temp_probe_1_value),
        // Compressor vibration sensor (edu.v2/v3 only; null on v1).
        comp_vib:
          r.comp_vib_status === null || r.comp_vib_status === undefined
            ? null
            : r.comp_vib_status === true
      }))
      .filter((r) => r.t !== null)
  };
};

module.exports = {
  fetch_identity,
  resolve_system_vendor,
  fetch_series,
  fetch_edu_series,
  fetch_thresholds,
  fetch_units
};
