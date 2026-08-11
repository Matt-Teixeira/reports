const { validate_scope, scope_set_hash } = require("./scope");

// Pure fan-out logic for DB-config (scheduled) runs — PLAN-SCOPED-WEEKLY.md
// B3. Everything here operates on plain rows handed in by the caller, so
// dev/check_config.js exercises every branch without a database; the thin
// SQL lives in config_loader.js.

const fail = (msg) => {
  throw new Error(`sme_report config invalid: ${msg}`);
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ["user_summary", "customer_summary", "fleet_summary", "briefs"];
// options is a contract, not a suggestion (the DDL comment promises unknown
// keys are rejected, not ignored). include_briefs / exception_only are
// designed-in but ship disabled; exclude carries the internal fleet run's
// service-station list.
const KNOWN_OPTIONS = ["include_briefs", "exception_only", "exclude"];

// Row (alert.sme_reports) -> canonical config, or a loud error naming the
// row id. Validation the DDL CHECKs cannot express lives here.
const validate_config = (row) => {
  const at = `config row ${row.id ?? "?"}`;
  if (!KINDS.includes(row.report_kind))
    fail(`${at}: unknown report_kind "${row.report_kind}"`);
  if (row.report_kind === "briefs")
    fail(`${at}: report_kind "briefs" is not implemented yet`);

  const options = row.options || {};
  for (const k of Object.keys(options))
    if (!KNOWN_OPTIONS.includes(k)) fail(`${at}: unknown option "${k}"`);
  if (options.include_briefs === true)
    fail(`${at}: options.include_briefs is not implemented yet`);
  if (options.exception_only === true)
    fail(`${at}: options.exception_only is not implemented yet`);
  if (options.exclude !== undefined && !Array.isArray(options.exclude))
    fail(`${at}: options.exclude must be an array of system ids`);

  if (!Number.isInteger(row.lookback_days) || row.lookback_days <= 0)
    fail(`${at}: lookback_days must be a positive integer`);

  const recipients = row.recipients || [];
  const cc_list = row.cc_list || [];
  for (const r of [...recipients, ...cc_list])
    if (!EMAIL_RE.test(r)) fail(`${at}: "${r}" is not an email address`);

  // Per-kind scope and recipient rules. user_summary derives its audience
  // from public.users by definition; the other kinds address a fixed list
  // (derived recipients for customer/fleet summaries are a later feature —
  // rejected loudly, never silently narrowed).
  if (row.report_kind === "user_summary") {
    const s = row.scope || {};
    if (!(s.all_users === true && Object.keys(s).length === 1))
      fail(`${at}: user_summary requires scope {"all_users": true}`);
    if (row.recipient_mode !== "derived")
      fail(`${at}: user_summary requires recipient_mode "derived"`);
  } else {
    if (row.recipient_mode !== "explicit")
      fail(`${at}: ${row.report_kind} requires recipient_mode "explicit" (derived is not implemented yet)`);
    if (!recipients.length) fail(`${at}: explicit recipients required`);
    if (row.report_kind === "customer_summary") {
      if (!row.scope) fail(`${at}: customer_summary requires a scope`);
      validate_scope(row.scope); // throws with the scope module's wording
    }
    if (row.report_kind === "fleet_summary" && row.scope !== null && row.scope !== undefined)
      fail(`${at}: fleet_summary takes no scope (it is the whole fleet)`);
  }

  return {
    id: row.id,
    kind: row.report_kind,
    scope: row.scope || null,
    lookback_days: row.lookback_days,
    options,
    recipient_mode: row.recipient_mode,
    recipients,
    cc_list,
    dry_run: row.dry_run !== false
  };
};

// public.users rows -> the weekly audience: active, notifiable, and able
// to see at least one magnet. scope_ids is each user's cache ∩ mag,
// sorted — the identity their document group is keyed by.
const resolve_audience = (users, mag_ids) => {
  const mag = new Set(mag_ids);
  const audience = [];
  for (const u of users || []) {
    if (u.status !== "active" || u.notify_email !== true) continue;
    const scope_ids = [...new Set((u.system_list_cache || []).filter((id) => mag.has(id)))].sort();
    if (!scope_ids.length) continue;
    audience.push({ email: u.email_address, scope_ids });
  }
  return audience;
};

// Users with IDENTICAL magnet scopes share one rendered document: 100
// users collapse to ~46 renders today. Groups are keyed by the same
// scope_set_hash the artifact filenames carry.
const group_by_scope = (audience) => {
  const groups = new Map();
  for (const a of audience) {
    const hash = scope_set_hash(a.scope_ids);
    if (!groups.has(hash))
      groups.set(hash, { scope_hash: hash, system_ids: a.scope_ids, users: [] });
    groups.get(hash).users.push(a.email);
  }
  return [...groups.values()].sort((a, b) => b.users.length - a.users.length);
};

// Send-time access re-check: the document's systems must still be a
// subset of the recipient's CURRENT cache — access revoked between render
// and send must not leak a wider document.
const access_covers = (cache_ids, document_ids) => {
  const cache = new Set(cache_ids || []);
  return (document_ids || []).every((id) => cache.has(id));
};

// Canonical config + resolved system ids -> the same raw request object a
// file-based run would carry, so everything downstream of the loader is
// shared. Scheduled runs are summary-only (briefs are a later option) and
// never per-report email; delivery happens in run_scheduled's send loop.
const config_to_raw = (cfg, { recipients }) => ({
  ...(cfg.scope && cfg.kind !== "user_summary" ? { scope: cfg.scope } : {}),
  lookback_days: cfg.lookback_days,
  ...(cfg.options.exclude ? { exclude: cfg.options.exclude, exclude_note: "excluded by report config" } : {}),
  summary_only: true,
  batch_email: {
    recipients,
    summary: false, // the send loop delivers; run_batch must not
    summary_pdf: true,
    attachments: false,
    archive_records: !cfg.dry_run
  }
});

module.exports = {
  validate_config,
  resolve_audience,
  group_by_scope,
  access_covers,
  config_to_raw,
  KNOWN_OPTIONS
};
