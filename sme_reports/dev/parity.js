// Output-parity harness (dev-only): renders a request batch with a PINNED
// explicit-date window and no delivery, writing byte-diffable witnesses into
// <out-dir>:
//   - every per-system brief HTML (byte-exact; skipped in summary-only mode)
//   - the fleet summary HTML (when the request builds one)
//   - records.json: the ordered distilled summary records + failures
//
// Usage:
//   node sme_reports/dev/parity.js <request-file> <out-dir> \
//        [--end YYYY-MM-DD] [--lookback N]
//
// Baseline-vs-candidate workflow:
//   git worktree add /tmp/parity-base <baseline-sha>
//   node /tmp/parity-base/sme_reports/dev/parity.js requests/batch-test-6.json /tmp/parity/base
//   node sme_reports/dev/parity.js requests/batch-test-6.json /tmp/parity/cand
//   diff -r --exclude='*.pdf' /tmp/parity/base /tmp/parity/cand
//
// Determinism contract: the analysis window is pinned (default: 30 days
// ending yesterday UTC; the pinned dates are PRINTED — pass them via --end /
// --lookback so baseline and candidate share them verbatim). Run the two
// sides back-to-back ON THE SAME CALENDAR DAY: artifact names carry the run
// date, and late-arriving telemetry or alert.models edits between runs are
// the residual drift this harness cannot pin. The fleet PDF is still
// rendered (build_fleet_summary always does) but is NOT a witness —
// render timestamps make PDF bytes noisy; HTML is the byte-exact witness.
//
// No production module is modified: the request JSON is transformed (window
// pinned into every entry, delivery and archival forced off), written beside
// the witnesses as request.parity.json, and loaded through the normal
// loader, so request validation behaves exactly as a real run.

const fs = require("fs");
const path = require("path");
// Unlike the check suites (fixture-only, no DB), this harness runs live
// batches — load the root .env regardless of cwd before any db require.
require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });
const { DateTime } = require("luxon");
const { v4: uuidv4 } = require("uuid");

const { run_batch } = require("../index");
const { load_requests, materialize_scoped_requests } = require("../request_loader");
const { close_pdf_renderer } = require("../output/render_pdf");
const [, , , makeAppRunLog] = require("../../utils/logger/log");

const usage = () => {
  console.error(
    "usage: node sme_reports/dev/parity.js <request-file> <out-dir> [--end YYYY-MM-DD] [--lookback N]"
  );
  process.exit(1);
};

const parse_args = (argv) => {
  const args = { request_path: null, out_dir: null, end: null, lookback: 30 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--end") args.end = argv[++i];
    else if (a === "--lookback") args.lookback = parseInt(argv[++i], 10);
    else if (a.startsWith("--")) usage();
    else positional.push(a);
  }
  if (positional.length !== 2) usage();
  [args.request_path, args.out_dir] = positional;
  if (!Number.isInteger(args.lookback) || args.lookback <= 0) usage();
  if (args.end && !DateTime.fromISO(args.end, { zone: "utc" }).isValid) usage();
  return args;
};

// Pin one explicit-date window into every report entry of the raw request
// JSON, and force every delivery/archival path off. Explicit dates make
// window_of derive lookback_days: null, so period tags stay empty and
// artifact names are date-stable.
const transform = (raw, pin) => {
  const out = JSON.parse(JSON.stringify(raw));
  if (out.scope !== undefined) {
    out.report_defaults = { ...(out.report_defaults || {}), window: pin };
  } else if (Array.isArray(out.reports)) {
    out.reports = out.reports.map((r) => ({ ...r, window: pin }));
  } else {
    out.window = pin;
  }
  if (out.batch_email) {
    out.batch_email = {
      ...out.batch_email,
      // summary_pdf is kept as authored — the fleet document is a witness.
      summary: false, // no summary email
      attachments: false, // no per-system PDF email
      zip: false,
      archive_records: false // no sidecar writes into sme_reports/archive
    };
  }
  return out;
};

const main = async () => {
  const args = parse_args(process.argv.slice(2));

  const end = args.end || DateTime.utc().minus({ days: 1 }).toISODate();
  const start = DateTime.fromISO(end, { zone: "utc" })
    .minus({ days: args.lookback })
    .toISODate();
  const pin = { start, end };
  console.log(
    `parity window pinned: ${start} .. ${end} — pass "--end ${end} --lookback ${args.lookback}" on the other side`
  );

  const out_dir = path.resolve(args.out_dir);
  fs.mkdirSync(out_dir, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(path.resolve(args.request_path), "utf8"));
  const transformed_path = path.join(out_dir, "request.parity.json");
  fs.writeFileSync(transformed_path, JSON.stringify(transform(raw, pin), null, 2));

  const run_log = await makeAppRunLog();
  const job_id = uuidv4();
  try {
    let loaded = load_requests(transformed_path);
    let scope_resolution = null;
    if (loaded.scoped) {
      const { resolve_scope } = require("../scope");
      scope_resolution = await resolve_scope(loaded.scope);
      console.log(
        `scope: ${scope_resolution.label} — ${scope_resolution.detail.systems} systems`
      );
      loaded = materialize_scoped_requests(loaded.raw, scope_resolution.system_ids);
    }

    // Witness outputs: brief HTML on (except summary-only, whose shape is
    // "no briefs" by definition), PDF/email/archive off, everything into
    // out_dir. This runs AFTER the loader so its forced flags (pdf:true for
    // batch members) don't reintroduce rendering the harness doesn't diff.
    for (const r of loaded.requests) {
      r.output = {
        html: !loaded.summary_only,
        pdf: false,
        email: false,
        archive: false,
        out_dir
      };
    }
    loaded = { ...loaded, out_dir };

    const { results, failures } = await run_batch(
      run_log,
      job_id,
      loaded,
      scope_resolution
    );

    // records.json: the distilled per-system records in request order, plus
    // failures — the sidecar shape minus generated_at and any filesystem
    // paths (paths differ between the two sides by construction).
    const witness = {
      window: pin,
      records: results.map((r) => ({ system_id: r.system_id, summary: r.summary })),
      failures
    };
    fs.writeFileSync(
      path.join(out_dir, "records.json"),
      JSON.stringify(witness, null, 1)
    );
    console.log(
      `parity witnesses written to ${out_dir}: ${results.length} records, ${failures.length} failures`
    );
  } finally {
    await close_pdf_renderer();
  }
};

main().catch((error) => {
  console.error(`parity run failed: ${error.message}`);
  process.exitCode = 1;
});
