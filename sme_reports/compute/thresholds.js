// Per-system alert-threshold resolution: alert.models default rows -> the
// threshold shape used everywhere downstream ({ pressure, helium }).
//
// Pure and DB-free BY REQUIREMENT: data.fetch_thresholds queries the rows and
// delegates here, but requiring data.js loads the pg pool (which reads env +
// SSL cert at module load), so the check suite exercises this module
// directly. Row shape is get-default-thresholds.sql's SELECT: { field_name,
// operator, threshold, threshold_units, severity }.
//
// Multiple rows for the same operator/severity keep the most conservative
// value (lowest greater_than, highest less_than). Falls back to the vendor's
// OEM constants when no default model rows exist.

const { fallback_thresholds } = require("../vendors");

const resolve_thresholds = (rows, vendor) => {
  const fallback = fallback_thresholds(vendor);
  const p = {
    units: vendor.pressure.units,
    high_gt: null,
    high_lt: null,
    med_gt: null,
    med_lt: null,
    source: "default_models"
  };
  const he = { low_high: null, low_med: null, units: null, source: "default_models" };
  let he_configured = false;

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
      he_configured = true;
    }
  }

  // Normalize display casing ("mBar" -> "mbar") to match the report style.
  p.units = p.units === "mBar" ? "mbar" : p.units;

  // PER-CHANNEL resolution: each channel keeps its own configured rows and
  // carries its own provenance. A single all-or-nothing gate here used to
  // return the WHOLE OEM fallback whenever pressure resolved no high row —
  // silently discarding a system's configured helium limits with it.
  //
  // The pressure predicate is deliberately unchanged: med-only pressure rows
  // still fall back to the OEM constant (whether a med-only config should
  // drive the med line without a high line is a domain decision, not this
  // change). Helium falls back to "nothing configured" (source "none") —
  // there is no OEM helium constant, and a channel without limits is stated,
  // never judged.
  const pressure =
    p.high_gt === null && p.high_lt === null ? fallback.pressure : p;
  const helium = he_configured ? he : fallback.helium;
  return { pressure, helium };
};

module.exports = { resolve_thresholds };
