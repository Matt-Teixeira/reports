// Pure model for the GE CV Insights viewer (hhm_rpp_ge PLAN-CV-INSIGHTS.md
// §13.2 items 4-8). Input: the datasets cv/data.js loads (or a fixture).
// Output: the fleet rows, the configured-without-data list, the inventory,
// and one compact payload per system. No database, no clock:
// build_model(raw, { as_of }) is a pure function, so a build is
// deterministic for a given snapshot and as-of date.
//
// Days are device wall-clock days ('YYYY-MM-DD', the date of host_local),
// handled as integer day numbers (ct/model.js helpers). Data on a device day
// after as_of (a clock running ahead) is ignored, as the findings rules do.
// A data day is a day with at least one counted log row, i.e. a cv.error
// row in ge_cv_daily_v (every counted row has one; §13.1). The log is
// errors only, so a day without rows is "no log", not "no errors".
//
// as_of may not be earlier than the snapshot's UTC day: findings are
// stored as their latest state (the CT viewer's contract, review
// PHASE6-DATA-MODEL F1).
//
// Fleet columns (§13.2 item 5), D = the system's last data day:
//   errors/day  = cv.error over the 30 device days D-29..D, divided by the
//                 data days in that window (2 decimals);
//   busiest day = the day in D-29..D with the most cv.error (ties: the
//                 earlier day);
//   named sums  = detector com, anticollision, table encoder, PIB over
//                 D-29..D; null when the system never logs the metric
//                 (capabilities).
// No column re-implements a findings rule; the findings column carries the
// rules.
//
// Clock (K1, §13.2 item 8): CV has no clock table. When the newest device
// time (summary last_seen) is after the snapshot, the clock is at least that
// many minutes fast (a record cannot be written in the future). cv/data.js
// computes floor((last_seen - snapshot) / 1 min) in SQL at microsecond
// precision (review CV6-DATA-MODEL F2); the model shows it when >= 1.

const CT = require("../ct/model");
const { dnum, dstr, valid_day, PERIODS, SEVERITIES, STALE_DAYS, open_findings, finding_view } = CT;

const DEFAULT_PERIOD = "90d";
const TOP_CODES = 10;
const ms = (t) => (t === null || t === undefined ? null : t instanceof Date ? t.getTime() : Date.parse(t));
const r2 = (x) => (x === null ? null : Math.round(100 * x) / 100);
const sev_rank = (s) => SEVERITIES.indexOf(s);

// The four named metrics of the fleet columns.
const FLEET_METRICS = {
  detector: "cv.detector_com_error",
  anticollision: "cv.anticollision_error",
  table: "cv.table_encoder_failure",
  pib: "cv.pib_com_loss"
};
// Panels (§13.2 item 6) and the metrics that show each one. A panel is shown
// only when the system has at least one of its metrics in capabilities; a
// chart inside it only when the system has that metric.
const PANELS = [
  { key: "errors", label: "Errors", metrics: ["cv.error"] },
  { key: "codes", label: "Errors by code", metrics: ["cv.error"] },
  { key: "detector", label: "Detector", metrics: ["cv.detector_com_error"] },
  { key: "positioner", label: "Positioner and table", metrics: ["cv.positioner_collision", "cv.anticollision_error", "cv.table_encoder_failure", "cv.emergency_backout"] },
  { key: "connectivity", label: "Connectivity", metrics: ["cv.pib_com_loss", "cv.worklist_query_failed", "cv.dose_export_rejected"] }
];
// Named metrics carried per day, per dim (dense), when the system logs them.
const NAMED = ["cv.detector_com_error", "cv.anticollision_error", "cv.table_encoder_failure", "cv.positioner_collision",
  "cv.emergency_backout", "cv.pib_com_loss", "cv.worklist_query_failed", "cv.dose_export_rejected"];
// Metrics whose dims are ranked per period (the client stacks the top
// RANKED_TOP and groups the rest as "other").
const RANKED = ["cv.anticollision_error", "cv.table_encoder_failure"];
const RANKED_TOP = 4;
// Code 1200019 (detector offset): its own series in the detector panel. The
// storm rule excludes it and the detector evidence reports it (§13.2 item 6;
// hhm_rpp_ge insight/cv/findings/context.js DETECTOR_OFFSET_CODE).
const DETECTOR_OFFSET_CODE = "1200019";
const SUBSYSTEMS = ["POS", "RTA", "DL"]; // stacked in this order; anything else is "other"

// ------------------------------------------------------------ per-system index

