// Compressor event detection over the normalized series.
// An "off run" is a contiguous stretch of rows with compressor_on === false
// (nulls are skipped, they carry no state information). The overall event
// window spans first stop -> recovery after the last off run, or stays open
// (end = null) when the series ends with the compressor off.

const detect_compressor_event = (series) => {
  const stateful = series.filter((r) => r.compressor_on !== null);
  if (!stateful.length) return null;

  const off_runs = [];
  let run = null;
  let recovery_t = null;
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
  if (!off_runs.length) return null;

  const last = off_runs[off_runs.length - 1];
  recovery_t = last.recovered_t || null;

  const off_count = off_runs.reduce((n, r) => n + r.count, 0);
  return {
    start: off_runs[0].start,
    end: recovery_t, // null => compressor still off at end of window
    cycles: off_runs.length,
    off_count,
    off_hours: (last.end - off_runs[0].start) / 3600000
  };
};

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

module.exports = { detect_compressor_event, detect_temp_alarm, detect_quench };
