// Scale/tick helpers for the SVG charts. Geometry follows the reports_new
// exemplars: viewBox 640x152, plot area x in [46, 632], y in [12, 126].

const PLOT = { x0: 46, x1: 632, y0: 126, y1: 12 }; // y0 = bottom, y1 = top

const linear = ([d0, d1], [r0, r1]) => (v) =>
  r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

const NICE_STEPS = [1, 2, 2.5, 5];

// Smallest "nice" step (1/2/2.5/5 x 10^n) giving at most max_intervals.
const nice_step = (span, max_intervals) => {
  const raw = span / max_intervals;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  for (const s of NICE_STEPS) {
    const step = s * mag;
    if (span / step <= max_intervals) return step;
  }
  return 10 * mag;
};

// Pressure y-domain. Gauge-style metrics (no low threshold) anchor at 0 and
// run up to a nice ceiling above both the data peak and the high threshold
// (10% headroom, so the threshold line never sits on the plot edge). Matches
// the exemplars: Philips peak 272/threshold 100 -> [0,300]; GE peak
// 3.7/threshold 5 -> [0,5.5]. Band metrics (Siemens absolute PSIA with a low
// AND high alert line) instead pad around the band + data, like padded_domain.
const pressure_domain = (data_min, data_max, thr) => {
  const high = thr.high_gt === null ? data_max : thr.high_gt;
  if (thr.high_lt !== null) {
    return padded_domain(
      Math.min(data_min, thr.high_lt),
      Math.max(data_max, high)
    );
  }
  const base = Math.max(data_max, high);
  const step = nice_step(base, 5);
  // Snap to the next tick, but never let the top edge sit within 10% of the
  // highest value (gridlines simply stop below a non-tick top, as in the GE
  // exemplar where the domain is [0, 5.5] with unit ticks up to 5).
  const top = Math.max(Math.ceil(base / step) * step, base * 1.1);
  return { domain: [0, top], step };
};

// Bounded-metric y-domain (helium %): pad the data range by ~35% then snap to
// nice bounds. Matches the exemplars: 76.4-79.3 -> [74,82]; 79.86-80.69 -> [79.5,81].
const padded_domain = (data_min, data_max) => {
  const span = Math.max(data_max - data_min, 0.1);
  const pad = span * 0.35;
  const step = nice_step(span + 2 * pad, 4);
  const lo = Math.floor((data_min - pad) / step) * step;
  const hi = Math.ceil((data_max + pad) / step) * step;
  return { domain: [lo, hi], step };
};

const y_ticks = ({ domain: [lo, hi], step }) => {
  const ticks = [];
  // Round each tick to the step's precision — raw float accumulation
  // produces values like 93.10000000000001 that wreck axis labels.
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  for (let v = lo; v <= hi + step / 1e6; v += step)
    ticks.push(parseFloat((Math.round(v / step) * step).toFixed(decimals)));
  return ticks;
};

// X (time) ticks: anchor the window endpoints, add interior ticks on a nice
// day step, and drop interior ticks that would collide with the anchors.
const DAY_MS = 24 * 60 * 60 * 1000;
const X_TICK_MIN_GAP_PX = 28;

const x_ticks = ([t0, t1], x_scale) => {
  const days = (t1 - t0) / DAY_MS;
  const day_steps = [1, 2, 3, 7, 14, 30];
  const step_days =
    day_steps.find((s) => days / s <= 5) || Math.ceil(days / 5);

  const ticks = [{ t: t0, anchor: "start" }];
  const first_day = Math.ceil(t0 / DAY_MS) * DAY_MS;
  for (let t = first_day; t < t1; t += step_days * DAY_MS) {
    const x = x_scale(t);
    if (
      x - x_scale(t0) >= X_TICK_MIN_GAP_PX &&
      x_scale(t1) - x >= X_TICK_MIN_GAP_PX
    )
      ticks.push({ t, anchor: "middle" });
  }
  ticks.push({ t: t1, anchor: "end" });
  return ticks;
};

module.exports = {
  PLOT,
  linear,
  nice_step,
  pressure_domain,
  padded_domain,
  y_ticks,
  x_ticks
};