function index_system(raw, system_id, T) {
  const mine = (rows) => rows.filter((r) => r.system_id === system_id);
  const cells = new Map(); // metric -> dim -> day -> n
  const subs = new Map(); // code -> subsystem (from the cv.error rows)
  const daynums = new Set();
  for (const c of mine(raw.daily)) {
    const n = dnum(c.day);
    if (n > T) continue;
    if (c.m === "cv.error") {
      daynums.add(n);
      if (!subs.has(c.dim)) subs.set(c.dim, c.sub ?? null);
    }
    if (!cells.has(c.m)) cells.set(c.m, new Map());
    const byDim = cells.get(c.m);
    if (!byDim.has(c.dim)) byDim.set(c.dim, new Map());
    byDim.get(c.dim).set(n, (byDim.get(c.dim).get(n) || 0) + Number(c.n));
  }
  const days = [...daynums].sort((a, b) => a - b);
  return {
    system_id, T, days, dayset: daynums, cells, subs,
    findings: mine(raw.findings).filter((f) => f.source === "ge_cv"),
    caps: new Set(mine(raw.capabilities).map((c) => c.metric_key)),
    last_day: days.length ? days[days.length - 1] : null
  };
}

// Sum of n over days a..b of metric m (all dims, or those passing dimPred).
function event_sum(ix, m, a, b, dimPred = null) {
  const byDim = ix.cells.get(m);
  if (!byDim) return 0;
  let s = 0;
  for (const [dim, byDay] of byDim) {
    if (dimPred && !dimPred(dim)) continue;
    for (const [d, n] of byDay) if (d >= a && d <= b) s += n;
  }
  return s;
}
// cv.error per day (all codes) as a Map day -> n.
function errors_by_day(ix) {
  const out = new Map();
  for (const byDay of (ix.cells.get("cv.error") || new Map()).values()) for (const [d, n] of byDay) out.set(d, (out.get(d) || 0) + n);
  return out;
}
const data_days = (ix, a, b) => ix.days.filter((d) => d >= a && d <= b).length;

// ----------------------------------------------------------- fleet columns

function errors_30d(ix, D) {
  const errors = event_sum(ix, "cv.error", D - 29, D), dd = data_days(ix, D - 29, D);
  return { errors, data_days: dd, per_day: dd ? r2(errors / dd) : null };
}
function busiest_30d(ix, D, byDay = errors_by_day(ix)) {
  let best = null;
  for (const [d, n] of byDay) {
    if (d < D - 29 || d > D) continue;
    if (!best || n > best.n || (n === best.n && d < best.d)) best = { d, n };
  }
  return best ? { day: dstr(best.d), n: best.n } : null;
}
function named_30d(ix, D) {
  const out = {};
  for (const [k, m] of Object.entries(FLEET_METRICS)) out[k] = ix.caps.has(m) ? event_sum(ix, m, D - 29, D) : null;
  return out;
}
// ahead_min: the summary row's SQL value (whole minutes, may be <= 0).
function clock_ahead(ahead_min) {
  if (ahead_min === null || ahead_min === undefined) return null;
  const m = Number(ahead_min);
  return Number.isInteger(m) && m >= 1 ? m : null;
}

// ----------------------------------------------------------- per-system view

function dense(nd, d0, fill) { const a = new Array(nd).fill(0); fill((d, x) => { const i = d - d0; if (i >= 0 && i < nd) a[i] += x; }); return a; }
function mask(nd, d0, set) { let s = ""; for (let i = 0; i < nd; i++) s += set.has(d0 + i) ? "1" : "0"; return s; }
function period_range(p, d0, L) { return p.days === null ? [d0, L] : [Math.max(d0, L - p.days + 1), L]; }
const by_count = (x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0);

// Per period: every code with events, [code, n, days] by n desc then code;
// the top TOP_CODES, "other" and the total.
function code_tables(ix, d0, L) {
  const byDim = ix.cells.get("cv.error") || new Map();
  const out = {};
  for (const p of PERIODS) {
    const [a, b] = period_range(p, d0, L);
    const rows = [];
    for (const [code, byDay] of byDim) {
      let n = 0, days = 0;
      for (const [d, x] of byDay) if (d >= a && d <= b && x > 0) { n += x; days++; }
      if (n > 0) rows.push([code, n, days]);
    }
    rows.sort(by_count);
    const total = rows.reduce((s, r) => s + r[1], 0);
    const top = rows.slice(0, TOP_CODES).reduce((s, r) => s + r[1], 0);
    out[p.key] = { rows, top: Math.min(TOP_CODES, rows.length), other: total - top, total };
  }
  return out;
}

