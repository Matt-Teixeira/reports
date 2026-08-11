const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

// Loads and validates a report request JSON file, applying defaults.
// The normalized request object is the single internal contract for the SME
// report pipeline — a future alert.sme_reports config table maps 1:1 onto it.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SME_RE = /^SME\d+$/;

const fail = (msg) => {
  throw new Error(`sme_report request invalid: ${msg}`);
};

const parse_date = (value, field) => {
  const dt = DateTime.fromISO(value, { zone: "utc" });
  if (!dt.isValid) fail(`${field} "${value}" is not a valid ISO date`);
  return dt;
};

const normalize_request = (raw) => {
  if (raw.report_type !== "magnet_health")
    fail(`report_type must be "magnet_health", got "${raw.report_type}"`);
  if (!SME_RE.test(raw.system_id || ""))
    fail(`system_id "${raw.system_id}" does not match SME#####`);
  if (!Array.isArray(raw.recipients) || raw.recipients.length === 0)
    fail("recipients must be a non-empty array");
  for (const r of raw.recipients)
    if (!EMAIL_RE.test(r)) fail(`recipient "${r}" is not an email address`);
  const cc_list = raw.cc_list || [];
  for (const c of cc_list)
    if (!EMAIL_RE.test(c)) fail(`cc "${c}" is not an email address`);

  const win = raw.window || {};
  const end = win.end
    ? parse_date(win.end, "window.end").endOf("day")
    : DateTime.utc().endOf("day");
  const lookback_days = win.lookback_days || 30;
  if (!Number.isInteger(lookback_days) || lookback_days <= 0)
    fail(`window.lookback_days must be a positive integer, got ${JSON.stringify(win.lookback_days)}`);
  const start = win.start
    ? parse_date(win.start, "window.start").startOf("day")
    : end.minus({ days: lookback_days }).startOf("day");
  if (start >= end) fail("window.start must be before window.end");

  let event_window = null;
  if (raw.event_window && raw.event_window.start) {
    event_window = {
      start: parse_date(raw.event_window.start, "event_window.start").toMillis(),
      end: raw.event_window.end
        ? parse_date(raw.event_window.end, "event_window.end").toMillis()
        : null
    };
  }

  const out = raw.output || {};

  return {
    report_type: raw.report_type,
    system_id: raw.system_id,
    recipients: raw.recipients,
    cc_list,
    // lookback_days is the period the window DEFAULTED from — null when an
    // explicit start was supplied (the days count would be a coincidence,
    // not a chosen period). Drives period tags on filenames and subjects.
    window: { start, end, lookback_days: win.start ? null : lookback_days },
    event_window,
    narrative_overrides: raw.narrative_overrides || {},
    output: {
      html: out.html !== false,
      pdf: out.pdf !== false,
      email: out.email !== false,
      archive: out.archive !== false,
      out_dir: out.out_dir || path.join(__dirname, "out")
    }
  };
};

// Optional top-level batch_email: send ONE email carrying every generated
// PDF, instead of one email per report. When present, member reports get
// pdf forced on and their individual email send forced off, and they may
// omit recipients (the batch recipients apply).
const normalize_batch_email = (raw) => {
  if (!raw) return null;
  if (!Array.isArray(raw.recipients) || raw.recipients.length === 0)
    fail("batch_email.recipients must be a non-empty array");
  for (const r of raw.recipients)
    if (!EMAIL_RE.test(r)) fail(`batch recipient "${r}" is not an email address`);
  const cc_list = raw.cc_list || [];
  for (const c of cc_list)
    if (!EMAIL_RE.test(c)) fail(`batch cc "${c}" is not an email address`);
  return {
    recipients: raw.recipients,
    cc_list,
    zip: raw.zip === true,
    // summary: one extra email listing every system + detected condition
    // (no attachments). attachments: false turns the PDF emails off entirely,
    // making summary-only delivery possible for very large batches.
    summary: raw.summary === true,
    // summary_pdf: also build the multi-page fleet summary document and
    // attach it to that summary email.
    summary_pdf: raw.summary_pdf === true,
    attachments: raw.attachments !== false,
    // archive_records: persist the distilled per-system records JSON beside
    // the archived PDFs whenever the summary document is built. This is
    // deliberate history capture — "changes since last report" needs weeks
    // of these to exist before it can be built. Probe runs set it false.
    archive_records: raw.archive_records !== false
  };
};

