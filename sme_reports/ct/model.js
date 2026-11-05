// Pure model for the GE CT Insights viewer (hhm_rpp_ge PLAN-CT-INSIGHTS.md
// §16.2 items 4-6). Input: the datasets ct/data.js loads (or a fixture).
// Output: the fleet rows and one compact payload per system. No database,
// no clock: build_model(raw, { as_of }) is a pure function, so a build is
// deterministic for a given snapshot and as-of date.
//
// Days are device wall-clock days ('YYYY-MM-DD', the date of host_local),
// handled as integer day numbers. A window "28 d as of D" is D-27..D.
// Data on a device day after as_of (a clock running ahead) is ignored, as
// the findings rules do.
//
// as_of may not be earlier than the snapshot's UTC day (raw.snapshot_day):
// tube segments and findings are stored as their latest state (severity,
// observed, evidence, latest_mas), which cannot be rewound to an earlier
// date. A build is a "now" report, deterministic for (snapshot, as_of)
// (review PHASE6-DATA-MODEL F1). A later as_of is allowed: the stored state
// is then the latest known.
//
// The fleet columns use the same definitions as the findings rules
// (insight/findings/rules.js, context.js in hhm_rpp_ge), so a column
// never contradicts a finding:
//   abort rate  = abort_rate_high's d28: 100 * scan.abort.system / exam.start
//                 over D-27..D, rounded to 2 decimals like the rule's pct();
//   prep        = prep_noncompliance: scan days (exam.start n > 0) in
//                 D-13..D without a Fast Calibration step, share = pct();
// with D = the system's last data day.
// Other fleet columns (§16.2 item 5):
//   exams/day   = exam.start over the 30 device days ending on D, divided by
//                 the data days in that window;
//   mA·s/day    = tube counter increments over the same window, divided by
//                 the same data days. An increment is a data day's last
//                 counter reading minus the previous reading day's; a drop
//                 (a tube replacement resets the counter) counts 0.

const DAY_MS = 864e5;
const dnum = (s) => Math.round(Date.parse(`${String(s).slice(0, 10)}T00:00:00Z`) / DAY_MS);
const dstr = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const ms = (t) => (t === null || t === undefined ? null : t instanceof Date ? t.getTime() : Date.parse(t));
const pct = (a, b) => (b > 0 ? Math.round((10000 * a) / b) / 100 : null); // the rules' pct()
const r2 = (x) => (x === null ? null : Math.round(100 * x) / 100);
const r3 = (x) => (x === null || x === undefined ? null : Math.round(1000 * Number(x)) / 1000);

// Same lists as hhm_rpp_ge insight/findings/context.js and rules.js.
const FAST_CAL_STEPS = ["Fast Calibration", "Cold Tube Warmup (Fast Calibration)"];
const STALE_DAYS = 7; // findings: no data in the last 7 device days = not evaluated
const SEVERITIES = ["info", "low", "medium", "high"];
const sev_rank = (s) => SEVERITIES.indexOf(s);
// Tube warm-up steps for the prep calendar (prep.tube_temp dims that are a
// warm-up and not a Fast Calibration). Recommendation; field service
// confirms in Phase 7.
const WARMUP_STEPS = ["Cold Tube Warmup", "WarmupI", "WarmupII"];

const PERIODS = [
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "6mo", label: "6 months", days: 183 },
  { key: "all", label: "All", days: null }
];
const DEFAULT_PERIOD = "90d";
const TOP_CODES = 10;

