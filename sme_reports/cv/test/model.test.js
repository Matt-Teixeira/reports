// node sme_reports/cv/test/model.test.js   (no DB; fixture from prod, built
// by cv/tools/build_fixture.js)
//
// Expected values are computed here straight from the fixture rows with
// plain loops, not through the model's helpers.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const M = require("../model");

const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "cv_fixture.json.gz"))).toString("utf8"));
const AS_OF = fx.as_of;
const model = M.build_model(fx, { as_of: AS_OF });
const rows = [...model.reporting, ...model.not_reporting];
const DAY = 864e5;
const plus = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
const span = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const cells = (sid, m, a = "0000-00-00", b = AS_OF) => fx.daily.filter((c) => c.system_id === sid && c.m === m && c.day >= a && c.day <= b);
const sum_n = (cs) => cs.reduce((s, c) => s + Number(c.n), 0);
const days_of = (sid, a = "0000-00-00", b = AS_OF) => [...new Set(cells(sid, "cv.error", a, b).map((c) => c.day))].sort();
const caps = (sid) => new Set(fx.capabilities.filter((c) => c.system_id === sid).map((c) => c.metric_key));
const SYS = ["SME02412", "SME08640"];

test("fixture: both systems, the configured list, the inventory; no text beyond masked labels", () => {
  for (const s of SYS) assert.ok(model.views[s], s);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(fx.configured.length, 18);
  assert.strictEqual(model.no_data.length, 16);
  assert.strictEqual(model.inventory.length, 44);
  for (const s of SYS) assert.ok(!model.no_data.some((r) => r.system_id === s));
  assert.ok(!model.inventory.some((r) => fx.configured.includes(r.system_id)), "inventory excludes configured systems");
  // no debug text / encoded fields; source files are base names
  for (const k of ["debugtext", "errortext", "fru", "majorfunction", "minorfunction"]) assert.ok(!JSON.stringify(fx).includes(`"${k}"`), k);
  for (const c of fx.codes) assert.ok(!c.sourcefile || !/[\\/]/.test(c.sourcefile), `code ${c.code} source file is a base name`);
  for (const r of fx.identity) assert.ok(/^Site \d+$/.test(r.site_name) && /^Customer [A-Z]$/.test(r.customer_name) && r.city === null && r.cus_sys_id === null);
});

test("fleet columns recomputed from raw rows", () => {
  for (const r of rows) {
    const sid = r.system_id, days = days_of(sid), D = days[days.length - 1];
    assert.strictEqual(r.last_day, D);
    const a = plus(D, -29);
    const errs = sum_n(cells(sid, "cv.error", a, D)), dd = days.filter((d) => d >= a).length;
    assert.deepStrictEqual(r.errors, { errors: errs, data_days: dd, per_day: Math.round((100 * errs) / dd) / 100 });
    const per = new Map();
    for (const c of cells(sid, "cv.error", a, D)) per.set(c.day, (per.get(c.day) || 0) + c.n);
    const best = [...per].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0];
    assert.deepStrictEqual(r.busiest, { day: best[0], n: best[1] });
    const cp = caps(sid);
    for (const [k, m] of Object.entries(M.FLEET_METRICS)) assert.strictEqual(r.named[k], cp.has(m) ? sum_n(cells(sid, m, a, D)) : null, `${sid} ${k}`);
    const open = fx.findings.filter((f) => f.system_id === sid && f.status === "open");
    assert.strictEqual(r.open.total, open.length);
    const s = fx.summary.find((x) => x.system_id === sid);
    assert.ok(Number.isInteger(s.ahead_min), `${sid}: the fixture carries the SQL clock bound`);
    assert.strictEqual(r.clock_ahead_min, s.ahead_min >= 1 ? s.ahead_min : null);
    assert.strictEqual(r.group, D >= plus(AS_OF, -6) ? "reporting" : "not_reporting");
  }
  // the reference systems as of the fixture: PIB not logged on SME08640
  assert.strictEqual(model.views.SME08640.header.named.pib, null);
});

