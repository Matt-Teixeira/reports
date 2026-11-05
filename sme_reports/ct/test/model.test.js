// node --test sme_reports/ct/test   (no DB; fixture from prod, built by
// ct/tools/build_fixture.js)
//
// Expected values are computed here straight from the fixture rows with
// plain loops, not through the model's helpers.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const M = require("../model");

const zlib = require("zlib");
const FX_PATH = path.join(__dirname, "fixtures", "ct_fixture.json.gz");
const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(FX_PATH)).toString("utf8"));
const AS_OF = fx.as_of;
const model = M.build_model(fx, { as_of: AS_OF });
const all_rows = [...model.reporting, ...model.not_reporting];
const DAY = 864e5;
const plus = (day, k) => new Date(Date.parse(`${day}T00:00:00Z`) + k * DAY).toISOString().slice(0, 10);
const daily = (sid, m, a, b, dimOk = () => true) => fx.daily.filter((c) => c.system_id === sid && c.m === m && c.day >= a && c.day <= b && dimOk(c.dim));
const sum_n = (cells) => cells.reduce((s, c) => s + Number(c.n), 0);
const pct = (a, b) => (b > 0 ? Math.round((10000 * a) / b) / 100 : null);

test("fixture covers the verification set, a not-reporting system and the panel variety", () => {
  for (const s of ["SME21859", "SME18531", "SME21867"]) assert.ok(model.views[s], s);
  assert.ok(model.not_reporting.some((r) => r.system_id === "SME17371"));
  assert.strictEqual(all_rows.length, fx.summary.length);
});

test("abort-rate and prep columns equal the rule's values on every trip day in the fixture", () => {
  let checked = 0;
  for (const f of fx.findings) {
    if (!["abort_rate_high", "prep_noncompliance"].includes(f.finding_key)) continue;
    const ix = M.index_system(fx, f.system_id, M.dnum(AS_OF));
    for (const which of ["first", "last"]) {
      const e = f.evidence[which];
      // the window must lie inside the fixture's day cut
      const need = f.finding_key === "abort_rate_high" ? 27 : 13;
      if (plus(e.day, -need) < fx.from_day) continue;
      const D = M.dnum(e.day);
      if (f.finding_key === "abort_rate_high") {
        const a = M.abort_28d(ix, D);
        assert.deepStrictEqual({ aborts: a.aborts, exams: a.exams, per_100: a.per_100 },
          { aborts: e.d28.aborts, exams: e.d28.exams, per_100: e.d28.per_100 }, `${f.system_id} ${f.finding_key} ${e.day}`);
      } else {
        const p = M.prep_14d(ix, D);
        assert.deepStrictEqual({ scan: p.scan_days, without: p.without_fast_cal, share: p.share },
          { scan: e.scan_days, without: e.scan_days_without_fast_cal, share: e.observed }, `${f.system_id} ${f.finding_key} ${e.day}`);
      }
      checked++;
    }
  }
  assert.ok(checked >= 4, `only ${checked} trip days checked`);
});

test("fleet columns recomputed from raw rows", () => {
  for (const r of all_rows) {
    const L = r.last_day, sid = r.system_id;
    const dd = new Set(fx.days.filter((d) => d.system_id === sid && d.day >= plus(L, -29) && d.day <= L).map((d) => d.day)).size;
    const ex = sum_n(daily(sid, "exam.start", plus(L, -29), L));
    assert.strictEqual(r.exams.exams, ex, sid);
    assert.strictEqual(r.exams.data_days, dd, sid);
    assert.strictEqual(r.exams.per_day, dd ? Math.round((100 * ex) / dd) / 100 : null, sid);
    const a = sum_n(daily(sid, "scan.abort.system", plus(L, -27), L)), e = sum_n(daily(sid, "exam.start", plus(L, -27), L));
    assert.strictEqual(r.abort_28d.per_100, pct(a, e), sid);
    const scan = new Set(daily(sid, "exam.start", plus(L, -13), L).filter((c) => c.n > 0).map((c) => c.day));
    const fast = new Set(daily(sid, "prep.tube_temp", plus(L, -13), L, (d) => M.FAST_CAL_STEPS.includes(d)).filter((c) => c.n > 0).map((c) => c.day));
    assert.strictEqual(r.prep_14d.share, pct([...scan].filter((d) => !fast.has(d)).length, scan.size), sid);
    // mA·s: counter increments by reading day, drops count 0
    const ctr = daily(sid, "tube.mas_total", "0000-00-00", L).sort((x, y) => (x.day < y.day ? -1 : 1));
    let mas = 0;
    for (let i = 1; i < ctr.length; i++) if (ctr[i].day >= plus(L, -29)) mas += Math.max(0, ctr[i].value_last - ctr[i - 1].value_last);
    assert.ok(Math.abs(r.mas.mas - mas) < 0.01, `${sid} mas ${r.mas.mas} vs ${mas}`);
    // last data day and group
    const last = fx.days.filter((d) => d.system_id === sid && d.day <= AS_OF).map((d) => d.day).sort().pop();
    assert.strictEqual(L, last, sid);
    assert.strictEqual(r.group, last >= plus(AS_OF, -6) ? "reporting" : "not_reporting", sid);
    // open findings by severity
    const open = fx.findings.filter((f) => f.system_id === sid && f.status === "open");
    for (const s of M.SEVERITIES) assert.strictEqual(r.open[s], open.filter((f) => f.severity === s).length, `${sid} ${s}`);
  }
});