// Panels (§16.2 item 6) and the metrics that show each one. A panel is shown
// only when the system has at least one of its metrics in capabilities.
const PANELS = [
  { key: "tube", label: "Tube", metrics: ["tube.mas_total", "tube.replacement"] },
  { key: "utilization", label: "Utilization", metrics: ["exam.start"] },
  { key: "reliability", label: "Reliability", metrics: ["scan.abort.system", "scan.abort.operator", "error.ermes", "scan.safe_state", "system.boot", "process.restart"] },
  { key: "compliance", label: "Compliance", metrics: ["prep.tube_temp", "op.warmup_skipped", "op.scan_in_warmup_zone", "calibration.air_overdue", "compliance.dose_display_disabled"] },
  { key: "environment", label: "Environment", metrics: ["env.plenum_temp", "env.detector_temp_low", "env.humidity_out_of_range", "env.psu_temp_out_of_spec", "env.psu_voltage_out_of_spec"] },
  { key: "rotor", label: "Rotor", metrics: ["tube.rotor_sgb_slope", "tube.rotor_unexpected_stop", "tube.rotor_not_at_speed"] }
];
// Daily event counts carried per day (dense) when the system logs them.
const EVENT_SERIES = [
  "exam.start", "scan.abort.system", "scan.abort.operator", "scan.safe_state", "system.shutdown",
  "op.warmup_skipped", "op.scan_in_warmup_zone", "calibration.air_overdue", "compliance.dose_display_disabled",
  "env.plenum_temp", "env.detector_temp_low", "env.humidity_out_of_range", "env.psu_temp_out_of_spec", "env.psu_voltage_out_of_spec",
  "tube.rotor_unexpected_stop", "tube.rotor_not_at_speed", "tube.rotor_sgb_slope"
];
// Gauges whose daily values are shown (min / max / mean). Not the PSU
// gauges: their logged values include 2147483647 (an integer-max
// placeholder, not a reading), so the PSU panel shows event days only.
const GAUGE_VALUES = ["env.plenum_temp", "env.detector_temp_low", "env.humidity_out_of_range", "tube.rotor_sgb_slope"];

// ------------------------------------------------------------ per-system index

// One system's data, as of T (a day number): data days, daily cells by
// metric -> dim -> day, exams, boots.
function index_system(raw, system_id, T) {
  const mine = (rows) => rows.filter((r) => r.system_id === system_id);
  const days = mine(raw.days).map((d) => ({ n: dnum(d.day), day: d.day, local_midnight: ms(d.local_midnight), last_at: ms(d.last_at) }))
    .filter((d) => d.n <= T).sort((a, b) => a.n - b.n);
  const cells = new Map();
  for (const c of mine(raw.daily)) {
    const n = dnum(c.day);
    if (n > T) continue;
    if (!cells.has(c.m)) cells.set(c.m, new Map());
    const byDim = cells.get(c.m);
    if (!byDim.has(c.dim)) byDim.set(c.dim, new Map());
    byDim.get(c.dim).set(n, { n: Number(c.n), sum: num(c.value_sum), min: num(c.value_min), max: num(c.value_max), last: num(c.value_last) });
  }
  return {
    system_id, T, days, by_day: new Map(days.map((d) => [d.n, d])), cells,
    exams: mine(raw.exams).map((e) => ({ ...e, n: dnum(e.day), t: ms(e.started_at) })).filter((e) => e.n <= T),
    boots: mine(raw.boots).map((b) => ({ n: dnum(b.day), t: ms(b.booted_at), clean: b.clean === true })).filter((b) => b.n <= T),
    tube: mine(raw.tube),
    findings: mine(raw.findings).filter((f) => f.source === "ge_ct"), // data.js filters too (review F2)
    caps: new Set(mine(raw.capabilities).map((c) => c.metric_key)),
    last_day: days.length ? days[days.length - 1].n : null
  };
}
function num(v) { return v === null || v === undefined ? null : Number(v); }

