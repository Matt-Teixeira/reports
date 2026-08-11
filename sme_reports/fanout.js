const { validate_scope, scope_set_hash, scope_set_key } = require("./scope");

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
  if (typeof options !== "object" || Array.isArray(options))
    fail(`${at}: options must be an object`);
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

  // Deduplicated by NORMALIZED identity, within each list and across the
  // To/CC boundary (round-2 F3, round-3 F1): "Same@x.co" and "same@x.co"
  // are one recipient — first spelling kept — so no address can ever
  // collect two copies or two sends rows.
  const dedup_ci = (list) => {
    const seen = new Set();
    const out = [];
    for (const raw of list || []) {
      const e = String(raw).trim();
      const key = e.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out;
  };
  const recipients = dedup_ci(row.recipients);
  const to_lower = new Set(recipients.map((e) => e.toLowerCase()));
  const cc_list = dedup_ci(row.cc_list).filter((e) => !to_lower.has(e.toLowerCase()));
  for (const r of [...recipients, ...cc_list])
    if (!EMAIL_RE.test(r)) fail(`${at}: "${r}" is not an email address`);

  // Per-kind scope and recipient rules. user_summary derives its audience
  // from public.users by definition; the other kinds address a fixed list
  // (derived recipients for customer/fleet summaries are a later feature —
  // rejected loudly, never silently narrowed).
  if (row.report_kind === "user_summary") {
    const s = row.scope || {};
    const keys = Object.keys(s);
    // Two audience shapes: the full derived audience, or a NAMED subset —
    // the pilot mechanism ("send only to me" runs the whole per-customer
    // paradigm for the listed users alone).
    const is_all = s.all_users === true && keys.length === 1;
    const is_named =
      keys.length === 1 &&
      Array.isArray(s.users) &&
      s.users.length > 0 &&
      s.users.every((u) => EMAIL_RE.test(String(u)));
    if (!is_all && !is_named)
      fail(`${at}: user_summary requires scope {"all_users": true} or {"users": ["a@b.co", …]}`);
    if (row.recipient_mode !== "derived")
      fail(`${at}: user_summary requires recipient_mode "derived"`);
    // Review B round-1 F1 (blocker): a CC on a derived row would ride
    // EVERY per-user message across every scope-group, receiving documents
    // the CC address was never authorized for. Rejected outright in v1;
    // derived CC, if ever wanted, must be resolved, authorized, and
    // recorded per-recipient like everyone else.
    if (cc_list.length)
      fail(`${at}: user_summary does not allow cc_list — a CC would bypass the per-user access check`);
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
// sorted. `allowed` (the {"users": […]} pilot scope) narrows the audience
// to the named addresses, case-insensitively — every other filter still
// applies, so a pilot user who is inactive or opted out resolves to
// nothing rather than being force-mailed.
const resolve_audience = (users, mag_ids, allowed = null) => {
  const mag = new Set(mag_ids);
  const allow = allowed
    ? new Set(allowed.map((e) => String(e).toLowerCase()))
    : null;
  const audience = [];
  for (const u of users || []) {
    if (allow && !allow.has(String(u.email_address).toLowerCase())) continue;
    if (u.status !== "active" || u.notify_email !== true) continue;
    const scope_ids = [...new Set((u.system_list_cache || []).filter((id) => mag.has(id)))].sort();
    if (!scope_ids.length) continue;
    audience.push({ email: u.email_address, scope_ids });
  }
  return audience;
};

// The per-customer document plan (the decided paradigm): the document unit
// is (customer × system-subset), never a cross-customer merge — a document
// scoped to one customer is forward-safe and carries that customer's name.
// Each user's magnet scope is partitioned by owning customer; users
// sharing a (customer, subset) share one rendered document. Returns
//   units: [{ key, customer_id, customer_name, system_ids, scope_hash, users }]
//   user_units: Map email -> [unit key, …]
// A system with no customer mapping is a data-integrity failure, loudly.
const plan_documents = (audience, system_customer) => {
  const units = new Map();
  const user_units = new Map();
  for (const a of audience) {
    const by_customer = new Map();
    for (const id of a.scope_ids) {
      const owner = system_customer.get(id);
      if (!owner) fail(`system ${id} has no customer mapping`);
      if (!by_customer.has(owner.customer_id))
        by_customer.set(owner.customer_id, { name: owner.customer_name, ids: [] });
      by_customer.get(owner.customer_id).ids.push(id);
    }
    const keys = [];
    for (const [customer_id, { name, ids }] of by_customer) {
      const sorted = [...ids].sort();
      const key = `${customer_id}|${scope_set_key(sorted)}`;
      if (!units.has(key))
        units.set(key, {
          key,
          customer_id,
          customer_name: name,
          system_ids: sorted,
          scope_hash: scope_set_hash(sorted),
          users: []
        });
      units.get(key).users.push(a.email);
      keys.push(key);
    }
    user_units.set(a.email, keys);
  }
  return { units: [...units.values()], user_units };
};

// Users with IDENTICAL magnet scopes share one rendered document: 100
// users collapse to ~46 renders today. Grouping identity is the FULL
// canonical id set — never the hash (review B round-1 F3: a real
// first-8-hex collision merged two distinct scopes, sending one user's
// document universe to the skipped-access bin). scope_hash rides along as
// artifact/sends metadata only.
const group_by_scope = (audience) => {
  const groups = new Map();
  for (const a of audience) {
    const key = scope_set_key(a.scope_ids);
    if (!groups.has(key))
      groups.set(key, {
        scope_hash: scope_set_hash(a.scope_ids),
        system_ids: a.scope_ids,
        users: []
      });
    groups.get(key).users.push(a.email);
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

// Nodemailer resolves SUCCESSFULLY on partial rejection — it only throws
// when every recipient is refused — so "the promise resolved" is not "this
// recipient got the email" (round-2 F1). Map each envelope email to its
// real outcome from the returned info. Entries may be strings or
// {address} objects; comparison is case-insensitive. A missing/odd info
// shape counts everyone REJECTED — claiming delivery needs evidence.
const smtp_outcomes = (info, emails) => {
  const addr = (e) =>
    String(typeof e === "object" && e !== null ? e.address : e).toLowerCase();
  const accepted = new Set((info && info.accepted ? info.accepted : []).map(addr));
  const out = new Map();
  for (const email of emails)
    out.set(email, accepted.has(String(email).toLowerCase()) ? "sent" : "error");
  return out;
};

module.exports = {
  validate_config,
  resolve_audience,
  group_by_scope,
  plan_documents,
  access_covers,
  config_to_raw,
  smtp_outcomes,
  KNOWN_OPTIONS
};
