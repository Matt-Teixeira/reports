// Pure series helpers: cleaning, daily rollups, and the chart-mode decision.

const DAY_MS = 24 * 60 * 60 * 1000;

// Above this many captures in the window, charts switch to a daily min/max
// band; at or below it every capture is plotted as a line.
const BAND_MODE_CAPTURE_LIMIT = 500;

const clean_series = (series) =>
  series
    .filter((r) => r.t !== null && !Number.isNaN(r.t))
    .sort((a, b) => a.t - b.t);

const chart_mode = (series) =>
  series.length > BAND_MODE_CAPTURE_LIMIT ? "band" : "line";

const metric_points = (series, field) =>
  series
    .filter((r) => r[field] != null && !Number.isNaN(r[field]))
    .map((r) => ({ t: r.t, v: r[field] }));

// Groups points into UTC days -> [{t: day_start_ms, min, max, last}]
const daily_rollup = (points) => {
  const days = new Map();
  for (const p of points) {
    const day = Math.floor(p.t / DAY_MS) * DAY_MS;
    const d = days.get(day);
    if (!d) {
      days.set(day, { t: day, min: p.v, max: p.v, last: p.v, last_t: p.t });
    } else {
      if (p.v < d.min) d.min = p.v;
      if (p.v > d.max) d.max = p.v;
      if (p.t >= d.last_t) {
        d.last = p.v;
        d.last_t = p.t;
      }
    }
  }
  return [...days.values()].sort((a, b) => a.t - b.t);
};

// Chart-ready points for one metric: band mode collapses to daily rollups,
// line mode keeps every capture (min = max = v so the band degenerates away).
const chart_points = (points, mode) =>
  mode === "band"
    ? daily_rollup(points).map((d) => ({
        t: d.t,
        min: d.min,
        max: d.max,
        v: d.last
      }))
    : points.map((p) => ({ t: p.t, min: p.v, max: p.v, v: p.v }));

module.exports = {
  DAY_MS,
  BAND_MODE_CAPTURE_LIMIT,
  clean_series,
  chart_mode,
  metric_points,
  daily_rollup,
  chart_points
};
