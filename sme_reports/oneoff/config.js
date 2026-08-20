// One-off (operator-run) report jobs — the config half.
//
// A job config file names the runs you want to be able to fire by hand:
// a customer's summary document by customer id, a brief for one or more
// SMEs, the internal fleet summary. `cli.js` reads one job out of it,
// applies any flag overrides, and hands the composed request to the SAME
// loader and batch runner the request-file and scheduled paths use — this
// module never renders, sends, or talks to a database, it only decides
// what request an operator asked for. That keeps it pure and dev-checked
// (dev/check_oneoff.js), and keeps one-off runs from drifting away from
// scheduled ones: everything downstream of `build_request` is shared code.
//
// Nothing here is on the scheduled path. Deleting this directory would
// leave cron, `npm start sme_report`, and every request file untouched.

const path = require("path");

const { resolve_period, PERIOD_KEYS } = require("../periods");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SME_RE = /^SME\d+$/;

const fail = (msg) => {
  throw new Error(`report job config invalid: ${msg}`);
};

const JOB_KINDS = ["customer_summary", "sme_brief", "fleet_summary"];

// Settings every kind accepts, and the extra keys each kind alone accepts.
// Unknown keys are REJECTED, never ignored (the stance fanout.js takes on
// config options): a misspelled "recipeints" that silently kept the
// default audience is exactly the failure a hand-edited config invites.
const COMMON_KEYS = [
  "kind",
  "description",
  "period",
  "recipients",
  "cc_list",
  "email",
  "out_dir",
  "archive",
  "archive_records",
  "summary_pdf"
];
const KIND_KEYS = {
  customer_summary: ["customer_id", "site_ids", "system_ids", "exclude", "exclude_note"],
  sme_brief: ["system_ids"],
  fleet_summary: ["exclude", "exclude_note"]
};

// Comment keys: hand-edited JSON has no comment syntax, so any key
// starting with "_" is ignored everywhere (`"_why": "..."` beside a
// setting). "$" is left alone too for editor schema keys.
const is_comment_key = (k) => k.startsWith("_") || k.startsWith("$");

const check_keys = (obj, allowed, at) => {
  for (const k of Object.keys(obj)) {
    if (is_comment_key(k)) continue;
    if (!allowed.includes(k)) fail(`${at}: unknown setting "${k}" (allowed: ${allowed.filter((a) => a !== "kind").join(", ")})`);
  }
};

const as_bool = (v, at) => {
  if (typeof v !== "boolean") fail(`${at} must be true or false, got ${JSON.stringify(v)}`);
  return v;
};

const as_emails = (v, at) => {
  if (!Array.isArray(v)) fail(`${at} must be an array of email addresses`);
  for (const e of v) if (!EMAIL_RE.test(String(e))) fail(`${at}: "${e}" is not an email address`);
  return v.map((e) => String(e).trim());
};

const as_system_ids = (v, at) => {
  if (!Array.isArray(v) || !v.length) fail(`${at} must be a non-empty array of system ids`);
  for (const id of v) if (!SME_RE.test(String(id))) fail(`${at}: "${id}" is not a system id (SME#####)`);
  return v.map((id) => String(id).trim());
};

// The settings a job runs with: file defaults, overlaid by the job, then
// by CLI flags. Every layer is validated with the SAME rules, so a flag
// cannot smuggle in a shape the file would have rejected.
const DEFAULT_SETTINGS = {
  period: "30d",
  recipients: [],
  cc_list: [],
  email: false,
  out_dir: null,
  archive: true,
  // One-off runs default to NOT writing a history sidecar: the archived
  // records series is the scheduled product's history, and an operator
  // exploring a 6-month window should not silently deposit rows in it.
  archive_records: false,
  summary_pdf: false
};

const resolve_settings = (raw, at) => {
  const s = {};
  if (raw.period !== undefined) s.period = resolve_period(raw.period, `${at}.period`);
  if (raw.recipients !== undefined) s.recipients = as_emails(raw.recipients, `${at}.recipients`);
  if (raw.cc_list !== undefined) s.cc_list = as_emails(raw.cc_list, `${at}.cc_list`);
  if (raw.email !== undefined) s.email = as_bool(raw.email, `${at}.email`);
  if (raw.archive !== undefined) s.archive = as_bool(raw.archive, `${at}.archive`);
  if (raw.archive_records !== undefined)
    s.archive_records = as_bool(raw.archive_records, `${at}.archive_records`);
  if (raw.summary_pdf !== undefined) s.summary_pdf = as_bool(raw.summary_pdf, `${at}.summary_pdf`);
  if (raw.out_dir !== undefined) {
    if (raw.out_dir !== null && (typeof raw.out_dir !== "string" || !raw.out_dir.trim()))
      fail(`${at}.out_dir must be a path string or null`);
    s.out_dir = raw.out_dir === null ? null : path.resolve(raw.out_dir.trim());
  }
  return s;
};

