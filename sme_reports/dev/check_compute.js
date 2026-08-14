// Plain node:assert checks for the compute layer (no test framework in repo).
// Run: node sme_reports/dev/check_compute.js
const assert = require("assert");

const {
  chart_mode,
  daily_rollup,
  metric_points,
  median_interval_ms,
  clean_series
} = require("../compute/series");
const {
  find_off_runs,
  build_compressor_events,
  describe_event_window,
  select_primary_event,
  classify_compressor_runs,
  detect_compressor_event,
  detect_temp_alarm,
  detect_quench
} = require("../compute/events");
const { metric_facts, clock_skew_minutes } = require("../compute/metrics");
const { classify } = require("../compute/archetype");
const { normalize_request } = require("../request_loader");
const {
  pressure_domain,
  padded_domain
} = require("../render/scales");

const HOUR = 3600000;
const T0 = Date.UTC(2026, 5, 28); // 2026-06-28

// Builds a normalized row; overrides fill specific fields.
const row = (h, over = {}) => ({
  t: T0 + h * HOUR,
  host_t: null,
  pressure: 30,
  pressure_avg: null,
  helium: 76.5,
  compressor_on: true,
  coldhead_k: null,
  shield_k: null,
  temp_alarm: false,
  quenched: false,
  ...over
});

