// Plain node:assert checks for the compute layer (no test framework in repo).
// Run: node sme_reports/dev/check_compute.js
const assert = require("assert");

const {
  chart_mode,
  daily_rollup,
  metric_points,
  clean_series
} = require("../compute/series");
const {
  find_off_runs,
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
  // on on off off on off on -> 2 off runs, 3 off readings, recovered
  const s = [
    row(0),
    row(1),
    row(2, { compressor_on: false }),
    row(3, { compressor_on: false }),
    row(4),
    row(5, { compressor_on: false }),
    row(6)
  ];
  const ev = detect_compressor_event(s);
  assert.strictEqual(ev.cycles, 2, "two off runs");
  assert.strictEqual(ev.off_count, 3, "three off readings");
  assert.strictEqual(ev.start, T0 + 2 * HOUR, "event starts at first stop");
  assert.strictEqual(ev.end, T0 + 6 * HOUR, "recovery after last off run");
}
{
  // series ends off -> open event
  const s = [row(0), row(1, { compressor_on: false }), row(2, { compressor_on: false })];
  const ev = detect_compressor_event(s);
  assert.strictEqual(ev.end, null, "open event when series ends off");
  assert.strictEqual(detect_compressor_event([row(0), row(1)]), null, "no event when always on");
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

console.log("check_compute: all assertions passed");
