#!/usr/bin/env node
// GE CT Insights — Internal (hhm_rpp_ge PLAN-CT-INSIGHTS.md §16): build the
// one-file viewer on demand.
//
//   npm run report:ct [-- --as-of YYYY-MM-DD] [--out DIR]
//
// Reads prod through ct/db.js (every session default_transaction_read_only
// =on; one read-only REPEATABLE READ snapshot), builds the model and writes
//   <out>/Avante-GE-CT-Insights-Internal-<as-of>.html
// (default out: sme_reports/out). --as-of defaults to the snapshot's UTC
// day, and only that day is accepted (review PHASE6-PAGE F2): findings and
// tube state are current, so an earlier day would show later state under an
// earlier date, and a later day would count systems that report today as
// not reporting.
// Not emailed and not scheduled in Phase 6 (§16.3 Q3): share the file.

const fs = require("fs");
const path = require("path");
const { open, close } = require("./db");
const { load_ct } = require("./data");
const { build_model, valid_day } = require("./model");
const { build_ct_page } = require("./render");

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

// The as-of day of a build: the snapshot's UTC day; --as-of may only repeat it.
function resolve_as_of(arg, snapshot_day) {
  if (arg === null || arg === undefined) return snapshot_day;
  if (!valid_day(arg)) throw new Error(`bad --as-of ${arg} (a calendar day YYYY-MM-DD)`);
  if (arg < snapshot_day) throw new Error(`--as-of ${arg} is before the snapshot day ${snapshot_day}: findings and tube state are current, so the page would show later state under an earlier date`);
  if (arg > snapshot_day) throw new Error(`--as-of ${arg} is after the snapshot day ${snapshot_day}: systems that report today would be counted as not reporting`);
  return arg;
}

async function main() {
  const o = args(process.argv.slice(2));
  const t0 = Date.now();
  const db = await open({ application_name: "ct_viewer" });
  let raw;
  try { raw = await load_ct(db); } finally { await close(); }
  const t1 = Date.now();
  const model = build_model(raw, { as_of: resolve_as_of(o.as_of, raw.snapshot_day) });
  const { html, name } = build_ct_page(model);
  fs.mkdirSync(o.out, { recursive: true });
  const file = path.join(o.out, name);
  fs.writeFileSync(file, html);
  const mb = Buffer.byteLength(html) / 1e6;
  console.log(`${file}
  as of ${model.as_of} (snapshot ${new Date(raw.snapshot_at).toISOString()}); ${model.reporting.length} reporting, ${model.not_reporting.length} not reporting, ${model.inventory.length} without log data
  ${mb.toFixed(2)} MB; load ${((t1 - t0) / 1000).toFixed(1)} s, build ${((Date.now() - t1) / 1000).toFixed(1)} s`);
  if (mb > 10) { console.error("over the 10 MB budget (§16.4)"); process.exitCode = 1; }
}

module.exports = { resolve_as_of };

if (require.main === module) main().catch((e) => { console.error(e.stack || e.message); process.exitCode = 2; close(); });