// --- compressor event detection ---------------------------------------------
{
  // on on off off on off on -> 2 off runs 2h apart (< gap) form ONE event.
  const s = [
    row(0),
    row(1),
    row(2, { compressor_on: false }),
    row(3, { compressor_on: false }),
    row(4),
    row(5, { compressor_on: false }),
    row(6)
  ];
  const events = build_compressor_events(find_off_runs(s), { interval_ms: HOUR });
  assert.strictEqual(events.length, 1, "runs 2h apart cluster into one event");
  const ev = events[0];
  assert.strictEqual(ev.cycles, 2, "two off runs");
  assert.strictEqual(ev.off_count, 3, "three off readings");
  assert.strictEqual(ev.start, T0 + 2 * HOUR, "event starts at first stop");
  assert.strictEqual(ev.end, T0 + 6 * HOUR, "recovery after last off run");
  // Off time = per-run reading span + one capture period each:
  // (h3-h2 + 1) + (h5-h5 + 1) = 3h. Never the whole first-stop->recovery
  // span (4h), which would charge the ON hour between the runs to the event.
  assert.strictEqual(ev.off_hours, 3, "off_hours sums per-run off time");

  // A single-reading run must never score zero off time — a real cycling
  // incident would otherwise lose primary selection to a shorter stop.
  const single = build_compressor_events(find_off_runs([row(0), row(1, { compressor_on: false }), row(2)]), {
    interval_ms: HOUR
  });
  assert.strictEqual(single[0].off_hours, 1, "one off reading = one capture period");
  assert.strictEqual(
    build_compressor_events(find_off_runs(s))[0].off_hours,
    1,
    "interval defaults to 0 when the caller cannot supply one"
  );
}
{
  // Irregular cadence: a dense burst inside an otherwise hourly series must
  // not report more downtime than elapsed between the stop and the restart.
  const MIN = 60000;
  const s = [];
  for (let h = 0; h < 10; h++) s.push(row(h));
  s.push({ ...row(0), t: T0 + 10 * HOUR + 1 * MIN, compressor_on: false });
  s.push({ ...row(0), t: T0 + 10 * HOUR + 4 * MIN, compressor_on: false });
  s.push({ ...row(0), t: T0 + 10 * HOUR + 6 * MIN }); // recovery, 5 min after stop
  const interval = median_interval_ms(s);
  assert.strictEqual(interval, HOUR, "median stays hourly despite the burst");
  const ev = build_compressor_events(find_off_runs(s), { interval_ms: interval })[0];
  const span_h = (ev.end - ev.start) / HOUR;
  assert.ok(
    ev.off_hours <= span_h,
    `off_hours ${ev.off_hours} must not exceed stop->recovery span ${span_h}`
  );
  assert.ok(Math.abs(ev.off_hours - 5 / 60) < 1e-9, `5 min off, got ${ev.off_hours}`);
}
{
  // median_interval_ms convention on an even number of unequal gaps: the
  // upper of the two middle values (index length/2 on the sorted list).
  const t = (mins) => ({ t: T0 + mins * 60000 });
  assert.strictEqual(median_interval_ms([t(0), t(1)]), 60000, "single gap");
  assert.strictEqual(median_interval_ms([t(0)]), null, "one row -> no interval");
  assert.strictEqual(median_interval_ms([]), null, "empty -> no interval");
  // gaps of 1, 2, 60, 600 min -> sorted [1,2,60,600], index 2 -> 60 min
  assert.strictEqual(
    median_interval_ms([t(0), t(1), t(3), t(63), t(663)]),
    60 * 60000,
    "even count takes the upper middle gap"
  );
}
{
  // Cluster boundary is strict: exactly 48h of ON time stays one event.
  const at = build_compressor_events(
    find_off_runs([
      row(0, { compressor_on: false }),
      row(1), // recovery at h1
      row(49, { compressor_on: false }), // gap exactly 48h
      row(50)
    ])
  );
  assert.strictEqual(at.length, 1, "gap of exactly 48h does not split");
  const past = build_compressor_events(
    find_off_runs([
      row(0, { compressor_on: false }),
      row(1),
      row(49.001, { compressor_on: false }), // gap 48h + 3.6s
      row(51)
    ])
  );
  assert.strictEqual(past.length, 2, "gap beyond 48h splits");
}
{
  // Runs separated by >48h of ON time are distinct events.
  const s = [
    row(0, { compressor_on: false }),
    row(10, { compressor_on: false }), // 10h run (one cluster: gap 10h < 48h... adjacent rows)
    row(11),
    row(100, { compressor_on: false }), // 89h ON gap -> new event
    row(101, { compressor_on: false }),
    row(102)
  ];
  const events = build_compressor_events(find_off_runs(s), { interval_ms: HOUR });
  assert.strictEqual(events.length, 2, "89h gap splits events");
  assert.strictEqual(events[0].off_hours, 11, "first event off h0 -> h10, +1 period");
  assert.strictEqual(events[1].off_hours, 2, "second event off h100 -> h101, +1 period");
  const primary = select_primary_event(events);
  assert.strictEqual(primary, events[0], "largest off time wins when all recovered");

  // Equal off time -> most recent wins.
  const tie = build_compressor_events(
    find_off_runs([
      row(0, { compressor_on: false }),
      row(2),
      row(200, { compressor_on: false }),
      row(202)
    ])
  );
  assert.strictEqual(tie.length, 2);
  assert.strictEqual(tie[0].off_hours, tie[1].off_hours, "tied off time");
  assert.strictEqual(select_primary_event(tie), tie[1], "tie goes to most recent");

  // An open trailing event beats a larger recovered one (alert bias), and
  // stops accruing at the last reading — never at the requested window end.
  const open = build_compressor_events(
    find_off_runs([
      row(0, { compressor_on: false }),
      row(40, { compressor_on: false }),
      row(41),
      row(299, { compressor_on: false }) // still off at the last capture
    ]),
    { interval_ms: HOUR }
  );
  assert.strictEqual(open.length, 2);
  assert.strictEqual(open[1].end, null, "trailing event is open");
  assert.strictEqual(select_primary_event(open), open[1], "ongoing beats larger recovered");
  assert.strictEqual(
    open[1].off_hours,
    1,
    "open event accrues only what was observed, +1 period"
  );
}
{
  // A request-supplied window counts only what lies inside it, including
  // runs that cross either boundary.
  const s = [];
  for (let h = 0; h <= 30; h++)
    s.push(row(h, { compressor_on: !((h >= 5 && h <= 15) || (h >= 18 && h <= 25)) }));
  const runs = find_off_runs(s);
  const win = { start: T0 + 10 * HOUR, end: T0 + 20 * HOUR };
  const ev = describe_event_window(win, runs, s, { interval_ms: HOUR });
  assert.strictEqual(ev.start, win.start, "override start is honored verbatim");
  assert.strictEqual(ev.end, win.end, "override end is honored verbatim");
  assert.strictEqual(ev.cycles, 2, "both boundary-crossing runs counted");
  // Run A (h5-h15) contributes h10-h15 = 6 readings; run B (h18-h25)
  // contributes h18-h20 = 3 readings. Neither is dropped nor counted whole.
  assert.strictEqual(ev.off_count, 9, `in-window off readings, got ${ev.off_count}`);
  // A: 5h span + 1h tail (recovery at h16 is inside) = 6h.
  // B: 2h span + 1h tail (recovery at h26 is outside -> open) = 3h.
  assert.strictEqual(ev.off_hours, 9, `clipped off time, got ${ev.off_hours}`);

  // A window with no OFF readings reports none rather than a ~0.0 h stop.
  const quiet = describe_event_window(
    { start: T0 + 27 * HOUR, end: T0 + 29 * HOUR },
    runs,
    s,
    { interval_ms: HOUR }
  );
  assert.strictEqual(quiet.off_count, 0, "no off readings in a quiet window");
  assert.strictEqual(quiet.cycles, 0);
  assert.strictEqual(quiet.off_hours, 0);
  assert.strictEqual(
    classify({ compressor_event: quiet, pressure: null, thr: { high_gt: null, high_lt: null } }),
    "stable_healthy",
    "an unobserved stop is not narrated as a compressor stop"
  );

  // An open-ended override (no end) runs to the end of the data.
  const open = describe_event_window({ start: T0 + 18 * HOUR, end: null }, runs, s, {
    interval_ms: HOUR
  });
  assert.strictEqual(open.end, null, "open override stays open");
  assert.strictEqual(open.off_count, 8, "h18-h25 readings");
}
{
  // A flicker between two real runs must not bridge them into one event:
  // classification removes it before clustering ever sees it.
  const s = [
    row(0, { compressor_on: false }),
    row(1, { compressor_on: false }),
    row(2),
    row(60, { compressor_on: false }), // single dropout, uncorroborated
    row(61),
    row(120, { compressor_on: false }),
    row(121, { compressor_on: false }),
    row(122)
  ];
  const { real_runs, flicker_runs } = classify_compressor_runs(find_off_runs(s), [], {});
  assert.strictEqual(flicker_runs.length, 1, "mid-gap dropout is a flicker");
  const events = build_compressor_events(real_runs);
  assert.strictEqual(events.length, 2, "flicker does not bridge the 118h gap");
}
{
  // series ends off -> open event; empty inputs
  const s = [row(0), row(1, { compressor_on: false }), row(2, { compressor_on: false })];
  const ev = detect_compressor_event(s);
  assert.strictEqual(ev.end, null, "open event when series ends off");
  assert.strictEqual(detect_compressor_event([row(0), row(1)]), null, "no event when always on");
  assert.deepStrictEqual(build_compressor_events([]), [], "no runs -> no events");
  assert.strictEqual(select_primary_event([]), null, "no events -> no primary");
}