// The batch-assembly half, shared by explicit reports[] requests and
// scope-synthesized ones: exclusions, batch-email defaults, summary-only
// guards, per-report normalization, out_dir.
const assemble = (raw, list) => {
  const batch_email = normalize_batch_email(raw.batch_email);
  const summary_only = raw.summary_only === true;

  // Top-level lookback_days: the batch's period (7 for the weekly customer
  // product, 30 default), applied as each report's window default. A
  // per-report window (its own lookback or explicit dates) still wins —
  // the spread order below is the override.
  if (raw.lookback_days !== undefined) {
    if (!Number.isInteger(raw.lookback_days) || raw.lookback_days <= 0)
      fail(`lookback_days must be a positive integer, got ${JSON.stringify(raw.lookback_days)}`);
    list = list.map((r) => ({
      ...r,
      window: { lookback_days: raw.lookback_days, ...(r.window || {}) }
    }));
  }
  const lookback_days = raw.lookback_days || 30;

  // Top-level "exclude": system ids dropped from the run entirely (no DB
  // pull, no report, no section row) — e.g. the RF/SC service-station
  // magnets, which are real hardware but not fleet. Exclusions are never
  // silent: the loader returns what it removed and the fleet summary states
  // it, so a system leaving the report is always visible as a decision.
  let excluded = null;
  if (raw.exclude !== undefined) {
    if (!Array.isArray(raw.exclude)) fail("exclude must be an array of system ids");
    for (const id of raw.exclude)
      if (!SME_RE.test(id)) fail(`exclude entry "${id}" is not a system id`);
    const drop = new Set(raw.exclude);
    const removed = list.filter((r) => drop.has(r.system_id)).map((r) => r.system_id);
    list = list.filter((r) => !drop.has(r.system_id));
    if (removed.length)
      excluded = {
        ids: removed,
        note: typeof raw.exclude_note === "string" ? raw.exclude_note : null
      };
  }
  if (summary_only && !batch_email)
    fail("summary_only requires a batch_email block to send the summary to");
  // In summary-only mode the fleet document is the entire deliverable — no
  // per-system PDF is written — so a run without it produces nothing.
  if (summary_only && !batch_email.summary_pdf)
    fail("summary_only requires batch_email.summary_pdf (it is the only output)");

  const requests = list.map((r) => {
    if (batch_email) {
      r = {
        ...r,
        recipients: r.recipients || batch_email.recipients,
        output: summary_only
          ? { ...(r.output || {}), html: false, pdf: false, email: false, archive: false }
          : { ...(r.output || {}), pdf: true, email: false }
      };
    }
    return normalize_request(r);
  });
  // Batch output directory, resolved INDEPENDENTLY of the surviving request
  // list — an all-excluded request still has to produce the fleet document
  // that names its exclusions, and `requests[0].output.out_dir` on an empty
  // list is a crash, not a report.
  const out_dir = requests.length
    ? requests[0].output.out_dir
    : path.join(__dirname, "out");
  return { requests, batch_email, summary_only, excluded, out_dir, lookback_days };
};

// Accepts a single request, or { "reports": [ ... ], "batch_email": {...} },
// or a SCOPED request: { "scope": {...}, "report_defaults": {...}, ... }
// with no reports[] — the system list comes from the scope (customer_id /
// site_ids / system_ids, resolved against customers→sites→systems by
// scope.js). Returns { requests, batch_email, summary_only } for explicit
// requests; for scoped ones returns { scoped: true, scope, raw } — the
// caller resolves the scope (a DB round-trip this loader deliberately does
// not make) and finishes via materialize_scoped_requests.
//
// Top-level "summary_only": true produces ONLY the fleet summary — no
// per-system HTML or PDF is written and no per-system email is sent. Every
// system's facts are still computed; the expensive part that gets skipped is
// rendering, which is where the ~6 s/report goes. That makes the fleet
// summary cheap enough to schedule on its own.
const load_requests = (request_path) => {
  if (!request_path) fail("no request file path given");
  const full_path = path.resolve(request_path);
  if (!fs.existsSync(full_path)) fail(`request file not found: ${full_path}`);
  const raw = JSON.parse(fs.readFileSync(full_path, "utf8"));
  if (raw.scope !== undefined) {
    // One source of truth per request: a scope RESOLVES the system list, an
    // explicit reports[] STATES it — carrying both invites silent drift
    // between what was asked for and what runs.
    if (raw.reports !== undefined)
      fail("a request carries either scope or reports[], never both");
    const { validate_scope } = require("./scope");
    // Shape errors surface here, before any DB work.
    return { scoped: true, scope: validate_scope(raw.scope), raw };
  }
  if (raw.report_defaults !== undefined)
    fail("report_defaults only applies to scoped requests");
  const list = Array.isArray(raw.reports) ? raw.reports : [raw];
  return assemble(raw, list);
};

// Second half of a scoped load: the resolved system ids become synthesized
// per-system report entries (report_defaults supplying recipients / output
// flags / anything normalize_request accepts), then flow through the SAME
// assembly path as an explicit batch — exclusions, batch defaults, and
// validation behave identically for both.
const materialize_scoped_requests = (raw, system_ids) =>
  assemble(
    raw,
    system_ids.map((id) => ({
      report_type: "magnet_health",
      system_id: id,
      ...(raw.report_defaults || {})
    }))
  );

module.exports = { load_requests, materialize_scoped_requests, normalize_request };
