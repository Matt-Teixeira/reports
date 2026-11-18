// Read-only loads for the GE CV Insights viewer (hhm_rpp_ge
// PLAN-CV-INSIGHTS.md §13.2 item 3). Sources:
//   - the api.ge_cv_* views (migration 007, the consumer contract);
//   - identity from public.systems -> sites -> customers, as the CT viewer;
//   - the configured CV systems: GE CV/IR systems in config.acquisition
//     (run_group 1) with a config.log row for sysError.log (§13.1: 18);
//   - the inventory footer: GE CV/IR systems in public.systems that are not
//     configured (§13.1: 44).
// Never insight.* or log.* directly.
//
// Everything is read in ONE read-only REPEATABLE READ transaction (ct/db.js
// sessions also have default_transaction_read_only=on), so the datasets are
// a consistent snapshot while the ge_cv stage writes every 30 min. Every
// query has an ORDER BY: same snapshot, same rows in the same order.
//
// Only the columns the viewer needs. No debug text, no encoded fields (the
// views have none); code labels are the masked templates of
// api.ge_cv_codes_v. The source file is cut to its base name here, in SQL,
// so GE's build paths never reach the builder (§13.1 privacy).
// Dates come back as 'YYYY-MM-DD' strings; instants as Date.

const { pgp } = require("../ct/db");
const { TX_MODE } = require("../ct/data");

const day = (col, as = col) => `to_char(${col}, 'YYYY-MM-DD') AS ${as}`;
const where = (systems, extra = null) => {
  const c = [systems && "system_id = ANY($1)", extra].filter(Boolean);
  return c.length ? `WHERE ${c.join(" AND ")}` : "";
};

// GE CV/IR systems configured to collect sysError.log
const CONFIGURED = `SELECT s.id
    FROM public.systems s
    JOIN config.acquisition ac ON ac.system_id = s.id AND ac.run_group = 1
    WHERE s.manufacturer = 'GE' AND s.modality = 'CV/IR'
      AND EXISTS (SELECT 1 FROM config.log l WHERE l.system_id = s.id AND l.file_name = 'sysError.log')`;

const SQL = {
  // ahead_min: the clock lower bound, whole minutes of last_seen after the
  // snapshot (now() of this transaction), at full microsecond precision
  // (review CV6-DATA-MODEL F2: a JS Date keeps only milliseconds)
  summary: (s) => `SELECT system_id, last_seen, ${day("last_local_day")}, open_findings::int AS open_findings, open_findings_max_severity,
      floor(extract(epoch FROM (last_seen - now())) / 60)::int AS ahead_min
    FROM api.ge_cv_system_summary_v ${where(s)} ORDER BY system_id`,
  daily: (s) => `SELECT system_id, ${day("local_day", "day")}, metric_key AS m, dim, n::int AS n, code_subsystem AS sub
    FROM api.ge_cv_daily_v ${where(s)} ORDER BY system_id, local_day, metric_key, dim`,
  capabilities: (s) => `SELECT system_id, metric_key, label, unit, category, value_kind, first_seen, last_seen, n::int AS n
    FROM api.ge_cv_capabilities_v ${where(s)} ORDER BY system_id, metric_key`,
  // GE CV findings only (the view filters source too)
  findings: (s) => `SELECT system_id, source, finding_key, label, category, description, customer_visible, status, severity, opened_at, resolved_at,
      ${day("data_through")}, window_start, window_end, observed, baseline, evidence, rule_version, last_evaluated
    FROM api.ge_cv_findings_v ${where(s, "source = 'ge_cv'")} ORDER BY system_id, finding_key, opened_at`,
  codes: `SELECT errorcode::text AS code, subsystem, label, label_share, regexp_replace(sourcefile, '^.*[\\\\/]', '') AS sourcefile,
      n::bigint AS n, systems::int AS systems, first_seen, last_seen
    FROM api.ge_cv_codes_v ORDER BY errorcode`,
  configured: `${CONFIGURED} ORDER BY s.id`,
  identity: `SELECT s.id AS system_id, s.manufacturer, s.modality, s.model, s.cus_sys_id, si.name AS site_name, si.city, si.state,
      c.id AS customer_id, c.name AS customer_name
    FROM public.systems s
    LEFT JOIN public.sites si ON si.id = s.site_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    WHERE s.id = ANY($1) ORDER BY s.id`,
  // GE CV/IR systems in inventory that are not configured for sysError.log
  // and have no CV data in insight
  inventory: `SELECT s.id AS system_id, s.modality, s.model, si.name AS site_name, c.name AS customer_name
    FROM public.systems s
    LEFT JOIN public.sites si ON si.id = s.site_id
    LEFT JOIN public.customers c ON c.id = si.customer_id
    WHERE s.manufacturer = 'GE' AND s.modality = 'CV/IR' AND NOT (s.id = ANY($1))
    ORDER BY s.id`
};

// Reads every dataset inside an open transaction t (cv/verify.js reads its
// independent SQL in the same snapshot).
// systems: optional list of system ids (fixtures, verification); null = all.
// Returns { snapshot_at, snapshot_day (its UTC date), summary, daily, capabilities, findings, codes,
//           configured (ids), identity, inventory }.
const read_cv = async (t, { systems = null } = {}) => {
  const p = systems ? [systems] : [];
  const snap = await t.one("SELECT now() AS t, to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day");
  const out = { snapshot_at: snap.t, snapshot_day: snap.day };
  for (const k of ["summary", "daily", "capabilities", "findings"]) out[k] = await t.any(SQL[k](systems), p);
  out.codes = await t.any(SQL.codes);
  const configured = (await t.any(SQL.configured)).map((r) => r.id);
  out.configured = systems ? configured.filter((s) => systems.includes(s)) : configured;
  const known = [...new Set([...out.summary.map((r) => r.system_id), ...out.configured])].sort();
  out.identity = await t.any(SQL.identity, [known]);
  // the inventory footer is fleet-wide only
  out.inventory = systems ? [] : await t.any(SQL.inventory, [known]);
  return out;
};

// One read-only REPEATABLE READ transaction.
const load_cv = (db, opts = {}) => db.tx({ mode: TX_MODE }, (t) => read_cv(t, opts));

module.exports = { load_cv, read_cv, SQL, CONFIGURED };