// --- flicker classification -------------------------------------------------
{
  // Two single-reading dropouts + one 3-reading run; metric flat except a
  // real rise after the second single dropout (corroborated -> real).
  const s = [
    row(0),
    row(1, { compressor_on: false }), // flicker candidate 1 — no response
    row(2),
    row(3),
    row(4, { compressor_on: false }), // candidate 2 — metric responds -> real
    row(5),
    row(6, { compressor_on: false }),
    row(7, { compressor_on: false }),
    row(8, { compressor_on: false }), // 3-reading run -> real by length
    row(9)
  ];
  const metric = s.map((r, i) => ({
    t: r.t,
    v: i === 5 ? 50 : 30 // rise within lag of candidate 2 only
  }));
  const { real_runs, flicker_runs } = classify_compressor_runs(
    find_off_runs(s),
    metric,
    { response_epsilon: 2 }
  );
  assert.strictEqual(flicker_runs.length, 1, "one uncorroborated flicker");
  assert.strictEqual(flicker_runs[0].start, T0 + 1 * HOUR);
  assert.strictEqual(real_runs.length, 2, "corroborated + long runs are real");

  // Trailing single dropout (no recovery) is never a flicker.
  const tail = [row(0), row(1), row(2, { compressor_on: false })];
  const c = classify_compressor_runs(find_off_runs(tail), metric, {
    response_epsilon: 2
  });
  assert.strictEqual(c.real_runs.length, 1, "trailing dropout treated as real");
  assert.strictEqual(c.flicker_runs.length, 0);

  // No epsilon (no threshold configured): short runs default to flicker.
  const d = classify_compressor_runs(find_off_runs(s), [], {});
  assert.strictEqual(d.flicker_runs.length, 2, "no corroboration data -> both short runs flicker");
}

// --- temp alarm / quench ----------------------------------------------------
{
  const s = [
    row(0),
    row(1, { temp_alarm: true }),
    row(2, { temp_alarm: true }),
    row(3),
    row(4, { temp_alarm: true })
  ];
  const ta = detect_temp_alarm(s);
  assert.strictEqual(ta.count, 3);
  assert.strictEqual(ta.runs, 2, "re-fired once");
  assert.strictEqual(detect_quench(s), false);
  assert.strictEqual(detect_quench([row(0, { quenched: true })]), true);
}

