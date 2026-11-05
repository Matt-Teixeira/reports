#!/usr/bin/env node
// Independent check of the numbers on the GE CT Insights viewer
// (hhm_rpp_ge PLAN-CT-INSIGHTS.md §16.4 "Numbers are verified, not
// eyeballed"). Read-only: ct/db.js sessions have
// default_transaction_read_only=on, and everything runs in ONE read-only
// REPEATABLE READ transaction, so the model and the SQL see the same
// snapshot.
//
// The model (ct/model.js, in JS) is built from the ct/data.js rows. This
// file recomputes the same values with its own SQL over the api.ge_ct_*
// views and compares them, value by value:
//   1. fleet: every column of every fleet row (all systems), the group, and
//      the order of both lists; the inventory footer;
//   2. panels: for the verification systems (--systems, default the three
//      candidates of plan §16.3 Q6), every per-day series in the system
//      payload and its total for each period (30 d / 90 d / 6 mo / all),
//      the busy-hour heatmap per period, the error-code top 10 per period,
//      gauges, tube counter, segments, panels, labels and findings;
//   3. findings: every finding the page shows (all systems), field by field
//      (status, severity, windows, observed, baseline, trip days, the
//      abort-rate / prep trip numbers, catalog text, and the stored evidence
//      exactly as stored), and their order;
//   4. rules: on every day an abort_rate_high or prep_noncompliance finding
//      trips (evidence first and last), the SQL value, the model function
//      and the stored rule evidence agree.
// Findings and tube segments are current state, so --as-of may not be
// earlier than the snapshot's UTC day (the model's contract, review
// PHASE6-DATA-MODEL F1); verify refuses it (review PHASE6-VERIFY F1).
// The stored finding values themselves (status, severity, windows,
// observed, baseline, trip days) are recomputed by hhm_rpp_ge
// `cli.js verify-findings`; this file checks the page carries them
// faithfully, and recomputes the trip numbers the fleet columns share.
// The rest of the stored evidence (weekly counts, code lists, ...) is
// shown as stored and labelled so; it is compared, not recomputed.
// Zero differences is a pass (exit 0); anything else exits 1.
//
// Where the SQL returns double precision (gauge values, the tube counter),
// the rounding to 3 decimals for display is done here with the same
// Math.round; sums of doubles are taken in day order (sum(... ORDER BY)),
// the order the model adds them. Integer division results are rounded in
// SQL numeric (exact).
//
// Usage (from the repo root):
//   node sme_reports/ct/verify.js [--as-of YYYY-MM-DD] [--systems A,B,C] [--max-diffs 20]
// --as-of defaults to the snapshot's UTC day; an earlier day is refused.

const { open, close } = require("./db");
const { read_ct, TX_MODE } = require("./data");
const M = require("./model");

const VERIFY_SYSTEMS = ["SME21859", "SME18531", "SME21867"]; // plan §16.3 Q6 candidates; Q6 still open

function args(argv) {
  const o = { as_of: null, systems: VERIFY_SYSTEMS, max_diffs: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--as-of") o.as_of = v();
    else if (a === "--systems") o.systems = v().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--max-diffs") o.max_diffs = Number(v());
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.as_of !== null && !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error(`bad --as-of ${o.as_of}`);
  return o;
}

// ------------------------------------------------------------ comparison

// JSON with sorted keys: key order never matters, a missing or extra key always does
const canon = (x) => JSON.stringify(x === undefined ? null : x, (k, v) =>
  (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key] === undefined ? null : v[key]])) : v));
const checks = [];
function check(name) {
  const c = { name, compared: 0, diffs: [] };
  checks.push(c);
  return (key, model, sql) => {
    c.compared++;
    const a = canon(model), b = canon(sql);
    if (a !== b) c.diffs.push({ key, model: a, sql: b });
  };
}
// element by element for a per-day series (one comparison per day)
function series(eq, key, arr, want) {
  const n = Math.max(arr ? arr.length : 0, want.length);
  for (let i = 0; i < n; i++) eq(`${key}[${i}]`, arr ? arr[i] : null, want[i]);
}

const r3 = (x) => (x === null || x === undefined ? null : Math.round(1000 * x) / 1000);
const num = (x) => (x === null || x === undefined ? null : Number(x));
const msOf = (t) => (t === null || t === undefined ? null : new Date(t).getTime());
const PERIOD_SQL = "(VALUES ('30d', 30), ('90d', 90), ('6mo', 183), ('all', NULL::int)) p(key, days)";
const SEV_RANK = "CASE severity WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 WHEN 'info' THEN 0 END";

// ------------------------------------------------------------------ fleet

