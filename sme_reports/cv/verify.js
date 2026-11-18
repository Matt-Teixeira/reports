#!/usr/bin/env node
// Independent check of the numbers on the GE CV Insights viewer (hhm_rpp_ge
// PLAN-CV-INSIGHTS.md §13.4 "cv/verify.js ... 0 differences against
// independent SQL"). Read-only: ct/db.js sessions have
// default_transaction_read_only=on, and everything runs in ONE read-only
// REPEATABLE READ transaction, so the model and the SQL see the same
// snapshot (and the same now()).
//
// The model (cv/model.js, in JS) is built from the cv/data.js rows. This
// file recomputes the same values with its own SQL over the api.ge_cv_*
// views, config.* and public.*, and compares them value by value:
//   1. fleet: every column of every fleet row (all systems with data), the
//      group, the clock lower bound, identity, the order of both lists; the
//      configured-without-data list and the inventory footer (from config.*
//      / public.*, written differently from cv/data.js);
//   2. panels, for the verification systems (--systems, default both,
//      §13.3 Q3): day range, data mask, errors per day by subsystem (the
//      subsystem from api.ge_cv_codes_v, not daily_v's joined column), every
//      named metric per day in total and per dim, the detector-offset
//      series, the code tables per period (every code, its count and days,
//      the order, top / other / total), the dim ranks per period, catalog
//      labels, panels, and the finding bands (clipped in SQL);
//   3. findings: every finding the page shows (all systems), field by field,
//      in the page order (computed in SQL), and the stored evidence exactly
//      as stored;
//   4. code labels: every code the page lists (in panels or in finding
//      evidence, found with jsonb_path_query), with subsystem, label, share
//      and the source file's base name.
// The stored finding values themselves (status, severity, windows,
// observed, baseline, trip days) are recomputed by hhm_rpp_ge
// `insight/cv/cli.js verify-findings`; this file checks the page carries them
// faithfully. The stored evidence is shown as stored and labelled so.
// Zero differences is a pass (exit 0); anything else exits 1.
//
// --probe plants one error of each kind in the model (after it is built
// from the same snapshot) and checks every one is caught; it exits 1 when
// any is missed or when the unmutated run has a difference.
//
// Rounding: per-day rates are rounded in SQL numeric (exact) and in JS with
// Math.round on the double; they agree except at an exact tie that the
// double cannot hold, which an exact quotient of two integers with a
// divisor <= 30 never is at 2 decimals. Label shares are rounded from the
// same double product (share * 1000) on both sides.
//
// Usage (from the repo root):
//   node sme_reports/cv/verify.js [--as-of YYYY-MM-DD] [--systems A,B] [--max-diffs 20] [--probe]
// --as-of defaults to the snapshot's UTC day; an earlier day is refused.

const { open, close } = require("../ct/db");
const { TX_MODE } = require("../ct/data");
const { read_cv } = require("./data");
const M = require("./model");
const { checker, series, num, msOf, PERIOD_SQL, SEV_RANK, report_lines } = require("../insights/verify_core");

const { checks, check } = checker();
const VERIFY_SYSTEMS = ["SME02412", "SME08640"]; // §13.3 Q3: both systems, every panel

// The page's definitions, written out here from PLAN-CV-INSIGHTS.md §13.2
// (review CV6-DATA-MODEL F1): the verifier's expectations and SQL use these,
// never the model's own constants, and a "contract" check compares the
// model's constants with them. So a wrong mapping in the model (say, the
// Detector column reading anticollision) is a difference, not a shared
// assumption.
const CONTRACT = {
  FLEET_METRICS: { detector: "cv.detector_com_error", anticollision: "cv.anticollision_error", table: "cv.table_encoder_failure", pib: "cv.pib_com_loss" },
  NAMED: ["cv.detector_com_error", "cv.anticollision_error", "cv.table_encoder_failure", "cv.positioner_collision",
    "cv.emergency_backout", "cv.pib_com_loss", "cv.worklist_query_failed", "cv.dose_export_rejected"],
  RANKED: ["cv.anticollision_error", "cv.table_encoder_failure"],
  RANKED_TOP: 4,
  PANELS: [
    ["errors", ["cv.error"]],
    ["codes", ["cv.error"]],
    ["detector", ["cv.detector_com_error"]],
    ["positioner", ["cv.positioner_collision", "cv.anticollision_error", "cv.table_encoder_failure", "cv.emergency_backout"]],
    ["connectivity", ["cv.pib_com_loss", "cv.worklist_query_failed", "cv.dose_export_rejected"]]
  ],
  TOP_CODES: 10,
  DETECTOR_OFFSET_CODE: "1200019",
  SUBSYSTEMS: ["POS", "RTA", "DL"],
  STALE_DAYS: 7,
  DEFAULT_PERIOD: "90d",
  PERIODS: [["30d", 30], ["90d", 90], ["6mo", 183], ["all", null]]
};
function check_contract(model) {
  const eq = check("contract: the model's definitions = §13.2");
  eq("FLEET_METRICS", M.FLEET_METRICS, CONTRACT.FLEET_METRICS);
  eq("NAMED", M.NAMED, CONTRACT.NAMED);
  eq("RANKED", M.RANKED, CONTRACT.RANKED);
  eq("RANKED_TOP", M.RANKED_TOP, CONTRACT.RANKED_TOP);
  eq("PANELS", M.PANELS.map((p) => [p.key, p.metrics]), CONTRACT.PANELS);
  eq("TOP_CODES", M.TOP_CODES, CONTRACT.TOP_CODES);
  eq("DETECTOR_OFFSET_CODE", M.DETECTOR_OFFSET_CODE, CONTRACT.DETECTOR_OFFSET_CODE);
  eq("SUBSYSTEMS", M.SUBSYSTEMS, CONTRACT.SUBSYSTEMS);
  eq("STALE_DAYS", M.STALE_DAYS, CONTRACT.STALE_DAYS);
  eq("default period", model.default_period, CONTRACT.DEFAULT_PERIOD);
  eq("periods", model.periods.map((p) => [p.key, p.days]), CONTRACT.PERIODS);
}
const C_PERIODS = CONTRACT.PERIODS.map(([key]) => ({ key }));