// --- metrics ----------------------------------------------------------------
{
  // flat 30 for 10h, event at h10, ramps to 272 at h20, eases to 262 at h24
  const pts = [];
  for (let h = 0; h < 10; h++) pts.push({ t: T0 + h * HOUR, v: 30 });
  for (let h = 10; h <= 20; h++)
    pts.push({ t: T0 + h * HOUR, v: 30 + (h - 10) * 24.2 });
  for (let h = 21; h <= 24; h++) pts.push({ t: T0 + h * HOUR, v: 262 });
  const ev = { start: T0 + 10 * HOUR, end: T0 + 24 * HOUR };
  const m = metric_facts(pts, ev);
  assert.strictEqual(m.peak.v, 272);
  assert.strictEqual(m.last.v, 262);
  assert.strictEqual(m.baseline_value, 30, "baseline = last pre-event value");
  assert.ok(Math.abs(m.rate_per_hr - 24.2) < 0.01, `ramp rate ~24.2/h, got ${m.rate_per_hr}`);
  assert.strictEqual(metric_facts([], null), null);

  // Points inside another event's window (+24h lag) are excluded from the
  // baseline so an earlier incident's excursion doesn't pollute it.
  const spiked = [];
  for (let h = 0; h <= 40; h++)
    spiked.push({ t: T0 + h * HOUR, v: h <= 2 ? 100 : 30 });
  const late_ev = { start: T0 + 40 * HOUR, end: null };
  const early = { start: T0, end: T0 + 2 * HOUR };
  assert.strictEqual(
    metric_facts(spiked, late_ev).baseline.max.v,
    100,
    "without other_events the early excursion leaks into the baseline"
  );
  const excl = metric_facts(spiked, late_ev, { other_events: [early] });
  assert.strictEqual(excl.baseline.max.v, 30, "early event + 24h lag excluded from baseline");
  assert.strictEqual(excl.baseline.first.t, T0 + 27 * HOUR, "baseline resumes after lag");

  // When exclusion consumes every pre-event point there is no honest
  // baseline. It must NOT fall back to a point inside the excluded window —
  // that reports a rise from a value the magnet never rested at — and every
  // derived comparison must drop out with it.
  const short_pts = spiked.filter((p) => p.t <= T0 + 10 * HOUR);
  const none = metric_facts(short_pts, { start: T0 + 10 * HOUR, end: null }, { other_events: [early] });
  assert.strictEqual(none.baseline, null, "all pre-event points excluded");
  assert.strictEqual(none.baseline_value, null, "no baseline is not the excluded excursion");
  assert.strictEqual(none.delta_vs_baseline, null, "no delta without a baseline");
  assert.strictEqual(none.rate_per_hr, null, "no ramp rate without a baseline");
  // Without an event, the first reading remains a fair stand-in.
  assert.strictEqual(metric_facts(short_pts, null).baseline_value, 100, "no event -> first point");
}
{
  const skew = clock_skew_minutes([
    row(0, { host_t: T0 - 72 * 60000 }),
    row(1, { host_t: T0 + HOUR - 71 * 60000 })
  ]);
  assert.ok(skew >= 71 && skew <= 72, `median skew ~72min, got ${skew}`);
}

// --- archetypes -------------------------------------------------------------
{
  const p = (peak, last, rate, min = 1) => ({
    peak: { v: peak, t: 0 },
    last: { v: last, t: 1 },
    rate_per_hr: rate,
    all: { min: { v: min, t: 0 } },
    baseline_value: 1
  });
  const thr5 = { high_gt: 5, high_lt: null, med_gt: null, med_lt: null };
  assert.strictEqual(
    classify({ compressor_event: { end: null }, pressure: p(3, 3, 1), thr: thr5 }),
    "compressor_stop_ongoing"
  );
  assert.strictEqual(
    classify({ compressor_event: { end: 9 }, pressure: p(3, 3, 1), thr: thr5 }),
    "compressor_stop_recovered"
  );
  assert.strictEqual(
    classify({ compressor_event: null, pressure: p(6, 5.5, 0.1), thr: thr5 }),
    "threshold_exceeded"
  );
  assert.strictEqual(
    classify({ compressor_event: null, pressure: p(4, 4, 0.2), thr: thr5 }),
    "pressure_rising"
  );
  assert.strictEqual(
    classify({ compressor_event: null, pressure: p(1.01, 1, 0), thr: thr5 }),
    "stable_healthy"
  );
  // Siemens-style band: low-side breach triggers threshold_exceeded
  const band = { high_gt: 16.4, high_lt: 14.4, med_gt: null, med_lt: null };
  assert.strictEqual(
    classify({ compressor_event: null, pressure: p(15.4, 15.3, 0, 14.1), thr: band }),
    "threshold_exceeded"
  );
  assert.strictEqual(
    classify({ compressor_event: null, pressure: p(15.4, 15.3, 0, 14.9), thr: band }),
    "stable_healthy"
  );
}