// $1 as_of, $2 Fast Calibration steps
const FLEET_SQL = `
WITH lastd AS (
  SELECT system_id, max(local_day) AS l, min(local_day) AS d0
  FROM api.ge_ct_days_v WHERE local_day <= $1::date GROUP BY system_id),
ev AS (
  SELECT system_id, metric_key, local_day, sum(n)::bigint AS n
  FROM api.ge_ct_daily_v
  WHERE local_day <= $1::date AND metric_key IN ('exam.start', 'scan.abort.system')
  GROUP BY system_id, metric_key, local_day),
fc AS (
  SELECT DISTINCT system_id, local_day FROM api.ge_ct_daily_v
  WHERE metric_key = 'prep.tube_temp' AND dim = ANY($2::text[]) AND n > 0),
ctr AS (
  SELECT system_id, local_day,
    value_last - lag(value_last) OVER (PARTITION BY system_id ORDER BY local_day) AS inc
  FROM api.ge_ct_daily_v
  WHERE metric_key = 'tube.mas_total' AND dim = '' AND local_day <= $1::date),
f AS (
  SELECT l.system_id, l.l, l.d0,
    (SELECT x.last_at FROM api.ge_ct_days_v x WHERE x.system_id = l.system_id AND x.local_day = l.l) AS last_at,
    (SELECT count(*) FROM api.ge_ct_days_v x WHERE x.system_id = l.system_id AND x.local_day BETWEEN l.l - 29 AND l.l)::int AS dd30,
    (SELECT coalesce(sum(n), 0) FROM ev WHERE ev.system_id = l.system_id AND ev.metric_key = 'exam.start' AND ev.local_day BETWEEN l.l - 29 AND l.l)::int AS ex30,
    (SELECT coalesce(sum(n), 0) FROM ev WHERE ev.system_id = l.system_id AND ev.metric_key = 'exam.start' AND ev.local_day BETWEEN l.l - 27 AND l.l)::int AS ex28,
    (SELECT coalesce(sum(n), 0) FROM ev WHERE ev.system_id = l.system_id AND ev.metric_key = 'scan.abort.system' AND ev.local_day BETWEEN l.l - 27 AND l.l)::int AS ab28,
    (SELECT count(*) FROM ev WHERE ev.system_id = l.system_id AND ev.metric_key = 'exam.start' AND ev.n > 0 AND ev.local_day BETWEEN l.l - 13 AND l.l)::int AS scan14,
    (SELECT count(*) FROM ev WHERE ev.system_id = l.system_id AND ev.metric_key = 'exam.start' AND ev.n > 0 AND ev.local_day BETWEEN l.l - 13 AND l.l
       AND NOT EXISTS (SELECT 1 FROM fc WHERE fc.system_id = ev.system_id AND fc.local_day = ev.local_day))::int AS nofc14,
    (SELECT coalesce(sum(greatest(c.inc, 0) ORDER BY c.local_day), 0) FROM ctr c
       WHERE c.system_id = l.system_id AND c.inc IS NOT NULL AND c.local_day BETWEEN l.l - 29 AND l.l) AS mas30
  FROM lastd l),
op AS (
  SELECT system_id,
    count(*) FILTER (WHERE severity = 'high')::int AS high, count(*) FILTER (WHERE severity = 'medium')::int AS medium,
    count(*) FILTER (WHERE severity = 'low')::int AS low, count(*) FILTER (WHERE severity = 'info')::int AS info,
    count(*)::int AS total, count(*) FILTER (WHERE severity <> 'info')::int AS attention,
    max(${SEV_RANK}) FILTER (WHERE severity <> 'info') AS max_rank
  FROM api.ge_ct_findings_v WHERE source = 'ge_ct' AND status = 'open' GROUP BY system_id),
cur AS (
  SELECT DISTINCT ON (system_id) system_id, segment_start, segment_mas, mas_per_day,
    to_char(install_date, 'YYYY-MM-DD') AS install_date, install_confidence, tube_source
  FROM api.ge_ct_tube_v WHERE is_current ORDER BY system_id, segment_start),
rows AS (
  SELECT f.system_id, to_char(f.l, 'YYYY-MM-DD') AS last_day, f.last_at,
    CASE WHEN f.l >= $1::date - 6 THEN 'reporting' ELSE 'not_reporting' END AS grp,
    f.dd30, f.ex30, CASE WHEN f.dd30 > 0 THEN round(f.ex30::numeric / f.dd30, 2) END AS exams_per_day,
    f.mas30, CASE WHEN f.dd30 > 0 THEN floor(f.mas30 / f.dd30 + 0.5) END AS mas_per_day,
    f.ab28, f.ex28, CASE WHEN f.ex28 > 0 THEN round(10000.0 * f.ab28 / f.ex28) / 100 END AS abort_per_100,
    f.scan14, f.nofc14, CASE WHEN f.scan14 > 0 THEN round(10000.0 * f.nofc14 / f.scan14) / 100 END AS prep_share,
    coalesce(op.high, 0) AS high, coalesce(op.medium, 0) AS medium, coalesce(op.low, 0) AS low, coalesce(op.info, 0) AS info,
    coalesce(op.total, 0) AS total, coalesce(op.attention, 0) AS attention,
    CASE op.max_rank WHEN 3 THEN 'high' WHEN 2 THEN 'medium' WHEN 1 THEN 'low' END AS max_severity, coalesce(op.max_rank, -1) AS max_rank,
    cur.system_id IS NOT NULL AS has_tube, cur.segment_mas AS tube_mas,
    CASE WHEN cur.mas_per_day IS NOT NULL THEN floor(cur.mas_per_day + 0.5) END AS tube_mas_per_day,
    cur.install_date AS tube_install_date, cur.install_confidence AS tube_confidence, cur.tube_source,
    CASE WHEN cur.install_confidence = 'initial' AND cur.install_date IS NULL THEN to_char(coalesce(
      (SELECT max(x.local_day) FROM api.ge_ct_days_v x
        WHERE x.system_id = f.system_id AND x.local_day <= $1::date AND x.local_midnight <= cur.segment_start), f.d0), 'YYYY-MM-DD') END AS tube_since,
    s.clock_flag, s.clock_est_offset_min,
    sy.model, c.name AS customer_name, si.name AS site_name, si.city, si.state, sy.cus_sys_id
  FROM f
  JOIN api.ge_ct_system_summary_v s ON s.system_id = f.system_id
  LEFT JOIN op ON op.system_id = f.system_id
  LEFT JOIN cur ON cur.system_id = f.system_id
  LEFT JOIN public.systems sy ON sy.id = f.system_id
  LEFT JOIN public.sites si ON si.id = sy.site_id
  LEFT JOIN public.customers c ON c.id = si.customer_id)
SELECT rows.*, row_number() OVER (PARTITION BY grp ORDER BY
    CASE WHEN grp = 'reporting' THEN max_rank END DESC,
    CASE WHEN grp = 'reporting' THEN attention END DESC,
    CASE WHEN grp = 'reporting' THEN coalesce(exams_per_day, -1) END DESC,
    CASE WHEN grp = 'not_reporting' THEN last_day END DESC,
    system_id COLLATE "C")::int AS pos
FROM rows ORDER BY grp, pos`;