test("clock lower bound: the SQL value, shown only when >= 1 min", () => {
  assert.strictEqual(M.clock_ahead(30), 30);
  assert.strictEqual(M.clock_ahead(0), null);
  assert.strictEqual(M.clock_ahead(-89), null);
  assert.strictEqual(M.clock_ahead(null), null);
  // review CV6-DATA-MODEL F2: last_seen 20:01:00.000000, snapshot 20:00:00.000001 -> SQL floor 0.
  // A JS Date keeps milliseconds only and would give 1; the model must use the SQL value.
  const fx2 = { ...fx, summary: fx.summary.map((r) => ({ ...r, last_seen: "2026-11-18T20:01:00.000Z", ahead_min: 0 })), snapshot_at: "2026-11-18T20:00:00.000Z" };
  for (const r of [...M.build_model(fx2, { as_of: AS_OF }).reporting]) assert.strictEqual(r.clock_ahead_min, null);
});

test("order and groups: attention, then not reporting by last data, configured without data by id", () => {
  const rank = (s) => ["info", "low", "medium", "high"].indexOf(s);
  for (let i = 1; i < model.reporting.length; i++) {
    const a = model.reporting[i - 1], b = model.reporting[i];
    const k = [rank(a.open.max_severity) - rank(b.open.max_severity), a.open.attention - b.open.attention, (a.errors.per_day ?? -1) - (b.errors.per_day ?? -1)].find((x) => x !== 0);
    assert.ok(k === undefined ? a.system_id < b.system_id : k > 0, `${a.system_id} before ${b.system_id}`);
  }
  assert.deepStrictEqual(model.no_data.map((r) => r.system_id), fx.configured.filter((s) => !SYS.includes(s)).sort());
  // a later as-of: both systems go to not reporting, most recent first
  const later = M.build_model(fx, { as_of: plus(AS_OF, 30) });
  assert.strictEqual(later.reporting.length, 0);
  assert.strictEqual(later.not_reporting.length, 2);
  assert.ok(later.not_reporting[0].last_day >= later.not_reporting[1].last_day);
});

test("dense series match the daily rows: subsystems, named metrics and dims, detector offset, data mask", () => {
  for (const sid of SYS) {
    const v = model.views[sid], days = days_of(sid);
    assert.strictEqual(v.d0, days[0]);
    assert.strictEqual(v.nd, span(days[0], days[days.length - 1]) + 1);
    for (let i = 0; i < v.nd; i++) assert.strictEqual(v.data[i] === "1", days.includes(plus(v.d0, i)));
    // subsystems: every cv.error row by its code's subsystem
    const want = {};
    for (const c of cells(sid, "cv.error")) {
      const s = ["POS", "RTA", "DL"].includes(c.sub) ? c.sub : "other";
      (want[s] ??= new Array(v.nd).fill(0))[span(v.d0, c.day)] += c.n;
    }
    for (const s of ["POS", "RTA", "DL"]) want[s] ??= new Array(v.nd).fill(0);
    assert.deepStrictEqual(v.subs, want);
    const cp = caps(sid);
    for (const m of M.NAMED) {
      if (!cp.has(m)) { assert.ok(!(m in v.ev) && !(m in v.dims), `${sid} ${m} absent`); continue; }
      const tot = new Array(v.nd).fill(0), dims = {};
      for (const c of cells(sid, m)) { tot[span(v.d0, c.day)] += c.n; (dims[c.dim] ??= new Array(v.nd).fill(0))[span(v.d0, c.day)] += c.n; }
      assert.deepStrictEqual(v.ev[m], tot, `${sid} ${m}`);
      assert.deepStrictEqual(v.dims[m], dims, `${sid} ${m} dims`);
    }
    const off = cells(sid, "cv.error").filter((c) => c.dim === M.DETECTOR_OFFSET_CODE);
    if (off.length && cp.has("cv.detector_com_error")) {
      const a = new Array(v.nd).fill(0);
      for (const c of off) a[span(v.d0, c.day)] += c.n;
      assert.deepStrictEqual(v.offset, a);
    } else assert.strictEqual(v.offset, null);
  }
  assert.ok(model.views.SME02412.offset, "SME02412 has the detector offset series");
});

