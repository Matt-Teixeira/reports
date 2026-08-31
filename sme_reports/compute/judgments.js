// Shared threshold/trend judgments, compute-owned. These two helpers began
// life in render/tiles.js and were imported back into compute by
// summary_facts — the one render→compute→render cycle in the codebase
// (render/model → compute/summary_facts → render/tiles). They are not
// display code: p_severity grades a value against the alert-line object and
// trend_of names the trend the wording and the fleet arrows both derive
// from, and both feed non-visual judgments (offline-state corroboration,
// the distilled records). tiles.js re-exports them so its callers keep
// working.

// Severity of a pressure value against the threshold object.
const p_severity = (v, thr) => {
  if (v === null) return "none";
  if (thr.high_gt !== null && v >= thr.high_gt) return "high";
  if (thr.high_lt !== null && v <= thr.high_lt) return "high";
  if (thr.med_gt !== null && v >= thr.med_gt) return "med";
  if (thr.med_lt !== null && v <= thr.med_lt) return "med";
  return "ok";
};

const trend_of = (pressure) => {
  if (!pressure) return null;
  if (pressure.last.v < pressure.peak.v * 0.995) return "easing";
  if (pressure.rate_per_hr !== null && pressure.rate_per_hr > 0) return "rising";
  return null;
};

module.exports = { p_severity, trend_of };