test("attention order: highest open severity (no info), then open count (no info), then exams/day", () => {
  const rank = (s) => M.SEVERITIES.indexOf(s);
  for (let i = 1; i < model.reporting.length; i++) {
    const a = model.reporting[i - 1], b = model.reporting[i];
    const k = (r) => [rank(r.open.max_severity), r.open.attention, r.exams.per_day ?? -1];
    const [x, y] = [k(a), k(b)];
    const cmp = x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    assert.ok(cmp > 0 || (cmp === 0 && a.system_id < b.system_id), `${a.system_id} before ${b.system_id}`);
  }
  assert.ok(model.reporting.every((r) => r.group === "reporting") && model.not_reporting.every((r) => r.group === "not_reporting"));
});

test("heatmap: one cell per exam in the period, every exam placed", () => {
  for (const [sid, v] of Object.entries(model.views)) {
    const L = v.header.last_day;
    for (const p of M.PERIODS) {
      const a = p.days === null ? "0000-00-00" : plus(L, -(p.days - 1));
      const n = fx.exams.filter((e) => e.system_id === sid && e.day >= a && e.day <= L).length;
      assert.strictEqual(v.heat[p.key].reduce((s, x) => s + x, 0), n, `${sid} ${p.key}`);
    }
  }
});

test("heatmap hour = started_at minus the day's local midnight", () => {
  const sid = "SME21859";
  const days = new Map(fx.days.filter((d) => d.system_id === sid).map((d) => [d.day, Date.parse(d.local_midnight)]));
  const h = new Array(168).fill(0);
  for (const e of fx.exams.filter((x) => x.system_id === sid)) {
    const hour = Math.min(23, Math.max(0, Math.floor((Date.parse(e.started_at) - days.get(e.day)) / 3600e3)));
    const dow = (new Date(`${e.day}T00:00:00Z`).getUTCDay() + 6) % 7;
    h[dow * 24 + hour]++;
  }
  assert.deepStrictEqual(model.views[sid].heat.all, h);
});

test("error codes: top 10 + other = all error.ermes events in each period", () => {
  for (const [sid, v] of Object.entries(model.views)) {
    if (!v.errors) continue;
    const L = v.header.last_day;
    for (const p of M.PERIODS) {
      const a = p.days === null ? "0000-00-00" : plus(L, -(p.days - 1));
      const total = sum_n(daily(sid, "error.ermes", a, L));
      const t = v.errors.top[p.key];
      assert.strictEqual(t.total, total, `${sid} ${p.key}`);
      assert.strictEqual(t.codes.reduce((s, x) => s + x[1], 0) + t.other, total);
      assert.ok(t.codes.length <= 10);
      for (const [code] of t.codes) assert.ok(v.errors.series[code], `${sid} series for ${code}`);
    }
  }
});

test("panels and series only for logged metrics (capabilities)", () => {
  for (const [sid, v] of Object.entries(model.views)) {
    const caps = new Set(fx.capabilities.filter((c) => c.system_id === sid).map((c) => c.metric_key));
    for (const p of M.PANELS) assert.strictEqual(v.panels.includes(p.key), p.metrics.some((m) => caps.has(m)), `${sid} ${p.key}`);
    for (const m of Object.keys(v.ev)) assert.ok(caps.has(m), `${sid} ev ${m}`);
    for (const m of Object.keys(v.gauges)) assert.ok(caps.has(m), `${sid} gauge ${m}`);
    assert.strictEqual(v.boots !== null, caps.has("system.boot"));
  }
  // variety: at least one system without rotor or environment
  assert.ok(Object.values(model.views).some((v) => !v.panels.includes("rotor")));
  assert.ok(Object.values(model.views).some((v) => v.panels.includes("rotor")));
});