const INVENTORY_SQL = `
SELECT s.id AS system_id FROM public.systems s
WHERE s.manufacturer = 'GE' AND s.modality IN ('CT', 'PET/CT')
  AND NOT EXISTS (SELECT 1 FROM api.ge_ct_system_summary_v v WHERE v.system_id = s.id)
ORDER BY s.id COLLATE "C"`;

function check_fleet(model, fleet, inventory) {
  const eq = check("fleet columns (every system)");
  const rows = new Map([...model.reporting, ...model.not_reporting].map((r) => [r.system_id, r]));
  const ids = new Set([...rows.keys(), ...fleet.map((f) => f.system_id)]);
  for (const id of [...ids].sort()) {
    const r = rows.get(id), f = fleet.find((x) => x.system_id === id);
    if (!r || !f) { eq(`${id} present`, !!r, !!f); continue; }
    const k = (c) => `${id}.${c}`;
    eq(k("group"), r.group, f.grp);
    eq(k("last_day"), r.last_day, f.last_day);
    eq(k("last_at"), r.last_at, msOf(f.last_at));
    eq(k("exams"), r.exams, { exams: f.ex30, data_days: f.dd30, per_day: num(f.exams_per_day) });
    eq(k("mas"), r.mas, { mas: r3(f.mas30), data_days: f.dd30, per_day: num(f.mas_per_day) });
    eq(k("abort_28d"), r.abort_28d, { aborts: f.ab28, exams: f.ex28, per_100: num(f.abort_per_100) });
    eq(k("prep_14d"), r.prep_14d, { scan_days: f.scan14, without_fast_cal: f.nofc14, share: num(f.prep_share) });
    eq(k("open"), r.open, { high: f.high, medium: f.medium, low: f.low, info: f.info, total: f.total, attention: f.attention, max_severity: f.max_severity });
    eq(k("tube"), r.tube, f.has_tube ? {
      mas: r3(f.tube_mas), mas_per_day: num(f.tube_mas_per_day), install_date: f.tube_install_date, confidence: f.tube_confidence,
      source: f.tube_source, since_data_start: f.tube_since
    } : null);
    eq(k("clock"), [r.clock_flag, r.clock_offset_min], [f.clock_flag, num(f.clock_est_offset_min)]);
    eq(k("identity"), [r.model, r.customer_name, r.site_name, r.city, r.state, r.cus_sys_id],
      [f.model, f.customer_name, f.site_name, f.city, f.state, f.cus_sys_id]);
  }
  const order = check("fleet order (attention; not reporting by last data)");
  for (const g of ["reporting", "not_reporting"]) {
    order(`${g} order`, model[g].map((r) => r.system_id), fleet.filter((f) => f.grp === g).map((f) => f.system_id));
  }
  const inv = check("inventory footer");
  inv("inventory ids", model.inventory.map((r) => r.system_id).sort(), inventory.map((r) => r.system_id).sort());
}

// ----------------------------------------------------------------- panels

// $1 as_of, $2 systems
const SPAN = `lastd AS (
  SELECT system_id, max(local_day) AS l, min(local_day) AS d0
  FROM api.ge_ct_days_v WHERE local_day <= $1::date AND system_id = ANY($2::text[]) GROUP BY system_id),
per AS (
  SELECT l.system_id, p.key, CASE WHEN p.days IS NULL THEN l.d0 ELSE greatest(l.d0, l.l - p.days + 1) END AS a, l.l AS b
  FROM lastd l CROSS JOIN ${PERIOD_SQL})`;
const dd = (col) => `(${col} - l.d0)::int`; // day offset from the first data day

