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
const { VENDORS, classify_manufacturer } = require("./vendors");
const { resolve_thresholds } = require("./compute/thresholds");
const {
  num,
  ms,
  normalize_philips,
  normalize_ge,
  normalize_siemens,
  normalize_siemens_non_tim
} = require("./normalize");

// Fetches system identity + vendor time series and normalizes vendor rows to
// one canonical shape so everything downstream is vendor-agnostic:
//   { t, host_t, pressure, helium, compressor_on, coldhead_k, shield_k, temp_alarm, quenched }
// t/host_t are epoch ms; missing values are null.

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
// A LIMITED manufacturer (classify_manufacturer allowlist) returns
// { limited: true, label } instead of a vendor — the caller takes the
// identity+EDU path. Unknown manufacturers keep the hard throw: unknown is
// never downgraded to limited, and a supported vendor whose data pulls
// fail later stays a failure, never limited either.
const resolve_system_vendor = async (identity) => {
  const c = classify_manufacturer(identity.manufacturer);
  if (c.kind === "unknown")
    throw new Error(
      `unsupported manufacturer "${identity.manufacturer}" for ${identity.system_id} (PHILIPS, GE, SIEMENS)`
    );
  if (c.kind === "limited")
    return { limited: true, label: c.label, vendor: null, routing: [] };
  const base = c.vendor;
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
  } else if (vendor.key === "SIEMENS") {
    rows = await db.any(siemens_series, params);
    source = "mag.siemens";
    series = normalize_siemens(rows);
  } else {
    // Fail closed: a default branch here once routed ANY unmatched vendor
    // to the Siemens tables — a half-registered vendor would silently
    // report another data model's numbers. resolve_vendor gates entry, but
    // this seam must hold on its own.
    throw new Error(`no series adapter for vendor "${vendor.key}"`);
  }

  return { vendor, source, series: series.filter((r) => r.t !== null) };
};

// Per-system alert thresholds from alert.models defaults (user_id='default',
// enabled). Resolution semantics live in compute/thresholds.js (pure, so the
// check suite exercises them without a database).
const fetch_thresholds = async (system_id, vendor) => {
  const fields = vendor.pressure.model_fields.concat(vendor.helium.model_fields);
  const rows = await db.any(get_default_thresholds, [system_id, fields]);
  return resolve_thresholds(rows, vendor);
};

// Display units from the vendor's mag.*_units row (e.g. Siemens helium can be
// LTRS instead of %). ABSENT (null/undefined) values fall back to the vendor
// defaults; a PRESENT-but-empty string is a configuration error and fails
// closed — `||` treated "" as missing and silently substituted the default,
// so a blanked units row never reached the fail-closed bounds dispatch.
const unit_of = (raw, fallback, system_id, what) => {
  if (raw === null || raw === undefined) return fallback;
  const s = String(raw).trim();
  if (!s)
    throw new Error(
      `empty ${what} units configured for ${system_id} — set the units row or clear it to NULL`
    );
  return s;
};

const fetch_units = async (system_id, vendor) => {
  const q = units_queries[vendor.key];
  // Fail closed with a named cause — db.any(undefined) rejects with an
  // unattributable "Invalid query format".
  if (!q) throw new Error(`no units query registered for vendor "${vendor.key}"`);
  const rows = await db.any(q, [system_id]);
  const row = rows[0] || {};
  const pressure = unit_of(row.pressure_units, vendor.pressure.units, system_id, "pressure");
  return {
    helium: unit_of(row.helium_units, vendor.helium.units, system_id, "helium"),
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
