// Compressor event detection over the normalized series.
// An "off run" is a contiguous stretch of rows with compressor_on === false
// (nulls are skipped, they carry no state information). The overall event
// window spans first stop -> recovery after the last off run, or stays open
// (end = null) when the series ends with the compressor off.

const find_off_runs = (series) => {
  const stateful = series.filter((r) => r.compressor_on !== null);
  const off_runs = [];
  let run = null;
  for (const row of stateful) {
    if (row.compressor_on === false) {
      if (!run) {
        run = { start: row.t, end: row.t, count: 1 };
        off_runs.push(run);
      } else {
        run.end = row.t;
        run.count += 1;
      }
    } else if (run) {
      run.recovered_t = row.t;
      run = null;
    }
  }
  return off_runs;
};

const build_compressor_event = (off_runs) => {
  if (!off_runs.length) return null;
  const last = off_runs[off_runs.length - 1];
  const off_count = off_runs.reduce((n, r) => n + r.count, 0);
  return {
    start: off_runs[0].start,
    end: last.recovered_t || null, // null => compressor still off at end of window
    cycles: off_runs.length,
    off_count,
    off_hours: (last.end - off_runs[0].start) / 3600000
  };
};

// Flicker classification: compressor state sensors (especially the EDU
// vibration sensor) occasionally drop a single reading without the machine
// actually stopping. An off-run is deemed a FLICKER when it is
//   (a) shorter than min_off_readings consecutive readings, AND
//   (b) uncorroborated — the primary metric shows no meaningful rise within
//       response_lag_ms after the run starts (a real stop warms things), AND
//   (c) not the trailing run of the window (a fresh dropout at the end could
//       be the start of a real, ongoing stop — alert bias wins).
// Real events are built from the remaining runs only; flickers are reported
// separately so the narrative can call them what they are.
const FLICKER_DEFAULTS = {
  min_off_readings: 2,
  response_lag_ms: 2 * 3600000
};

const classify_compressor_runs = (
  off_runs,
  metric_pts,
  { min_off_readings, response_lag_ms, response_epsilon } = {}
) => {
  min_off_readings = min_off_readings || FLICKER_DEFAULTS.min_off_readings;
  response_lag_ms = response_lag_ms || FLICKER_DEFAULTS.response_lag_ms;

  const real = [];
  const flickers = [];
  for (const run of off_runs) {
    if (run.count >= min_off_readings || !run.recovered_t) {
      real.push(run);
      continue;
    }
    // Corroboration: compare the metric just before the run against its peak
    // through the lag window. No epsilon (or no metric data) -> flicker.
    let responded = false;
    if (response_epsilon && metric_pts && metric_pts.length) {
      const before = metric_pts.filter((p) => p.t < run.start);
      const baseline = before.length ? before[before.length - 1].v : null;
      const after = metric_pts.filter(
        (p) => p.t >= run.start && p.t <= run.end + response_lag_ms
      );
      if (baseline !== null && after.length) {
        const peak = Math.max(...after.map((p) => p.v));
        responded = peak - baseline >= response_epsilon;
      }
    }
    if (responded) real.push(run);
    else flickers.push(run);
  }
  return { real_runs: real, flicker_runs: flickers };
};

// Convenience wrapper preserving the original single-call shape (used by
// callers that don't need flicker separation, e.g. dev checks).
const detect_compressor_event = (series) =>
  build_compressor_event(find_off_runs(series));

// Temp-alarm runs (Philips): rows with the alarm raised, grouped into
// contiguous run intervals, plus the peak alarm-state reading (minutes).
const detect_temp_alarm = (series) => {
  const active = series.filter((r) => r.temp_alarm === true);
  if (!active.length) return null;

  const idx = series
    .map((r, i) => (r.temp_alarm === true ? i : -1))
    .filter((i) => i >= 0);
  const intervals = [{ start: series[idx[0]].t, end: series[idx[0]].t }];
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] - idx[i - 1] > 1)
      intervals.push({ start: series[idx[i]].t, end: series[idx[i]].t });
    else intervals[intervals.length - 1].end = series[idx[i]].t;
  }

  const minutes = active
    .map((r) => r.temp_alarm_minutes)
    .filter((v) => v !== null && v !== undefined);

  return {
    start: active[0].t,
    end: active[active.length - 1].t,
    count: active.length,
    runs: intervals.length,
    intervals,
    max_minutes: minutes.length ? Math.max(...minutes) : null
  };
};

const detect_quench = (series) => series.some((r) => r.quenched === true);

module.exports = {
  find_off_runs,
  build_compressor_event,
  classify_compressor_runs,
  detect_compressor_event,
  detect_temp_alarm,
  detect_quench
};
