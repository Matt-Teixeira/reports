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
    window: { start, end },
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
    attachments: raw.attachments !== false
  };
};

// Accepts a single request, or { "reports": [ ... ], "batch_email": {...} }.
// Returns { requests, batch_email } — batch_email is null for per-report sends.
const load_requests = (request_path) => {
  if (!request_path) fail("no request file path given");
  const full_path = path.resolve(request_path);
  if (!fs.existsSync(full_path)) fail(`request file not found: ${full_path}`);
  const raw = JSON.parse(fs.readFileSync(full_path, "utf8"));
  const list = Array.isArray(raw.reports) ? raw.reports : [raw];
  const batch_email = normalize_batch_email(raw.batch_email);

  const requests = list.map((r) => {
    if (batch_email) {
      r = {
        ...r,
        recipients: r.recipients || batch_email.recipients,
        output: { ...(r.output || {}), pdf: true, email: false }
      };
    }
    return normalize_request(r);
  });
  return { requests, batch_email };
};

module.exports = { load_requests, normalize_request };
