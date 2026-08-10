// Compressor event detection over the normalized series.
// An "off run" is a contiguous stretch of rows with compressor_on === false
// (nulls are skipped, they carry no state information). Runs separated by
// more than EVENT_GAP_MS of ON time are distinct events (clusters); each
// event spans its first stop -> recovery after its last off run, or stays
// open (end = null) when the series ends with the compressor off.

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

// Real off-runs whose ON gap (next stop minus previous recovery) exceeds
// this are separate incidents, not one event. Time-based rather than
// reading-count based — EDU-sourced compressor cadence differs from mag rows.
const EVENT_GAP_MS = 48 * 3600000;

// Off time contributed by one run: the span of its off readings plus one
// capture period, because each off reading stands for the period it was
// observed over — a single-reading stop counts as one period, not zero.
// The trailing period is capped at the actual time to recovery, so a dense
// burst of captures inside an otherwise sparse series can never report more
// downtime than elapsed between the stop and the restart. An unrecovered run
// has nothing to cap against and takes the full period.
const run_off_ms = (run, interval_ms) => {
  const tail = run.recovered_t
    ? Math.min(interval_ms, Math.max(0, run.recovered_t - run.end))
    : interval_ms;
  return run.end - run.start + tail;
};

const build_compressor_events = (
  off_runs,
  { gap_ms = EVENT_GAP_MS, interval_ms = 0 } = {}
) => {
  if (!off_runs.length) return [];
  const clusters = [[off_runs[0]]];
  for (let i = 1; i < off_runs.length; i++) {
    const prev = off_runs[i - 1];
    const gap = off_runs[i].start - (prev.recovered_t || prev.end);
    if (gap > gap_ms) clusters.push([off_runs[i]]);
    else clusters[clusters.length - 1].push(off_runs[i]);
  }
  return clusters.map((runs) => {
    const last = runs[runs.length - 1];
    const open = !last.recovered_t;
    const off_ms = runs.reduce((ms, r) => ms + run_off_ms(r, interval_ms), 0);
    return {
      start: runs[0].start,
      end: open ? null : last.recovered_t, // null => still off at end of window
      // Start of the event's FINAL off-run: for a multi-run event whose
      // first run is left-truncated (already off when coverage began), this
      // is the observed moment the compressor went down for good — the
      // event's `start` would misstate it by the truncated run's span.
      last_stop_t: last.start,
      cycles: runs.length,
      off_count: runs.reduce((n, r) => n + r.count, 0),
      off_hours: off_ms / 3600000
    };
  });
};

// A request-supplied event window fixes start/end by hand, but the reading
// counts still come from the data inside it — otherwise the tile and story
// render "undefined readings off" and "off ~NaN h". A run overlapping either
// boundary contributes only the part inside the window: its off readings are
// re-counted from the series rather than taken wholesale, so a run that
// starts before the window is not dropped and one that runs past the end is
// not charged in full. off_count === 0 means the window contains no observed
// stop, which the tile and story report as such.
const describe_event_window = (
  window,
  off_runs,
  stateful,
  { interval_ms = 0 } = {}
) => {
  const end = window.end === undefined ? null : window.end;
  const w_end = end === null ? Infinity : end;
  let cycles = 0;
  let off_count = 0;
  let off_ms = 0;
  // First off reading of the LAST intersecting run (clipped to the window)
  // — the same observed trailing-stop anchor build_compressor_events
  // carries, so start-truncated wording works through this path too.
  let last_stop_t = null;
  for (const run of off_runs) {
    if (run.end < window.start || run.start > w_end) continue;
    const readings = stateful.filter(
      (r) =>
        r.compressor_on === false &&
        r.t >= Math.max(run.start, window.start) &&
        r.t <= Math.min(run.end, w_end)
    );
    if (!readings.length) continue;
    const last_t = readings[readings.length - 1].t;
    // Only cap against a recovery that actually falls inside the window;
    // otherwise the clipped run is open as far as this window can tell.
    const clipped = {
      start: readings[0].t,
      end: last_t,
      recovered_t: run.recovered_t <= w_end ? run.recovered_t : undefined
    };
    cycles += 1;
    off_count += readings.length;
    off_ms += run_off_ms(clipped, interval_ms);
    last_stop_t = clipped.start;
  }
  return {
    start: window.start,
    end,
    last_stop_t,
    cycles,
    off_count,
    off_hours: off_ms / 3600000
  };
};

// The report anchors on one event: an open trailing event always wins
// (ongoing beats everything); otherwise the largest true off time, with
// ties going to the most recent. Returns the same object reference held in
// the array — callers identify the other events by identity.
const select_primary_event = (events) => {
  if (!events.length) return null;
  const last = events[events.length - 1];
  if (last.end === null) return last;
  return events.reduce((best, ev) => (ev.off_hours >= best.off_hours ? ev : best));
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
const detect_compressor_event = (series, opts = {}) =>
  select_primary_event(build_compressor_events(find_off_runs(series), opts));

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
  build_compressor_events,
  describe_event_window,
  select_primary_event,
  classify_compressor_runs,
  detect_compressor_event,
  detect_temp_alarm,
  detect_quench,
  EVENT_GAP_MS
};
