const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");

const { resolve_period, DEFAULT_DAYS, is_utc } = require("./periods");

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

// A named "period" ("6mo", "7d", "90d", or a plain day count) resolved to
// days through the shared vocabulary (periods.js), so a request file, a
// one-off CLI job and an artifact filename can never disagree about what a
// span is called. It is the same setting as lookback_days — never a second
// one layered on top — so naming both is a loud error.
const days_of = (spec, at, sibling_lookback) => {
  if (sibling_lookback !== undefined)
    fail(`${at} and ${at.replace(/period$/, "lookback_days")} are the same setting — give one, not both`);
  try {
    return resolve_period(spec, at).days;
  } catch (error) {
    fail(error.message);
  }
};

// A window bound: a date ("2026-10-09") or a date-time
// ("2026-10-09T14:00", seconds optional, a space accepted for the T, an
// optional Z or ±HH:MM offset). Deliberately narrower than everything
// luxon's fromISO accepts: "2026-10" or a week date would parse to SOME
// instant, and a window bound must be the instant the operator meant.
const BOUND_RE = /^\d{4}-\d{2}-\d{2}(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

// Zone-less bounds are read in `zone`; a Z or offset always wins. Returns
// the instant and whether only a date was given (a whole-day bound).
const parse_bound = (value, field, zone) => {
  if (typeof value !== "string")
    fail(`${field} must be a date or date-time string, got ${JSON.stringify(value)}`);
  const v = value.trim();
  const m = BOUND_RE.exec(v);
  if (!m) fail(`${field} "${value}" is not YYYY-MM-DD or YYYY-MM-DDTHH:mm (optionally with Z or ±HH:MM)`);
  const dt = DateTime.fromISO(v.replace(" ", "T"), { zone });
  if (!dt.isValid) fail(`${field} "${value}" is not a valid date (${dt.invalidExplanation || dt.invalidReason})`);
  return { dt, date_only: m[1] === undefined };
};

// The shortest window a report is built for. Shorter than this, the charts
// and the story describe a handful of captures — a mistake (a reversed AM/PM,
// a missing day) far more often than a request.
const MIN_WINDOW_MS = 60 * 60 * 1000;

// Window normalization on its own: the batch-period derivation needs the
// EFFECTIVE window of entries that may later be excluded (round-2 F2), so
// this cannot live only inside normalize_request.
//
// Bounds: a DATE is a whole day (start of the start day through the end of
// the end day — the historical behavior); a DATE-TIME is that exact
// instant, never moved to a day boundary (it used to be, silently). A
// window may give both bounds, only an end (the period then counts back
// from it — "the 30 days before the incident"), only a start (through
// today), or neither (the rolling period ending today).
//
// window.tz is the zone zone-less bounds are read in, and the zone the
// window is described in back to the reader (periods.js span_text). It
// defaults to UTC, which keeps every existing request file's window
// exactly as it was; the one-off CLI passes America/New_York.
const window_of = (win, { now = DateTime.utc() } = {}) => {
  // || not a default parameter: "window": null appears in pre-existing
  // request files and a default parameter only covers undefined — null
  // must keep its historical 30-day-default behavior (round-3 F1).
  win = win || {};
  const tz = win.tz === undefined || win.tz === null ? "utc" : win.tz;
  if (typeof tz !== "string" || !tz.trim() || !DateTime.utc().setZone(tz).isValid)
    fail(`window.tz "${tz}" is not a known time zone (e.g. America/New_York, America/Chicago, UTC)`);
  // A zone with no bound would quietly move a ROLLING window onto that
  // zone's days while every rolling surface still words it in UTC days.
  if (win.tz !== undefined && win.tz !== null && !win.start && !win.end)
    fail("window.tz only applies with window.start / window.end");
  const zone = is_utc(tz) ? "utc" : tz;
  const today_end = now.setZone(zone).endOf("day");

  const end_b = win.end ? parse_bound(win.end, "window.end", zone) : null;
  const end = !end_b ? today_end : end_b.date_only ? end_b.dt.endOf("day") : end_b.dt;
  // A window that reaches past now would be labelled with a span the data
  // cannot cover. A date bound may be today (through the end of today, the
  // same as the rolling default); a time bound may not be later than now.
  if (end_b && (end_b.date_only ? end > today_end : end > now.plus({ minutes: 1 })))
    fail(`window.end "${win.end}" is in the future`);

  // ?? not ||: zero must reach validation and fail loudly, not silently
  // become the 30-day default under a 7-day batch (review round-1 F7).
  // "period" is the NAMED spelling of the same setting ("6mo", "7d", a day
  // count) — one setting, so carrying both is a request error rather than
  // a silent precedence rule between two numbers that may disagree.
  const lookback_days =
    win.period !== undefined ? days_of(win.period, "window.period", win.lookback_days) : win.lookback_days ?? DEFAULT_DAYS;
  if (!Number.isInteger(lookback_days) || lookback_days <= 0)
    fail(`window.lookback_days must be a positive integer, got ${JSON.stringify(win.lookback_days)}`);

  const start_b = win.start ? parse_bound(win.start, "window.start", zone) : null;
  // Counting back from an end: from a whole-day end the start lands on a
  // day boundary (the historical rolling shape); from an exact end it is
  // exactly N days earlier — "7 days before 17:00" starts at 17:00.
  const start = start_b
    ? start_b.date_only
      ? start_b.dt.startOf("day")
      : start_b.dt
    : end_b && !end_b.date_only
      ? end.minus({ days: lookback_days })
      : end.minus({ days: lookback_days }).startOf("day");
  if (start >= end) fail("window.start must be before window.end");
  if (start_b && start > now) fail(`window.start "${win.start}" is in the future`);
  if (end.toMillis() - start.toMillis() < MIN_WINDOW_MS)
    fail(`the window is shorter than 1 hour (${win.start || "?"} to ${win.end || "?"}) — check the bounds`);

  // lookback_days records the period the window DEFAULTED from — null when
  // explicit start was given (a day count would be coincidence). explicit:
  // either bound was CHOSEN, so the window is named by its ends, not by a
  // period ending today (periods.js window_tag / window_label).
  return {
    start: start.toUTC(),
    end: end.toUTC(),
    lookback_days: win.start ? null : lookback_days,
    tz: zone,
    explicit: !!(win.start || win.end)
  };
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
// omit recipients (the batch recipients apply). scoped: whether the request
// is customer-scoped, which decides the default activity-page audience.
const normalize_batch_email = (raw, { scoped = false } = {}) => {
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
    archive_records: raw.archive_records !== false,
    // system_pages: also build one interactive System Activity page per
    // system that needs attention, has a data issue or failed, zip them,
    // and deliver them with the summary email (incident/system_pages.js).
    // Normalized to the AUDIENCE — false, "internal" or "external" — here,
    // once, under the recipient rules (incident/page_policy.js).
    system_pages: page_audience_of(raw, cc_list, scoped),
    // system_pages_format: "app" (one file listing every flagged system,
    // the default) or "pages" (one file per system).
    system_pages_format: require("./incident/page_policy").normalize_pages_format(raw.system_pages_format, "batch_email.system_pages_format", fail)
  };
};

// The envelope is checked only when THIS run sends the summary email: a
// build-only run addresses nobody, and a scheduled run (summary: false —
// its send loop delivers) is checked on its config row by fanout.js and
// again at send time by run_scheduled.js.
const page_audience_of = (raw, cc_list, scoped) => {
  const { normalize_system_pages, pages_audience, page_envelope_error } = require("./incident/page_policy");
  const audience = pages_audience(normalize_system_pages(raw.system_pages, "batch_email.system_pages", fail), { scoped });
  const refused = raw.summary === true ? page_envelope_error(audience, raw.recipients, cc_list) : null;
  if (refused) fail(refused);
  return audience || false;
};

// The batch-assembly half, shared by explicit reports[] requests and
// scope-synthesized ones: exclusions, batch-email defaults, summary-only
// guards, per-report normalization, out_dir.
const assemble = (raw, list) => {
  const batch_email = normalize_batch_email(raw.batch_email, { scoped: raw.scope !== undefined });
  const summary_only = raw.summary_only === true;

  // Top-level lookback_days (or its named spelling, "period": "6mo"): the
  // batch's period — 7 for the weekly customer product, 180 for the
  // 6-month review, 30 default — applied as each report's window default.
  // A per-report window (its own lookback, its own period, or explicit
  // dates) still wins.
  let batch_days;
  if (raw.period !== undefined) batch_days = days_of(raw.period, "period", raw.lookback_days);
  else if (raw.lookback_days !== undefined) {
    if (!Number.isInteger(raw.lookback_days) || raw.lookback_days <= 0)
      fail(`lookback_days must be a positive integer, got ${JSON.stringify(raw.lookback_days)}`);
    batch_days = raw.lookback_days;
  }
  if (batch_days !== undefined) {
    // Applied as a DEFAULT, not an override: a report window that already
    // states its own span (either spelling) keeps it, and one that states
    // explicit dates is untouched — window_of ignores a lookback beside a
    // start, exactly as the previous spread did.
    list = list.map((r) => {
      const win = { ...(r.window || {}) };
      if (win.lookback_days === undefined && win.period === undefined)
        win.lookback_days = batch_days;
      return { ...r, window: win };
    });
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

  // The batch's ONE window when every report shares it (always, for a
  // summary batch — enforced above), else null. Artifact tags and labels
  // read it, so an explicit window names its documents by its ends.
  const first = effective_windows[0];
  const window =
    first &&
    effective_windows.every(
      (w) => w.start.toMillis() === first.start.toMillis() && w.end.toMillis() === first.end.toMillis() && w.tz === first.tz
    )
      ? first
      : null;

  // History records are the scheduled product's period series ("changes
  // since last report" compares like with like). An explicit window is an
  // investigation, not a point in that series, so it never writes one —
  // whatever the batch asked for — and says so rather than skipping
  // quietly.
  let history_skipped = false;
  if (batch_email && batch_email.archive_records && effective_windows.some((w) => w.explicit)) {
    batch_email.archive_records = false;
    history_skipped = true;
  }

  return { requests, batch_email, summary_only, excluded, out_dir, lookback_days, window, history_skipped };
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
  return load_raw_request(JSON.parse(fs.readFileSync(full_path, "utf8")));
};

// The same load, from an ALREADY-PARSED request object: the one-off CLI
// (oneoff/) composes its request in memory from a job config instead of
// reading a file, and must take the identical validation path — a second
// assembly path is a second set of rules to keep in step. File mode is
// this function plus a read.
const load_raw_request = (raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fail("request must be an object");
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

module.exports = {
  load_requests,
  load_raw_request,
  materialize_scoped_requests,
  normalize_request,
  window_of
};
