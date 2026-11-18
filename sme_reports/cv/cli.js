#!/usr/bin/env node
// GE CV Insights — Internal (hhm_rpp_ge PLAN-CV-INSIGHTS.md §13): build the
// one-file viewer on demand.
//
//   npm run report:cv [-- --as-of YYYY-MM-DD] [--out DIR]
//
// Reads prod through ct/db.js (every session default_transaction_read_only
// =on; one read-only REPEATABLE READ snapshot), builds the model and writes
//   <out>/Avante-GE-CV-Insights-Internal-<as-of>.html
// (default out: sme_reports/out). --as-of defaults to the snapshot's UTC
// day, and only that day is accepted (ct/cli.js resolve_as_of; CT review
// PHASE6-PAGE F2): findings are current, so an earlier day would show later
// state under an earlier date.
// Not emailed and not scheduled (§13.2 item 1): share the file.

const fs = require("fs");
const path = require("path");
const { open, close } = require("../ct/db");
const { resolve_as_of } = require("../ct/cli");
const { load_cv } = require("./data");
const { build_model, valid_day } = require("./model");
const { build_cv_page } = require("./render");
const { assert_clean } = require("./privacy");

function args(argv) {
  const o = { as_of: null, out: path.join(__dirname, "..", "out") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === "--as-of") o.as_of = v();
    else if (a === "--out") o.out = path.resolve(v());
    else throw new Error(`unknown argument ${a} (usage: --as-of YYYY-MM-DD --out DIR)`);
  }
  if (o.as_of !== null && !valid_day(o.as_of)) throw new Error(`bad --as-of ${o.as_of} (a calendar day YYYY-MM-DD)`);
  return o;
}

async function main() {
  const o = args(process.argv.slice(2));
  const t0 = Date.now();
  const db = await open({ application_name: "cv_viewer" });
  let raw;
  try { raw = await load_cv(db); } finally { await close(); }
  const t1 = Date.now();
  assert_clean(raw, "the page"); // review CV6-DATA-MODEL F3
  const model = build_model(raw, { as_of: resolve_as_of(o.as_of, raw.snapshot_day) });
  const { html, name } = build_cv_page(model);
  fs.mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, name);
  fs.writeFileSync(file, html);
  const mb = Buffer.byteLength(html) / 1e6;
  console.log(`${file}
  as of ${model.as_of} (snapshot ${new Date(raw.snapshot_at).toISOString()}); ${model.reporting.length} reporting, ${model.not_reporting.length} not reporting, ${model.no_data.length} configured without data, ${model.inventory.length} not configured
  ${mb.toFixed(2)} MB; load ${((t1 - t0) / 1000).toFixed(1)} s, build ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  if (mb > 10) { console.error("over the 10 MB budget (§13.4)"); process.exitCode = 1; }
}

module.exports = { args };

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 2; close(); });