// --- series helpers ---------------------------------------------------------
{
  const many = [];
  for (let i = 0; i < 600; i++) many.push(row(i / 10));
  assert.strictEqual(chart_mode(many), "band");
  assert.strictEqual(chart_mode(many.slice(0, 400)), "line");

  const days = daily_rollup([
    { t: T0 + 1 * HOUR, v: 5 },
    { t: T0 + 2 * HOUR, v: 9 },
    { t: T0 + 3 * HOUR, v: 7 },
    { t: T0 + 25 * HOUR, v: 3 }
  ]);
  assert.strictEqual(days.length, 2);
  assert.deepStrictEqual(
    { min: days[0].min, max: days[0].max, last: days[0].last },
    { min: 5, max: 9, last: 7 }
  );

  const cleaned = clean_series([row(2), row(0), { ...row(1), t: null }]);
  assert.strictEqual(cleaned.length, 2);
  assert.ok(cleaned[0].t < cleaned[1].t, "sorted by t");
  assert.deepStrictEqual(
    metric_points([row(0, { pressure: null }), row(1)], "pressure").length,
    1
  );
}

// --- scales (exemplar-matching domains) -------------------------------------
{
  const gt = (v) => ({ high_gt: v, high_lt: null });
  assert.deepStrictEqual(pressure_domain(28, 272, gt(100)).domain, [0, 300], "Philips domain");
  assert.deepStrictEqual(pressure_domain(1, 3.7, gt(5)).domain, [0, 5.5], "GE domain");
  assert.deepStrictEqual(padded_domain(76.4, 79.3).domain, [74, 82], "Philips helium domain");
  assert.deepStrictEqual(padded_domain(79.86, 80.69).domain, [79.5, 81], "GE helium domain");
  // Siemens band: padded around low line + data, NOT 0-anchored
  const band_dom = pressure_domain(15.1, 15.5, { high_gt: 16.4, high_lt: 14.4 }).domain;
  assert.ok(band_dom[0] > 0 && band_dom[0] <= 14.4, `band floor near low line, got ${band_dom}`);
  assert.ok(band_dom[1] >= 16.4, `band top above high line, got ${band_dom}`);
}

// --- request loader ---------------------------------------------------------
{
  const req = normalize_request({
    report_type: "magnet_health",
    system_id: "SME15822",
    recipients: ["a@b.com"],
    window: { start: "2026-06-28", end: "2026-07-22" }
  });
  assert.strictEqual(req.output.html, true);
  assert.strictEqual(req.output.pdf, true);
  assert.strictEqual(req.event_window, null);
  assert.strictEqual(req.window.start.toISODate(), "2026-06-28");

  assert.throws(
    () => normalize_request({ report_type: "magnet_health", system_id: "X", recipients: ["a@b.com"] }),
    /SME/
  );
  assert.throws(
    () => normalize_request({ report_type: "magnet_health", system_id: "SME1", recipients: [] }),
    /recipients/
  );
  assert.throws(
    () => normalize_request({ report_type: "other", system_id: "SME1", recipients: ["a@b.com"] }),
    /report_type/
  );
}

// --- request exclusions -----------------------------------------------------
{
  // Excluded systems are dropped before any DB pull, and the loader reports
  // exactly what it removed so the fleet summary can state it — a system
  // leaving the report must always be visible as a decision.
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = path.join(os.tmpdir(), `check-exclude-${process.pid}.json`);
  const write = (obj) => {
    fs.writeFileSync(tmp, JSON.stringify(obj));
    return tmp;
  };
  const base = {
    batch_email: { recipients: ["a@b.com"] },
    reports: [
      { report_type: "magnet_health", system_id: "SME00001" },
      { report_type: "magnet_health", system_id: "SME10844" },
      { report_type: "magnet_health", system_id: "SME13604" }
    ]
  };
  const { load_requests } = require("../request_loader");

  const r = load_requests(
    write({ ...base, exclude: ["SME10844", "SME13604"], exclude_note: "stations" })
  );
  assert.strictEqual(r.requests.length, 1, "excluded systems never become requests");
  assert.strictEqual(r.requests[0].system_id, "SME00001");
  assert.deepStrictEqual(r.excluded.ids, ["SME10844", "SME13604"], "removals reported");
  assert.strictEqual(r.excluded.note, "stations");

  // An exclusion that matches nothing is not an exclusion.
  const none = load_requests(write({ ...base, exclude: ["SME99999"] }));
  assert.strictEqual(none.requests.length, 3);
  assert.strictEqual(none.excluded, null, "nothing removed -> nothing to state");

  // Malformed exclusions fail loudly, not silently.
  assert.throws(() => load_requests(write({ ...base, exclude: "SME10844" })), /array/);
  assert.throws(() => load_requests(write({ ...base, exclude: ["bogus"] })), /system id/);
  fs.unlinkSync(tmp);
}

