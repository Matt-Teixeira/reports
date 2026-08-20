const assert = require("assert");

// The period vocabulary (periods.js) and the one-off job layer
// (oneoff/), exercised without a database: everything under test is pure,
// and the requests these jobs compose are pushed through the REAL request
// loader so a job that would fail at run time fails here instead.
//
// Run: node sme_reports/dev/check_oneoff.js   (npm run check:oneoff)

const {
  resolve_period,
  period_of_days,
  period_tag,
  period_label,
  DEFAULT_DAYS
} = require("../periods");
const { load_job_config, apply_overrides, build_request, describe_job } = require("../oneoff/config");
const { parse_oneoff_args, overrides_of } = require("../oneoff/args");
const { load_raw_request, materialize_scoped_requests } = require("../request_loader");

const throws = (fn, re, what) => assert.throws(fn, re, what);

// --- periods: the shared vocabulary -----------------------------------------
{
  // The 6-month period is the point of the module: one span, one name,
  // whichever spelling a config used.
  for (const spec of ["6mo", "180d", 180, "180", "6-month", "SEMIANNUAL"]) {
    const p = resolve_period(spec);
    assert.strictEqual(p.days, 180, `${JSON.stringify(spec)} -> 180 days`);
    assert.strictEqual(p.key, "6mo");
    assert.strictEqual(p.label, "6-month");
    assert.strictEqual(p.tag, "-6mo");
  }
  assert.strictEqual(resolve_period("7d").days, 7);
  assert.strictEqual(resolve_period("weekly").days, 7);
  assert.strictEqual(resolve_period("30d").days, DEFAULT_DAYS);
  assert.strictEqual(resolve_period("quarter").days, 90);
  // An unnamed span stays expressible and keeps the historical forms.
  assert.deepStrictEqual(resolve_period("14d"), {
    key: "14d",
    days: 14,
    label: "14-day",
    tag: "-14d"
  });

  // A typo must never fall back to the default and quietly report the
  // wrong span — the whole reason this resolution is centralized.
  for (const bad of ["6m", "sixmonths", "", "0", 0, -3, 1.5, null, {}, "6mo!"])
    throws(() => resolve_period(bad), /invalid/, `rejects ${JSON.stringify(bad)}`);

  // Compatibility: the pre-existing tag/label expressions, byte for byte.
  assert.strictEqual(period_tag(30), "");
  assert.strictEqual(period_tag(null), "");
  assert.strictEqual(period_tag(undefined), "");
  assert.strictEqual(period_tag(7), "-7d");
  assert.strictEqual(period_tag(14), "-14d");
  assert.strictEqual(period_tag(180), "-6mo");
  assert.strictEqual(period_label(30), null);
  assert.strictEqual(period_label(null), null);
  assert.strictEqual(period_label(7), "7-day");
  assert.strictEqual(period_label(14), "14-day");
  assert.strictEqual(period_label(180), "6-month");
  assert.strictEqual(period_of_days(180).key, "6mo");
}

