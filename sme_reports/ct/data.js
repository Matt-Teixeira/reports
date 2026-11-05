// Read-only loads for the GE CT Insights viewer (hhm_rpp_ge
// PLAN-CT-INSIGHTS.md §16.2 item 3). Sources:
//   - the api.ge_ct_* views (the consumer contract, §3), including the
//     migration 006 views ge_ct_days_v, ge_ct_capabilities_v, ge_ct_boots_v;
//   - identity from public.systems -> sites -> customers, as in
//     sql/get-system-identity.sql (fleet-wide here).
// Never insight.* directly.
//
// Everything is read in ONE read-only REPEATABLE READ transaction, so the
// datasets are a consistent snapshot even while the ge_ct stage writes
// (it runs every 30 min). Every query has an ORDER BY: same snapshot, same
// rows in the same order.
//
// Only the columns the viewer needs are selected. In particular no
// exam_no and no protocol from ge_ct_exams_v (internal raw material, §7).
// Dates come back as 'YYYY-MM-DD' strings; instants as Date.

const { pgp } = require("./db");

const day = (col, as = col) => `to_char(${col}, 'YYYY-MM-DD') AS ${as}`;
const where = (systems, extra = null) => {
  const c = [systems && "system_id = ANY($1)", extra].filter(Boolean);
  return c.length ? `WHERE ${c.join(" AND ")}` : "";
};

const SQL = {
  summary: (s) => `SELECT system_id, last_seen, current_tube_install_date, current_tube_install_confidence, current_tube_mas,
      current_tube_mas_per_day, open_findings, open_findings_max_severity, current_tube_source, clock_flag, clock_est_offset_min
    FROM api.ge_ct_system_summary_v ${where(s)} ORDER BY system_id`,
  days: (s) => `SELECT system_id, ${day("local_day", "day")}, local_midnight, first_at, last_at
    FROM api.ge_ct_days_v ${where(s)} ORDER BY system_id, local_day`,
  daily: (s) => `SELECT system_id, ${day("local_day", "day")}, metric_key AS m, dim, n::int AS n, value_sum, value_min, value_max, value_last
    FROM api.ge_ct_daily_v ${where(s)} ORDER BY system_id, local_day, metric_key, dim`,
  exams: (s) => `SELECT system_id, ${day("local_day", "day")}, started_at, series, scans, images, aborts_operator, aborts_system, reopened
    FROM api.ge_ct_exams_v ${where(s)} ORDER BY system_id, started_at, local_day, series, images`,
  tube: (s) => `SELECT system_id, segment_start, segment_end, is_current, ${day("install_date")}, install_confidence, tube_source,
      start_mas, latest_mas, segment_mas, latest_at, mas_per_day, readings, ended_reason
    FROM api.ge_ct_tube_v ${where(s)} ORDER BY system_id, segment_start`,
  // GE CT findings only: the view carries every source (review PHASE6-DATA-MODEL F2)
  findings: (s) => `SELECT system_id, source, finding_key, label, category, description, customer_visible, status, severity, opened_at, resolved_at,
      ${day("data_through")}, window_start, window_end, observed, baseline, evidence, rule_version, last_evaluated
    FROM api.ge_ct_findings_v ${where(s, "source = 'ge_ct'")} ORDER BY system_id, finding_key, opened_at`,
  capabilities: (s) => `SELECT system_id, metric_key, label, unit, category, value_kind, model_specific, first_seen, last_seen, n::int AS n
    FROM api.ge_ct_capabilities_v ${where(s)} ORDER BY system_id, metric_key`,
  boots: (s) => `SELECT system_id, ${day("local_day", "day")}, booted_at, clean
    FROM api.ge_ct_boots_v ${where(s)} ORDER BY system_id, booted_at`,
  identity: `SELECT s.id AS system_id, s.manufacturer, s.modality, s.model, s.cus_sys_id, si.name AS site_name, si.city, si.state,
      c.id AS customer_id, c.name AS customer_name
    FROM public.systems s
    JOIN public.sites si ON si.id = s.site_id
    JOIN public.customers c ON c.id = si.customer_id
    WHERE s.id = ANY($1) ORDER BY s.id`,
  // GE CT (and PET/CT) systems in inventory with no GE CT log data in insight
  inventory: `SELECT s.id AS system_id, s.modality, s.model, si.name AS site_name, c.name AS customer_name
    FROM public.systems s
    LEFT JOIN public.sites si ON si.id = s.site_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    WHERE s.manufacturer = 'GE' AND s.modality IN ('CT', 'PET/CT') AND NOT (s.id = ANY($1))
    ORDER BY s.id`
};

const TX_MODE = new pgp.txMode.TransactionMode({ tiLevel: pgp.txMode.isolationLevel.repeatableRead, readOnly: true });

// Reads every dataset inside an open transaction t (ct/verify.js reads its
// independent SQL in the same snapshot).
// systems: optional list of system ids (fixtures, verification); null = all.
// Returns { snapshot_at, snapshot_day (its UTC date), summary, days, daily, exams, tube, findings,
//           capabilities, boots, identity, inventory }.
const read_ct = async (t, { systems = null } = {}) => {
  const p = systems ? [systems] : [];
  const snap = await t.one("SELECT now() AS t, to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day");
  const out = { snapshot_at: snap.t, snapshot_day: snap.day };
  for (const k of ["summary", "days", "daily", "exams", "tube", "findings", "capabilities", "boots"]) out[k] = await t.any(SQL[k](systems), p);
  const ids = out.summary.map((r) => r.system_id);
  out.identity = await t.any(SQL.identity, [ids]);
  // the inventory footer is fleet-wide only
  out.inventory = systems ? [] : await t.any(SQL.inventory, [ids]);
  return out;
};

// One read-only REPEATABLE READ transaction.
const load_ct = (db, opts = {}) => db.tx({ mode: TX_MODE }, (t) => read_ct(t, opts));

module.exports = { load_ct, read_ct, TX_MODE, SQL };