test("dense series match the daily rows; boots match ge_ct_boots_v", () => {
  for (const [sid, v] of Object.entries(model.views)) {
    for (const [m, arr] of Object.entries(v.ev)) assert.strictEqual(arr.reduce((s, x) => s + x, 0), sum_n(daily(sid, m, v.d0, v.header.last_day)), `${sid} ${m}`);
    if (v.boots) {
      const b = fx.boots.filter((x) => x.system_id === sid && x.day >= v.d0 && x.day <= v.header.last_day);
      assert.strictEqual(v.boots.clean.reduce((s, x) => s + x, 0), b.filter((x) => x.clean).length);
      assert.strictEqual(v.boots.unclean.reduce((s, x) => s + x, 0), b.filter((x) => !x.clean).length);
    }
    assert.strictEqual(v.data.length, v.nd);
    assert.strictEqual(v.exams.rows.reduce((s, x) => s + x, 0), fx.exams.filter((e) => e.system_id === sid).length);
  }
});

test("deterministic, and independent of input row order", () => {
  const a = JSON.stringify(M.build_model(fx, { as_of: AS_OF }));
  const shuffled = Object.fromEntries(Object.entries(fx).map(([k, v]) => [k, Array.isArray(v) ? v.slice().reverse() : v]));
  assert.strictEqual(JSON.stringify(M.build_model(shuffled, { as_of: AS_OF })), a);
});

test("as_of: earlier than the snapshot day is refused; later device days are ignored; not reporting after 7 days", () => {
  // review PHASE6-DATA-MODEL F1: findings and tube segments are current state
  assert.throws(() => M.build_model(fx, { as_of: plus(fx.snapshot_day, -1) }), /before the snapshot day/);
  assert.throws(() => M.build_model({ ...fx, snapshot_day: undefined }, { as_of: AS_OF }), /snapshot_day is required/);
  // a device day after as_of (clock ahead) is ignored: add one and build as of the snapshot day
  const sid = "SME21859";
  const ahead = plus(AS_OF, 1);
  const fx2 = { ...fx, days: [...fx.days, { system_id: sid, day: ahead, local_midnight: `${ahead}T05:00:00Z`, first_at: `${ahead}T06:00:00Z`, last_at: `${ahead}T07:00:00Z` }],
    daily: [...fx.daily, { system_id: sid, day: ahead, m: "exam.start", dim: "", n: 99, value_sum: null, value_min: null, value_max: null, value_last: null }] };
  assert.strictEqual(JSON.stringify(M.build_model(fx2, { as_of: AS_OF })), JSON.stringify(model));
  // exact boundary from the system's own last data day L: reporting through L+6, not at L+7
  const L = all_rows.find((x) => x.system_id === sid).last_day;
  assert.ok(M.build_model(fx, { as_of: plus(L, 6) }).reporting.some((x) => x.system_id === sid));
  assert.ok(M.build_model(fx, { as_of: plus(L, 7) }).not_reporting.some((x) => x.system_id === sid));
});

test("only ge_ct findings count (review PHASE6-DATA-MODEL F2)", () => {
  const sid = "SME21859";
  const other = { ...fx.findings.find((f) => f.system_id === sid), source: "ge_mri", finding_key: "x_other", status: "open", severity: "high" };
  const m2 = M.build_model({ ...fx, findings: [...fx.findings, other] }, { as_of: AS_OF });
  assert.strictEqual(JSON.stringify(m2), JSON.stringify(model));
  assert.ok(fx.findings.every((f) => f.source === "ge_ct"));
});

test("mas_increments: a counter drop (tube replacement) counts 0", () => {
  const raw = {
    days: ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"].map((day) => ({ system_id: "X", day, local_midnight: `${day}T05:00:00Z`, last_at: `${day}T20:00:00Z` })),
    daily: [[1, 100], [2, 150], [3, 10], [4, 40]].map(([d, v]) => ({ system_id: "X", day: `2026-01-0${d}`, m: "tube.mas_total", dim: "", n: 1, value_sum: v, value_min: v, value_max: v, value_last: v })),
    exams: [], boots: [], tube: [], findings: [], capabilities: []
  };
  const ix = M.index_system(raw, "X", M.dnum("2026-01-04"));
  assert.deepStrictEqual([...M.mas_increments(ix)].map(([d, x]) => [M.dstr(d), x]), [["2026-01-02", 50], ["2026-01-03", 0], ["2026-01-04", 30]]);
  assert.deepStrictEqual(M.mas_30d(ix, M.dnum("2026-01-04")), { mas: 80, data_days: 4, per_day: 20 });
  assert.strictEqual(M.local_day_of(ix, Date.parse("2026-01-03T04:59:59Z")).day, "2026-01-02");
  assert.strictEqual(M.local_day_of(ix, Date.parse("2026-01-03T05:00:00Z")).day, "2026-01-03");
});