// --- the request loader speaks "period" -------------------------------------
{
  const base = {
    report_type: "magnet_health",
    system_id: "SME01096",
    recipients: ["dev@example.com"],
    output: { html: false, pdf: false, email: false }
  };
  const six = load_raw_request({ ...base, window: { period: "6mo" } });
  assert.strictEqual(six.requests[0].window.lookback_days, 180);
  const span_days =
    six.requests[0].window.end.diff(six.requests[0].window.start, "days").days;
  assert.ok(span_days >= 180 && span_days < 181.1, `6mo spans ~180 days, got ${span_days.toFixed(2)}`);

  // Batch-level period, and a per-report window that still outranks it.
  const batch = load_raw_request({
    period: "6mo",
    reports: [base, { ...base, system_id: "SME01098", window: { period: "7d" } }]
  });
  assert.strictEqual(batch.requests[0].window.lookback_days, 180);
  assert.strictEqual(batch.requests[1].window.lookback_days, 7);
  assert.strictEqual(batch.lookback_days, null, "mixed periods yield no batch period");

  // Explicit dates keep winning over an inherited batch period, and carry
  // no period of their own.
  const dated = load_raw_request({
    period: "6mo",
    reports: [{ ...base, window: { start: "2026-07-01", end: "2026-07-31" } }]
  });
  assert.strictEqual(dated.requests[0].window.lookback_days, null);

  // The historical spelling is untouched, including "window": null.
  assert.strictEqual(load_raw_request({ ...base, window: { lookback_days: 7 } }).requests[0].window.lookback_days, 7);
  assert.strictEqual(load_raw_request({ ...base, window: null }).requests[0].window.lookback_days, 30);
  assert.strictEqual(load_raw_request({ lookback_days: 7, reports: [base] }).lookback_days, 7);

  // One setting, one spelling: naming both is a request error, never a
  // silent precedence rule between two numbers that may disagree.
  throws(
    () => load_raw_request({ ...base, window: { period: "6mo", lookback_days: 7 } }),
    /same setting/,
    "window.period beside window.lookback_days"
  );
  throws(
    () => load_raw_request({ period: "6mo", lookback_days: 7, reports: [base] }),
    /same setting/,
    "batch period beside batch lookback_days"
  );
  throws(() => load_raw_request({ ...base, window: { period: "6m" } }), /window.period invalid/);
  throws(() => load_raw_request({ period: "nonsense", reports: [base] }), /period invalid/);
  // Zero still fails loudly rather than becoming the default (round-1 F7).
  throws(() => load_raw_request({ ...base, window: { lookback_days: 0 } }), /positive integer/);
  throws(() => load_raw_request([]), /must be an object/);
}

// --- job config validation ---------------------------------------------------
const CONFIG = {
  _readme: "comment keys are ignored",
  defaults: { period: "30d", recipients: ["ops@example.com"], email: false },
  jobs: {
    customer: { kind: "customer_summary", customer_id: "C0137", period: "6mo" },
    sme: { kind: "sme_brief", system_ids: ["SME21824"], period: "6mo" },
    fleet: {
      kind: "fleet_summary",
      period: "6mo",
      exclude: ["SME13604"],
      exclude_note: "RF/SC service stations, not fleet"
    }
  }
};

{
  const { jobs, defaults } = load_job_config(CONFIG);
  assert.deepStrictEqual([...jobs.keys()], ["customer", "sme", "fleet"]);
  assert.strictEqual(defaults.period.days, 30, "file defaults resolve");
  const customer = jobs.get("customer");
  assert.strictEqual(customer.period.days, 180, "job period outranks the file default");
  assert.deepStrictEqual(customer.recipients, ["ops@example.com"], "inherits default recipients");
  assert.strictEqual(customer.email, false);
  assert.deepStrictEqual(customer.scope, { customer_id: "C0137" });
  assert.ok(describe_job(customer).includes("6-month"), "the run description states the period");

  // Unknown keys are rejected, never ignored: a misspelled setting that
  // silently kept the default is the failure a hand-edited file invites.
  throws(
    () => load_job_config({ ...CONFIG, jobs: { x: { kind: "sme_brief", system_ids: ["SME01"], recipeints: [] } } }),
    /unknown setting "recipeints"/
  );
  throws(() => load_job_config({ ...CONFIG, defaults: { nope: 1 } }), /unknown setting "nope"/);
  throws(() => load_job_config({ jobs: {} }), /defines no jobs/);
  throws(() => load_job_config({ jobs: { x: { kind: "nope" } } }), /kind must be one of/);
  throws(
    () => load_job_config({ jobs: { x: { kind: "sme_brief", system_ids: ["nope"] } } }),
    /is not a system id/
  );
  // A summary job needs an address even when nothing is emailed (it is the
  // loader's fallback per-report recipient) — named at the config, not deep
  // in request validation.
  throws(
    () => load_job_config({ jobs: { x: { kind: "fleet_summary" } } }),
    /recipients is empty/
  );
  throws(
    () =>
      load_job_config({
        ...CONFIG,
        jobs: { x: { kind: "customer_summary", customer_id: "C1", site_ids: ["S1"] } }
      }),
    /exactly one of customer_id, site_ids, system_ids/
  );
  throws(
    () => load_job_config({ ...CONFIG, jobs: { x: { kind: "customer_summary" } } }),
    /exactly one of/
  );
  throws(
    () => load_job_config({ ...CONFIG, jobs: { x: { kind: "sme_brief", system_ids: ["SME1"], email: "yes" } } }),
    /must be true or false/
  );
}