// Config file -> { defaults, jobs: Map(name -> job) }. Job shape is
// validated here, so `cli.js` only chooses one and overlays flags.
const load_job_config = (raw) => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    fail("the config must be a JSON object");
  check_keys(raw, ["defaults", "jobs"], "config");
  if (raw.defaults !== undefined) {
    if (typeof raw.defaults !== "object" || raw.defaults === null || Array.isArray(raw.defaults))
      fail("config.defaults must be an object");
    check_keys(raw.defaults, COMMON_KEYS.filter((k) => k !== "kind"), "defaults");
  }
  const defaults = {
    ...DEFAULT_SETTINGS,
    period: resolve_period(DEFAULT_SETTINGS.period),
    ...resolve_settings(raw.defaults || {}, "defaults")
  };

  const jobs_raw = raw.jobs;
  if (typeof jobs_raw !== "object" || jobs_raw === null || Array.isArray(jobs_raw))
    fail("config.jobs must be an object of job name -> job");
  const jobs = new Map();
  for (const [name, job_raw] of Object.entries(jobs_raw)) {
    if (is_comment_key(name)) continue;
    jobs.set(name, validate_job(name, job_raw, defaults));
  }
  if (!jobs.size) fail("config.jobs defines no jobs");
  return { defaults, jobs };
};

