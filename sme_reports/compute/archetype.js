// Priority-ordered event archetype classification. The archetype picks which
// narrative template renders and colors several KPI tiles.

const RISING_RATE_EPSILON = 0.001; // per-hour, in the metric's native units
const RISING_PCT_OF_THRESHOLD = 0.6;

// The CLOSED set of conditions classify can produce, in priority order —
// conditions.js SEVERITY_ORDER must equal it exactly and render/narrative
// STORIES must cover it (both check-asserted). classify validates its own
// output at runtime, so a future branch returning an unregistered key
// fails HERE with a named error instead of reaching an unregistered story.
const ARCHETYPES = [
  "compressor_stop_ongoing",
  "compressor_stop_recovered",
  "threshold_exceeded",
  "pressure_rising",
  "stable_healthy"
];

// thr is the pressure threshold object from data.fetch_thresholds():
// {high_gt, high_lt, med_gt, med_lt, units} — high_lt is the low alert line
// on band-alerted metrics (Siemens absolute PSIA).
const classify_inner = ({ compressor_event, pressure, thr }) => {
  // A hand-supplied event window containing no observed OFF readings still
  // scopes the analysis, but must not narrate a stop that was never seen.
  const observed = compressor_event && compressor_event.off_count !== 0;
  if (observed && compressor_event.end === null) return "compressor_stop_ongoing";
  if (observed) return "compressor_stop_recovered";
  if (
    pressure &&
    ((thr.high_gt !== null && pressure.peak.v >= thr.high_gt) ||
      (thr.high_lt !== null && pressure.all.min.v <= thr.high_lt))
  )
    return "threshold_exceeded";
  if (
    pressure &&
    thr.high_gt !== null &&
    pressure.rate_per_hr !== null &&
    pressure.rate_per_hr > RISING_RATE_EPSILON &&
    pressure.last.v >= thr.high_gt * RISING_PCT_OF_THRESHOLD
  )
    return "pressure_rising";
  return "stable_healthy";
};

const classify = (facts) => {
  const out = classify_inner(facts);
  if (!ARCHETYPES.includes(out))
    throw new Error(
      `classify produced unregistered archetype "${out}" — register it in ARCHETYPES, conditions.js SEVERITY_ORDER, and render/narrative.js STORIES`
    );
  return out;
};

module.exports = { classify, ARCHETYPES };