test("code tables: every code per period; top + other = total = cv.error in the period; days", () => {
  for (const sid of SYS) {
    const v = model.views[sid], L = v.nd - 1;
    for (const p of model.periods) {
      const a = p.days === null ? v.d0 : plus(v.d0, Math.max(0, L - p.days + 1)), b = plus(v.d0, L);
      const by = new Map();
      for (const c of cells(sid, "cv.error", a, b)) { const x = by.get(c.dim) || [c.dim, 0, 0]; x[1] += c.n; x[2] += 1; by.set(c.dim, x); }
      const want = [...by.values()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
      const t = v.codes[p.key];
      assert.deepStrictEqual(t.rows, want, `${sid} ${p.key}`);
      const total = sum_n(cells(sid, "cv.error", a, b));
      assert.strictEqual(t.total, total);
      assert.strictEqual(t.top, Math.min(10, want.length));
      assert.strictEqual(want.slice(0, 10).reduce((s, x) => s + x[1], 0) + t.other, total);
    }
  }
  // labels for every listed code; source file base names only
  for (const v of Object.values(model.views)) for (const r of v.codes.all.rows) assert.ok(r[0] in model.codes, `label entry for ${r[0]}`);
});

test("dim ranks per period: by events, then name; zero dims left out", () => {
  for (const sid of SYS) {
    const v = model.views[sid], L = v.nd - 1;
    for (const m of M.RANKED) {
      if (!v.ranks[m]) continue;
      for (const p of model.periods) {
        const a = p.days === null ? 0 : Math.max(0, L - p.days + 1);
        const sums = Object.entries(v.dims[m]).map(([d, arr]) => [d, arr.slice(a, L + 1).reduce((s, x) => s + x, 0)]).filter((x) => x[1] > 0);
        sums.sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
        assert.deepStrictEqual(v.ranks[m][p.key], sums.map((x) => x[0]), `${sid} ${m} ${p.key}`);
      }
    }
  }
});

test("finding bands: one per finding, opened day to resolved day (open: last data day)", () => {
  for (const sid of SYS) {
    const v = model.views[sid], fs_ = fx.findings.filter((f) => f.system_id === sid);
    assert.strictEqual(v.bands.length, fs_.length);
    for (const b of v.bands) {
      const f = fs_.find((x) => x.finding_key === b.key && x.evidence.opened_day === b.opened_day);
      assert.ok(f, `${sid} band ${b.key} ${b.opened_day}`);
      assert.strictEqual(b.from, span(v.d0, f.evidence.opened_day));
      assert.strictEqual(b.to, f.status === "open" ? v.nd - 1 : span(v.d0, f.evidence.resolved_day));
      assert.strictEqual(b.severity, f.severity);
    }
  }
  // the 2026-09-11 episode: storm, PIB, anticollision and table bands overlap on SME02412
  const ep = model.views.SME02412.bands.filter((b) => b.opened_day >= "2026-09-11" && b.opened_day <= "2026-09-15").map((b) => b.key).sort();
  assert.deepStrictEqual(ep, ["cv_anticollision_burst", "cv_error_storm", "cv_pib_com_loss", "cv_table_encoder_fault"]);
  // clipped and dropped outside the day range
  assert.deepStrictEqual(M.finding_bands([{ finding_key: "k", label: "K", severity: "low", status: "resolved", evidence: { opened_day: "2026-01-01", resolved_day: "2026-01-05" } }], M.dnum("2026-02-01"), M.dnum("2026-03-01")), []);
});

test("findings: every finding shown, open first; stored evidence unchanged; evidence codes have labels", () => {
  for (const sid of SYS) {
    const v = model.views[sid], fs_ = fx.findings.filter((f) => f.system_id === sid);
    assert.strictEqual(v.findings.length, fs_.length);
    const firstResolved = v.findings.findIndex((f) => f.status !== "open");
    assert.ok(firstResolved === -1 || v.findings.slice(firstResolved).every((f) => f.status !== "open"));
    for (const f of v.findings) {
      const src = fs_.find((x) => x.finding_key === f.finding_key && x.evidence.opened_day === f.opened_day);
      assert.deepStrictEqual(f.evidence, src.evidence);
      for (const c of M.evidence_codes(f.evidence)) assert.ok(c in model.codes, `label entry for evidence code ${c}`);
    }
  }
  assert.deepStrictEqual(M.evidence_codes({ last: { top_codes: [{ n: 1, code: "1050170" }, { n: 2, code: 2800176 }] }, first: { x: [{ code: "1050170" }] } }), ["1050170", "2800176"]);
});

test("panels and series only for logged metrics (capabilities)", () => {
  for (const sid of SYS) {
    const cp = caps(sid);
    assert.deepStrictEqual(model.views[sid].panels, M.PANELS.filter((p) => p.metrics.some((m) => cp.has(m))).map((p) => p.key));
  }
  const drop = ["cv.detector_com_error", "cv.positioner_collision", "cv.anticollision_error", "cv.table_encoder_failure", "cv.emergency_backout"];
  const m2 = M.build_model({ ...fx, capabilities: fx.capabilities.filter((c) => !(c.system_id === "SME02412" && drop.includes(c.metric_key))) }, { as_of: AS_OF });
  const v = m2.views.SME02412;
  assert.deepStrictEqual(v.panels, ["errors", "codes", "connectivity"]);
  assert.strictEqual(v.offset, null);
  assert.ok(!("cv.anticollision_error" in v.ev) && !("cv.anticollision_error" in v.ranks));
  assert.strictEqual(v.header.named.detector, null);
});

test("as-of: a real day, not before the snapshot day", () => {
  assert.throws(() => M.build_model(fx, { as_of: "2026-02-31" }), /bad as_of/);
  assert.throws(() => M.build_model(fx, { as_of: plus(fx.snapshot_day, -1) }), /before the snapshot day/);
});

test("deterministic, and independent of input row order", () => {
  const rev = Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, Array.isArray(v) ? v.slice().reverse() : v]));
  assert.strictEqual(JSON.stringify(M.build_model(rev, { as_of: AS_OF })), JSON.stringify(model));
  assert.strictEqual(JSON.stringify(M.build_model(fx, { as_of: AS_OF })), JSON.stringify(model));
});

test("edges the real data does not reach: busiest-day ties, the 7-day reporting boundary", () => {
  // two days with the same count: the earlier one is the busiest
  const ix = { cells: new Map(), days: [] };
  const pts = [[M.dnum("2026-11-10"), 5], [M.dnum("2026-11-03"), 5], [M.dnum("2026-11-12"), 4]];
  for (const order of [pts, pts.slice().reverse()]) assert.deepStrictEqual(M.busiest_30d(ix, M.dnum("2026-11-12"), new Map(order)), { day: "2026-11-03", n: 5 });
  // last data day = as_of - 6: reporting; as_of - 7: not reporting
  for (const sid of SYS) {
    const D = model.views[sid].header.last_day;
    assert.strictEqual(M.build_model(fx, { as_of: plus(D, 6) }).views[sid].header.group, "reporting", `${sid} D+6`);
    assert.strictEqual(M.build_model(fx, { as_of: plus(D, 7) }).views[sid].header.group, "not_reporting", `${sid} D+7`);
  }
});