const PANEL_SQL = {
  span: `WITH ${SPAN} SELECT system_id, to_char(d0, 'YYYY-MM-DD') AS d0, (l - d0 + 1)::int AS nd FROM lastd ORDER BY system_id`,
  data_days: `WITH ${SPAN} SELECT d.system_id, ${dd("d.local_day")} AS i FROM api.ge_ct_days_v d JOIN lastd l USING (system_id)
    WHERE d.local_day BETWEEN l.d0 AND l.l ORDER BY 1, 2`,
  // every daily cell up to as_of, per metric and dim, for the panel metrics
  cells: `WITH ${SPAN} SELECT v.system_id, v.metric_key AS m, v.dim, ${dd("v.local_day")} AS i, v.n::int AS n,
      v.value_sum, v.value_min, v.value_max, v.value_last
    FROM api.ge_ct_daily_v v JOIN lastd l USING (system_id) WHERE v.local_day <= $1::date ORDER BY 1, 2, 3, 4`,
  // period totals per metric (all dims) inside the payload's day range
  period_events: `WITH ${SPAN} SELECT p.system_id, p.key, v.metric_key AS m, sum(v.n)::bigint AS n
    FROM per p JOIN api.ge_ct_daily_v v ON v.system_id = p.system_id AND v.local_day BETWEEN p.a AND p.b
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  period_errors: `WITH ${SPAN}, s AS (
      SELECT p.system_id, p.key, v.dim AS code, sum(v.n)::bigint AS n
      FROM per p JOIN api.ge_ct_daily_v v ON v.system_id = p.system_id AND v.metric_key = 'error.ermes' AND v.local_day BETWEEN p.a AND p.b
      GROUP BY 1, 2, 3 HAVING sum(v.n) > 0)
    SELECT system_id, key, code, n::int AS n, row_number() OVER (PARTITION BY system_id, key ORDER BY n DESC, code COLLATE "C")::int AS rk
    FROM s ORDER BY 1, 2, rk`,
  period_counts: `WITH ${SPAN} SELECT p.system_id, p.key,
      (SELECT count(*) FROM api.ge_ct_days_v d WHERE d.system_id = p.system_id AND d.local_day BETWEEN p.a AND p.b)::int AS data_days,
      (SELECT count(*) FROM api.ge_ct_exams_v e WHERE e.system_id = p.system_id AND e.local_day BETWEEN p.a AND p.b)::int AS exams,
      (SELECT coalesce(sum(e.series), 0) FROM api.ge_ct_exams_v e WHERE e.system_id = p.system_id AND e.local_day BETWEEN p.a AND p.b)::int AS series,
      (SELECT coalesce(sum(e.images), 0) FROM api.ge_ct_exams_v e WHERE e.system_id = p.system_id AND e.local_day BETWEEN p.a AND p.b)::int AS images,
      (SELECT count(*) FROM api.ge_ct_boots_v b WHERE b.system_id = p.system_id AND b.local_day BETWEEN p.a AND p.b AND b.clean)::int AS boots_clean,
      (SELECT count(*) FROM api.ge_ct_boots_v b WHERE b.system_id = p.system_id AND b.local_day BETWEEN p.a AND p.b AND NOT b.clean)::int AS boots_unclean
    FROM per p ORDER BY 1, 2`,
  exams: `WITH ${SPAN} SELECT e.system_id, ${dd("e.local_day")} AS i, count(*)::int AS rows,
      coalesce(sum(e.series), 0)::int AS series, coalesce(sum(e.images), 0)::int AS images
    FROM api.ge_ct_exams_v e JOIN lastd l USING (system_id) WHERE e.local_day BETWEEN l.d0 AND l.l GROUP BY 1, 2 ORDER BY 1, 2`,
  heat: `WITH ${SPAN} SELECT p.system_id, p.key,
      ((extract(isodow FROM e.local_day)::int - 1) * 24
        + least(23, greatest(0, floor(extract(epoch FROM (e.started_at - d.local_midnight)) / 3600)))::int) AS cell,
      count(*)::int AS n
    FROM per p
    JOIN api.ge_ct_exams_v e ON e.system_id = p.system_id AND e.local_day BETWEEN p.a AND p.b
    JOIN api.ge_ct_days_v d ON d.system_id = e.system_id AND d.local_day = e.local_day
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  boots: `WITH ${SPAN} SELECT b.system_id, ${dd("b.local_day")} AS i, count(*) FILTER (WHERE b.clean)::int AS clean,
      count(*) FILTER (WHERE NOT b.clean)::int AS unclean
    FROM api.ge_ct_boots_v b JOIN lastd l USING (system_id) WHERE b.local_day BETWEEN l.d0 AND l.l GROUP BY 1, 2 ORDER BY 1, 2`,
  capabilities: `SELECT system_id, metric_key, label, unit, value_kind FROM api.ge_ct_capabilities_v
    WHERE system_id = ANY($2::text[]) ORDER BY system_id, metric_key COLLATE "C"`,
  segments: `WITH ${SPAN} SELECT t.system_id, t.segment_start, t.segment_end, t.is_current, to_char(t.install_date, 'YYYY-MM-DD') AS install_date,
      t.install_confidence, t.tube_source, t.segment_mas, t.mas_per_day, t.ended_reason,
      (SELECT to_char(max(x.local_day), 'YYYY-MM-DD') FROM api.ge_ct_days_v x
        WHERE x.system_id = t.system_id AND x.local_day <= $1::date AND x.local_midnight <= t.segment_start) AS start_day
    FROM api.ge_ct_tube_v t WHERE t.system_id = ANY($2::text[]) ORDER BY t.system_id, t.segment_start`
};