// Sum of n over days a..b of metric m (all dims, or those passing dimPred).
function event_sum(ix, m, a, b, dimPred = null) {
  const byDim = ix.cells.get(m);
  if (!byDim) return 0;
  let s = 0;
  for (const [dim, byDay] of byDim) {
    if (dimPred && !dimPred(dim)) continue;
    for (const [d, c] of byDay) if (d >= a && d <= b) s += c.n;
  }
  return s;
}
// Days in a..b where metric m (dims passing dimPred) has n > 0.
function event_days(ix, m, a, b, dimPred = null) {
  const out = new Set();
  const byDim = ix.cells.get(m);
  if (!byDim) return out;
  for (const [dim, byDay] of byDim) {
    if (dimPred && !dimPred(dim)) continue;
    for (const [d, c] of byDay) if (d >= a && d <= b && c.n > 0) out.add(d);
  }
  return out;
}
const data_days = (ix, a, b) => ix.days.filter((d) => d.n >= a && d.n <= b).length;

// ----------------------------------------------------- columns (rule-exact)

// abort_rate_high d28 as of D.
function abort_28d(ix, D) {
  const aborts = event_sum(ix, "scan.abort.system", D - 27, D), exams = event_sum(ix, "exam.start", D - 27, D);
  return { aborts, exams, per_100: pct(aborts, exams) };
}
// prep_noncompliance as of D.
function prep_14d(ix, D) {
  const scan = event_days(ix, "exam.start", D - 13, D);
  const fast = event_days(ix, "prep.tube_temp", D - 13, D, (dim) => FAST_CAL_STEPS.includes(dim));
  const without = [...scan].filter((d) => !fast.has(d)).length;
  return { scan_days: scan.size, without_fast_cal: without, share: pct(without, scan.size) };
}
// exams per data day over the 30 device days ending on D.
function exams_30d(ix, D) {
  const exams = event_sum(ix, "exam.start", D - 29, D), dd = data_days(ix, D - 29, D);
  return { exams, data_days: dd, per_day: dd ? r2(exams / dd) : null };
}
// Tube counter increments per reading day (all history up to T).
function mas_increments(ix) {
  const byDim = ix.cells.get("tube.mas_total");
  const byDay = byDim && byDim.get("");
  if (!byDay) return new Map();
  const ds = [...byDay.keys()].sort((a, b) => a - b);
  const inc = new Map();
  for (let i = 1; i < ds.length; i++) {
    const x = byDay.get(ds[i]).last - byDay.get(ds[i - 1]).last;
    inc.set(ds[i], x > 0 ? x : 0);
  }
  return inc;
}
function mas_30d(ix, D, inc = mas_increments(ix)) {
  let mas = 0;
  for (const [d, x] of inc) if (d >= D - 29 && d <= D) mas += x;
  const dd = data_days(ix, D - 29, D);
  return { mas: r3(mas), data_days: dd, per_day: dd ? Math.round(mas / dd) : null };
}

// The device day an instant falls on: the last data day whose local
// midnight is at or before it (null before the first data day).
function local_day_of(ix, t) {
  let out = null;
  for (const d of ix.days) { if (d.local_midnight <= t) out = d; else break; }
  return out;
}

function current_tube(ix) {
  const cur = ix.tube.find((t) => t.is_current);
  if (!cur) return null;
  const predates = cur.install_confidence === "initial" && !cur.install_date;
  const start_day = local_day_of(ix, ms(cur.segment_start));
  return {
    mas: r3(cur.segment_mas), mas_per_day: cur.mas_per_day === null ? null : Math.round(cur.mas_per_day),
    install_date: cur.install_date || null, confidence: cur.install_confidence, source: cur.tube_source,
    since_data_start: predates ? (start_day ? start_day.day : ix.days.length ? ix.days[0].day : null) : null
  };
}

function open_findings(ix) {
  const open = ix.findings.filter((f) => f.status === "open");
  const by = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of open) by[f.severity]++;
  const attention = open.filter((f) => f.severity !== "info");
  const max = attention.reduce((m, f) => (sev_rank(f.severity) > sev_rank(m) ? f.severity : m), null);
  return { ...by, total: open.length, attention: attention.length, max_severity: max };
}

// ----------------------------------------------------------- per-system view