function args(argv) {
  const o = { as_of: null, systems: VERIFY_SYSTEMS, max_diffs: 20, probe: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--as-of") o.as_of = v();
    else if (a === "--systems") o.systems = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--max-diffs") o.max_diffs = Number(v());
    else if (a === "--probe") o.probe = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.as_of !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error(`bad --as-of ${o.as_of}`);
  return o;
}

const group = (rows, k = "system_id") => { const m = new Map(); for (const r of rows) { if (!m.has(r[k])) m.set(r[k], []); m.get(r[k]).push(r); } return m; };
const SEV_R = (col) => `CASE ${col} WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 WHEN 'info' THEN 0 END`;

// Each system's day span up to as_of: data days are the cv.error days.
const SPAN = `lastd AS (
  SELECT system_id, min(local_day) AS d0, max(local_day) AS l
  FROM api.ge_cv_daily_v WHERE metric_key = 'cv.error' AND local_day <= $1::date GROUP BY system_id)`;
const IN_PERIOD = "d.local_day >= CASE WHEN p.days IS NULL THEN l.d0 ELSE greatest(l.d0, l.l - p.days + 1) END AND d.local_day <= l.l";

// ------------------------------------------------------------------ fleet

// $1 as_of
const FLEET_SQL = `
WITH ${SPAN},
err AS (
  SELECT d.system_id, d.local_day, sum(d.n) AS n
  FROM api.ge_cv_daily_v d JOIN lastd l USING (system_id)
  WHERE d.metric_key = 'cv.error' AND d.local_day BETWEEN l.l - 29 AND l.l
  GROUP BY d.system_id, d.local_day),
e30 AS (SELECT system_id, sum(n)::bigint AS errors, count(*)::int AS dd FROM err GROUP BY system_id),
busy AS (SELECT DISTINCT ON (system_id) system_id, to_char(local_day, 'YYYY-MM-DD') AS day, n::bigint AS n FROM err ORDER BY system_id, n DESC, local_day),
opn AS (
  SELECT system_id,
    count(*) FILTER (WHERE severity = 'high')::int AS high, count(*) FILTER (WHERE severity = 'medium')::int AS medium,
    count(*) FILTER (WHERE severity = 'low')::int AS low, count(*) FILTER (WHERE severity = 'info')::int AS info,
    count(*)::int AS total, count(*) FILTER (WHERE severity <> 'info')::int AS attention,
    (array_agg(severity ORDER BY ${SEV_RANK} DESC) FILTER (WHERE severity <> 'info'))[1] AS max_severity
  FROM api.ge_cv_findings_v WHERE status = 'open' GROUP BY system_id),
f AS (
  SELECT l.system_id, l.l, to_char(l.l, 'YYYY-MM-DD') AS last_day,
    CASE WHEN l.l >= $1::date - 6 THEN 'reporting' ELSE 'not_reporting' END AS grp,
    e.errors, e.dd, round(e.errors::numeric / e.dd, 2) AS per_day, b.day AS busy_day, b.n AS busy_n,
    coalesce(o.high, 0) AS high, coalesce(o.medium, 0) AS medium, coalesce(o.low, 0) AS low, coalesce(o.info, 0) AS info,
    coalesce(o.total, 0) AS total, coalesce(o.attention, 0) AS attention, o.max_severity,
    s.last_seen, floor((extract(epoch FROM s.last_seen) - extract(epoch FROM now())) / 60)::int AS ahead_raw,
    i.model, si.name AS site_name, c.name AS customer_name, si.city, si.state, i.cus_sys_id
  FROM lastd l
  JOIN e30 e USING (system_id)
  LEFT JOIN busy b USING (system_id)
  LEFT JOIN opn o USING (system_id)
  JOIN api.ge_cv_system_summary_v s USING (system_id)
  LEFT JOIN public.systems i ON i.id = l.system_id
  LEFT JOIN public.sites si ON si.id = i.site_id
  LEFT JOIN public.customers c ON c.id = si.customer_id)
SELECT * FROM f
ORDER BY grp DESC,
  CASE WHEN grp = 'reporting' THEN coalesce(${SEV_R("max_severity")}, -1) END DESC,
  CASE WHEN grp = 'reporting' THEN attention END DESC,
  CASE WHEN grp = 'reporting' THEN per_day END DESC,
  CASE WHEN grp = 'not_reporting' THEN l END DESC,
  system_id COLLATE "C"`;

// 30-day sums of the fleet metrics, for systems that log them. $1 as_of, $2 metrics
const NAMED30_SQL = `
WITH ${SPAN}
SELECT c.system_id, c.metric_key, coalesce(sum(d.n), 0)::bigint AS n
FROM api.ge_cv_capabilities_v c
JOIN lastd l USING (system_id)
LEFT JOIN api.ge_cv_daily_v d ON d.system_id = c.system_id AND d.metric_key = c.metric_key AND d.local_day BETWEEN l.l - 29 AND l.l
WHERE c.metric_key = ANY($2)
GROUP BY c.system_id, c.metric_key ORDER BY 1, 2`;

// Configured for sysError.log, with no data day up to as_of. $1 as_of
const NO_DATA_SQL = `
SELECT DISTINCT s.id AS system_id, s.model, si.name AS site_name, c.name AS customer_name, si.city, si.state, s.cus_sys_id
FROM config.log lg
JOIN public.systems s ON s.id = lg.system_id
JOIN config.acquisition ac ON ac.system_id = s.id
LEFT JOIN public.sites si ON si.id = s.site_id
LEFT JOIN public.customers c ON c.id = si.customer_id
WHERE lg.file_name = 'sysError.log' AND ac.run_group = 1 AND s.manufacturer = 'GE' AND s.modality = 'CV/IR'
  AND NOT EXISTS (SELECT 1 FROM api.ge_cv_daily_v d WHERE d.system_id = s.id AND d.metric_key = 'cv.error' AND d.local_day <= $1::date)
ORDER BY s.id`;

// The number of GE CV/IR systems configured for sysError.log.
const CONFIGURED_COUNT_SQL = `
SELECT count(DISTINCT s.id)::int AS n
FROM config.log lg JOIN public.systems s ON s.id = lg.system_id JOIN config.acquisition ac ON ac.system_id = s.id
WHERE lg.file_name = 'sysError.log' AND ac.run_group = 1 AND s.manufacturer = 'GE' AND s.modality = 'CV/IR'`;

// GE CV/IR in inventory: not configured for sysError.log and not in insight.
const INVENTORY_SQL = `
SELECT s.id AS system_id, s.modality, s.model, si.name AS site_name, c.name AS customer_name
FROM public.systems s
LEFT JOIN public.sites si ON si.id = s.site_id
LEFT JOIN public.customers c ON c.id = si.customer_id
WHERE s.manufacturer = 'GE' AND s.modality = 'CV/IR'
  AND s.id NOT IN (SELECT system_id FROM api.ge_cv_system_summary_v)
  AND NOT EXISTS (SELECT 1 FROM config.acquisition ac JOIN config.log lg ON lg.system_id = ac.system_id AND lg.file_name = 'sysError.log'
                  WHERE ac.system_id = s.id AND ac.run_group = 1)
ORDER BY s.id`;

function check_fleet(model, fleet, named, no_data, inventory, configured_n) {
  const eq = check("fleet columns (every system)");
  const rows = new Map([...model.reporting, ...model.not_reporting].map((r) => [r.system_id, r]));
  const nm = group(named);
  for (const id of [...new Set([...rows.keys(), ...fleet.map((f) => f.system_id)])].sort()) {
    const r = rows.get(id), f = fleet.find((x) => x.system_id === id);
    if (!r || !f) { eq(`${id} present`, !!r, !!f); continue; }
    const k = (c) => `${id}.${c}`;
    eq(k("group"), r.group, f.grp);
    eq(k("last_day"), r.last_day, f.last_day);
    eq(k("last_seen"), r.last_seen, msOf(f.last_seen));
    eq(k("errors"), r.errors, { errors: Number(f.errors), data_days: f.dd, per_day: num(f.per_day) });
    eq(k("busiest"), r.busiest, { day: f.busy_day, n: Number(f.busy_n) });
    const want = {};
    for (const [key, m] of Object.entries(CONTRACT.FLEET_METRICS)) { const x = (nm.get(id) || []).find((y) => y.metric_key === m); want[key] = x ? Number(x.n) : null; }
    eq(k("named"), r.named, want);
    eq(k("open"), r.open, { high: f.high, medium: f.medium, low: f.low, info: f.info, total: f.total, attention: f.attention, max_severity: f.max_severity });
    eq(k("clock_ahead_min"), r.clock_ahead_min, f.ahead_raw >= 1 ? f.ahead_raw : null);
    eq(k("identity"), [r.model, r.customer_name, r.site_name, r.city, r.state, r.cus_sys_id], [f.model, f.customer_name, f.site_name, f.city, f.state, f.cus_sys_id]);
  }
  const order = check("fleet order (attention; not reporting by last data)");
  for (const g of ["reporting", "not_reporting"]) order(`${g} order`, model[g].map((r) => r.system_id), fleet.filter((f) => f.grp === g).map((f) => f.system_id));
  const nd = check("configured list, without data, inventory footer");
  nd("no_data rows", model.no_data, no_data.map((r) => ({ system_id: r.system_id, model: r.model, customer_name: r.customer_name, site_name: r.site_name, city: r.city, state: r.state, cus_sys_id: r.cus_sys_id })));
  nd("configured count", model.configured, configured_n);
  nd("inventory rows", model.inventory.map((r) => [r.system_id, r.modality, r.model, r.site_name, r.customer_name]), inventory.map((r) => [r.system_id, r.modality, r.model, r.site_name, r.customer_name]));
}

// ------------------------------------------------------------------ panels

// $1 as_of, $2 systems
const PANEL_SQL = {
  span: `WITH ${SPAN} SELECT system_id, to_char(d0, 'YYYY-MM-DD') AS d0, (l - d0 + 1)::int AS nd FROM lastd WHERE system_id = ANY($2) ORDER BY 1`,
  data: `WITH ${SPAN} SELECT d.system_id, (d.local_day - l.d0)::int AS i
    FROM (SELECT DISTINCT system_id, local_day FROM api.ge_cv_daily_v WHERE metric_key = 'cv.error') d JOIN lastd l USING (system_id)
    WHERE d.local_day <= l.l AND d.system_id = ANY($2) ORDER BY 1, 2`,
  subs: `WITH ${SPAN} SELECT d.system_id, CASE WHEN k.subsystem IN ('POS', 'RTA', 'DL') THEN k.subsystem ELSE 'other' END AS sub,
      (d.local_day - l.d0)::int AS i, sum(d.n)::bigint AS n
    FROM api.ge_cv_daily_v d JOIN lastd l USING (system_id) LEFT JOIN api.ge_cv_codes_v k ON k.errorcode::text = d.dim
    WHERE d.metric_key = 'cv.error' AND d.local_day <= l.l AND d.system_id = ANY($2) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  named: `WITH ${SPAN} SELECT d.system_id, d.metric_key AS m, d.dim, (d.local_day - l.d0)::int AS i, d.n::bigint AS n
    FROM api.ge_cv_daily_v d JOIN lastd l USING (system_id)
    JOIN api.ge_cv_capabilities_v c ON c.system_id = d.system_id AND c.metric_key = d.metric_key
    WHERE d.metric_key = ANY($3) AND d.local_day <= l.l AND d.system_id = ANY($2) ORDER BY 1, 2, 3, 4`,
  offset: `WITH ${SPAN} SELECT d.system_id, (d.local_day - l.d0)::int AS i, d.n::bigint AS n
    FROM api.ge_cv_daily_v d JOIN lastd l USING (system_id)
    WHERE d.metric_key = 'cv.error' AND d.dim = $4 AND d.local_day <= l.l AND d.system_id = ANY($2)
      AND EXISTS (SELECT 1 FROM api.ge_cv_capabilities_v c WHERE c.system_id = d.system_id AND c.metric_key = 'cv.detector_com_error')
    ORDER BY 1, 2`,
  codes: `WITH ${SPAN}, s AS (
      SELECT d.system_id, p.key, d.dim AS code, sum(d.n)::bigint AS n, count(*)::int AS days
      FROM api.ge_cv_daily_v d JOIN lastd l USING (system_id) CROSS JOIN ${PERIOD_SQL}
      WHERE d.metric_key = 'cv.error' AND ${IN_PERIOD} AND d.system_id = ANY($2)
      GROUP BY 1, 2, 3)
    SELECT system_id, key, code, n, days, row_number() OVER (PARTITION BY system_id, key ORDER BY n DESC, code COLLATE "C")::int AS rk,
      sum(n) OVER (PARTITION BY system_id, key)::bigint AS total
    FROM s ORDER BY system_id, key, rk`,
  ranks: `WITH ${SPAN}, s AS (
      SELECT d.system_id, d.metric_key AS m, p.key, d.dim, sum(d.n)::bigint AS n
      FROM api.ge_cv_daily_v d JOIN lastd l USING (system_id) CROSS JOIN ${PERIOD_SQL}
      JOIN api.ge_cv_capabilities_v c ON c.system_id = d.system_id AND c.metric_key = d.metric_key
      WHERE d.metric_key = ANY($5) AND ${IN_PERIOD} AND d.system_id = ANY($2)
      GROUP BY 1, 2, 3, 4 HAVING sum(d.n) > 0)
    SELECT system_id, m, key, dim, row_number() OVER (PARTITION BY system_id, m, key ORDER BY n DESC, dim COLLATE "C")::int AS rk
    FROM s ORDER BY system_id, m, key, rk`,
  capabilities: `SELECT system_id, metric_key, label, unit, value_kind FROM api.ge_cv_capabilities_v WHERE system_id = ANY($2) ORDER BY 1, 2`,
  bands: `WITH ${SPAN}, b AS (
      SELECT f.system_id, f.finding_key, f.label, f.severity, f.status, f.evidence ->> 'opened_day' AS opened_day,
        (f.evidence ->> 'opened_day')::date AS od,
        CASE WHEN f.status = 'open' THEN l.l ELSE (f.evidence ->> 'resolved_day')::date END AS ed, l.d0, l.l
      FROM api.ge_cv_findings_v f JOIN lastd l USING (system_id) WHERE f.system_id = ANY($2))
    SELECT system_id, finding_key AS key, coalesce(label, finding_key) AS label, severity, status,
      (greatest(od, d0) - d0)::int AS "from", (least(ed, l) - d0)::int AS "to", opened_day, to_char(ed, 'YYYY-MM-DD') AS end_day
    FROM b WHERE od IS NOT NULL AND ed IS NOT NULL AND least(ed, l) >= greatest(od, d0)
    ORDER BY system_id, od, finding_key COLLATE "C"`
};

function check_panels(model, q, systems) {
  const span = check("panels: day range and data mask");
  const sub = check("panels: errors per day by subsystem");
  const ev = check("panels: named metrics per day (total and per dim)");
  const off = check("panels: detector offset series");
  const codes = check("panels: code tables per period");
  const ranks = check("panels: dim ranks per period");
  const meta = check("panels: panels, labels, finding bands");
  const by = Object.fromEntries(Object.entries(q).map(([k, rows]) => [k, group(rows)]));
  for (const sid of systems) {
    const v = model.views[sid], s = (by.span.get(sid) || [])[0];
    if (!v || !s) { span(`${sid} present`, !!v, !!s); continue; }
    span(`${sid}.d0`, v.d0, s.d0);
    span(`${sid}.nd`, v.nd, s.nd);
    const dense = (rows, pred = () => true) => { const a = new Array(s.nd).fill(0); for (const r of rows) if (pred(r)) a[r.i] += Number(r.n); return a; };
    const mask = new Array(s.nd).fill("0");
    for (const r of by.data.get(sid) || []) mask[r.i] = "1";
    series(span, `${sid}.data`, v.data.split(""), mask);
    // subsystems
    const srows = by.subs.get(sid) || [];
    const want_subs = [...new Set([...CONTRACT.SUBSYSTEMS, ...srows.map((r) => r.sub)])];
    sub(`${sid}.subs keys`, Object.keys(v.subs).sort(), want_subs.sort());
    for (const k of want_subs) series(sub, `${sid}.subs.${k}`, v.subs[k], dense(srows, (r) => r.sub === k));
    // named metrics: totals and dims, only for logged metrics
    const nrows = by.named.get(sid) || [];
    const caps = new Set((by.capabilities.get(sid) || []).map((c) => c.metric_key));
    const logged = CONTRACT.NAMED.filter((m) => caps.has(m));
    ev(`${sid}.ev keys`, Object.keys(v.ev).sort(), logged.slice().sort());
    for (const m of logged) {
      series(ev, `${sid}.ev.${m}`, v.ev[m], dense(nrows, (r) => r.m === m));
      const dims = [...new Set(nrows.filter((r) => r.m === m).map((r) => r.dim))].sort();
      ev(`${sid}.dims.${m} keys`, Object.keys(v.dims[m] || {}).sort(), dims);
      for (const d of dims) series(ev, `${sid}.dims.${m}.${d}`, (v.dims[m] || {})[d], dense(nrows, (r) => r.m === m && r.dim === d));
    }
    const orows = by.offset.get(sid) || [];
    if (orows.length) series(off, `${sid}.offset`, v.offset, dense(orows));
    else off(`${sid}.offset`, v.offset, null);
    // code tables per period
    const crows = by.codes.get(sid) || [];
    for (const p of C_PERIODS) {
      const rows = crows.filter((r) => r.key === p.key);
      const t = v.codes ? v.codes[p.key] : null;
      const total = rows.length ? Number(rows[0].total) : 0;
      codes(`${sid}.codes.${p.key}.rows`, t && t.rows, rows.map((r) => [r.code, Number(r.n), r.days]));
      codes(`${sid}.codes.${p.key}.totals`, t && [t.top, t.other, t.total], [Math.min(CONTRACT.TOP_CODES, rows.length), rows.filter((r) => r.rk > CONTRACT.TOP_CODES).reduce((x, r) => x + Number(r.n), 0), total]);
    }
    // dim ranks per period
    const rrows = by.ranks.get(sid) || [];
    for (const m of CONTRACT.RANKED.filter((x) => caps.has(x))) for (const p of C_PERIODS) {
      ranks(`${sid}.ranks.${m}.${p.key}`, (v.ranks[m] || {})[p.key], rrows.filter((r) => r.m === m && r.key === p.key).map((r) => r.dim));
    }
    ranks(`${sid}.ranks keys`, Object.keys(v.ranks).sort(), CONTRACT.RANKED.filter((x) => caps.has(x)).sort());
    // panels, labels, bands
    meta(`${sid}.panels`, v.panels, CONTRACT.PANELS.filter(([, ms]) => ms.some((m) => caps.has(m))).map(([k]) => k));
    meta(`${sid}.labels`, v.labels, Object.fromEntries((by.capabilities.get(sid) || []).map((c) => [c.metric_key, { label: c.label, unit: c.unit, kind: c.value_kind }])));
    meta(`${sid}.bands`, v.bands, (by.bands.get(sid) || []).map((b) => ({ key: b.key, label: b.label, severity: b.severity, status: b.status, from: b.from, to: b.to, opened_day: b.opened_day, end_day: b.end_day })));
  }
}

// --------------------------------------------------------------- findings

// In the page's order: open first (highest severity first, newest opened
// first), then resolved (newest resolved first); ties by key.
const FINDINGS_SQL = `
SELECT system_id, finding_key, label, category, description, customer_visible, status, severity, evidence,
  opened_at, resolved_at, to_char(data_through, 'YYYY-MM-DD') AS data_through, window_start, window_end, observed, baseline,
  evidence ->> 'opened_day' AS opened_day, evidence ->> 'last_trip_day' AS last_trip_day, (evidence ->> 'trip_days')::int AS trip_days
FROM api.ge_cv_findings_v
WHERE source = 'ge_cv'
ORDER BY system_id, (status = 'open') DESC, CASE WHEN status = 'open' THEN ${SEV_RANK} END DESC,
  CASE WHEN status = 'open' THEN opened_at ELSE resolved_at END DESC, finding_key COLLATE "C"`;

function expected_finding(r) {
  return {
    finding_key: r.finding_key, label: r.label, category: r.category, description: r.description, customer_visible: r.customer_visible,
    status: r.status, severity: r.severity, opened_at: msOf(r.opened_at), resolved_at: msOf(r.resolved_at), data_through: r.data_through,
    window_start: msOf(r.window_start), window_end: msOf(r.window_end), observed: num(r.observed), baseline: num(r.baseline),
    opened_day: r.opened_day, last_trip_day: r.last_trip_day, trip_days: r.trip_days,
    trip: null, // CV findings have no trip table (ct/model.js TRIP_FIELDS is CT's)
    evidence: r.evidence
  };
}
function check_findings(model, rows) {
  const eq = check("findings shown (every system, every field)");
  const by = group(rows);
  let n = 0;
  for (const sid of Object.keys(model.views).sort()) {
    const got = model.views[sid].findings, want = (by.get(sid) || []).map(expected_finding);
    eq(`${sid}.findings order`, got.map((f) => `${f.finding_key}@${f.opened_at}`), want.map((f) => `${f.finding_key}@${f.opened_at}`));
    for (let i = 0; i < Math.max(got.length, want.length); i++) {
      const w = want[i] || {}, g = got[i] || {};
      for (const k of new Set([...Object.keys(g), ...Object.keys(w)])) eq(`${sid}.findings[${i}] ${w.finding_key || g.finding_key}.${k}`, g[k], w[k]);
      n++;
    }
  }
  const shown = new Set(Object.keys(model.views));
  eq("findings of systems not shown", rows.filter((r) => !shown.has(r.system_id)).map((r) => r.system_id), []);
  return n;
}

// ------------------------------------------------------------ code labels

// Every code the page lists: cv.error codes of the shown systems up to
// as_of (their last data day), and codes named in finding evidence. $1 as_of, $2 shown systems
const CODES_SQL = `
WITH ${SPAN}, used AS (
  SELECT DISTINCT d.dim AS code FROM api.ge_cv_daily_v d JOIN lastd l USING (system_id)
  WHERE d.metric_key = 'cv.error' AND d.local_day <= l.l AND d.system_id = ANY($2)
  UNION
  SELECT DISTINCT c #>> '{}' FROM api.ge_cv_findings_v f, jsonb_path_query(f.evidence, 'strict $.**.code') c WHERE f.system_id = ANY($2))
SELECT u.code, k.subsystem, k.label, round((k.label_share * 1000)::numeric) / 1000 AS share,
  substring(k.sourcefile FROM '[^/\\\\]*$') AS sourcefile
FROM used u JOIN api.ge_cv_codes_v k ON k.errorcode::text = u.code
ORDER BY u.code COLLATE "C"`;

function check_codes(model, rows) {
  const eq = check("code labels (every code listed)");
  // a lookup map: JS orders integer-like keys numerically, so compare the sets
  eq("codes listed", Object.keys(model.codes).sort(), rows.map((r) => r.code).sort());
  for (const r of rows) eq(`code ${r.code}`, model.codes[r.code], { subsystem: r.subsystem, label: r.label, share: num(r.share), sourcefile: r.sourcefile });
}

// ------------------------------------------------------------------- main

// All checks inside an open read-only transaction t. mutate(model) (the
// probe) alters the model before the comparison.
async function run_checks(t, { as_of = null, systems = VERIFY_SYSTEMS } = {}, { mutate = null, before = null } = {}) {
  checks.length = 0;
  const ro = await t.one("SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso");
  if (ro.ro !== "on" || ro.iso !== "repeatable read") throw new Error(`verify: transaction is ${ro.iso}, read_only=${ro.ro}; refusing`);
  const raw = await read_cv(t);
  as_of = as_of || raw.snapshot_day;
  if (as_of < raw.snapshot_day) throw new Error(`verify: --as-of ${as_of} is before the snapshot day ${raw.snapshot_day}; findings are current state`);
  // before (the probe): alters the model's definitions, as a source edit
  // would, for this run only (restored before run_checks returns)
  const restore = before ? before() : null;
  try {
    return await checks_after_build(t, raw, as_of, systems, mutate);
  } finally {
    if (restore) restore();
  }
}
async function checks_after_build(t, raw, as_of, systems, mutate) {
  const model = M.build_model(raw, { as_of });
  check_contract(model);
  for (const s of systems) if (!model.views[s]) throw new Error(`verify: ${s} has no data up to ${as_of}`);
  if (mutate) mutate(model);
  const fleet = await t.any(FLEET_SQL, [as_of]);
  const named = await t.any(NAMED30_SQL, [as_of, Object.values(CONTRACT.FLEET_METRICS)]);
  const no_data = await t.any(NO_DATA_SQL, [as_of]);
  const inventory = await t.any(INVENTORY_SQL);
  const cfg = await t.one(CONFIGURED_COUNT_SQL);
  check_fleet(model, fleet, named, no_data, inventory, cfg.n);
  const q = {};
  for (const [k, sql] of Object.entries(PANEL_SQL)) q[k] = await t.any(sql, [as_of, systems, CONTRACT.NAMED, CONTRACT.DETECTOR_OFFSET_CODE, CONTRACT.RANKED]);
  check_panels(model, q, systems);
  const findings = check_findings(model, await t.any(FINDINGS_SQL));
  check_codes(model, await t.any(CODES_SQL, [as_of, Object.keys(model.views)]));
  return { raw, model, as_of, findings, checks: checks.map((x) => ({ ...x })) };
}

// --probe: one planted error per kind; each must give at least one difference.
const S0 = (m) => m.views[VERIFY_SYSTEMS[0]];
const firstNonZero = (a) => Math.max(0, a.findIndex((x) => x > 0));
const PROBES = {
  "fleet errors": (m) => { m.reporting[0].errors.errors += 1; },
  "fleet per day": (m) => { m.reporting[0].errors.per_day += 0.01; },
  "fleet busiest day": (m) => { m.reporting[0].busiest.n -= 1; },
  "fleet named sum": (m) => { const r = m.reporting.find((x) => x.named.anticollision !== null); r.named.anticollision += 1; },
  "fleet named not logged": (m) => { const r = m.reporting.find((x) => x.named.pib === null) || m.reporting[0]; r.named.pib = r.named.pib === null ? 0 : null; },
  "fleet open count": (m) => { m.reporting[0].open.total += 1; },
  "fleet clock bound": (m) => { const r = m.reporting[0]; r.clock_ahead_min = r.clock_ahead_min === null ? 1 : r.clock_ahead_min + 1; },
  "fleet group": (m) => { m.reporting[0].group = "not_reporting"; },
  "fleet order": (m) => { m.reporting.reverse(); },
  "fleet identity": (m) => { m.reporting[0].site_name = "Elsewhere"; },
  "configured without data": (m) => { m.no_data.pop(); },
  "inventory": (m) => { m.inventory.shift(); },
  "configured count": (m) => { m.configured += 1; },
  "data mask": (m) => { const v = S0(m); v.data = (v.data[1] === "1" ? "10" : "11") + v.data.slice(2); },
  "subsystem series": (m) => { const a = S0(m).subs.RTA; a[firstNonZero(a)] += 1; },
  "named series": (m) => { const a = S0(m).ev["cv.positioner_collision"]; a[firstNonZero(a)] += 1; },
  "dim series": (m) => { const d = S0(m).dims["cv.anticollision_error"]; const k = Object.keys(d)[0]; d[k][firstNonZero(d[k])] += 1; },
  "detector offset": (m) => { const a = S0(m).offset; a[firstNonZero(a)] += 1; },
  "code count": (m) => { S0(m).codes["90d"].rows[0][1] += 1; },
  "code days": (m) => { S0(m).codes.all.rows[0][2] += 1; },
  "code order": (m) => { const r = S0(m).codes["30d"].rows; [r[0], r[1]] = [r[1], r[0]]; },
  "code other": (m) => { S0(m).codes["6mo"].other += 1; },
  "dim rank": (m) => { S0(m).ranks["cv.anticollision_error"].all.reverse(); },
  "panels": (m) => { S0(m).panels.pop(); },
  "metric label": (m) => { S0(m).labels["cv.error"].label = "Errors"; },
  "finding band": (m) => { S0(m).bands[0].to -= 1; },
  "finding field": (m) => { S0(m).findings[0].severity = "low"; },
  "finding evidence": (m) => { S0(m).findings[0].evidence = { ...S0(m).findings[0].evidence, trip_days: -1 }; },
  "finding order": (m) => { S0(m).findings.reverse(); },
  "code label": (m) => { const k = Object.keys(m.codes)[0]; m.codes[k].label = `${m.codes[k].label || ""}x`; },
  "code source file": (m) => { const k = Object.keys(m.codes).find((c) => m.codes[c].sourcefile); m.codes[k].sourcefile = `dir/${m.codes[k].sourcefile}`; }
};

// Definition probes (review CV6-DATA-MODEL F1): each changes one of the
// model's definitions before the build and is restored afterwards. Each
// must be caught by the data checks alone, not only by the contract check.
const swap = (obj, key, val) => () => { const old = obj[key]; obj[key] = val; return () => { obj[key] = old; }; };
const DEF_PROBES = {
  "def: Detector column reads anticollision": swap(M.FLEET_METRICS, "detector", "cv.anticollision_error"),
  "def: a named metric dropped": () => { const i = M.NAMED.indexOf("cv.emergency_backout"); M.NAMED.splice(i, 1); return () => { M.NAMED.splice(i, 0, "cv.emergency_backout"); }; },
  "def: the Detector panel keyed on PIB": () => { const p = M.PANELS.find((x) => x.key === "detector"); const old = p.metrics; p.metrics = ["cv.pib_com_loss"]; return () => { p.metrics = old; }; },
  "def: anticollision not ranked": () => { const old = M.RANKED.slice(); M.RANKED.length = 0; M.RANKED.push("cv.table_encoder_failure"); return () => { M.RANKED.length = 0; M.RANKED.push(...old); }; }
  // Primitive constants (TOP_CODES, DETECTOR_OFFSET_CODE, STALE_DAYS) are
  // module-level consts in the model, so they cannot be swapped from here;
  // an edit to them is caught by the contract check and by the data checks,
  // which use CONTRACT's values.
};

async function main() {
  const o = args(process.argv.slice(2));
  const db = await open({ application_name: "cv_verify" });
  const t0 = Date.now();
  try {
    if (o.probe) {
      const out = await db.tx({ mode: TX_MODE }, async (t) => {
        const res = [];
        const base = await run_checks(t, o);
        res.push(["(no mutation)", base.checks.reduce((s, c) => s + c.diffs.length, 0)]);
        for (const [name, mutate] of Object.entries(PROBES)) {
          const r = await run_checks(t, o, { mutate });
          res.push([name, r.checks.reduce((s, c) => s + c.diffs.length, 0)]);
        }
        for (const [name, before] of Object.entries(DEF_PROBES)) {
          const r = await run_checks(t, o, { before });
          const data = r.checks.filter((c) => !c.name.startsWith("contract")).reduce((s, c) => s + c.diffs.length, 0);
          const contract = r.checks.filter((c) => c.name.startsWith("contract")).reduce((s, c) => s + c.diffs.length, 0);
          // caught only when the data checks alone see it
          res.push([`${name} (contract ${contract})`, data]);
        }
        return res;
      });
      const missed = out.slice(1).filter((x) => x[1] === 0).map((x) => x[0]);
      console.log(`GE CV Insights verify --probe (read-only, one snapshot): ${out.length - 1} planted errors`);
      for (const [name, n] of out) console.log(`  ${name.padEnd(52)} ${String(n).padStart(5)} differences${name === "(no mutation)" ? (n ? "  <- FAIL" : "") : n ? "  caught" : "  <- MISSED"}`);
      console.log(out[0][1] || missed.length ? `FAIL: ${missed.length} missed${out[0][1] ? `, ${out[0][1]} differences without a mutation` : ""}` : `ALL ${out.length - 1} PLANTED ERRORS CAUGHT`);
      console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      process.exitCode = out[0][1] || missed.length ? 1 : 0;
      return;
    }
    const { raw, model, as_of, findings } = await db.tx({ mode: TX_MODE }, (t) => run_checks(t, o));
    const out = [];
    out.push(`GE CV Insights verify: as of ${as_of}, snapshot ${new Date(raw.snapshot_at).toISOString()} (read-only, repeatable read)`);
    out.push(`fleet: ${model.reporting.length + model.not_reporting.length} systems with data (${model.reporting.length} reporting, ${model.not_reporting.length} not reporting); configured ${model.configured}, of which ${model.no_data.length} without data; inventory ${model.inventory.length}`);
    out.push(`panel systems: ${o.systems.join(", ")}; findings shown: ${findings}; code labels: ${Object.keys(model.codes).length}`);
    out.push("");
    const rep = report_lines(checks, o.max_diffs);
    out.push(...rep.lines);
    out.push(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(out.join("\n"));
    process.exitCode = rep.diffs ? 1 : 0;
  } finally {
    await close();
  }
}

module.exports = { run_checks, CONTRACT, DEF_PROBES, VERIFY_SYSTEMS, FLEET_SQL, NAMED30_SQL, NO_DATA_SQL, INVENTORY_SQL, PANEL_SQL, FINDINGS_SQL, CODES_SQL, PROBES };

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 2; close(); });
