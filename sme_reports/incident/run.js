// One-off Anomaly Report for one system over a fixed window.
//
//   node sme_reports/incident/run.js --system SME21284 \
//     --from 2026-10-05T17:00Z --to 2026-10-12T17:00Z --tz America/Chicago
//
// Writes the Anomaly Report, internal and external HTML, to sme_reports/out/ (override with --out-dir). Read-only
// against the database; nothing is emailed.
require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const { load_incident_data } = require("./data");
const { analyze_incident } = require("./analyze");
const { build_timeline } = require("./timeline");
const content = require("./content");

const parse_args = (argv) => {
  const out = { tz: "America/New_York", out_dir: path.join(__dirname, "../out") };
  const keys = { "--system": "system_id", "--from": "from", "--to": "to", "--tz": "tz", "--out-dir": "out_dir" };
  for (let i = 0; i < argv.length; i += 2) {
    const k = keys[argv[i]];
    if (!k || argv[i + 1] === undefined) throw new Error(`unknown or incomplete flag: ${argv[i]}`);
    out[k] = argv[i + 1];
  }
  for (const k of ["system_id", "from", "to"]) if (!out[k]) throw new Error(`--${k === "system_id" ? "system" : k} is required`);
  out.from = new Date(out.from);
  out.to = new Date(out.to);
  if (isNaN(out.from) || isNaN(out.to) || out.from >= out.to) throw new Error("--from/--to must be valid times, from before to");
  if (!DateTime.local().setZone(out.tz).isValid) throw new Error(`unknown time zone ${out.tz}`);
  return out;
};

(async () => {
  const args = parse_args(process.argv.slice(2));
  const db = require("../../utils/db/pg-pool");
  try {
    const data = await load_incident_data(db, args);
    const analysis = analyze_incident(data, args);
    const analyzed_date = DateTime.fromJSDate(args.to, { zone: args.tz }).toFormat("yyyy-MM-dd");
    fs.mkdirSync(args.out_dir, { recursive: true });
    // The Anomaly Report, once per audience: internal (everything) and
    // external (customer-scoped, for the customer).
    for (const audience of ["internal", "external"]) {
      const label = audience === "internal" ? "Internal" : "External";
      const p = path.join(args.out_dir, `Avante-${args.system_id}-Anomaly-Report-${label}-${analyzed_date}.html`);
      fs.writeFileSync(p, build_timeline(data, analysis, { tz_site: args.tz, analyzed_date, content: content[args.system_id], audience }));
      console.log(p);
    }
  } finally {
    db.$pool.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