function dense(nd, d0, fill) { const a = new Array(nd).fill(0); fill((d, x) => { const i = d - d0; if (i >= 0 && i < nd) a[i] += x; }); return a; }
function mask(nd, d0, set) { let s = ""; for (let i = 0; i < nd; i++) s += set.has(d0 + i) ? "1" : "0"; return s; }

function period_range(p, d0, L) { return p.days === null ? [d0, L] : [Math.max(d0, L - p.days + 1), L]; }

// Busy hours: exams by local day of week (0 = Monday) x local hour. The
// local hour is started_at - the device day's local midnight (api
// ge_ct_days_v), clamped to 0..23 (a clock step inside a day can push it
// out by the step).
function heatmap(ix, a, b) {
  const h = new Array(7 * 24).fill(0);
  for (const e of ix.exams) {
    if (e.n < a || e.n > b) continue;
    const d = ix.by_day.get(e.n);
    if (!d) continue;
    const hour = Math.min(23, Math.max(0, Math.floor((e.t - d.local_midnight) / 3600e3)));
    const dow = (new Date(e.n * DAY_MS).getUTCDay() + 6) % 7;
    h[dow * 24 + hour]++;
  }
  return h;
}

function error_codes(ix, d0, L, nd) {
  const byDim = ix.cells.get("error.ermes") || new Map();
  const total = dense(nd, d0, (add) => { for (const byDay of byDim.values()) for (const [d, c] of byDay) add(d, c.n); });
  const top = {}, keep = new Set();
  for (const p of PERIODS) {
    const [a, b] = period_range(p, d0, L);
    const sums = [];
    for (const [code, byDay] of byDim) {
      let s = 0;
      for (const [d, c] of byDay) if (d >= a && d <= b) s += c.n;
      if (s > 0) sums.push([code, s]);
    }
    sums.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const codes = sums.slice(0, TOP_CODES);
    const all = sums.reduce((n, x) => n + x[1], 0);
    codes.forEach(([c]) => keep.add(c));
    top[p.key] = { codes, other: all - codes.reduce((n, x) => n + x[1], 0), total: all };
  }
  const series = {};
  for (const code of [...keep].sort()) series[code] = dense(nd, d0, (add) => { for (const [d, c] of byDim.get(code)) add(d, c.n); });
  return { total, top, series };
}

