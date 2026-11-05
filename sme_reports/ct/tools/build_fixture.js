// Builds the model test fixture from prod, read-only (ct/db.js).
//
//   node sme_reports/ct/tools/build_fixture.js --as-of 2026-11-05 [--days 240] [--systems A,B,...]
//
// Writes ct/test/fixtures/ct_fixture.json.gz (gzip, deterministic): the ct/data.js datasets for a
// few systems, cut to the last --days device days before --as-of (the same
// cut on every day-based dataset), with identity names replaced by
// placeholders (no customer or site names in the repo). Tube segments,
// findings and capabilities are kept whole: they are not day-based.
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { open, close } = require("../db");
const { load_ct } = require("../data");

// The verification set (PLAN-CT-INSIGHTS.md §16.3 Q6: SME21859 rotor,
// SME18531 restart loop, also the one system logging humidity; SME21867
// chronic aborts), a system not reporting (SME17371), the one system
// logging PSU (SME20608, clock flag "jumps") and a rotor SGB slope system
// (SME01430).
const DEFAULT_SYSTEMS = ["SME21859", "SME18531", "SME21867", "SME17371", "SME20608", "SME01430"];

function args(argv) {
  const a = { as_of: null, days: 240, systems: DEFAULT_SYSTEMS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--as-of") a.as_of = argv[++i];
    else if (argv[i] === "--days") a.days = parseInt(argv[++i], 10);
    else if (argv[i] === "--systems") a.systems = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.as_of || "")) throw new Error("--as-of YYYY-MM-DD is required");
  if (!(a.days > 0)) throw new Error("bad --days");
  return a;
}

(async () => {
  const a = args(process.argv.slice(2));
  const db = await open({ application_name: "ct_fixture" });
  try {
    const raw = await load_ct(db, { systems: a.systems });
    if (a.as_of < raw.snapshot_day) throw new Error(`--as-of ${a.as_of} is before the snapshot day ${raw.snapshot_day} (historical builds are not supported)`);
    const lo = new Date(Date.parse(`${a.as_of}T00:00:00Z`) - (a.days - 1) * 864e5).toISOString().slice(0, 10);
    const keep = (r) => r.day >= lo && r.day <= a.as_of;
    const fx = {
      note: `GE CT viewer fixture from prod (read-only), as of ${a.as_of}, device days ${lo}..${a.as_of}. Identity names are placeholders.`,
      as_of: a.as_of, from_day: lo, snapshot_day: raw.snapshot_day,
      summary: raw.summary, tube: raw.tube, findings: raw.findings, capabilities: raw.capabilities,
      days: raw.days.filter(keep), daily: raw.daily.filter(keep), exams: raw.exams.filter(keep), boots: raw.boots.filter(keep),
      identity: raw.identity.map((r, i) => ({ ...r, cus_sys_id: null, site_name: `Site ${i + 1}`, city: null, state: null,
        customer_id: null, customer_name: `Customer ${String.fromCharCode(65 + i)}` })),
      inventory: []
    };
    const missing = a.systems.filter((s) => !fx.summary.some((r) => r.system_id === s));
    if (missing.length) throw new Error(`not in api.ge_ct_system_summary_v: ${missing.join(", ")}`);
    const out = path.join(__dirname, "..", "test", "fixtures", "ct_fixture.json.gz");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // gzip output carries no timestamp or name, so the same data gives the same bytes
    fs.writeFileSync(out, zlib.gzipSync(`${JSON.stringify(fx)}\n`, { level: 9 }));
    const n = (k) => fx[k].length;
    console.log(`wrote ${path.relative(process.cwd(), out)}: ${(fs.statSync(out).size / 1e6).toFixed(2)} MB; systems ${n("summary")}, days ${n("days")}, daily ${n("daily")}, exams ${n("exams")}, boots ${n("boots")}, findings ${n("findings")}, tube ${n("tube")}, capabilities ${n("capabilities")}`);
  } finally {
    close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
