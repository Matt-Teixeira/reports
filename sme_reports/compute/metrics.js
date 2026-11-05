// Metric aggregation over the normalized series. All pure functions —
// no DB, no date formatting (display formatting lives in render/model.js).

const HOUR_MS = 3600000;

const stats_for = (points) => {
  if (!points.length) return null;
  let min = points[0];
  let max = points[0];
  for (const p of points) {
    if (p.v < min.v) min = p;
    if (p.v > max.v) max = p;
  }
  const first = points[0];
  const last = points[points.length - 1];
  return {
    first: { ...first },
    last: { ...last },
    min: { ...min },
    max: { ...max },
    count: points.length
  };
};

// Splits points around an event window; peak/rate facts are computed within
// the event when one exists, otherwise globally. The event scope extends
// THERMAL_LAG_MS past recovery — pressure/temperature routinely keeps
// climbing for hours after a compressor restarts, and the honest event peak
// includes that tail.
const THERMAL_LAG_MS = 24 * 3600000;

const metric_facts = (points, event, { other_events = [] } = {}) => {
  const all = stats_for(points);
  if (!all) return null;

  let baseline = null;
  let during = null;
  if (event) {
    // Baseline excludes points inside any *other* event window (+ lag) so
    // earlier incidents don't pollute it. It can therefore come back null
    // even with pre-event points; base_v then falls back to all.first.v.
    const in_other = (t) =>
      other_events.some(
        (ev) => t >= ev.start && (ev.end === null || t <= ev.end + THERMAL_LAG_MS)
      );
    baseline = stats_for(
      points.filter((p) => p.t < event.start && !in_other(p.t))
    );
    during = stats_for(
      points.filter(
        (p) =>
          p.t >= event.start &&
          (event.end === null || p.t <= event.end + THERMAL_LAG_MS)
      )
    );
  }

  const scope = during || all;
  // With no event, the first reading is a fair stand-in for the baseline.
  // With an event, it is not: exclusion may have removed every clean
  // pre-event point, and all.first.v could sit inside an excluded window —
  // using it would report a rise from a value the magnet never rested at.
  // Null instead, and every derived comparison drops out with it.
  const base_v = baseline ? baseline.last.v : event ? null : all.first.v;
  const peak = scope.max;
  const ramp_hours = (peak.t - (event ? event.start : all.first.t)) / HOUR_MS;
  const rate_per_hr =
    base_v !== null && ramp_hours > 0.5 ? (peak.v - base_v) / ramp_hours : null;

  return {
    all,
    baseline,
    during,
    peak: { ...peak },
    last: { ...all.last },
    baseline_value: base_v,
    delta_vs_baseline: base_v === null ? null : all.last.v - base_v,
    rate_per_hr,
    // Least-squares fit over every reading in the period — the input to
    // the steady-rise judgment (judgments.js steady_rise).
    trend: linear_trend(points)
  };
};

// Least-squares trend over the period's readings: the fitted slope
// (units/hr), the span it was fitted over, and the rise the fit implies
// across that span (slope × span — the line's end minus its start, so a
// bump that comes back down contributes ~nothing, unlike peak − first).
// Null with fewer than 3 readings or a span under 1 hour. Times are
// centered before squaring: raw epoch ms squared loses precision.
const linear_trend = (points) => {
  if (!points || points.length < 3) return null;
  const t0 = points[0].t;
  const span_hours = (points[points.length - 1].t - t0) / HOUR_MS;
  if (!(span_hours >= 1)) return null;
  const n = points.length;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += (p.t - t0) / HOUR_MS;
    my += p.v;
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of points) {
    const dx = (p.t - t0) / HOUR_MS - mx;
    const dy = p.v - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope_per_hr = sxy / sxx;
  return {
    slope_per_hr,
    span_hours,
    fitted_rise: slope_per_hr * span_hours,
    fitted_start: my - slope_per_hr * mx,
    // Share of the variance the line explains: near 0 for noise or a
    // bump-and-return, near 1 for a steady climb.
    r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy)
  };
};

// Median |capture - host| clock skew in minutes over rows carrying both.
const clock_skew_minutes = (series) => {
  const diffs = series
    .filter((r) => r.host_t !== null)
    .map((r) => Math.abs(r.t - r.host_t) / 60000)
    .sort((a, b) => a - b);
  if (!diffs.length) return null;
  return diffs[Math.floor(diffs.length / 2)];
};

const valid_counts = (series) => ({
  captures: series.length,
  pressure: series.filter((r) => r.pressure !== null).length,
  helium: series.filter((r) => r.helium !== null).length
});

module.exports = { stats_for, metric_facts, linear_trend, clock_skew_minutes, valid_counts };
