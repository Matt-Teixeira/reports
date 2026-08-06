// Chart + full-page render checks with synthetic data (no DB required).
// Run: node sme_reports/dev/check_chart.js
// Also writes sme_reports/out/dev-synthetic-{philips,ge}.html for eyeballing.
const assert = require("assert");
const path = require("path");

const { render_timeseries_chart } = require("../render/chart");
const { pressure_domain, padded_domain } = require("../render/scales");
const { build_render_model } = require("../render/model");
const { build_page } = require("../render/page");
const { VENDORS } = require("../vendors");
const { normalize_request } = require("../request_loader");
const write_html = require("../output/write_html");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 5, 28);

// --- chart svg structure ----------------------------------------------------
{
  const points = [
    { t: T0, min: 28, max: 32, v: 30 },
    { t: T0 + DAY, min: 29, max: 31, v: 30 },
    { t: T0 + 2 * DAY, min: 30, max: 272, v: 262 }
  ];
  const svg = render_timeseries_chart({
    points,
    x_domain: [T0, T0 + 2 * DAY],
    y_spec: pressure_domain(28, 272, { high_gt: 100, high_lt: null }),
    y_format: (v) => `${v}`,
    event_window: { start: T0 + 1.5 * DAY, end: T0 + 2 * DAY },
    thresholds: [{ value: 100, label: "PHILIPS ALERT — 100 mbar" }],
    markers: [{ t: T0 + 2 * DAY, v: 262, color: "#C25E00", label: "now 262", dy: 15 }]
  });
  assert.ok(svg.startsWith('<svg viewBox="0 0 640 152"'), "viewBox");
  assert.ok(svg.includes("<polygon"), "band polygon present in band mode");
  assert.ok(svg.includes("<polyline"), "series polyline");
  assert.ok(svg.includes('stroke-dasharray="5,4"'), "threshold dashes");
  assert.ok(svg.includes("PHILIPS ALERT — 100 mbar"), "threshold label");
  assert.ok(svg.includes('fill="#F58025" opacity="0.09"'), "event rect");
  assert.ok(svg.includes("now 262"), "marker label");
  assert.ok(svg.includes("06-28") && svg.includes("06-30"), "x tick labels");
  // threshold 100 in domain [0,300]: y = 126 - (100/300)*114 = 88
  assert.ok(svg.includes('y1="88" y2="88"') || svg.includes('y1="88.0"'), "threshold at y=88");
}
{
  // line mode: degenerate min=max -> no visible band polygon emitted
  const pts = [
    { t: T0, min: 1, max: 1, v: 1 },
    { t: T0 + DAY, min: 2, max: 2, v: 2 }
  ];
  const svg = render_timeseries_chart({
    points: pts,
    x_domain: [T0, T0 + DAY],
    y_spec: padded_domain(1, 2),
    y_format: (v) => `${v}%`,
    event_window: null,
    thresholds: null,
    markers: []
  });
  assert.ok(!svg.includes("<polygon"), "no polygon when band degenerate");
  assert.ok(!svg.includes("<rect"), "no event rect without event window");
}

// --- full page render, Philips-shaped synthetic (band mode) -----------------
const philips_identity = {
  system_id: "SME15822",
  manufacturer: "Philips",
  modality: "MRI",
  cus_sys_id: "1046",
  site_name: "Althea Smyrna",
  city: "Smyrna",
  state: "TN",
  customer_name: "Althea"
};
const philips_series = [];
{
  const end_h = 24 * 24; // 24 days
  const stop_h = 22 * 24; // stop on day 22
  const rec_h = stop_h + 28;
  for (let h = 0; h < end_h; h++) {
    for (let m = 0; m < 2; m++) {
      const t = T0 + h * HOUR + m * 30 * 60000;
      const in_event = h >= stop_h && h < rec_h;
      const after = h >= rec_h;
      philips_series.push({
        t,
        host_t: t,
        pressure:
          h < stop_h ? 29 : in_event ? 30 + (h - stop_h) * 8.6 : 262,
        pressure_avg: null,
        helium: h < stop_h ? 76.5 : Math.min(79.3, 76.5 + (h - stop_h) * 0.06),
        compressor_on: in_event ? h % 3 !== 0 : true, // cycling during event
        coldhead_k: null,
        shield_k: null,
        temp_alarm: in_event && h - stop_h > 10,
        quenched: false
      });
    }
  }
}
{
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME15822",
    recipients: ["dev@example.com"],
    window: { start: "2026-06-28", end: "2026-07-22" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: philips_identity,
    vendor: VENDORS.PHILIPS,
    series: philips_series,
    source: "synthetic",
    request
  });
  assert.strictEqual(vm.facts.chart_mode, "band", "1152 captures -> band mode");
  assert.strictEqual(vm.facts.archetype, "compressor_stop_recovered");
  assert.strictEqual(vm.tiles.length, 5);
  assert.deepStrictEqual(
    vm.tiles.map((t) => t.k),
    ["COMPRESSOR", "PRESSURE NOW", "EVENT PEAK", "TEMP ALARM", "HELIUM"]
  );
  assert.ok(vm.tiles[3].v === "TRIGGERED", "temp alarm tile triggered");
  assert.ok(vm.pressure_chart_svg.includes("PHILIPS ALERT — 100 mbar"));
  assert.ok(
    vm.pressure_chart_svg.includes('height="3" fill="#C25E00"'),
    "temp-alarm strip on pressure chart"
  );
  assert.ok(vm.story_html.includes("the compressor stopped"));
  assert.strictEqual(vm.rx_cards.length, 3);
  const html = build_page(vm);
  assert.ok(html.includes('<div class="page">'));
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-philips", html);
}