// --- jobs compose requests the real loader accepts ---------------------------
{
  const { jobs } = load_job_config(CONFIG);

  // customer_summary: a scoped, summary-only request. The loader defers
  // resolution (a DB round trip), so finish it the way index.js does.
  const raw_customer = build_request(jobs.get("customer"));
  const scoped = load_raw_request(raw_customer);
  assert.strictEqual(scoped.scoped, true);
  assert.deepStrictEqual(scoped.scope, { kind: "customer_id", value: "C0137" });
  const materialized = materialize_scoped_requests(scoped.raw, ["SME01096", "SME01098"]);
  assert.strictEqual(materialized.lookback_days, 180, "the 6-month period reaches the batch");
  assert.strictEqual(materialized.summary_only, true);
  assert.strictEqual(materialized.batch_email.summary_pdf, true, "the document is always built");
  assert.strictEqual(materialized.batch_email.summary, false, "email off sends nothing");
  assert.strictEqual(materialized.batch_email.archive_records, false, "one-off runs do not write history");
  for (const r of materialized.requests) {
    assert.strictEqual(r.window.lookback_days, 180);
    assert.strictEqual(r.output.pdf, false, "summary-only writes no per-system PDF");
  }
  assert.strictEqual(period_tag(materialized.lookback_days), "-6mo", "artifacts tag the period");

  // sme_brief: per-system briefs, no email, nothing sent.
  const briefs = load_raw_request(build_request(jobs.get("sme")));
  assert.strictEqual(briefs.requests.length, 1);
  assert.strictEqual(briefs.requests[0].system_id, "SME21824");
  assert.strictEqual(briefs.requests[0].window.lookback_days, 180);
  assert.strictEqual(briefs.requests[0].output.pdf, true);
  assert.strictEqual(briefs.requests[0].output.email, false, "one-off briefs never email by default");
  assert.strictEqual(briefs.batch_email, null);
  assert.strictEqual(briefs.lookback_days, 180);

  // fleet_summary: the system list comes from the caller (the DB in the
  // CLI), exclusions apply, and an empty fleet is an error, not an empty
  // document.
  const fleet_raw = build_request(jobs.get("fleet"), {
    fleet_system_ids: ["SME01096", "SME13604", "SME01098"]
  });
  const fleet = load_raw_request(fleet_raw);
  assert.strictEqual(fleet.requests.length, 2, "the excluded station is dropped");
  assert.deepStrictEqual(fleet.excluded.ids, ["SME13604"]);
  assert.strictEqual(fleet.excluded.note, "RF/SC service stations, not fleet");
  assert.strictEqual(fleet.lookback_days, 180);
  throws(() => build_request(jobs.get("fleet"), { fleet_system_ids: [] }), /fleet system list is empty/);

  // Emailing a brief batch: ONE email carrying the PDFs. The separate
  // condition-list email is suppressed — "email me these briefs" should
  // put one message in the inbox, not two.
  const emailed = load_raw_request(
    build_request(apply_overrides(jobs.get("sme"), { email: true }))
  );
  assert.strictEqual(emailed.batch_email.attachments, true);
  assert.strictEqual(emailed.batch_email.summary, false, "no second email for a plain brief batch");
  assert.strictEqual(emailed.batch_email.summary_pdf, false);
  assert.deepStrictEqual(emailed.batch_email.recipients, ["ops@example.com"]);

  // Asking for a summary document with the briefs brings the second email
  // back — it is what delivers that document.
  const with_summary = load_raw_request(
    build_request(apply_overrides(jobs.get("sme"), { email: true, summary_pdf: true }))
  );
  assert.strictEqual(with_summary.batch_email.summary_pdf, true);
  assert.strictEqual(with_summary.batch_email.summary, true);
  assert.strictEqual(with_summary.batch_email.attachments, true);
}