const group = (rows, key = (r) => r.system_id) => {
  const m = new Map();
  for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
};
const zeros = (n) => new Array(n).fill(0);
const ones = (n, idx) => { const a = new Array(n).fill("0"); for (const i of idx) if (i >= 0 && i < n) a[i] = "1"; return a.join(""); };
const slice_sum = (arr, a, b) => { let s = 0; for (let i = a; i <= b; i++) s += arr[i]; return s; };
const mask_count = (m, a, b) => [...m.slice(a, b + 1)].filter((c) => c === "1").length;

function check_panels(model, q, as_of, systems) {
  const eq_span = check("panels: day range and data days");
  const eq_ev = check("panels: per-day event series");
  const eq_tot = check("panels: period totals");
  const eq_heat = check("panels: busy-hour heatmap per period");
  const eq_err = check("panels: error-code top 10 per period");
  const eq_g = check("panels: gauges and tube counter");
  const eq_meta = check("panels: panels, labels, segments");
  const span = new Map(q.span.map((r) => [r.system_id, r]));
  const cells = group(q.cells), data_days = group(q.data_days), exams = group(q.exams), boots = group(q.boots);
  const caps = group(q.capabilities), segs = group(q.segments);
  const pev = group(q.period_events), perr = group(q.period_errors), pcount = group(q.period_counts), heat = group(q.heat);

  for (const sid of systems) {
    const v = model.views[sid], sp = span.get(sid);
    if (!v || !sp) { eq_span(`${sid} present`, !!v, !!sp); continue; }
    const nd = sp.nd, L = nd - 1;
    eq_span(`${sid}.d0`, v.d0, sp.d0);
    eq_span(`${sid}.nd`, v.nd, nd);
    eq_span(`${sid}.data`, v.data, ones(nd, (data_days.get(sid) || []).map((r) => r.i)));

    const mine = cells.get(sid) || [];
    const capset = new Set((caps.get(sid) || []).map((c) => c.metric_key));
    // dense per-day sum of n for metric m (dims passing pred), inside 0..L
    const dense_n = (m, pred = () => true) => {
      const a = zeros(nd);
      for (const c of mine) if (c.m === m && pred(c.dim) && c.i >= 0 && c.i <= L) a[c.i] += c.n;
      return a;
    };
    const day_set = (m, pred = () => true) => mine.filter((c) => c.m === m && pred(c.dim) && c.n > 0).map((c) => c.i);

    // event series: exactly the logged EVENT_SERIES metrics, each day equal
    eq_meta(`${sid}.ev keys`, Object.keys(v.ev).sort(), M.EVENT_SERIES.filter((m) => capset.has(m)).sort());
    for (const m of M.EVENT_SERIES.filter((x) => capset.has(x))) series(eq_ev, `${sid}.ev.${m}`, v.ev[m], dense_n(m));

    // exams per day
    const ex = { rows: zeros(nd), series: zeros(nd), images: zeros(nd) };
    for (const r of exams.get(sid) || []) for (const k of ["rows", "series", "images"]) ex[k][r.i] = r[k];
    for (const k of ["rows", "series", "images"]) series(eq_ev, `${sid}.exams.${k}`, v.exams[k], ex[k]);

    // errors: daily total and per code
    if (capset.has("error.ermes")) {
      series(eq_ev, `${sid}.errors.total`, v.errors && v.errors.total, dense_n("error.ermes"));
      for (const code of Object.keys((v.errors && v.errors.series) || {})) series(eq_ev, `${sid}.errors.${code}`, v.errors.series[code], dense_n("error.ermes", (d) => d === code));
    } else eq_meta(`${sid}.errors`, v.errors, null);

    // process restarts per process
    const procs = [...new Set(mine.filter((c) => c.m === "process.restart").map((c) => c.dim))].sort();
    eq_meta(`${sid}.restarts keys`, Object.keys(v.restarts), procs);
    for (const p of procs) series(eq_ev, `${sid}.restarts.${p}`, v.restarts[p], dense_n("process.restart", (d) => d === p));

    // boots
    if (capset.has("system.boot")) {
      const b = { clean: zeros(nd), unclean: zeros(nd) };
      for (const r of boots.get(sid) || []) { b.clean[r.i] = r.clean; b.unclean[r.i] = r.unclean; }
      series(eq_ev, `${sid}.boots.clean`, v.boots && v.boots.clean, b.clean);
      series(eq_ev, `${sid}.boots.unclean`, v.boots && v.boots.unclean, b.unclean);
    } else eq_meta(`${sid}.boots`, v.boots, null);

    // prep calendar masks
    if (capset.has("prep.tube_temp")) {
      eq_ev(`${sid}.prep.scan`, v.prep && v.prep.scan, ones(nd, day_set("exam.start")));
      eq_ev(`${sid}.prep.fast_cal`, v.prep && v.prep.fast_cal, ones(nd, day_set("prep.tube_temp", (d) => M.FAST_CAL_STEPS.includes(d))));
      eq_ev(`${sid}.prep.warmup`, v.prep && v.prep.warmup, ones(nd, day_set("prep.tube_temp", (d) => M.WARMUP_STEPS.includes(d))));
    } else eq_meta(`${sid}.prep`, v.prep, null);

    // gauges: per-day min / max / mean of the logged gauge metrics
    eq_meta(`${sid}.gauge keys`, Object.keys(v.gauges).sort(), M.GAUGE_VALUES.filter((m) => capset.has(m)).sort());
    for (const m of M.GAUGE_VALUES.filter((x) => capset.has(x))) {
      const want = mine.filter((c) => c.m === m && c.dim === "").map((c) => [c.i, r3(c.value_min), r3(c.value_max), r3(c.value_sum / c.n)]);
      series(eq_g, `${sid}.gauges.${m}`, v.gauges[m], want);
    }
    // tube counter readings and per-day increments (a drop counts 0)
    const ctr = mine.filter((c) => c.m === "tube.mas_total" && c.dim === "");
    series(eq_g, `${sid}.tube.counter`, v.tube.counter, ctr.map((c) => [c.i, r3(c.value_last)]));
    const inc = zeros(nd);
    for (let j = 1; j < ctr.length; j++) if (ctr[j].i >= 0 && ctr[j].i <= L) inc[ctr[j].i] = r3(Math.max(0, ctr[j].value_last - ctr[j - 1].value_last));
    series(eq_g, `${sid}.tube.increments`, v.tube.increments, inc);

    // period totals of what the panels show (sums of the payload's day arrays vs SQL sums)
    const pe = group(pev.get(sid) || [], (r) => r.key), pc = new Map((pcount.get(sid) || []).map((r) => [r.key, r]));
    for (const p of M.PERIODS) {
      const a = p.days === null ? 0 : Math.max(0, L - p.days + 1), k = `${sid}.${p.key}`;
      const sqlev = new Map((pe.get(p.key) || []).map((r) => [r.m, Number(r.n)]));
      const c = pc.get(p.key);
      eq_tot(`${k}.data_days`, mask_count(v.data, a, L), c.data_days);
      for (const m of Object.keys(v.ev)) eq_tot(`${k}.ev.${m}`, slice_sum(v.ev[m], a, L), sqlev.get(m) || 0);
      eq_tot(`${k}.exams`, [slice_sum(v.exams.rows, a, L), slice_sum(v.exams.series, a, L), slice_sum(v.exams.images, a, L)], [c.exams, c.series, c.images]);
      if (v.errors) eq_tot(`${k}.errors.total`, slice_sum(v.errors.total, a, L), sqlev.get("error.ermes") || 0);
      for (const proc of Object.keys(v.restarts)) {
        const want = (cells.get(sid) || []).filter((x) => x.m === "process.restart" && x.dim === proc && x.i >= a && x.i <= L).reduce((s, x) => s + x.n, 0);
        eq_tot(`${k}.restarts.${proc}`, slice_sum(v.restarts[proc], a, L), want);
      }
      if (v.boots) eq_tot(`${k}.boots`, [slice_sum(v.boots.clean, a, L), slice_sum(v.boots.unclean, a, L)], [c.boots_clean, c.boots_unclean]);
      eq_tot(`${k}.tube.increments`, r3(slice_sum(v.tube.increments, a, L)), r3(inc.slice(a, L + 1).reduce((s, x) => s + x, 0)));
      if (v.prep) {
        const sd = new Set(day_set("exam.start").filter((i) => i >= a && i <= L));
        const fc = new Set(day_set("prep.tube_temp", (d) => M.FAST_CAL_STEPS.includes(d)).filter((i) => i >= a && i <= L));
        eq_tot(`${k}.prep`, [mask_count(v.prep.scan, a, L), mask_count(v.prep.fast_cal, a, L)], [sd.size, fc.size]);
      }
      // heatmap: all 168 cells
      const h = zeros(168);
      for (const r of (heat.get(sid) || []).filter((x) => x.key === p.key)) h[r.cell] = r.n;
      series(eq_heat, `${k}.heat`, v.heat[p.key], h);
      // error-code top 10, other, total
      if (v.errors) {
        const er = (perr.get(sid) || []).filter((x) => x.key === p.key);
        const top = er.filter((x) => x.rk <= 10).map((x) => [x.code, x.n]);
        const all = er.reduce((s, x) => s + x.n, 0);
        eq_err(`${k}.errors.top`, v.errors.top[p.key], { codes: top, other: all - top.reduce((s, x) => s + x[1], 0), total: all });
      }
    }

    // panels shown, labels, segments, findings order
    eq_meta(`${sid}.panels`, v.panels, M.PANELS.filter((p) => p.metrics.some((m) => capset.has(m))).map((p) => p.key));
    eq_meta(`${sid}.labels`, v.labels, Object.fromEntries((caps.get(sid) || []).map((c) => [c.metric_key, { label: c.label, unit: c.unit, kind: c.value_kind }])));
    eq_meta(`${sid}.segments`, v.tube.segments.map((s) => [s.start, s.start_day, s.end, s.current, s.install_date, s.confidence, s.source, s.mas, s.mas_per_day, s.ended]),
      (segs.get(sid) || []).map((s) => [msOf(s.segment_start), s.start_day, msOf(s.segment_end), s.is_current, s.install_date, s.install_confidence,
        s.tube_source, r3(s.segment_mas), s.mas_per_day === null ? null : Math.floor(s.mas_per_day + 0.5), s.ended_reason]));
  }
}