// ---- threshold resolution (compute/thresholds.js) -------------------------
// Pure core of data.fetch_thresholds; row shape mirrors
// get-default-thresholds.sql's SELECT. These cases pin the resolution
// semantics the reports rest on.
{
  const { resolve_thresholds } = require("../compute/thresholds");
  const { VENDORS } = require("../vendors");
  const trow = (field_name, operator, threshold, severity, threshold_units = null) => ({
    field_name,
    operator,
    threshold,
    threshold_units,
    severity
  });

  // No rows at all -> the vendor OEM fallback, marked as such.
  const none = resolve_thresholds([], VENDORS.PHILIPS);
  assert.strictEqual(none.pressure.source, "oem_constant");
  assert.strictEqual(none.pressure.high_gt, 100, "Philips OEM line");

  // Configured pressure rows -> default_models, most conservative kept
  // (lowest greater_than, highest less_than), unparseable rows skipped.
  const p = resolve_thresholds(
    [
      trow("he_psi_avg_value", "greater_than", "90", "high"),
      trow("he_psi_avg_value", "greater_than", "80", "high"),
      trow("he_psi_avg_value", "greater_than", "garbage", "high"),
      trow("he_psi_avg_value", "greater_than", "70", "medium"),
      trow("helium_level_value", "less_than", "40", "high"),
      trow("helium_level_value", "less_than", "55", "medium")
    ],
    VENDORS.PHILIPS
  );
  assert.strictEqual(p.pressure.source, "default_models");
  assert.strictEqual(p.pressure.high_gt, 80, "most conservative high wins");
  assert.strictEqual(p.pressure.med_gt, 70);
  assert.strictEqual(p.helium.low_high, 40);
  assert.strictEqual(p.helium.low_med, 55);

  // Band config (Siemens): both sides resolve, highest less_than wins.
  const band = resolve_thresholds(
    [
      trow("mag_psia_value", "greater_than", "16.4", "high"),
      trow("mag_psia_value", "less_than", "14.4", "high"),
      trow("mag_psia_value", "less_than", "14.0", "high")
    ],
    VENDORS.SIEMENS
  );
  assert.strictEqual(band.pressure.high_gt, 16.4);
  assert.strictEqual(band.pressure.high_lt, 14.4, "highest less_than wins");

  // Units ride the rows ("mBar" display-normalized to "mbar").
  const units = resolve_thresholds(
    [trow("he_psi_avg_value", "greater_than", "100", "high", "mBar")],
    VENDORS.PHILIPS
  );
  assert.strictEqual(units.pressure.units, "mbar");

  // A helium greater_than row carries no meaning here and is ignored.
  const he_gt = resolve_thresholds(
    [
      trow("he_psi_avg_value", "greater_than", "100", "high"),
      trow("helium_level_value", "greater_than", "90", "high")
    ],
    VENDORS.PHILIPS
  );
  assert.strictEqual(he_gt.helium.low_high, null, "helium greater_than ignored");
  assert.strictEqual(he_gt.helium.source, "none", "an ignored row configures nothing");

  // PER-CHANNEL resolution: helium-only configs keep their helium limits
  // (the old all-or-nothing gate discarded them with the missing pressure
  // rows — live systems SME15805/11/16, SME20487); pressure independently
  // falls back to its OEM constant.
  const he_only = resolve_thresholds(
    [
      trow("helium_level_value", "less_than", "40", "high"),
      trow("helium_level_value", "less_than", "55", "medium")
    ],
    VENDORS.PHILIPS
  );
  assert.strictEqual(he_only.helium.low_high, 40, "configured helium limit kept");
  assert.strictEqual(he_only.helium.low_med, 55);
  assert.strictEqual(he_only.helium.source, "default_models");
  assert.strictEqual(he_only.pressure.source, "oem_constant", "pressure independently falls back");
  assert.strictEqual(he_only.pressure.high_gt, 100);

  // Pressure-only configs: helium falls back to "nothing configured" —
  // no limits, judged nowhere — never to an invented constant.
  const p_only = resolve_thresholds(
    [trow("he_psi_avg_value", "greater_than", "80", "high")],
    VENDORS.PHILIPS
  );
  assert.strictEqual(p_only.pressure.source, "default_models");
  assert.strictEqual(p_only.helium.source, "none");
  assert.strictEqual(p_only.helium.low_high, null);

  // Med-only pressure rows still fall back (deliberately unchanged
  // behavior — a domain decision, not this change), but no longer drag a
  // configured helium limit down with them.
  const med_only = resolve_thresholds(
    [
      trow("he_psi_avg_value", "greater_than", "70", "medium"),
      trow("helium_level_value", "less_than", "40", "high")
    ],
    VENDORS.PHILIPS
  );
  assert.strictEqual(med_only.pressure.source, "oem_constant", "med-only pressure falls back");
  assert.strictEqual(med_only.pressure.med_gt, null, "med row discarded with the fallback");
  assert.strictEqual(med_only.helium.low_high, 40, "helium survives pressure's fallback");
  assert.strictEqual(med_only.helium.source, "default_models");

  // Fully configured: both channels carry default_models provenance.
  assert.strictEqual(p.helium.source, "default_models");
  assert.strictEqual(p.pressure.source, "default_models");

  // Units resolve from the SET of row-supplied units, so database row order
  // can never change the result (the query is unordered; last-row-wins let
  // the same limit apply or suppress per run).
  const perm_rows = [
    trow("he_psi_avg_value", "greater_than", "80", "high", "PSI"),
    trow("helium_level_value", "less_than", "40", "high", "%"),
    trow("helium_level_value", "less_than", "55", "medium", "%")
  ];
  assert.deepStrictEqual(
    resolve_thresholds(perm_rows, VENDORS.PHILIPS),
    resolve_thresholds([...perm_rows].reverse(), VENDORS.PHILIPS),
    "row order never changes resolution"
  );

  // Rows that DISAGREE on units are a configuration error and fail closed —
  // in either order. (Live alert.models carries zero conflicts, surveyed
  // 2026-08-14, so the throw can only fire on new misconfiguration.)
  const he_conflict = [
    trow("he_level_1_value", "less_than", "40", "high", "%"),
    trow("he_level_1_value", "less_than", "300", "medium", "LTRS")
  ];
  assert.throws(
    () => resolve_thresholds(he_conflict, VENDORS.SIEMENS),
    /conflicting helium threshold units/
  );
  assert.throws(
    () => resolve_thresholds([...he_conflict].reverse(), VENDORS.SIEMENS),
    /conflicting helium threshold units/
  );
  assert.throws(
    () =>
      resolve_thresholds(
        [
          trow("he_psi_avg_value", "greater_than", "80", "high", "PSI"),
          trow("monitor_magnet_pressure_value", "greater_than", "90", "high", "mbar")
        ],
        VENDORS.PHILIPS
      ),
    /conflicting pressure threshold units/
  );

  // Row-supplied units are trimmed; whitespace variants of one unit are
  // one unit, and a present-but-blank string counts as absent (a unitless
  // threshold row is meaningful — it applies regardless of display units).
  const padded = resolve_thresholds(
    [
      trow("helium_level_value", "less_than", "40", "high", " % "),
      trow("helium_level_value", "less_than", "55", "medium", "%")
    ],
    VENDORS.PHILIPS
  );
  assert.strictEqual(padded.helium.units, "%", "padded units trim to one unit");
  const blank = resolve_thresholds(
    [trow("helium_level_value", "less_than", "40", "high", "   ")],
    VENDORS.PHILIPS
  );
  assert.strictEqual(blank.helium.units, null, "blank units count as absent");
  assert.strictEqual(blank.helium.low_high, 40, "the limit itself still resolves");
}

