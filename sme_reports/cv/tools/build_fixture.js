// Builds the model test fixture from prod, read-only (ct/db.js sessions are
// default_transaction_read_only=on; cv/data.js reads in one read-only
// REPEATABLE READ transaction).
//
//   node sme_reports/cv/tools/build_fixture.js [--as-of YYYY-MM-DD]
//
// Writes cv/test/fixtures/cv_fixture.json.gz (gzip, deterministic): every
// cv/data.js dataset, all of CV (2 reporting systems on 2026-11-18, all
// history), so the configured-without-data group and the inventory footer
// are covered too. --as-of defaults to the snapshot's UTC day.
//
// Privacy (hhm_rpp_ge PLAN-CV-INSIGHTS.md §13.5 step 2): the fixture holds
// codes, counts, dims, days, the masked code labels of api.ge_cv_codes_v
// (all reviewed) and source-file base names. Site, customer, city, state
// and cus_sys_id are replaced by placeholders; system ids and models stay.
// The tool refuses to write when cv/privacy.js finds a label or source file
// that looks like an address, a path, a host or a system id, or finding
// evidence outside the reviewed vocabulary (review CV6-DATA-MODEL F3).
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const { open, close } = require("../../ct/db");
const { load_cv } = require("../data");
const { assert_clean } = require("../privacy");

function args(argv) {
  const a = { as_of: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--as-of") a.as_of = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (a.as_of !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.as_of)) throw new Error("bad --as-of");
  return a;
}

(async () => {
  const a = args(process.argv.slice(2));
  const db = await open({ application_name: "cv_fixture" });
  try {
    const raw = await load_cv(db);
    const as_of = a.as_of || raw.snapshot_day;
    if (as_of < raw.snapshot_day) throw new Error(`--as-of ${as_of} is before the snapshot day ${raw.snapshot_day} (historical builds are not supported)`);
    assert_clean(raw, "fixture");
    const names = new Map();
    const ph = (sid) => { if (!names.has(sid)) names.set(sid, names.size); return names.get(sid); };
    [...raw.identity.map((r) => r.system_id), ...raw.inventory.map((r) => r.system_id)].sort().forEach(ph);
    const anon = (r) => ({ ...r, cus_sys_id: null, site_name: `Site ${ph(r.system_id) + 1}`, city: null, state: null, customer_id: null,
      customer_name: `Customer ${String.fromCharCode(65 + (ph(r.system_id) % 26))}` });
    const fx = {
      note: `GE CV viewer fixture from prod (read-only), as of ${as_of}. Codes, counts, dims, days, masked code labels and source-file base names only; identity names are placeholders.`,
      as_of, snapshot_day: raw.snapshot_day, snapshot_at: raw.snapshot_at,
      summary: raw.summary, daily: raw.daily, capabilities: raw.capabilities, findings: raw.findings, codes: raw.codes,
      configured: raw.configured,
      identity: raw.identity.map(anon),
      inventory: raw.inventory.map((r) => { const x = anon(r); return { system_id: x.system_id, modality: x.modality, model: x.model, site_name: x.site_name, customer_name: x.customer_name }; })
    };
    const out = path.join(__dirname, "..", "test", "fixtures", "cv_fixture.json.gz");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // gzip output carries no timestamp or name, so the same data gives the same bytes
    fs.writeFileSync(out, zlib.gzipSync(`${JSON.stringify(fx)}\n`, { level: 9 }));
    const n = (k) => fx[k].length;
    console.log(`wrote ${path.relative(process.cwd(), out)}: ${(fs.statSync(out).size / 1e6).toFixed(2)} MB; as of ${as_of}; systems ${n("summary")}, daily ${n("daily")}, capabilities ${n("capabilities")}, findings ${n("findings")}, codes ${n("codes")}, configured ${n("configured")}, identity ${n("identity")}, inventory ${n("inventory")}`);
  } finally {
    close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