// --------------------------------------------------------------- findings

// Every GE CT finding, in the page's order: open first (highest severity
// first, newest opened first), then resolved (newest resolved first).
const FINDINGS_SQL = `
SELECT system_id, finding_key, label, category, description, customer_visible, status, severity, evidence,
  opened_at, resolved_at, to_char(data_through, 'YYYY-MM-DD') AS data_through, window_start, window_end, observed, baseline,
  evidence ->> 'opened_day' AS opened_day, evidence ->> 'last_trip_day' AS last_trip_day, (evidence ->> 'trip_days')::int AS trip_days,
  (finding_key IN ('abort_rate_high', 'prep_noncompliance') AND evidence ? 'first' AND evidence ? 'last') AS has_trip,
  evidence #>> '{first,day}' AS f_day, evidence #>> '{last,day}' AS l_day,
  (evidence #>> '{first,d28,aborts}')::int AS f_aborts, (evidence #>> '{first,d28,exams}')::int AS f_exams, (evidence #>> '{first,d28,per_100}')::numeric AS f_per_100,
  (evidence #>> '{last,d28,aborts}')::int AS l_aborts, (evidence #>> '{last,d28,exams}')::int AS l_exams, (evidence #>> '{last,d28,per_100}')::numeric AS l_per_100,
  (evidence #>> '{first,scan_days}')::int AS f_scan, (evidence #>> '{first,scan_days_without_fast_cal}')::int AS f_without, (evidence #>> '{first,observed}')::numeric AS f_share,
  (evidence #>> '{last,scan_days}')::int AS l_scan, (evidence #>> '{last,scan_days_without_fast_cal}')::int AS l_without, (evidence #>> '{last,observed}')::numeric AS l_share
FROM api.ge_ct_findings_v
WHERE source = 'ge_ct'
ORDER BY system_id, (status = 'open') DESC, CASE WHEN status = 'open' THEN ${SEV_RANK} END DESC NULLS LAST,
  CASE WHEN status = 'open' THEN opened_at ELSE resolved_at END DESC, finding_key COLLATE "C"`;