// --- CLI arguments and overrides ---------------------------------------------
{
  const a = parse_oneoff_args(["customer", "--period", "6mo", "--customer", "C0151", "--email"]);
  assert.strictEqual(a.job, "customer");
  assert.strictEqual(a.period, "6mo");
  assert.strictEqual(a.customer_id, "C0151");
  assert.strictEqual(a.email, true);
  assert.deepStrictEqual(overrides_of(a), { period: "6mo", email: true });

  const b = parse_oneoff_args(["sme", "--system", "SME19034,SME21824", "--system", "SME19034"]);
  assert.deepStrictEqual(b.system_ids, ["SME19034", "SME21824"], "comma lists split, duplicates collapse");
  assert.strictEqual(b.email, null, "no flag leaves the config's setting alone");
  assert.strictEqual(parse_oneoff_args(["--list"]).list, true);

  throws(() => parse_oneoff_args([]), /no job name given/);
  throws(() => parse_oneoff_args(["a", "b"]), /more than one job name/);
  throws(() => parse_oneoff_args(["sme", "--nope"]), /unknown argument/);
  throws(() => parse_oneoff_args(["sme", "--period"]), /--period requires a value/);
  throws(() => parse_oneoff_args(["sme", "--period", "--email"]), /--period requires a value/);
  throws(() => parse_oneoff_args(["sme", "--email", "--no-email"]), /contradictory/);
  throws(() => parse_oneoff_args(["sme", "--system", "19034"]), /is not a system id/);

  // Overrides run through the same validators as the file, and a flag that
  // does not apply to the job's kind is an error rather than ignored.
  const { jobs } = load_job_config(CONFIG);
  const overridden = apply_overrides(jobs.get("customer"), { period: "7d", customer_id: " C0151 " });
  assert.strictEqual(overridden.period.days, 7);
  assert.deepStrictEqual(overridden.scope, { customer_id: "C0151" });
  assert.strictEqual(jobs.get("customer").period.days, 180, "the loaded job is not mutated");
  assert.deepStrictEqual(
    apply_overrides(jobs.get("customer"), { system_ids: ["SME01096"] }).scope,
    { system_ids: ["SME01096"] },
    "--system narrows a customer job to an explicit set"
  );
  throws(() => apply_overrides(jobs.get("sme"), { customer_id: "C1" }), /--customer applies to customer_summary/);
  throws(() => apply_overrides(jobs.get("fleet"), { system_ids: ["SME01096"] }), /--system does not apply/);
  throws(() => apply_overrides(jobs.get("sme"), { period: "6m" }), /invalid/);
}

// --- the shipped config file itself loads ------------------------------------
{
  const shipped = require("../oneoff/jobs.config.json");
  const { jobs } = load_job_config(shipped);
  assert.ok(jobs.size, "jobs.config.json defines jobs");
  for (const [name, job] of jobs) {
    const raw = build_request(
      job,
      job.kind === "fleet_summary" ? { fleet_system_ids: ["SME01096"] } : {}
    );
    const loaded = load_raw_request(raw);
    assert.ok(loaded, `shipped job "${name}" composes a valid request`);
    if (loaded.scoped)
      assert.ok(materialize_scoped_requests(loaded.raw, ["SME01096"]).requests.length);
  }
}

console.log("check_oneoff: OK");