const validate_job = (name, raw, defaults) => {
  const at = `job "${name}"`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${at} must be an object`);
  if (!JOB_KINDS.includes(raw.kind))
    fail(`${at}: kind must be one of ${JOB_KINDS.join(", ")} (got ${JSON.stringify(raw.kind)})`);
  check_keys(raw, [...COMMON_KEYS, ...KIND_KEYS[raw.kind]], at);

  const job = {
    name,
    kind: raw.kind,
    description: raw.description ? String(raw.description) : null,
    ...defaults,
    ...resolve_settings(raw, at)
  };

  if (raw.kind === "customer_summary") {
    // Exactly one selector, so a config can never quietly widen from a
    // customer to a site list because both keys were left in the file.
    const given = ["customer_id", "site_ids", "system_ids"].filter((k) => raw[k] !== undefined);
    if (given.length !== 1)
      fail(`${at}: give exactly one of customer_id, site_ids, system_ids (got ${given.join(", ") || "none"})`);
    if (given[0] === "customer_id") {
      if (typeof raw.customer_id !== "string" || !raw.customer_id.trim())
        fail(`${at}.customer_id must be a non-empty string`);
      job.scope = { customer_id: raw.customer_id.trim() };
    } else if (given[0] === "site_ids") {
      if (!Array.isArray(raw.site_ids) || !raw.site_ids.length)
        fail(`${at}.site_ids must be a non-empty array`);
      job.scope = { site_ids: raw.site_ids.map((s) => String(s).trim()) };
    } else {
      job.scope = { system_ids: as_system_ids(raw.system_ids, `${at}.system_ids`) };
    }
  }

  if (raw.kind === "sme_brief") job.system_ids = as_system_ids(raw.system_ids, `${at}.system_ids`);

  if (raw.kind !== "sme_brief") {
    if (raw.exclude !== undefined) job.exclude = as_system_ids(raw.exclude, `${at}.exclude`);
    if (raw.exclude_note !== undefined) {
      if (typeof raw.exclude_note !== "string") fail(`${at}.exclude_note must be a string`);
      job.exclude_note = raw.exclude_note;
    }
  }

  // A summary document is built for every summary-kind run whether or not
  // it is emailed, and the loader requires an address on the batch block
  // even when nothing is sent (it is the fallback per-report recipient).
  // Requiring one here names the problem at the config instead of deep in
  // request validation.
  if (!job.recipients.length)
    fail(`${at}: recipients is empty — set defaults.recipients in the config (nothing is emailed unless email is true)`);
  return job;
};

// CLI flags overlaid on the chosen job. Overrides run through the SAME
// validators the file goes through — a flag cannot introduce a shape the
// config would have rejected — and a flag that does not apply to the
// job's kind is an error rather than a silently ignored argument.
const apply_overrides = (job, overrides = {}) => {
  const next = { ...job, ...resolve_settings(overrides, "command line") };
  if (overrides.customer_id !== undefined && overrides.customer_id !== null) {
    if (job.kind !== "customer_summary")
      fail(`--customer applies to customer_summary jobs; "${job.name}" is a ${job.kind} job`);
    const id = String(overrides.customer_id).trim();
    if (!id) fail("--customer requires a customer id");
    next.scope = { customer_id: id };
  }
  const ids = overrides.system_ids || [];
  if (ids.length) {
    if (job.kind === "sme_brief") next.system_ids = as_system_ids(ids, "--system");
    else if (job.kind === "customer_summary")
      next.scope = { system_ids: as_system_ids(ids, "--system") };
    else fail(`--system does not apply to a ${job.kind} job (it covers the whole fleet)`);
  }
  return next;
};

// The output block a brief run's reports carry. summary-kind runs get
// their outputs forced off by the loader (summary_only), so only out_dir
// matters to them.
const brief_output = (job) => ({
  html: true,
  pdf: true,
  email: false,
  archive: job.archive,
  ...(job.out_dir ? { out_dir: job.out_dir } : {})
});

const batch_email_block = (job, { summary_pdf }) => ({
  recipients: job.recipients,
  cc_list: job.cc_list,
  // The email is the OPTIONAL half: with email false the batch block still
  // exists (it is what builds the summary document) but sends nothing.
  summary: job.email,
  summary_pdf,
  attachments: false,
  archive_records: job.archive_records
});

// Job (+ resolved fleet system ids, for the fleet kind) -> the raw request
// object `load_raw_request` validates. Every field here has the same
// meaning it has in a request file; nothing is a one-off-only concept.
const build_request = (job, { fleet_system_ids = null } = {}) => {
  const period = job.period.key;
  const exclusion = job.exclude
    ? { exclude: job.exclude, exclude_note: job.exclude_note || "excluded by report job config" }
    : {};

  if (job.kind === "customer_summary")
    return {
      scope: job.scope,
      summary_only: true,
      period,
      ...exclusion,
      report_defaults: { output: job.out_dir ? { out_dir: job.out_dir } : {} },
      batch_email: batch_email_block(job, { summary_pdf: true })
    };

  if (job.kind === "fleet_summary") {
    if (!Array.isArray(fleet_system_ids) || !fleet_system_ids.length)
      fail(`job "${job.name}": the fleet system list is empty — nothing to report on`);
    return {
      summary_only: true,
      period,
      ...exclusion,
      batch_email: batch_email_block(job, { summary_pdf: true }),
      reports: fleet_system_ids.map((id) => ({
        report_type: "magnet_health",
        system_id: id,
        ...(job.out_dir ? { output: { out_dir: job.out_dir } } : {})
      }))
    };
  }

  // sme_brief — the per-system Magnet Health Brief for one or more MRIs.
  // With email off (the one-off default) each report writes HTML + PDF and
  // sends nothing; with email on ONE email carries the briefs. The extra
  // condition-list email rides along only when a summary DOCUMENT was
  // asked for and needs delivering — "email me these briefs" should put
  // one message in the inbox, not two.
  return {
    period,
    ...(job.email
      ? {
          batch_email: {
            ...batch_email_block(job, { summary_pdf: job.summary_pdf }),
            summary: job.summary_pdf,
            attachments: true
          }
        }
      : {}),
    reports: job.system_ids.map((id) => ({
      report_type: "magnet_health",
      system_id: id,
      recipients: job.recipients,
      cc_list: job.cc_list,
      output: brief_output(job)
    }))
  };
};

// One line describing what is about to run, printed before the work
// starts: a one-off run that reports on the wrong period or the wrong
// customer should be obvious from the console, not from the PDF.
const describe_job = (job) => {
  const target =
    job.kind === "sme_brief"
      ? job.system_ids.join(", ")
      : job.kind === "fleet_summary"
        ? "the whole mag fleet"
        : Object.entries(job.scope)
            .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
            .join(" ");
  return (
    `job "${job.name}" — ${job.kind} · ${target} · ${job.period.label} period ` +
    `(${job.period.days} days) · ${job.email ? `email -> ${job.recipients.join(", ")}` : "no email"}`
  );
};

module.exports = {
  JOB_KINDS,
  PERIOD_KEYS,
  DEFAULT_SETTINGS,
  load_job_config,
  resolve_settings,
  apply_overrides,
  build_request,
  describe_job
};
