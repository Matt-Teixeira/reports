("use strict");
require("dotenv").config();

const fs = require("fs");
const path = require("path");

const { parse_oneoff_args, overrides_of, USAGE } = require("./args");
const { load_job_config, apply_overrides, build_request, describe_job } = require("./config");

// One-off report runner: `npm run report -- <job> [flags]`.
//
// Reads one job out of a config file the operator edits (jobs.config.json
// by default), composes the request that job describes, and runs it
// through the shared pipeline — the same loader, the same batch runner,
// the same renderers and senders the scheduled product uses. This file
// owns nothing but argument handling, the console, and the exit code.
//
// Nothing scheduled calls it. `npm start sme_report` (file mode and the
// cron slot batch) is untouched by this directory's existence.

const DEFAULT_CONFIG = path.join(__dirname, "jobs.config.json");

const read_config = (config_path) => {
  const full = path.resolve(config_path || DEFAULT_CONFIG);
  if (!fs.existsSync(full)) throw new Error(`report job config not found: ${full}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (error) {
    throw new Error(`report job config is not valid JSON (${full}): ${error.message}`);
  }
  return { full, config: load_job_config(parsed) };
};

// The fleet job's system list is the whole mag fleet, read the same way
// the scheduled fleet_summary reads it — one source for "the fleet", so a
// hand-run document and a scheduled one cover the same systems.
const fleet_ids = async () => {
  const { load_audience_pool } = require("../config_loader");
  const { mag_ids } = await load_audience_pool();
  return mag_ids;
};

const print_outcome = (job, batch) => {
  const lines = [];
  if (batch.fleet_pdf_path) lines.push(`summary document: ${batch.fleet_pdf_path}`);
  for (const r of batch.results) {
    const artifacts = [r.pdf_path, r.html_path].filter(Boolean);
    if (artifacts.length) lines.push(`${r.system_id}: ${artifacts.join("  ")}`);
  }
  for (const f of batch.failures) lines.push(`FAILED ${f.system_id}: ${f.message}`);
  const counts =
    `${batch.results.length} system${batch.results.length === 1 ? "" : "s"} analyzed` +
    (batch.failures.length ? `, ${batch.failures.length} failed` : "") +
    ` · ${job.period.label} period` +
    (job.email ? "" : " · nothing emailed");
  console.log(`\n${counts}`);
  for (const l of lines) console.log(`  ${l}`);
};

const main = async () => {
  const args = parse_oneoff_args(process.argv.slice(2));
  const { full, config } = read_config(args.config_path);

  if (args.list || !args.job) {
    console.log(`jobs in ${full}:\n`);
    for (const [name, job] of config.jobs)
      console.log(`  ${name.padEnd(16)} ${job.kind.padEnd(17)} ${job.description || ""}`);
    console.log(`\n${USAGE}`);
    return;
  }

  const base = config.jobs.get(args.job);
  if (!base)
    throw new Error(
      `no job named "${args.job}" in ${full} — configured jobs: ${[...config.jobs.keys()].join(", ")}`
    );
  const job = apply_overrides(base, { ...overrides_of(args), customer_id: args.customer_id, system_ids: args.system_ids });

  // State what is about to run BEFORE running it: a 6-month fleet sweep is
  // long enough that discovering the wrong period afterwards is expensive.
  console.log(describe_job(job));

  const raw = build_request(
    job,
    job.kind === "fleet_summary" ? { fleet_system_ids: await fleet_ids() } : {}
  );

  const [, writeLogEvents, , makeAppRunLog] = require("../../utils/logger/log");
  const { run_request_object } = require("../index");
  const run_log = await makeAppRunLog();
  try {
    const batch = await run_request_object(run_log, raw);
    print_outcome(job, batch);
    // A per-system failure inside a batch is isolated by design, but a
    // hand-run job that produced nothing at all should not exit 0 — the
    // operator is reading the exit code, not just the console.
    if (!batch.results.length && batch.failures.length)
      throw new Error("every system in this job failed; no document was produced");
  } finally {
    await writeLogEvents(run_log);
  }
};

main()
  .then(() => {
    // The pg pool holds the event loop open; the run is over here.
    process.exit(process.exitCode || 0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