// Dims of metric m ranked per period by events (desc, then name); dims with
// no events in the period are left out.
function dim_ranks(ix, m, d0, L) {
  const byDim = ix.cells.get(m) || new Map();
  const out = {};
  for (const p of PERIODS) {
    const [a, b] = period_range(p, d0, L);
    const sums = [];
    for (const [dim, byDay] of byDim) {
      let s = 0;
      for (const [d, x] of byDay) if (d >= a && d <= b) s += x;
      if (s > 0) sums.push([dim, s]);
    }
    out[p.key] = sums.sort(by_count).map((x) => x[0]);
  }
  return out;
}

// One band per finding over the day axis: opened day to resolved day, or to
// the last data day while open (§13.2 item 6). Days from the stored
// evidence (opened_day, resolved_day); indexes clipped to 0..nd-1.
function finding_bands(findings, d0, L) {
  return findings.map((f) => {
    const ev = f.evidence || {};
    const from = ev.opened_day ? dnum(ev.opened_day) : null;
    const to = f.status === "open" ? L : ev.resolved_day ? dnum(ev.resolved_day) : null;
    if (from === null || to === null) return null;
    const a = Math.max(from, d0), b = Math.min(to, L);
    if (b < a) return null;
    return { key: f.finding_key, label: f.label || f.finding_key, severity: f.severity, status: f.status, from: a - d0, to: b - d0, opened_day: ev.opened_day, end_day: dstr(to) };
  }).filter(Boolean);
}

function system_view(ix, catalog) {
  const L = ix.last_day, d0 = ix.days[0], nd = L - d0 + 1;
  const has = (m) => ix.caps.has(m);
  const err = ix.cells.get("cv.error") || new Map();
  // errors per day by subsystem (stack order POS, RTA, DL, other)
  const subs = {};
  for (const s of [...SUBSYSTEMS, "other"]) subs[s] = new Array(nd).fill(0);
  for (const [code, byDay] of err) {
    const s = SUBSYSTEMS.includes(ix.subs.get(code)) ? ix.subs.get(code) : "other";
    for (const [d, x] of byDay) subs[s][d - d0] += x;
  }
  if (!subs.other.some((x) => x)) delete subs.other;
  // named metrics: total and per dim, dense
  const ev = {}, dims = {};
  for (const m of NAMED) {
    if (!has(m)) continue;
    const byDim = ix.cells.get(m) || new Map();
    ev[m] = dense(nd, d0, (add) => { for (const byDay of byDim.values()) for (const [d, x] of byDay) add(d, x); });
    dims[m] = {};
    for (const dim of [...byDim.keys()].sort()) dims[m][dim] = dense(nd, d0, (add) => { for (const [d, x] of byDim.get(dim)) add(d, x); });
  }
  const ranks = {};
  for (const m of RANKED) if (has(m)) ranks[m] = dim_ranks(ix, m, d0, L);
  const offset = err.get(DETECTOR_OFFSET_CODE);
  return {
    system_id: ix.system_id,
    d0: dstr(d0), nd,
    data: mask(nd, d0, ix.dayset),
    labels: Object.fromEntries([...ix.caps].sort().map((m) => [m, catalog.get(`${ix.system_id}|${m}`)])),
    panels: PANELS.filter((p) => p.metrics.some(has)).map((p) => p.key),
    subs, ev, dims, ranks,
    offset: has("cv.detector_com_error") && offset ? dense(nd, d0, (add) => { for (const [d, x] of offset) add(d, x); }) : null,
    codes: has("cv.error") ? code_tables(ix, d0, L) : null,
    bands: finding_bands(ix.findings.slice().sort(band_order), d0, L)
  };
}
// bands: by opened day, then key
function band_order(a, b) {
  const x = (a.evidence || {}).opened_day || "", y = (b.evidence || {}).opened_day || "";
  return x < y ? -1 : x > y ? 1 : a.finding_key < b.finding_key ? -1 : a.finding_key > b.finding_key ? 1 : 0;
}

// Findings, open first (highest severity first), then resolved (newest
// first): CT's order.
function finding_order(a, b) {
  if (a.status !== b.status) return a.status === "open" ? -1 : 1;
  if (a.status === "open" && a.severity !== b.severity) return sev_rank(b.severity) - sev_rank(a.severity);
  const ta = ms(a.status === "open" ? a.opened_at : a.resolved_at), tb = ms(b.status === "open" ? b.opened_at : b.resolved_at);
  return tb - ta || (a.finding_key < b.finding_key ? -1 : 1);
}

