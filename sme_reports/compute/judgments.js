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

// "Pressure rising" without a compressor event: a STEADY climb that has
// used a real share of the room left below the alert line (RULES.md §2,
// decided 2026-11-04 against the whole fleet). Fitted over every reading
// in the period (metrics.js linear_trend), so a spike that comes back down
// is not a rise — reported only if it crosses the line (threshold_exceeded).
//
//   fitted rise ≥ RISING_HEADROOM_SHARE × (alert line − where the line
//   starts)  and  r² ≥ RISING_MIN_R2
//
// Measured against the room to the line rather than as a share OF the
// line, so it means the same on absolute pressure (Siemens 4K ~15.3 PSIA
// under 16.4 — 60% of the line was always met) and on gauge pressure (GE
// ~1–3 PSI under 5.2). The previous rule (peak − first > 0.001/hr and ≥60%
// of the line) flagged 12 of 146 systems over 30 days, every one a flat
// Siemens magnet, and missed two GE magnets climbing steadily.
const RISING_HEADROOM_SHARE = 0.1;
const RISING_MIN_R2 = 0.5;

// A trend needs time to be one: under a day of readings, a few quantized
// steps (Siemens reports 0.01 PSIA) fit a perfect line and can read as a
// large share of a small headroom — 16.35, 16.36, 16.37 in an hour is "40%
// of the room" (rising-trend review F2). Short explicit windows still show
// stops and breaches; they just never call a rise.
const RISING_MIN_SPAN_HOURS = 24;

// -> { rise, hours, share } or null. Needs an upper alert line to measure
// the room against; a series already starting at or over it is a breach,
// not a rise.
const steady_rise = (pressure, thr) => {
  const tr = pressure && pressure.trend;
  if (!tr || !thr || thr.high_gt === null) return null;
  if (tr.span_hours < RISING_MIN_SPAN_HOURS) return null;
  const headroom = thr.high_gt - tr.fitted_start;
  if (!(headroom > 0)) return null;
  const share = tr.fitted_rise / headroom;
  if (share < RISING_HEADROOM_SHARE || tr.r2 < RISING_MIN_R2) return null;
  return { rise: tr.fitted_rise, hours: tr.span_hours, share };
};

// The trend word on tiles and the fleet arrows. With an OBSERVED stop the
// event ramp decides, as before (peak vs the pre-event baseline — a
// meaningful rate). Without one, only a steady rise reads "rising" — the
// same answer the classifier reads — and it wins over "easing": a system
// classified pressure_rising must not wear a ↓ because its last reading
// sits a hair under the period's peak. analyze sets event_observed and
// steady_rise together (steady_rise is always null with an observed stop).
const trend_of = (pressure) => {
  if (!pressure) return null;
  if (pressure.steady_rise) return "rising";
  if (pressure.last.v < pressure.peak.v * 0.995) return "easing";
  if (pressure.event_observed && pressure.rate_per_hr !== null && pressure.rate_per_hr > 0) return "rising";
  return null;
};

module.exports = { p_severity, trend_of, steady_rise, RISING_HEADROOM_SHARE, RISING_MIN_R2, RISING_MIN_SPAN_HOURS };