// ---- compressor provenance is a closed registry (round-2 F3) ---------------
{
  const { source_kind, is_inferred } = require("../compute/provenance");
  assert.strictEqual(source_kind("cryo_comp_malf_value"), "reported");
  assert.strictEqual(source_kind("compressor_status"), "reported");
  assert.strictEqual(source_kind("edu_comp_vib"), "measured");
  assert.strictEqual(source_kind("coldhead_ruo_value"), "inferred");
  assert.strictEqual(is_inferred("coldhead_ruo_value"), true);
  assert.strictEqual(is_inferred("edu_comp_vib"), false);
  // Unknown or typoed sources throw — they must never fail open as
  // "measured" and silently drop the ᶜ mark.
  assert.throws(() => is_inferred("coldhead_rou_value"), /unknown compressor source/);
  assert.throws(() => source_kind(undefined), /unknown compressor source/);
}

// ---- plausibility-bounds dispatch fails closed (phase 2) -------------------
// Bounds are per-unit physics; defaulting an unknown unit to another unit's
// bounds silently rejects good data or admits garbage.
{
  const { primary_bounds, helium_bounds } = require("../compute/plausible");
  assert.throws(() => primary_bounds("furlongs"), /no plausibility bounds/);
  assert.throws(() => primary_bounds(null), /no plausibility bounds/);
  assert.throws(
    () => primary_bounds("mBar"),
    /no plausibility bounds/,
    "raw mBar reaching bounds means the display normalization was bypassed"
  );
  assert.throws(() => helium_bounds("kg"), /no plausibility bounds/);
  assert.throws(() => helium_bounds(null), /no plausibility bounds/);
  // The complete live vocabulary (mag.*_units + alert.models, surveyed
  // 2026-08-14) still resolves.
  assert.strictEqual(primary_bounds("mbar").max, 10000);
  assert.strictEqual(primary_bounds("PSI").max, 100);
  assert.strictEqual(primary_bounds("K").max, 320);
  assert.strictEqual(helium_bounds("%").max, 100);
  assert.strictEqual(helium_bounds("LTRS").max, 5000);
}

