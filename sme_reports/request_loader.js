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

// Window normalization on its own: the batch-period derivation needs the
// EFFECTIVE window of entries that may later be excluded (round-2 F2), so
// this cannot live only inside normalize_request.
const window_of = (win) => {
  // || not a default parameter: "window": null appears in pre-existing
  // request files and a default parameter only covers undefined — null
  // must keep its historical 30-day-default behavior (round-3 F1).
  win = win || {};
  const end = win.end
    ? parse_date(win.end, "window.end").endOf("day")
    : DateTime.utc().endOf("day");
  // ?? not ||: zero must reach validation and fail loudly, not silently
  // become the 30-day default under a 7-day batch (review round-1 F7).
  const lookback_days = win.lookback_days ?? 30;
  if (!Number.isInteger(lookback_days) || lookback_days <= 0)
    fail(`window.lookback_days must be a positive integer, got ${JSON.stringify(win.lookback_days)}`);
  const start = win.start
    ? parse_date(win.start, "window.start").startOf("day")
    : end.minus({ days: lookback_days }).startOf("day");
  if (start >= end) fail("window.start must be before window.end");
  // lookback_days records the period the window DEFAULTED from — null when
  // explicit dates were given (a day count would be coincidence).
  return { start, end, lookback_days: win.start ? null : lookback_days };
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

  const window = window_of(raw.window);

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
    window,
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
  // Pre-exclusion candidates: the batch-period fallback for all-excluded
  // runs (round-2 F2) reads their windows, since no request survives to
  // carry one.
  const candidates = list;

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
    // The document states every excluded id and the note VERBATIM in one
    // block (fleet_page.js), which in the worst layout shares its page with
    // the pinned legend. These bounds are what keeps that block clear of the
    // legend — check_fleet's all-excluded geometry doc measures exactly the
    // bound maxima — so past them the request fails loudly here rather than
    // the page clipping silently there.
    if (removed.length > 100)
      fail(
        `exclude removes ${removed.length} systems; the exclusion statement can name at most 100 — split the run or narrow the exclusion`
      );
    if (typeof raw.exclude_note === "string" && raw.exclude_note.length > 240)
      fail(
        `exclude_note is ${raw.exclude_note.length} chars; keep it under 240 so the exclusion statement stays one block`
      );
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

  // The batch's EFFECTIVE period, derived from the normalized windows the
  // reports will actually analyze — never from the top-level default, which
  // per-report overrides may have diverged from (review round-1 F3). When
  // every candidate was excluded, the period comes from the EXCLUDED
  // candidates' windows: the exclusion document still describes a period,
  // and a 7-day and a 30-day all-excluded run for the same scope must not
  // share artifact names (round-2 F2).
  const effective_windows = requests.length
    ? requests.map((r) => r.window)
    : candidates.map((r) => window_of(r.window));

  // A summary document renders ONE date range in its heading and footers,
  // so a summary batch must share ONE normalized window — same lookback is
  // not enough (round-2 F1: two 7-day windows ending ten days apart union
  // to a 17-day heading; two disjoint explicit ranges union to a span
  // neither system was analyzed for). Mislabeled periods are fatal request
  // errors, not artifacts.
  if (requests.length && batch_email && batch_email.summary_pdf) {
    const spans = [
      ...new Set(
        effective_windows.map((w) => `${w.start.toMillis()}|${w.end.toMillis()}`)
      )
    ];
    if (spans.length > 1)
      fail(
        `a summary batch must share one analysis window; found ${spans.length} distinct windows`
      );
  }
  const periods = [...new Set(effective_windows.map((w) => w.lookback_days))];
  if (requests.length && batch_email && batch_email.summary_pdf && periods.length > 1)
    fail(
      `a summary batch must share one period; found ${periods
        .map((p) => (p === null ? "explicit dates" : `${p} days`))
        .join(", ")}`
    );
  const lookback_days = periods.length === 1 ? periods[0] : null;

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
//
// The scope is the ONLY authority on which systems run and what report
// they get (review round-1 F1: report_defaults.system_id spread after the
// synthesized id replaced every scope-resolved system with an arbitrary —
// possibly other-customer — one). Reserved keys are rejected outright, the
// authoritative fields are applied LAST, and the materialized ids are
// asserted against the resolution before exclusions.
const RESERVED_DEFAULTS = ["system_id", "report_type"];

const materialize_scoped_requests = (raw, system_ids) => {
  const defaults = raw.report_defaults || {};
  for (const k of RESERVED_DEFAULTS)
    if (defaults[k] !== undefined)
      fail(`report_defaults.${k} is not allowed — the scope decides it`);
  const list = system_ids.map((id) => ({
    ...defaults,
    report_type: "magnet_health",
    system_id: id
  }));
  if (
    list.length !== system_ids.length ||
    list.some((r, i) => r.system_id !== system_ids[i])
  )
    fail("materialized system ids diverge from the resolved scope");
  return assemble(raw, list);
};

module.exports = { load_requests, materialize_scoped_requests, normalize_request };