function expected_finding(r) {
  const trip = (p) => (r.finding_key === "abort_rate_high"
    ? { day: r[`${p}_day`], aborts: r[`${p}_aborts`], exams: r[`${p}_exams`], per_100: num(r[`${p}_per_100`]) }
    : { day: r[`${p}_day`], scan_days: r[`${p}_scan`], without_fast_cal: r[`${p}_without`], share: num(r[`${p}_share`]) });
  return {
    finding_key: r.finding_key, label: r.label, category: r.category, description: r.description, customer_visible: r.customer_visible,
    status: r.status, severity: r.severity, opened_at: msOf(r.opened_at), resolved_at: msOf(r.resolved_at), data_through: r.data_through,
    window_start: msOf(r.window_start), window_end: msOf(r.window_end), observed: r.observed, baseline: r.baseline,
    opened_day: r.opened_day, last_trip_day: r.last_trip_day, trip_days: r.trip_days,
    trip: r.has_trip ? { first: trip("f"), last: trip("l") } : null,
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
  // no finding outside the systems the page shows
  const shown = new Set(Object.keys(model.views));
  eq("findings of systems not shown", rows.filter((r) => !shown.has(r.system_id)).map((r) => r.system_id), []);
  return n;
}

// ------------------------------------------------------------------ rules

// $1 system ids, $2 days, $3 Fast Calibration steps
const RULE_SQL = `
SELECT q.system_id, to_char(q.d, 'YYYY-MM-DD') AS day,
  (SELECT coalesce(sum(n), 0) FROM api.ge_ct_daily_v v WHERE v.system_id = q.system_id AND v.metric_key = 'scan.abort.system' AND v.local_day BETWEEN q.d - 27 AND q.d)::int AS aborts,
  (SELECT coalesce(sum(n), 0) FROM api.ge_ct_daily_v v WHERE v.system_id = q.system_id AND v.metric_key = 'exam.start' AND v.local_day BETWEEN q.d - 27 AND q.d)::int AS exams,
  (SELECT count(*) FROM (SELECT local_day FROM api.ge_ct_daily_v v WHERE v.system_id = q.system_id AND v.metric_key = 'exam.start'
     AND v.local_day BETWEEN q.d - 13 AND q.d GROUP BY local_day HAVING sum(n) > 0) s)::int AS scan_days,
  (SELECT count(*) FROM (SELECT local_day FROM api.ge_ct_daily_v v WHERE v.system_id = q.system_id AND v.metric_key = 'exam.start'
     AND v.local_day BETWEEN q.d - 13 AND q.d GROUP BY local_day HAVING sum(n) > 0) s
   WHERE NOT EXISTS (SELECT 1 FROM api.ge_ct_daily_v p WHERE p.system_id = q.system_id AND p.local_day = s.local_day
     AND p.metric_key = 'prep.tube_temp' AND p.dim = ANY($3::text[]) AND p.n > 0))::int AS without
FROM unnest($1::text[], $2::date[]) AS q(system_id, d)
ORDER BY 1, 2`;

const pct = (a, b) => (b > 0 ? Math.round((10000 * a) / b) / 100 : null);

async function check_rules(t, raw, model, as_of) {
  const eq = check("rules: columns = rule evidence on trip days");
  const trips = [];
  for (const f of raw.findings) {
    if (!["abort_rate_high", "prep_noncompliance"].includes(f.finding_key)) continue;
    for (const which of ["first", "last"]) {
      const e = f.evidence && f.evidence[which];
      if (e && e.day) trips.push({ f, which, e });
    }
  }
  if (!trips.length) return 0;
  const sql = await t.any(RULE_SQL, [trips.map((x) => x.f.system_id), trips.map((x) => x.e.day), M.FAST_CAL_STEPS]);
  const by = new Map(sql.map((r) => [`${r.system_id}|${r.day}`, r]));
  const T = M.dnum(as_of), ix = new Map();
  for (const { f, which, e } of trips) {
    const k = `${f.system_id} ${f.finding_key} ${which} ${e.day}`, s = by.get(`${f.system_id}|${e.day}`);
    if (!ix.has(f.system_id)) ix.set(f.system_id, M.index_system(raw, f.system_id, T));
    const D = M.dnum(e.day);
    if (f.finding_key === "abort_rate_high") {
      const want = { aborts: s.aborts, exams: s.exams, per_100: pct(s.aborts, s.exams) };
      eq(`${k} sql=evidence`, { aborts: e.d28.aborts, exams: e.d28.exams, per_100: e.d28.per_100 }, want);
      eq(`${k} model=sql`, M.abort_28d(ix.get(f.system_id), D), want);
    } else {
      const want = { scan_days: s.scan_days, without_fast_cal: s.without, share: pct(s.without, s.scan_days) };
      eq(`${k} sql=evidence`, { scan_days: e.scan_days, without_fast_cal: e.scan_days_without_fast_cal, share: e.observed }, want);
      eq(`${k} model=sql`, M.prep_14d(ix.get(f.system_id), D), want);
    }
  }
  return trips.length;
}

// ------------------------------------------------------------------- main

// All checks inside an open read-only transaction t. mutate(model) (tests
// only) alters the model before the comparison, to show a difference is
// caught.
async function run_checks(t, { as_of = null, systems = VERIFY_SYSTEMS } = {}, { mutate = null } = {}) {
  checks.length = 0;
  const ro = await t.one("SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso");
  if (ro.ro !== "on" || ro.iso !== "repeatable read") throw new Error(`verify: transaction is ${ro.iso}, read_only=${ro.ro}; refusing`);
  const raw = await read_ct(t);
  as_of = as_of || raw.snapshot_day;
  if (as_of < raw.snapshot_day) {
    throw new Error(`verify: --as-of ${as_of} is before the snapshot day ${raw.snapshot_day}; tube segments and findings are current state, so a historical check would compare future state on both sides (review PHASE6-VERIFY F1)`);
  }
  const model = M.build_model(raw, { as_of });
  for (const s of systems) if (!model.views[s]) throw new Error(`verify: ${s} has no data up to ${as_of}`);
  if (mutate) mutate(model, raw);
  const fleet = await t.any(FLEET_SQL, [as_of, M.FAST_CAL_STEPS]);
  const inventory = await t.any(INVENTORY_SQL);
  check_fleet(model, fleet, inventory);
  const q = {};
  for (const [k, sql] of Object.entries(PANEL_SQL)) q[k] = await t.any(sql, [as_of, systems]);
  check_panels(model, q, as_of, systems);
  const findings = check_findings(model, await t.any(FINDINGS_SQL));
  const trips = await check_rules(t, raw, model, as_of);
  return { raw, model, as_of, trips, findings, checks: checks.map((c) => ({ ...c })) };
}

async function main() {
  const o = args(process.argv.slice(2));
  const db = await open({ application_name: "ct_verify" });
  const t0 = Date.now();
  try {
    const { raw, model, as_of, trips, findings } = await db.tx({ mode: TX_MODE }, (t) => run_checks(t, o));
    const out = [];
    out.push(`GE CT Insights verify: as of ${as_of}, snapshot ${new Date(raw.snapshot_at).toISOString()} (read-only, repeatable read)`);
    out.push(`fleet: ${model.reporting.length + model.not_reporting.length} systems (${model.reporting.length} reporting, ${model.not_reporting.length} not reporting), inventory ${model.inventory.length}`);
    out.push(`panel systems: ${o.systems.join(", ")}; findings shown: ${findings}; rule trip days checked: ${trips}`);
    out.push("");
    const w = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) out.push(`  ${c.name.padEnd(w)}  ${String(c.compared).padStart(7)} compared  ${String(c.diffs.length).padStart(4)} diffs`);
    const diffs = checks.flatMap((c) => c.diffs.map((d) => ({ check: c.name, ...d })));
    if (diffs.length) {
      out.push("", `DIFFERENCES (${diffs.length}; first ${Math.min(diffs.length, o.max_diffs)}):`);
      for (const d of diffs.slice(0, o.max_diffs)) out.push(`  [${d.check}] ${d.key}\n      model ${d.model}\n      sql   ${d.sql}`);
    }
    out.push("", diffs.length ? `FAIL: ${diffs.length} differences` : `ALL CHECKS PASS: 0 differences in ${checks.reduce((s, c) => s + c.compared, 0)} comparisons`);
    out.push(`(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(out.join("\n"));
    process.exitCode = diffs.length ? 1 : 0;
  } finally {
    await close();
  }
}

module.exports = { run_checks, VERIFY_SYSTEMS, FLEET_SQL, PANEL_SQL, FINDINGS_SQL, RULE_SQL, INVENTORY_SQL };

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 2; close(); });
