// Output-parity harness (dev-only): renders a request batch with a PINNED
// explicit-date window and no delivery, writing byte-diffable witnesses into
// <out-dir>:
//   - every per-system brief HTML (byte-exact; skipped in summary-only mode)
//   - the fleet summary HTML (when the request builds one)
//   - records.json: the ordered distilled summary records + failures
//
// Usage:
//   node sme_reports/dev/parity.js <request-file> <out-dir> \
//        [--end YYYY-MM-DD] [--lookback N] [--facts]
//
// --facts additionally writes facts-<id>.json per system — the direct
// analysis witness, captured from the PRODUCTION pass via run_one's
// dev-only observer (never a second fetch), finer-grained than
// records.json.
//
// Baseline-vs-candidate workflow. A bare worktree is NOT runnable: .env,
// node_modules/, and utils/ (the whole DB/logger layer) are gitignored, so
// they must be provisioned from the main checkout; and .env's PG_SSL_PATH
// is cwd-relative, so run BOTH sides from the main repo root:
//   git worktree add /tmp/parity-base <baseline-sha>
//   cp .env /tmp/parity-base/.env
//   ln -s "$PWD/node_modules" "$PWD/utils" /tmp/parity-base/
//   node /tmp/parity-base/sme_reports/dev/parity.js requests/batch-test-6.json /tmp/parity/base
//   node sme_reports/dev/parity.js requests/batch-test-6.json /tmp/parity/cand
//   diff -r --exclude='*.pdf' /tmp/parity/base /tmp/parity/cand
// Each side's <out-dir> must be new or empty — reusing a directory could
// let a stale witness from an earlier run masquerade as this run's output.
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

const usage = () => {
  console.error(
    "usage: node sme_reports/dev/parity.js <request-file> <out-dir> [--end YYYY-MM-DD] [--lookback N]"
  );
  process.exit(1);
};

const parse_args = (argv) => {
  const args = { request_path: null, out_dir: null, end: null, lookback: 30, facts: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--end") args.end = argv[++i];
    else if (a === "--lookback") args.lookback = parseInt(argv[++i], 10);
    else if (a === "--facts") args.facts = true;
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
  // Fresh directory only: a reused directory could carry a stale witness
  // (e.g. a prior run's fleet HTML surviving a soft render failure this
  // run) and diff clean against a baseline it was never produced from.
  if (fs.existsSync(out_dir) && fs.readdirSync(out_dir).length)
    throw new Error(`out-dir ${out_dir} is not empty — parity witnesses must land in a fresh directory`);
  fs.mkdirSync(out_dir, { recursive: true });

  const raw = JSON.parse(fs.readFileSync(path.resolve(args.request_path), "utf8"));
  const transformed_path = path.join(out_dir, "request.parity.json");
  fs.writeFileSync(transformed_path, JSON.stringify(transform(raw, pin), null, 2));

  // Local run_log: makeAppRunLog() opens a persistent write stream under
  // utils/logger/ as a side effect; a parity probe must not leave files
  // behind. addLogEvent only pushes onto log_events, so this shape is the
  // whole contract.
  const run_log = { run_id: uuidv4(), log_events: [] };
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

    // --facts: collect the EXACT facts objects the production pass computes
    // (run_one's dev-only observer) — a second fetch against the same
    // pinned window is not a database snapshot, and a re-derived witness
    // could disagree with the artifacts of its own run.
    const facts_by_id = args.facts ? new Map() : null;
    const { results, failures, fleet_pdf_path } = await run_batch(
      run_log,
      job_id,
      loaded,
      scope_resolution,
      facts_by_id ? { on_facts: (id, facts) => facts_by_id.set(id, facts) } : {}
    );

    // Witness manifest: every artifact this run OWES must exist before the
    // directory can be diffed — a soft fleet-render failure (run_batch
    // tolerates it for normal batches) must fail parity loudly, never
    // present an absent witness as "no change".
    const missing = [];
    if (!loaded.summary_only)
      for (const r of results)
        if (!r.html_path || !fs.existsSync(r.html_path))
          missing.push(`brief HTML for ${r.system_id}`);
    const owes_fleet =
      loaded.batch_email &&
      loaded.batch_email.summary_pdf &&
      (results.length ||
        failures.length ||
        (loaded.excluded && loaded.excluded.ids.length > 0));
    if (owes_fleet) {
      if (!fleet_pdf_path) missing.push("fleet summary (render failed soft — see run output)");
      else if (!fs.existsSync(fleet_pdf_path.replace(/\.pdf$/, ".html")))
        missing.push("fleet summary HTML beside the PDF");
    }
    if (missing.length)
      throw new Error(`parity witnesses missing: ${missing.join("; ")}`);

    // --facts: one facts-<id>.json per successful system — the direct
    // analysis witness, strictly finer-grained than records.json (which is
    // facts distilled through build_summary_facts): a fact that reaches
    // neither a record field nor the brief HTML still diffs here. Every
    // successful result must have produced facts through the observer; a
    // gap means the observer channel broke, and that fails parity loudly.
    if (facts_by_id) {
      for (const r of results) {
        // Limited-coverage systems produce a record but no analysis facts
        // (identity + EDU only) — their witness is records.json alone.
        if (r.summary && r.summary.assessment_status === "limited_coverage")
          continue;
        const facts = facts_by_id.get(r.system_id);
        if (!facts)
          throw new Error(`parity --facts: no facts observed for ${r.system_id}`);
        fs.writeFileSync(
          path.join(out_dir, `facts-${r.system_id}.json`),
          JSON.stringify(facts, null, 1)
        );
      }
      console.log(`facts witnesses written for ${results.length} systems`);
    }

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