// ---- condition registration coverage (phase 4) -----------------------------
// build_narrative's story lookup is unguarded — STORIES[facts.archetype]
// throws a TypeError AT RENDER TIME on an unregistered key — and
// conditions.js's ordering coupling to archetype.js was comment-only. Both
// invariants become executable here: every severity-ordered condition has a
// story, and classify can only produce severity-ordered conditions.
{
  const { SEVERITY_ORDER } = require("../conditions");
  const { ARCHETYPES } = require("../compute/archetype");
  const { STORY_KEYS, build_narrative } = require("../render/narrative");
  // The registry IS the coupling (round-2 F2): SEVERITY_ORDER must equal
  // the classifier's closed output set exactly — same keys, same priority
  // order (the "MUST match" comment, now executable) — and every archetype
  // needs a story. classify additionally validates its own output against
  // ARCHETYPES at runtime, so a future branch returning an unregistered
  // key fails with a named error even where this matrix never exercised it.
  assert.deepStrictEqual(
    SEVERITY_ORDER,
    ARCHETYPES,
    "SEVERITY_ORDER must equal the classifier's registry, in priority order"
  );
  for (const key of ARCHETYPES)
    assert.ok(
      STORY_KEYS.includes(key),
      `every registered archetype needs a narrative story: "${key}"`
    );
  // The story lookup fails NAMED, not with a bare TypeError.
  assert.throws(
    () => build_narrative({ archetype: "probe_stuck" }),
    /no narrative story registered for archetype "probe_stuck"/
  );

  const thr0 = { high_gt: 100, high_lt: null, med_gt: null, med_lt: null };
  const p = (over = {}) => ({
    peak: { v: 30 },
    all: { min: { v: 29 } },
    last: { v: 30 },
    rate_per_hr: null,
    ...over
  });
  const matrix = [
    { compressor_event: { off_count: 2, end: null }, pressure: p(), thr: thr0 },
    { compressor_event: { off_count: 2, end: 1 }, pressure: p(), thr: thr0 },
    { compressor_event: { off_count: 0, end: null }, pressure: p(), thr: thr0 },
    { compressor_event: null, pressure: p({ peak: { v: 120 } }), thr: thr0 },
    { compressor_event: null, pressure: p({ rate_per_hr: 0.01, last: { v: 70 } }), thr: thr0 },
    { compressor_event: null, pressure: null, thr: thr0 },
    { compressor_event: null, pressure: p({ all: { min: { v: 10 } } }), thr: { ...thr0, high_gt: null, high_lt: 14 } }
  ];
  for (const facts of matrix) {
    const a = classify(facts);
    assert.ok(
      SEVERITY_ORDER.includes(a),
      `classify produced "${a}", which SEVERITY_ORDER does not carry`
    );
  }
}

console.log("check_compute: all assertions passed");