function system_view(ix, catalog) {
  const L = ix.last_day, d0 = ix.days[0].n, nd = L - d0 + 1;
  const has = (m) => ix.caps.has(m);
  const ev = {};
  for (const m of EVENT_SERIES) if (has(m)) ev[m] = dense(nd, d0, (add) => { for (const d of ix.cells.get(m)?.values() || []) for (const [n, c] of d) add(n, c.n); });
  const gauges = {};
  for (const m of GAUGE_VALUES) {
    if (!has(m)) continue;
    const byDay = ix.cells.get(m)?.get("") || new Map();
    gauges[m] = [...byDay].sort((a, b) => a[0] - b[0]).map(([d, c]) => [d - d0, r3(c.min), r3(c.max), r3(c.sum / c.n)]);
  }
  const inc = mas_increments(ix);
  const counter = [...(ix.cells.get("tube.mas_total")?.get("") || new Map())].sort((a, b) => a[0] - b[0]).map(([d, c]) => [d - d0, r3(c.last)]);
  const restarts = {};
  for (const [proc, byDay] of [...(ix.cells.get("process.restart") || new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    restarts[proc] = dense(nd, d0, (add) => { for (const [d, c] of byDay) add(d, c.n); });
  }
  const exam_rows = (f) => dense(nd, d0, (add) => { for (const e of ix.exams) add(e.n, f(e)); });
  const heat = {};
  for (const p of PERIODS) heat[p.key] = heatmap(ix, ...period_range(p, d0, L));
  return {
    system_id: ix.system_id,
    d0: dstr(d0), nd,
    data: mask(nd, d0, new Set(ix.days.map((d) => d.n))),
    labels: Object.fromEntries([...ix.caps].sort().map((m) => [m, catalog.get(`${ix.system_id}|${m}`)])),
    panels: PANELS.filter((p) => p.metrics.some(has)).map((p) => p.key),
    ev, gauges,
    tube: {
      counter, increments: dense(nd, d0, (add) => { for (const [d, x] of inc) add(d, r3(x)); }).map(r3),
      segments: ix.tube.map((t) => ({
        start: ms(t.segment_start), start_day: local_day_of(ix, ms(t.segment_start))?.day ?? null, end: ms(t.segment_end),
        current: t.is_current, install_date: t.install_date, confidence: t.install_confidence, source: t.tube_source,
        mas: r3(t.segment_mas), mas_per_day: t.mas_per_day === null ? null : Math.round(t.mas_per_day), ended: t.ended_reason
      }))
    },
    exams: { rows: exam_rows(() => 1), series: exam_rows((e) => Number(e.series) || 0), images: exam_rows((e) => Number(e.images) || 0) },
    heat,
    errors: has("error.ermes") ? error_codes(ix, d0, L, nd) : null,
    restarts,
    boots: has("system.boot") ? {
      clean: dense(nd, d0, (add) => { for (const b of ix.boots) if (b.clean) add(b.n, 1); }),
      unclean: dense(nd, d0, (add) => { for (const b of ix.boots) if (!b.clean) add(b.n, 1); })
    } : null,
    prep: has("prep.tube_temp") ? {
      scan: mask(nd, d0, event_days(ix, "exam.start", d0, L)),
      fast_cal: mask(nd, d0, event_days(ix, "prep.tube_temp", d0, L, (dim) => FAST_CAL_STEPS.includes(dim))),
      warmup: mask(nd, d0, event_days(ix, "prep.tube_temp", d0, L, (dim) => WARMUP_STEPS.includes(dim)))
    } : null
  };
}

// ------------------------------------------------------------------ model

// raw: the ct/data.js datasets. as_of: 'YYYY-MM-DD'.
function build_model(raw, { as_of }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(as_of || "")) throw new Error(`build_model: bad as_of ${as_of}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.snapshot_day || "")) throw new Error("build_model: raw.snapshot_day is required");
  if (as_of < raw.snapshot_day) {
    throw new Error(`build_model: as_of ${as_of} is before the snapshot day ${raw.snapshot_day}; findings and tube segments are current state, so historical builds are not supported`);
  }
  const T = dnum(as_of);
  const identity = new Map(raw.identity.map((r) => [r.system_id, r]));
  const summary = new Map(raw.summary.map((r) => [r.system_id, r]));
  const catalog = new Map(raw.capabilities.map((c) => [`${c.system_id}|${c.metric_key}`, { label: c.label, unit: c.unit, kind: c.value_kind }]));
  const rows = [], views = {};
  for (const system_id of [...summary.keys()].sort()) {
    const ix = index_system(raw, system_id, T);
    if (ix.last_day === null) continue; // no data day up to as_of
    const L = ix.last_day;
    const id = identity.get(system_id) || {};
    const s = summary.get(system_id);
    const tube = current_tube(ix);
    const row = {
      system_id, model: id.model ?? null, customer_name: id.customer_name ?? null, site_name: id.site_name ?? null,
      city: id.city ?? null, state: id.state ?? null, cus_sys_id: id.cus_sys_id ?? null,
      group: L >= T - (STALE_DAYS - 1) ? "reporting" : "not_reporting",
      last_day: dstr(L), last_at: ix.by_day.get(L).last_at,
      exams: exams_30d(ix, L), mas: mas_30d(ix, L), tube,
      abort_28d: abort_28d(ix, L), prep_14d: prep_14d(ix, L),
      open: open_findings(ix), clock_flag: s.clock_flag ?? null, clock_offset_min: s.clock_est_offset_min === null ? null : Number(s.clock_est_offset_min)
    };
    rows.push(row);
    views[system_id] = {
      ...system_view(ix, catalog),
      header: row,
      findings: ix.findings.slice().sort(finding_order).map(finding_view)
    };
  }
  const attention = (a, b) => (sev_rank(b.open.max_severity) - sev_rank(a.open.max_severity)) || (b.open.attention - a.open.attention)
    || ((b.exams.per_day ?? -1) - (a.exams.per_day ?? -1)) || (a.system_id < b.system_id ? -1 : 1);
  const reporting = rows.filter((r) => r.group === "reporting").sort(attention);
  // not reporting: most recent last data first
  const not_reporting = rows.filter((r) => r.group === "not_reporting").sort((a, b) => (a.last_day < b.last_day ? 1 : a.last_day > b.last_day ? -1 : a.system_id < b.system_id ? -1 : 1));
  return { as_of, snapshot_day: raw.snapshot_day, periods: PERIODS, default_period: DEFAULT_PERIOD, reporting, not_reporting, views, inventory: raw.inventory };
}

// What the page shows of a finding (review PHASE6-VERIFY F2): only values an
// independent check covers.
//   - status, severity, windows, data_through, observed, baseline, opened /
//     last trip day and trip days: recomputed by hhm_rpp_ge
//     `cli.js verify-findings` (independent SQL, Phases 4-5);
//   - trip: the abort-rate / prep numbers on the first and last trip day,
//     recomputed by ct/verify.js (rules check);
//   - label, category, description, customer_visible: the findings catalog.
// The rest of the stored evidence (weekly rotor counts, code lists, boot
// times, ...) is not recomputed anywhere, so it is not carried; the panels
// show the verified series behind it.
const TRIP_FIELDS = {
  abort_rate_high: (e) => ({ day: e.day, aborts: e.d28.aborts, exams: e.d28.exams, per_100: e.d28.per_100 }),
  prep_noncompliance: (e) => ({ day: e.day, scan_days: e.scan_days, without_fast_cal: e.scan_days_without_fast_cal, share: e.observed })
};
function finding_view(f) {
  const ev = f.evidence || {}, trip = TRIP_FIELDS[f.finding_key];
  return {
    finding_key: f.finding_key, label: f.label, category: f.category, description: f.description, customer_visible: f.customer_visible,
    status: f.status, severity: f.severity, opened_at: ms(f.opened_at), resolved_at: ms(f.resolved_at), data_through: f.data_through,
    window_start: ms(f.window_start), window_end: ms(f.window_end), observed: num(f.observed), baseline: num(f.baseline),
    opened_day: ev.opened_day ?? null, last_trip_day: ev.last_trip_day ?? null, trip_days: ev.trip_days ?? null,
    trip: trip && ev.first && ev.last ? { first: trip(ev.first), last: trip(ev.last) } : null
  };
}

// Open first (highest severity first), then resolved (newest first).
function finding_order(a, b) {
  if (a.status !== b.status) return a.status === "open" ? -1 : 1;
  if (a.status === "open" && a.severity !== b.severity) return sev_rank(b.severity) - sev_rank(a.severity);
  const ta = ms(a.status === "open" ? a.opened_at : a.resolved_at), tb = ms(b.status === "open" ? b.opened_at : b.resolved_at);
  return tb - ta || (a.finding_key < b.finding_key ? -1 : 1);
}

module.exports = {
  build_model, index_system, abort_28d, prep_14d, exams_30d, mas_30d, mas_increments, heatmap, open_findings, local_day_of,
  finding_view, dnum, dstr, pct, PERIODS, PANELS, EVENT_SERIES, GAUGE_VALUES, FAST_CAL_STEPS, WARMUP_STEPS, STALE_DAYS, SEVERITIES
};