// ------------------------------------------------------------------ model

const identity_row = (id, sid) => ({
  system_id: sid, model: id.model ?? null, customer_name: id.customer_name ?? null, site_name: id.site_name ?? null,
  city: id.city ?? null, state: id.state ?? null, cus_sys_id: id.cus_sys_id ?? null
});

// raw: the cv/data.js datasets. as_of: 'YYYY-MM-DD'.
function build_model(raw, { as_of }) {
  if (!valid_day(as_of)) throw new Error(`build_model: bad as_of ${as_of}`);
  if (!valid_day(raw.snapshot_day)) throw new Error("build_model: raw.snapshot_day is required");
  if (as_of < raw.snapshot_day) {
    throw new Error(`build_model: as_of ${as_of} is before the snapshot day ${raw.snapshot_day}; findings are current state, so historical builds are not supported`);
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
    const s = summary.get(system_id);
    const row = {
      ...identity_row(identity.get(system_id) || {}, system_id),
      group: L >= T - (STALE_DAYS - 1) ? "reporting" : "not_reporting",
      last_day: dstr(L), last_seen: ms(s.last_seen),
      errors: errors_30d(ix, L), busiest: busiest_30d(ix, L), named: named_30d(ix, L),
      open: open_findings(ix), clock_ahead_min: clock_ahead(s.ahead_min)
    };
    rows.push(row);
    views[system_id] = {
      ...system_view(ix, catalog),
      header: row,
      findings: ix.findings.slice().sort(finding_order).map(finding_view)
    };
  }
  const attention = (a, b) => (sev_rank(b.open.max_severity) - sev_rank(a.open.max_severity)) || (b.open.attention - a.open.attention)
    || ((b.errors.per_day ?? -1) - (a.errors.per_day ?? -1)) || (a.system_id < b.system_id ? -1 : 1);
  const reporting = rows.filter((r) => r.group === "reporting").sort(attention);
  const not_reporting = rows.filter((r) => r.group === "not_reporting").sort((a, b) => (a.last_day < b.last_day ? 1 : a.last_day > b.last_day ? -1 : a.system_id < b.system_id ? -1 : 1));
  // configured for sysError.log but no data day up to as_of
  const with_data = new Set(rows.map((r) => r.system_id));
  const no_data = [...new Set(raw.configured)].filter((sid) => !with_data.has(sid)).sort().map((sid) => identity_row(identity.get(sid) || {}, sid));
  // code labels for every code any system view lists
  const used = new Set();
  for (const v of Object.values(views)) if (v.codes) for (const p of PERIODS) for (const r of v.codes[p.key].rows) used.add(r[0]);
  for (const v of Object.values(views)) for (const f of v.findings) for (const c of evidence_codes(f.evidence)) used.add(c);
  const codes = {};
  for (const c of raw.codes.slice().sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
    if (!used.has(c.code)) continue;
    codes[c.code] = { subsystem: c.subsystem, label: c.label ?? null, share: c.label_share === null || c.label_share === undefined ? null : Math.round(1000 * Number(c.label_share)) / 1000, sourcefile: c.sourcefile ?? null };
  }
  const inventory = raw.inventory.slice().sort((a, b) => (a.system_id < b.system_id ? -1 : 1));
  return { as_of, snapshot_day: raw.snapshot_day, snapshot_at: ms(raw.snapshot_at), periods: PERIODS, default_period: DEFAULT_PERIOD,
    reporting, not_reporting, no_data, views, codes, inventory, configured: [...new Set(raw.configured)].length };
}

// Error codes named in a stored evidence object (top_codes[].code, at any
// depth), for the label lookup on finding cards.
function evidence_codes(ev) {
  const out = new Set();
  const walk = (x) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) {
        if (k === "code" && (typeof v === "string" || typeof v === "number")) out.add(String(v));
        else walk(v);
      }
    }
  };
  walk(ev);
  return [...out].sort();
}

module.exports = {
  build_model, index_system, errors_30d, busiest_30d, named_30d, clock_ahead, code_tables, dim_ranks, finding_bands, evidence_codes,
  PANELS, NAMED, RANKED, RANKED_TOP, FLEET_METRICS, DETECTOR_OFFSET_CODE, SUBSYSTEMS, TOP_CODES, DEFAULT_PERIOD, PERIODS, STALE_DAYS, valid_day, dnum, dstr
};
