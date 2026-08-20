// Strict argument parsing for the one-off report CLI, in the same shape
// (and for the same reason) as cli_args.js: every token must be
// recognized and every value must validate, and a parse error aborts
// before any run state exists. A typo'd flag on a hand-run command must
// never silently run the job with different settings than the operator
// typed — a 6-month sweep is expensive to run and easy to misread.
//
// Pure: dev/check_oneoff.js exercises every branch.

const SME_RE = /^SME\d+$/;

const fail = (msg) => {
  throw new Error(`report job arguments invalid: ${msg}`);
};

const USAGE = `usage: npm run report -- <job> [options]

  <job>                  a job name from the config file (--list shows them)

  --list                 list the jobs in the config and exit
  --config <path>        job config file (default: sme_reports/oneoff/jobs.config.json)
  --period <spec>        override the job period: 7d, 30d, 90d, 6mo, or a day count
  --customer <id>        override the job's customer scope (customer_summary, sme_brief)
  --system <SME#####>    override the job's system list (repeatable)
  --out-dir <path>       write documents here instead of sme_reports/out
  --email                send the job's email
  --no-email             build the documents, send nothing (the default)`;

const parse_oneoff_args = (args) => {
  const out = {
    job: null,
    config_path: null,
    period: null,
    customer_id: null,
    system_ids: [],
    out_dir: null,
    email: null, // null = leave the config's setting alone
    list: false
  };
  const value_of = (args, i, flag) => {
    const v = args[i];
    if (v === undefined || v.startsWith("--")) fail(`${flag} requires a value`);
    return v;
  };
  for (let i = 0; i < (args || []).length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      if (out.job) fail(`more than one job name given ("${out.job}" and "${a}")`);
      out.job = a;
      continue;
    }
    switch (a) {
      case "--list":
        out.list = true;
        break;
      case "--config":
        if (out.config_path) fail("--config given twice");
        out.config_path = value_of(args, ++i, "--config");
        break;
      case "--period":
        if (out.period) fail("--period given twice");
        out.period = value_of(args, ++i, "--period");
        break;
      case "--customer":
        if (out.customer_id) fail("--customer given twice");
        out.customer_id = value_of(args, ++i, "--customer");
        break;
      case "--system": {
        const v = value_of(args, ++i, "--system");
        // Repeatable, and comma lists are accepted because that is what
        // anyone pasting a list of ids will type.
        for (const id of v.split(",").map((s) => s.trim()).filter(Boolean)) {
          if (!SME_RE.test(id)) fail(`--system "${id}" is not a system id (SME#####)`);
          if (!out.system_ids.includes(id)) out.system_ids.push(id);
        }
        break;
      }
      case "--out-dir":
        if (out.out_dir) fail("--out-dir given twice");
        out.out_dir = value_of(args, ++i, "--out-dir");
        break;
      case "--email":
        if (out.email === false) fail("--email and --no-email are contradictory");
        out.email = true;
        break;
      case "--no-email":
        if (out.email === true) fail("--email and --no-email are contradictory");
        out.email = false;
        break;
      default:
        fail(`unknown argument "${a}"`);
    }
  }
  if (!out.list && !out.job) fail("no job name given — run with --list to see the configured jobs");
  return out;
};

// Flags -> the settings overlay applied on top of the chosen job. Kept
// separate from parsing so the overlay is testable on its own, and so
// every override still runs through the config module's validators.
const overrides_of = (args) => {
  const o = {};
  if (args.period !== null) o.period = args.period;
  if (args.out_dir !== null) o.out_dir = args.out_dir;
  if (args.email !== null) o.email = args.email;
  return o;
};

module.exports = { parse_oneoff_args, overrides_of, USAGE };