// --- full page render, GE-shaped synthetic (line mode, under threshold) -----
{
  const ge_series = [];
  const captures = 388;
  const span = 8 * DAY;
  const G0 = Date.UTC(2026, 6, 20);
  const stop_i = 350;
  const rec_i = 380;
  for (let i = 0; i < captures; i++) {
    const t = G0 + (i / (captures - 1)) * span;
    const warm = i >= stop_i && i < rec_i;
    const after = i >= rec_i;
    ge_series.push({
      t,
      host_t: t - 72 * 60000, // console clock 72 min slow
      pressure: warm ? 1 + ((i - stop_i) / (rec_i - stop_i)) * 2.7 : after ? 3.66 : 1,
      pressure_avg: null,
      helium: warm ? 79.9 + ((i - stop_i) / (rec_i - stop_i)) * 0.8 : after ? 80.69 : 79.93,
      compressor_on: !warm,
      coldhead_k: warm ? 4.1 + ((i - stop_i) / (rec_i - stop_i)) * 73.8 : 4.457,
      shield_k: 51,
      temp_alarm: null,
      quenched: null
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME21824",
    recipients: ["dev@example.com"],
    window: { start: "2026-07-20", end: "2026-07-28" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: {
      system_id: "SME21824",
      manufacturer: "GE",
      modality: "MRI",
      cus_sys_id: "ge167",
      site_name: "MAK Algonquin Station 1",
      city: "Algonquin",
      state: "IL",
      customer_name: "Northside"
    },
    vendor: VENDORS.GE,
    series: ge_series,
    source: "synthetic",
    request
  });
  assert.strictEqual(vm.facts.chart_mode, "line", "388 captures -> line mode");
  assert.strictEqual(vm.facts.archetype, "compressor_stop_recovered");
  assert.deepStrictEqual(
    vm.tiles.map((t) => t.k),
    ["COMPRESSOR", "COLDHEAD", "PRESSURE NOW", "EVENT PEAK", "HELIUM"]
  );
  assert.ok(vm.pressure_chart_svg.includes("GE ALERT — 5 PSI"));
  assert.ok(vm.tiles[3].s.includes("under threshold"), "peak under GE line");
  const notes = vm.rx_cards[2].body;
  assert.ok(notes.includes("72 min"), `clock skew surfaced in data notes: ${notes}`);
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-ge", build_page(vm));
}

// --- full page render, Siemens-shaped synthetic (band thresholds) -----------
{
  const s_series = [];
  const S0 = Date.UTC(2026, 7, 1);
  for (let i = 0; i < 300; i++) {
    const t = S0 + i * HOUR;
    s_series.push({
      t,
      host_t: t,
      pressure: 15.3 + Math.sin(i / 20) * 0.1,
      pressure_avg: null,
      helium: 84.3 - i * 0.001,
      compressor_on: true,
      coldhead_k: 43 + Math.sin(i / 10),
      shield_k: null,
      temp_alarm: null,
      temp_alarm_minutes: null,
      room_temp_c: null,
      quenched: null
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME20557",
    recipients: ["dev@example.com"],
    window: { start: "2026-08-01", end: "2026-08-13" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: {
      system_id: "SME20557",
      manufacturer: "Siemens",
      modality: "MRI",
      site_name: "Test Site",
      city: "Testville",
      state: "TN",
      customer_name: "TestCo"
    },
    vendor: VENDORS.SIEMENS,
    series: s_series,
    source: "synthetic",
    request
  });
  assert.strictEqual(vm.facts.archetype, "stable_healthy");
  assert.deepStrictEqual(
    vm.tiles.map((t) => t.k),
    ["COMPRESSOR", "COLDHEAD", "PRESSURE NOW", "EVENT PEAK", "HELIUM"]
  );
  assert.ok(vm.tiles[1].cls === "good", "43 K coldhead is good for Siemens (warm_k 55)");
  assert.ok(vm.tiles[2].s.includes("within the 14.4–16.4"), `band wording: ${vm.tiles[2].s}`);
  // Band renders BOTH alert lines and a non-zero-anchored y domain
  assert.ok(vm.pressure_chart_svg.includes(">16.4 PSI"), "high band line");
  assert.ok(vm.pressure_chart_svg.includes("&lt;14.4 PSI"), "low band line");
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-siemens", build_page(vm));
}

console.log("check_chart: all assertions passed");
