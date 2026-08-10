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
    event_windows: [{ start: T0 + 1.5 * DAY, end: T0 + 2 * DAY }],
    thresholds: [{ value: 100, label: "PHILIPS ALERT — 100 mbar" }],
    markers: [{ t: T0 + 2 * DAY, v: 262, color: "#C25E00", label: "now 262", dy: 15 }]
  });
  assert.ok(svg.startsWith('<svg viewBox="0 0 640 152"'), "viewBox");
  assert.ok(svg.includes("<polygon"), "band polygon present in band mode");
  assert.ok(svg.includes("<polyline"), "series polyline");
  assert.ok(svg.includes('stroke-dasharray="5,4"'), "threshold dashes");
  assert.ok(svg.includes("PHILIPS ALERT — 100 mbar"), "threshold label");
  assert.ok(svg.includes('fill="#F58025" opacity="0.09"'), "event rect");
  // Pinned geometry: a single event must keep the exact rect the pre-cluster
  // single-window code emitted — the loop changed how many rects are drawn,
  // never where any one of them sits.
  assert.ok(
    svg.includes(
      '<rect x="485.5" y="12" width="146.5" height="114" fill="#F58025" opacity="0.09"/>'
    ),
    "single-event rect geometry unchanged"
  );
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
    event_windows: null,
    thresholds: null,
    markers: []
  });
  assert.ok(!svg.includes("<polygon"), "no polygon when band degenerate");
  assert.ok(!svg.includes("<rect"), "no event rect without event windows");
}
{
  // Two clustered events -> two shaded rects.
  const pts = [
    { t: T0, min: 30, max: 30, v: 30 },
    { t: T0 + 10 * DAY, min: 30, max: 30, v: 30 }
  ];
  const svg = render_timeseries_chart({
    points: pts,
    x_domain: [T0, T0 + 10 * DAY],
    y_spec: padded_domain(28, 32),
    y_format: (v) => `${v}`,
    event_windows: [
      { start: T0 + 1 * DAY, end: T0 + 2 * DAY },
      { start: T0 + 7 * DAY, end: null } // open second event runs to plot edge
    ],
    thresholds: null,
    markers: []
  });
  const rects = (svg.match(/fill="#F58025"/g) || []).length;
  assert.strictEqual(rects, 2, `two event rects, got ${rects}`);
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
  // Short cycling inside one incident (gaps ≤3h, far under the 48h gap
  // threshold) must remain ONE event.
  assert.strictEqual(vm.facts.compressor_events.length, 1, "cycling does not split the event");
  assert.strictEqual(
    (vm.pressure_chart_svg.match(/fill="#F58025"/g) || []).length,
    1,
    "single orange event rect"
  );
  assert.ok(!vm.tiles[0].s.includes("other event"), `no +N marker: ${vm.tiles[0].s}`);
  assert.ok(!vm.story_html.includes("other compressor stop"), "no other-events sentence");
  assert.ok(vm.pressure_heading_note.includes("orange shade ="), "singular caption");
  const html = build_page(vm);
  assert.ok(html.includes('<div class="page">'));
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-philips", html);
}

// --- full page render, multi-event synthetic (three clustered incidents) ----
{
  // Hourly captures over 20 days (line mode). Three separate incidents:
  //   A: off h50-h59,   recovered h60  (10h)  — pressure bumps to 60
  //   B: off h150-h189, recovered h190 (40h)  — the significant one, primary
  //   C: off h400-h404, recovered h405 (5h)
  // Gaps (90h, 210h) far exceed the 48h cluster threshold.
  const m_series = [];
  for (let h = 0; h < 480; h++) {
    const t = T0 + h * HOUR;
    const in_a = h >= 50 && h < 60;
    const in_b = h >= 150 && h < 190;
    const in_c = h >= 400 && h < 405;
    m_series.push({
      t,
      host_t: t,
      pressure: in_a ? 60 : in_b ? 30 + (h - 150) * 2 : h >= 190 ? 40 : 29,
      pressure_avg: null,
      helium: 76.5,
      compressor_on: !(in_a || in_b || in_c),
      coldhead_k: null,
      shield_k: null,
      temp_alarm: false,
      quenched: false
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME15822",
    recipients: ["dev@example.com"],
    window: { start: "2026-06-28", end: "2026-07-18" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: philips_identity,
    vendor: VENDORS.PHILIPS,
    series: m_series,
    source: "synthetic",
    request
  });
  assert.strictEqual(vm.facts.compressor_events.length, 3, "three distinct events");
  assert.deepStrictEqual(
    vm.facts.compressor_events.map((e) => e.off_hours),
    [10, 40, 5],
    "hourly captures -> off hours match the incident durations above"
  );
  assert.strictEqual(
    vm.facts.compressor_event.start,
    T0 + 150 * HOUR,
    "largest off time is primary"
  );
  assert.strictEqual(vm.facts.archetype, "compressor_stop_recovered");
  for (const [name, svg] of [
    ["pressure", vm.pressure_chart_svg],
    ["helium", vm.helium_chart_svg]
  ]) {
    const rects = (svg.match(/fill="#F58025"/g) || []).length;
    assert.strictEqual(rects, 3, `${name} chart shades all events, got ${rects}`);
  }
  assert.ok(vm.tiles[0].s.includes("+2 other events"), `tile marker: ${vm.tiles[0].s}`);
  assert.ok(
    vm.story_html.includes("2 other compressor stop events"),
    "story summarizes the other events"
  );
  assert.ok(
    !vm.story_html.includes("and has held since"),
    "no 'held since' claim when a later event exists"
  );
  assert.ok(
    vm.story_html.includes("(outside other event spans)"),
    "baseline qualifier when an earlier event precedes the primary"
  );
  assert.strictEqual(
    vm.facts.pressure.baseline.max.v,
    29,
    "baseline excludes the earlier incident's excursion"
  );
  assert.ok(vm.pressure_heading_note.includes("orange shades ="), "plural caption");
  assert.ok(
    !vm.story_html.includes("most significant"),
    "primary is the longest event, not necessarily the worst — don't claim otherwise"
  );
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-multi-event", build_page(vm));
}

// --- ongoing stop must not accrue downtime past the last capture ------------
{
  // Captures stop at 09:00 on the window's last day; the requested window
  // runs to 23:59:59.999Z. An ongoing stop starting at 08:00 was observed
  // for one hour and must report ~2 h (span + one capture period), not the
  // ~16 h that measuring to the window end would produce.
  const O0 = Date.UTC(2026, 7, 1);
  const o_series = [];
  for (let h = 0; h <= 152; h++) {
    const t = O0 + h * HOUR;
    o_series.push({
      t,
      host_t: t,
      pressure: h >= 152 ? 40 : 30,
      pressure_avg: null,
      helium: 76.5,
      compressor_on: h < 151, // off at the last two captures (h151, h152)
      coldhead_k: null,
      shield_k: null,
      temp_alarm: false,
      quenched: false
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME15822",
    recipients: ["dev@example.com"],
    window: { start: "2026-08-01", end: "2026-08-07" }, // ends 23:59:59.999Z
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: philips_identity,
    vendor: VENDORS.PHILIPS,
    series: o_series,
    source: "synthetic",
    request
  });
  const ev = vm.facts.compressor_event;
  assert.strictEqual(ev.end, null, "ongoing stop");
  assert.strictEqual(ev.off_hours, 2, `observed 1h + one capture period, got ${ev.off_hours}`);
  assert.ok(
    vm.tiles[0].s.includes("off ~2.0 h"),
    `tile reports observed downtime only: ${vm.tiles[0].s}`
  );
}

// --- no compressor state at all must not fabricate a health claim -----------
{
  // Philips units whose only malf readings are −1 cable errors carry NO
  // compressor state (data.js maps −1 to null, per the DDL). Verified live:
  // SME15805/09/11 are online and healthy, and previously rendered a false
  // month-long ongoing stop — and after the mapping fix, would have rendered
  // an equally false green "ON · running continuously" without the tile fix.
  const NC0 = Date.UTC(2026, 7, 1);
  const nc_series = [];
  for (let h = 0; h < 200; h++) {
    nc_series.push({
      t: NC0 + h * HOUR,
      host_t: NC0 + h * HOUR,
      pressure: null, // this hardware has no pressure channel
      pressure_avg: null,
      helium: h % 40 === 0 ? 53.0 : null,
      compressor_on: null, // −1 cable errors + nulls -> no state
      coldhead_k: null,
      shield_k: null,
      temp_alarm: false,
      quenched: false
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME15811",
    recipients: ["dev@example.com"],
    window: { start: "2026-08-01", end: "2026-08-10" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: philips_identity,
    vendor: VENDORS.PHILIPS,
    series: nc_series,
    source: "synthetic",
    request
  });
  assert.strictEqual(vm.facts.archetype, "stable_healthy", "no fabricated stop");
  assert.strictEqual(vm.facts.compressor_event, null, "no event from cable errors");
  assert.strictEqual(vm.tiles[0].v, "—", "compressor tile claims nothing");
  assert.ok(
    vm.tiles[0].s.includes("no compressor state"),
    `tile says why: ${vm.tiles[0].s}`
  );
  assert.ok(!/[">]ON</.test(JSON.stringify(vm.tiles[0])), "never a green ON from no data");
  assert.ok(
    !vm.story_html.includes("compressor stopped"),
    "story does not narrate a stop that was never observed"
  );
  const page = build_page(vm);
  for (const bad of ["undefined", "NaN"]) assert.ok(!page.includes(bad));
}

// --- EDU comp_vib outranks the GE coldhead inference ------------------------
{
  // A GE system WITH an EDU gets its compressor state measured (vibration
  // sensor on the compressor), not inferred. Proof by contradiction: the EDU
  // reports a 6 h stop while the coldhead stays at 4 K throughout — if the
  // inference were still driving, no event would exist.
  const E0 = Date.UTC(2026, 7, 1);
  const ge_series = [];
  const ge_edu = [];
  for (let h = 0; h < 200; h++) {
    const t = E0 + h * HOUR;
    ge_series.push({
      t,
      host_t: t,
      pressure: 1.2,
      pressure_avg: null,
      helium: 80,
      compressor_on: true, // coldhead cold all period -> inference says ON
      coldhead_k: 4.2,
      shield_k: 45,
      temp_alarm: null,
      quenched: null
    });
    ge_edu.push({
      t,
      room_temp_f: 70,
      humidity_pct: 45,
      probe_0_f: 66,
      probe_1_f: 68,
      comp_vib: !(h >= 100 && h < 106) // EDU saw a 6 h stop
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME22099",
    recipients: ["dev@example.com"],
    window: { start: "2026-08-01", end: "2026-08-10" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: { system_id: "SME22099", manufacturer: "GE", modality: "MRI", site_name: "RMCHCS", city: "Gallup", state: "NM", customer_name: "RMCHCS" },
    vendor: VENDORS.GE,
    series: ge_series,
    source: "synthetic",
    request,
    edu: ge_edu,
    edu_source: "edu.v3"
  });
  assert.strictEqual(vm.facts.compressor_source, "edu_comp_vib", "EDU outranks the inference");
  assert.strictEqual(vm.facts.archetype, "compressor_stop_recovered", "the EDU-seen stop is the event");
  assert.ok(vm.story_html.includes("per EDU vibration sensor"), "narrative credits the sensor");

  // A nearly-empty EDU must NOT displace dense inference — exact boundary:
  // 23 readings stay fallback, 24 flip the source.
  const sparse_edu = ge_edu.slice(0, 23);
  const vm2 = build_render_model({
    identity: { system_id: "SME22099", manufacturer: "GE", modality: "MRI", site_name: "RMCHCS", city: "Gallup", state: "NM", customer_name: "RMCHCS" },
    vendor: VENDORS.GE,
    series: ge_series,
    source: "synthetic",
    request,
    edu: sparse_edu,
    edu_source: "edu.v3"
  });
  assert.strictEqual(vm2.facts.compressor_source, "coldhead_ruo_value", "23 EDU readings stay fallback");
  assert.strictEqual(vm2.facts.archetype, "stable_healthy");
  const vm2b = build_render_model({
    identity: { system_id: "SME22099", manufacturer: "GE", modality: "MRI", site_name: "RMCHCS", city: "Gallup", state: "NM", customer_name: "RMCHCS" },
    vendor: VENDORS.GE,
    series: ge_series,
    source: "synthetic",
    request,
    edu: ge_edu.slice(0, 24),
    edu_source: "edu.v3"
  });
  assert.strictEqual(vm2b.facts.compressor_source, "edu_comp_vib", "24 EDU readings meet the floor");

  // A scanner channel that yields NOTHING falls back to a sufficient EDU —
  // the cable-error Philips case, whose state was measurable all along.
  const ph_series = ge_series.map((r) => ({ ...r, compressor_on: null, coldhead_k: null, shield_k: null, pressure: null, helium: 53 }));
  const vm3 = build_render_model({
    identity: philips_identity,
    vendor: VENDORS.PHILIPS,
    series: ph_series,
    source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health",
      system_id: "SME15811",
      recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" },
      output: { html: false, pdf: false, email: false }
    }),
    edu: ge_edu,
    edu_source: "edu.v2"
  });
  assert.strictEqual(vm3.facts.compressor_source, "edu_comp_vib", "empty scanner channel falls back to EDU");
  assert.strictEqual(vm3.facts.archetype, "compressor_stop_recovered", "the trio's state is measurable after all");
  assert.notStrictEqual(vm3.tiles[0].v, "—", "no more 'no data' tile when the EDU can answer");
}

// --- raw Philips cable errors through the REAL mapper -----------------------
{
  const { normalize_philips } = require("../normalize");
  const rows = normalize_philips(
    [
      { capture_datetime: "2026-08-01T00:00:00Z", host_datetime: "2026-08-01T00:00:00Z", monitor_magnet_pressure_value: "12.1", helium_level_value: "53.0", cryo_comp_malf_value: "-1", cryo_comp_temp_alarm_state: "0", quenched_state: "0" },
      { capture_datetime: "2026-08-01T01:00:00Z", host_datetime: "2026-08-01T01:00:00Z", monitor_magnet_pressure_value: "12.2", helium_level_value: "53.0", cryo_comp_malf_value: "0", cryo_comp_temp_alarm_state: "0", quenched_state: "0" },
      { capture_datetime: "2026-08-01T02:00:00Z", host_datetime: "2026-08-01T02:00:00Z", monitor_magnet_pressure_value: "12.2", helium_level_value: "53.0", cryo_comp_malf_value: "34", cryo_comp_temp_alarm_state: "1", quenched_state: "0" },
      { capture_datetime: "2026-08-01T03:00:00Z", host_datetime: "2026-08-01T03:00:00Z", monitor_magnet_pressure_value: null, helium_level_value: null, cryo_comp_malf_value: null, cryo_comp_temp_alarm_state: null, quenched_state: null }
    ],
    VENDORS.PHILIPS
  );
  assert.strictEqual(rows[0].compressor_on, null, "malf −1 (cable error) is UNKNOWN, not off");
  assert.strictEqual(rows[1].compressor_on, true, "malf 0 = OK = running");
  assert.strictEqual(rows[2].compressor_on, false, "positive alarm-minutes = not running");
  assert.strictEqual(rows[3].compressor_on, null, "null carries no information");
}

// --- one stray scanner reading must not hide a dense EDU stop ---------------
{
  // Codex F1: a Philips whose ONLY stateful malf reading is one OK at hour 0,
  // against 200 EDU readings containing a six-hour stop. The scanner channel
  // no longer displaces the EDU unless it actually covers the period.
  const E0 = Date.UTC(2026, 7, 1);
  const series = [];
  const edu_rows = [];
  for (let h = 0; h < 200; h++) {
    const t = E0 + h * HOUR;
    series.push({
      t, host_t: t, pressure: 12.1, pressure_avg: null, helium: 53,
      compressor_on: h === 0 ? true : null, // one reading, then cable errors
      coldhead_k: null, shield_k: null, temp_alarm: null, quenched: null
    });
    edu_rows.push({ t, room_temp_f: 70, humidity_pct: 45, probe_0_f: 66, probe_1_f: 68, comp_vib: !(h >= 100 && h < 106) });
  }
  const vm = build_render_model({
    identity: philips_identity,
    vendor: VENDORS.PHILIPS,
    series,
    source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME15809", recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" }, output: { html: false, pdf: false, email: false }
    }),
    edu: edu_rows,
    edu_source: "edu.v2"
  });
  assert.strictEqual(vm.facts.compressor_source, "edu_comp_vib", "one stray malf reading is not coverage");
  assert.strictEqual(vm.facts.archetype, "compressor_stop_recovered", "the EDU-measured stop is not hidden");

  // 24 scanner readings IS coverage — the scanner keeps its priority.
  const covered = series.map((r, i) => ({ ...r, compressor_on: i < 24 ? true : null }));
  const vm2 = build_render_model({
    identity: philips_identity, vendor: VENDORS.PHILIPS, series: covered, source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME15809", recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" }, output: { html: false, pdf: false, email: false }
    }),
    edu: edu_rows, edu_source: "edu.v2"
  });
  assert.strictEqual(vm2.facts.compressor_source, "cryo_comp_malf_value", "a covered scanner channel keeps priority");

  // An EDU of nothing but nulls contributes zero readings and changes nothing.
  const null_edu = edu_rows.map((r) => ({ ...r, comp_vib: null }));
  const vm3 = build_render_model({
    identity: philips_identity, vendor: VENDORS.PHILIPS, series: covered, source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME15809", recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" }, output: { html: false, pdf: false, email: false }
    }),
    edu: null_edu, edu_source: "edu.v2"
  });
  assert.strictEqual(vm3.facts.compressor_source, "cryo_comp_malf_value", "all-null comp_vib is no EDU at all");
}

// --- the plausibility screen runs per point, before metrics -----------------
{
  // Codex F3: a 200 PSI reading three weeks ago on a GE (bounds: −1..100)
  // must not own the peak, trip PEAK OVER LIMIT, or reach the chart — while
  // the plausible readings around it stay fully trusted.
  const E0 = Date.UTC(2026, 7, 1);
  const series = [];
  for (let h = 0; h < 200; h++) {
    const t = E0 + h * HOUR;
    series.push({
      t, host_t: t,
      pressure: h === 50 ? 200 : 1.2, pressure_avg: null,
      helium: 80, compressor_on: true, coldhead_k: 4.2,
      shield_k: h === 120 ? 400 : 45, // second garbage point, different row
      temp_alarm: null, quenched: null
    });
  }
  const vm = build_render_model({
    identity: { system_id: "SME99001", manufacturer: "GE", modality: "MRI", site_name: "Bounds General", city: "X", state: "TX", customer_name: "X" },
    vendor: VENDORS.GE,
    series,
    source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME99001", recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" }, output: { html: false, pdf: false, email: false }
    })
  });
  assert.strictEqual(vm.facts.pressure.peak.v, 1.2, "the impossible spike does not own the peak");
  assert.strictEqual(vm.facts.archetype, "stable_healthy", "no PEAK OVER LIMIT from garbage");
  assert.strictEqual(vm.facts.implausible.pressure, 1, "the rejection is counted");
  assert.strictEqual(vm.facts.implausible.shield_k, 1);
  assert.strictEqual(vm.facts.suspect_rows, 0, "impossible readings in DIFFERENT rows never convict");
  assert.strictEqual(vm.facts.last_suspect, false);
  assert.ok(vm.foot_source.includes("2 implausible readings excluded"), "the brief says what it dropped");
  assert.ok(!vm.pressure_chart_svg.includes("200.0"), "the spike stays off the chart");

  // The same two impossible values in ONE capture, still current at the last
  // row, DO convict the chain.
  const aligned = series.map((r, i) =>
    i >= 198 ? { ...r, pressure: -3.625, shield_k: 400 } : r
  );
  const vm2 = build_render_model({
    identity: { system_id: "SME99001", manufacturer: "GE", modality: "MRI", site_name: "Bounds General", city: "X", state: "TX", customer_name: "X" },
    vendor: VENDORS.GE,
    series: aligned,
    source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME99001", recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" }, output: { html: false, pdf: false, email: false }
    })
  });
  assert.ok(vm2.facts.suspect_rows >= 2, "same-capture combination detected");
  assert.strictEqual(vm2.facts.last_suspect, true, "and it is still true at the latest capture");
  assert.strictEqual(vm2.facts.raw_last.pressure, -3.625, "the raw garbage is preserved for display");
}

// --- an implausible coldhead cannot drive inferred compressor state ---------
{
  // Codex re-review F1 (blocker): normalize_ge derives compressor_on from
  // the RAW coldhead, so a 382.8 K garbage reading arrived in the model as
  // compressor_on = false and manufactured an urgent "ongoing stop" from
  // data the screen had rejected. End-to-end through the REAL normalizer.
  const { normalize_ge } = require("../normalize");
  const { build_summary_facts } = require("../compute/summary_facts");
  const { is_urgent, is_attention } = require("../conditions");
  const raw = [];
  for (let h = 0; h < 30; h++) {
    raw.push({
      capture_datetime: new Date(Date.UTC(2026, 7, 1, h)).toISOString(),
      host_datetime: new Date(Date.UTC(2026, 7, 1, h)).toISOString(),
      he_pressure_value: "1.2",
      he_level_value: "80",
      coldhead_ruo_value: h >= 28 ? "382.8" : "4.2", // garbage at the end
      shield_si410_value: "45"
    });
  }
  const series = normalize_ge(raw, VENDORS.GE);
  assert.strictEqual(series[29].compressor_on, false, "the normalizer still derives from raw (screened later)");
  const vm = build_render_model({
    identity: { system_id: "SME99002", manufacturer: "GE", modality: "MRI", site_name: "Inference General", city: "X", state: "TX", customer_name: "X" },
    vendor: VENDORS.GE,
    series,
    source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME99002", recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" }, output: { html: false, pdf: false, email: false }
    })
  });
  assert.strictEqual(vm.facts.archetype, "stable_healthy", "no stop manufactured from rejected readings");
  assert.strictEqual(vm.facts.compressor_events.length, 0, "no event at all");
  assert.strictEqual(vm.facts.last_compressor_on, true, "last TRUSTED inference wins");
  assert.strictEqual(vm.facts.implausible.coldhead_k, 2, "the rejections are still counted");
  const rec = build_summary_facts(vm.facts, { system_id: "SME99002", site_name: "X", customer_name: "X", city: "X", state: "TX", manufacturer: "GE", modality: "MRI" });
  assert.ok(!is_urgent(rec) && !is_attention(rec), "no urgency from data the report excluded");
}

// --- non-TIM shield is ONE physical channel, not two ------------------------
{
  // Codex re-review F2: the normalizer maps shield_temp_value into both the
  // primary slot and shield_k; the alias must not double-count one physical
  // failure into "2 impossible readings — sensor suspect".
  const { normalize_siemens_non_tim } = require("../normalize");
  const { build_summary_facts } = require("../compute/summary_facts");
  const { is_data_issue } = require("../conditions");
  const { build_fleet_model } = require("../render/fleet_model");
  const raw = [];
  const edu_rows = [];
  for (let h = 0; h < 48; h++) {
    const iso = new Date(Date.UTC(2026, 7, 1, h)).toISOString();
    raw.push({
      capture_datetime: iso, host_datetime: iso,
      shield_temp_value: h === 47 ? "382.8" : "45.0", // one garbage reading, latest
      he_level_1_value: "80",
      cca_cab_temp_value: "25", cca_cab_temp_warn_value: "38", cca_cab_temp_alarm_value: "43"
    });
    edu_rows.push({ t: Date.UTC(2026, 7, 1, h), room_temp_f: 70, humidity_pct: 45, probe_0_f: 66, probe_1_f: 68, comp_vib: true });
  }
  const series = normalize_siemens_non_tim(raw);
  assert.strictEqual(series[47].pressure, 382.8, "one sensor, two slots");
  assert.strictEqual(series[47].shield_k, 382.8);
  const vm = build_render_model({
    identity: { system_id: "SME99003", manufacturer: "Siemens", modality: "MRI", site_name: "Alias Medical", city: "X", state: "TX", customer_name: "X" },
    vendor: VENDORS.SIEMENS_NON_TIM,
    series,
    source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME99003", recipients: ["dev@example.com"],
      window: { start: "2026-08-01", end: "2026-08-10" }, output: { html: false, pdf: false, email: false }
    }),
    edu: edu_rows,
    edu_source: "edu.v3"
  });
  assert.strictEqual(vm.facts.implausible.pressure, 1, "counted once, under the canonical channel");
  assert.strictEqual(vm.facts.implausible.shield_k, undefined, "the alias never counts");
  assert.strictEqual(vm.facts.suspect_rows, 0, "one physical failure is not a combination");
  assert.strictEqual(vm.facts.last_suspect, false);
  const rec = build_summary_facts(vm.facts, { system_id: "SME99003", site_name: "X", customer_name: "X", city: "X", state: "TX", manufacturer: "Siemens", modality: "MRI" });
  assert.strictEqual(rec.sensor_suspect, false, "one impossible channel alone never convicts");
  assert.ok(!is_data_issue(rec), "the system stays out of DATA ISSUES");
  assert.strictEqual(rec.implausible_count, 1, "one reading, one count");
  assert.strictEqual(rec.shield_k, null, "the alias is dropped from the record entirely");
  assert.strictEqual(rec.data_flags.shield, false);
  assert.strictEqual(rec.data_flags.primary, true, "the real failure is still flagged, once");
  const flv = build_fleet_model([rec], []);
  const readings = flv.data_issue_readings(rec);
  assert.strictEqual((`${readings.bad}`.match(/✕/g) || []).length, 1, "the raw value renders once, not twice");
}

// --- full page render with no clean baseline --------------------------------
{
  // An early event (h0–h2) and a primary event (h150+) more than 48h apart,
  // with valid metric readings ONLY inside the early event and after the
  // primary starts. Exclusion then leaves no clean pre-event point, so every
  // baseline comparison must drop out rather than compare against the early
  // event's own excursion.
  const B0 = Date.UTC(2026, 7, 1);
  const b_series = [];
  for (let h = 0; h <= 200; h++) {
    const early = h <= 2;
    const primary = h >= 150 && h < 160;
    const measured = early || h >= 150;
    b_series.push({
      t: B0 + h * HOUR,
      host_t: B0 + h * HOUR,
      pressure: measured ? (early ? 200 : 45 + (h - 150)) : null,
      pressure_avg: null,
      helium: measured ? (early ? 90 : 76) : null,
      compressor_on: !(early || primary),
      coldhead_k: null,
      shield_k: null,
      temp_alarm: false,
      quenched: false
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME15822",
    recipients: ["dev@example.com"],
    window: { start: "2026-08-01", end: "2026-08-10" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: philips_identity,
    vendor: VENDORS.PHILIPS,
    series: b_series,
    source: "synthetic",
    request
  });
  assert.strictEqual(vm.facts.compressor_events.length, 2, "two events");
  assert.strictEqual(vm.facts.pressure.baseline, null, "no clean pre-event point");
  assert.strictEqual(vm.facts.pressure.baseline_value, null, "no fabricated baseline");
  assert.strictEqual(vm.facts.pressure.delta_vs_baseline, null, "no delta");
  assert.strictEqual(vm.facts.pressure.rate_per_hr, null, "no ramp rate");
  const page = build_page(vm);
  for (const bad of ["undefined", "NaN"])
    assert.ok(!page.includes(bad), `null-baseline page contains ${bad}`);
  // The excluded event's own value must never be presented as the baseline.
  assert.ok(
    !vm.story_html.includes("rose from 200"),
    `story must not compare against the excluded excursion: ${vm.story_html}`
  );
  assert.ok(vm.story_html.includes("reached a"), "peak reported without a rise-from");
  assert.ok(
    vm.rx_cards[1].body.includes("no clean baseline"),
    `rates card states the gap: ${vm.rx_cards[1].body}`
  );
  // No tile may imply a zero comparison against a baseline that doesn't exist.
  for (const tile of vm.tiles)
    assert.ok(
      !/[+−]0\.0+\s*(pts|mbar)/.test(tile.s),
      `tile implies a zero delta: ${tile.k} ${tile.s}`
    );
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-no-baseline", build_page(vm));
}

// --- request event_window override still renders cleanly --------------------
{
  for (const [label, event_window] of [
    ["recovered", { start: "2026-06-30", end: "2026-07-01" }],
    ["ongoing", { start: "2026-06-30" }]
  ]) {
    const request = normalize_request({
      report_type: "magnet_health",
      system_id: "SME15822",
      recipients: ["dev@example.com"],
      window: { start: "2026-06-28", end: "2026-07-22" },
      event_window,
      output: { html: false, pdf: false, email: false }
    });
    const vm = build_render_model({
      identity: philips_identity,
      vendor: VENDORS.PHILIPS,
      series: philips_series,
      source: "synthetic",
      request
    });
    assert.strictEqual(vm.facts.compressor_events.length, 1, `${label} override is one event`);
    assert.strictEqual(
      vm.facts.compressor_event,
      vm.facts.compressor_events[0],
      `${label} override is the primary`
    );
    const page = build_page(vm);
    for (const bad of ["undefined", "NaN", "null"])
      assert.ok(!page.includes(bad), `${label} override page contains ${bad}`);
  }
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

// --- full page render, Siemens non-TIM synthetic (shield primary metric,
// --- EDU-vibration compressor, ongoing stop) --------------------------------
{
  const N0 = Date.UTC(2026, 7, 1);
  const nt_series = [];
  const nt_edu = [];
  for (let i = 0; i < 300; i++) {
    const t = N0 + i * HOUR;
    const warm = i >= 270; // compressor stops at hour 270, never recovers
    nt_series.push({
      t,
      host_t: t,
      pressure: warm ? 45 + (i - 270) * 2 : 45, // shield K in the primary slot
      pressure_avg: null,
      helium: 80,
      compressor_on: null, // non-TIM mag data has no compressor state
      coldhead_k: null,
      shield_k: warm ? 45 + (i - 270) * 2 : 45,
      cab_temp: 25,
      cab_warn: 38,
      cab_alarm: 43,
      temp_alarm: null,
      temp_alarm_minutes: null,
      room_temp_c: null,
      quenched: null
    });
    nt_edu.push({
      t,
      room_temp_f: 70,
      humidity_pct: 45,
      probe_0_f: 66,
      probe_1_f: 68,
      comp_vib: !warm
    });
  }
  const request = normalize_request({
    report_type: "magnet_health",
    system_id: "SME01136",
    recipients: ["dev@example.com"],
    window: { start: "2026-08-01", end: "2026-08-13" },
    output: { html: false, pdf: false, email: false }
  });
  const vm = build_render_model({
    identity: {
      system_id: "SME01136",
      manufacturer: "Siemens",
      modality: "MRI",
      site_name: "Piedmont Newnan",
      city: "Newnan",
      state: "GA",
      customer_name: "Piedmont"
    },
    vendor: VENDORS.SIEMENS_NON_TIM,
    series: nt_series,
    source: "synthetic",
    request,
    edu: nt_edu,
    edu_source: "edu.v2"
  });
  assert.strictEqual(
    vm.facts.archetype,
    "compressor_stop_ongoing",
    "EDU-vibration compressor stop detected"
  );
  assert.deepStrictEqual(
    vm.tiles.map((t) => t.k),
    ["COMPRESSOR", "SHIELD NOW", "EVENT PEAK", "CABINET", "HELIUM"]
  );
  assert.ok(vm.pressure_heading.startsWith("SHIELD TEMP"), vm.pressure_heading);
  assert.ok(vm.pressure_chart_svg.includes("SIEMENS ALERT — 100 K"), "shield alert line");
  assert.ok(vm.tiles[3].s.includes("warn 38 · alarm 43"), `cabinet tile: ${vm.tiles[3].s}`);
  assert.ok(
    vm.story_html.includes("per EDU vibration sensor"),
    "narrative cites EDU vibration source"
  );
  assert.ok(
    vm.story_html.includes("Shield temp rose"),
    "narrative uses primary-metric name"
  );
  // Padded (non-anchored) domain must never produce negative axis ticks
  assert.ok(
    !/>-\d/.test(vm.pressure_chart_svg),
    "no negative shield-temp axis ticks"
  );
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-non-tim", build_page(vm));
}

// --- brief/fleet parity: sensor-suspect conviction --------------------------
{
  // The SME20122 disagreement, as a regression test: the fleet convicted the
  // sensor chain while the brief reported a live helium emergency with full
  // confidence. Whatever the design, a convicted system's brief must NOT
  // claim confident magnet state. Raw rows go through the REAL GE mapper;
  // the EDU (separate hardware) measures a real ongoing stop underneath the
  // garbage, exactly like the live case.
  const { normalize_ge } = require("../normalize");
  const { build_summary_facts } = require("../compute/summary_facts");
  const { effective_status, is_data_issue, STATUS_LABELS } = require("../conditions");
  const raw = [];
  const edu_rows = [];
  const GARBAGE_H = 600; // day 25 of 30
  for (let h = 0; h < 720; h++) {
    const iso = new Date(Date.UTC(2026, 6, 1, h)).toISOString();
    const bad = h >= GARBAGE_H;
    raw.push({
      capture_datetime: iso, host_datetime: iso,
      he_pressure_value: bad ? "-3.625" : "1.2",
      he_level_value: bad ? "0.0" : "70",
      coldhead_ruo_value: bad ? "383" : "4.2",
      shield_si410_value: bad ? "382.8" : "45"
    });
    edu_rows.push({ t: Date.UTC(2026, 6, 1, h), room_temp_f: 70, humidity_pct: 45, probe_0_f: 66, probe_1_f: 68, comp_vib: !bad });
  }
  const series = normalize_ge(raw, VENDORS.GE);
  const request = normalize_request({
    report_type: "magnet_health", system_id: "SME99004", recipients: ["dev@example.com"],
    window: { start: "2026-07-01", end: "2026-07-31" }, output: { html: false, pdf: false, email: false }
  });
  const identity = { system_id: "SME99004", manufacturer: "GE", modality: "MRI", site_name: "Suspect Memorial", city: "X", state: "TX", customer_name: "X" };
  const vm = build_render_model({ identity, vendor: VENDORS.GE, series, source: "synthetic", request, edu: edu_rows, edu_source: "edu.v2" });
  assert.strictEqual(vm.facts.last_suspect, true, "latest capture combines impossible values");
  assert.strictEqual(vm.facts.compressor_source, "edu_comp_vib", "EDU outranks the poisoned inference");
  assert.strictEqual(vm.facts.archetype, "compressor_stop_ongoing", "the EDU stop underneath is real");
  // The banner reframes the page, in the fleet's shared words.
  assert.ok(vm.banner, "suspect page carries the banner");
  assert.ok(vm.banner.label.startsWith(STATUS_LABELS.sensor_suspect.toUpperCase()), `shared label: ${vm.banner.label}`);
  assert.ok(vm.banner.text.includes("impossible reading"), vm.banner.text);
  // Tiles: EDU compressor stays confident; every other tile suspends judgment.
  const [comp, coldhead, p_now, peak, helium] = vm.tiles;
  assert.strictEqual(comp.cls, "bad", "EDU-measured OFF stays confident");
  assert.strictEqual(comp.v, "OFF", "measured state carries no ᶜ");
  for (const t of [coldhead, p_now, peak, helium])
    assert.strictEqual(t.cls, "dim", `no confident magnet state on a convicted page: ${t.k} is ${t.cls}`);
  assert.ok(p_now.v.includes("-3.625") && p_now.v.includes("‡"), `raw greyed with ‡: ${p_now.v}`);
  assert.ok(coldhead.v.includes("383") && coldhead.v.includes("‡"), `flagged coldhead shows raw: ${coldhead.v}`);
  assert.strictEqual(helium.v, "0.00%", "the sensor's helium claim is shown");
  assert.ok(!helium.s.includes("below the"), `no alert-level claim on a convicted page: ${helium.s}`);
  assert.ok(vm.story_html.startsWith("<b>Monitoring suspect:</b>"), "story leads with the monitoring problem");
  assert.ok(vm.rx_cards[0].heading.includes("sensor's claims"), vm.rx_cards[0].heading);
  // Banner pages trade chart height for the banner's room.
  assert.ok(vm.pressure_chart_svg.includes('viewBox="0 0 640 100"'), "suspect charts render short");
  assert.ok(build_page(vm).includes('class="banner"'), "banner div rendered");
  // Parity: the fleet record reaches the same verdict from the same facts.
  const rec = build_summary_facts(vm.facts, identity);
  assert.strictEqual(rec.sensor_suspect, true);
  assert.strictEqual(effective_status(rec), "sensor_suspect");
  assert.ok(is_data_issue(rec), "fleet files it as a data issue");
  write_html(path.join(__dirname, "..", "out"), "dev-synthetic-suspect", build_page(vm));
  // A recorded quench overrides the conviction: no banner, no dimming —
  // missing a real quench is the costlier error.
  const q_series = series.map((r, i) => (i === series.length - 1 ? { ...r, quenched: true } : r));
  const qvm = build_render_model({ identity, vendor: VENDORS.GE, series: q_series, source: "synthetic", request, edu: edu_rows, edu_source: "edu.v2" });
  assert.strictEqual(qvm.banner, null, "quench overrides the suspect banner");
  assert.ok(qvm.tiles[4].s.includes("QUENCH"), "helium tile states the quench");
  assert.ok(!qvm.tiles[4].s.includes("not judged"), "quench page is not reframed as claims");
}

// --- brief/fleet parity: left-censored, corroborated warm -------------------
{
  // A magnet whose compressor was never seen ON, with coverage from the
  // period start and a warm coldhead vouching for the stop: the brief must
  // not headline an observed stop with a fabricated month-long hour count.
  const { normalize_ge } = require("../normalize");
  const { build_summary_facts } = require("../compute/summary_facts");
  const { effective_status, is_urgent, STATUS_LABELS } = require("../conditions");
  const raw = [];
  for (let h = 0; h < 720; h++) {
    const iso = new Date(Date.UTC(2026, 6, 1, h)).toISOString();
    raw.push({
      capture_datetime: iso, host_datetime: iso,
      he_pressure_value: "2.1", he_level_value: "60",
      coldhead_ruo_value: "146", shield_si410_value: "140"
    });
  }
  const identity = { system_id: "SME99005", manufacturer: "GE", modality: "MRI", site_name: "Warm Springs Imaging", city: "X", state: "TX", customer_name: "X" };
  const vm = build_render_model({
    identity, vendor: VENDORS.GE, series: normalize_ge(raw, VENDORS.GE), source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME99005", recipients: ["dev@example.com"],
      window: { start: "2026-07-01", end: "2026-07-31" }, output: { html: false, pdf: false, email: false }
    })
  });
  assert.strictEqual(vm.facts.left_censored, true);
  assert.strictEqual(vm.facts.offline_kind, "warm");
  const comp = vm.tiles[0];
  assert.strictEqual(comp.cls, "warn", "amber, matching the fleet's never-urgent stance");
  assert.strictEqual(comp.v, "OFFᶜ", "inferred state keeps its mark");
  assert.ok(comp.s.includes(`${STATUS_LABELS.warm_offline.toLowerCase()}ᶜ`), `shared vocabulary: ${comp.s}`);
  assert.ok(!comp.s.includes("off ~"), `no fabricated hour count: ${comp.s}`);
  assert.ok(vm.story_html.includes("off the entire periodᶜ"), "story states the overlay");
  assert.ok(!vm.story_html.includes("Warming event OPEN"), "no open-event alarm line");
  assert.ok(!vm.story_html.includes("off ~"), "no fabricated downtime in the story");
  assert.strictEqual(vm.banner, null, "warm offline is a magnet state, not a banner");
  assert.ok(vm.rx_cards[0].body.includes("off entire periodᶜ"), vm.rx_cards[0].body);
  assert.ok(vm.rx_cards[2].body.includes("ᶜ = concluded"), "legend line on a marked, bannerless page");
  const rec = build_summary_facts(vm.facts, identity);
  assert.strictEqual(rec.offline_kind, "warm");
  assert.strictEqual(effective_status(rec), "warm_offline");
  assert.ok(!is_urgent(rec), "never urgent");
  // Codex round-1 F2: the quench override must gate the overlay VERDICT in
  // ONE place (offline_state), so the brief and the fleet record cannot
  // reach different conclusions from the same facts. The censoring FACT
  // survives: the fleet history cell still says "entire period".
  {
    const q_series = normalize_ge(raw, VENDORS.GE).map((r, i) =>
      i === 719 ? { ...r, quenched: true } : r
    );
    const qvm = build_render_model({
      identity, vendor: VENDORS.GE, series: q_series, source: "synthetic",
      request: normalize_request({
        report_type: "magnet_health", system_id: "SME99005", recipients: ["dev@example.com"],
        window: { start: "2026-07-01", end: "2026-07-31" }, output: { html: false, pdf: false, email: false }
      })
    });
    assert.strictEqual(qvm.facts.offline_kind, null, "quench suppresses the overlay on the brief");
    assert.strictEqual(qvm.facts.left_censored, true, "the censoring fact is not erased");
    assert.ok(!qvm.story_html.includes("off the entire periodᶜ"), "quench story is not reframed");
    const qrec = build_summary_facts(qvm.facts, identity);
    assert.strictEqual(qrec.offline_kind, null, "fleet record gates identically");
    assert.strictEqual(qrec.left_censored, true, "history cell still reads entire period");
    assert.strictEqual(effective_status(qrec), null, "no overlay label competes with QUENCH");
    assert.ok(is_urgent(qrec), "the quench itself stays urgent");
  }
}

// --- brief/fleet parity: left-censored, no thermal response (no signal) -----
{
  // A Philips whose malf channel has claimed "off" since before the period
  // opened while the magnet sits cold and calm: the signal is lying. The
  // brief gets the data-issue banner; the other channels keep their
  // judgments — only the compressor channel is convicted.
  const { normalize_philips } = require("../normalize");
  const { build_summary_facts } = require("../compute/summary_facts");
  const { effective_status, is_data_issue, STATUS_LABELS } = require("../conditions");
  const raw = [];
  for (let h = 0; h < 720; h++) {
    const iso = new Date(Date.UTC(2026, 6, 1, h)).toISOString();
    raw.push({
      capture_datetime: iso, host_datetime: iso,
      monitor_magnet_pressure_value: "29", he_psi_avg_value: "29",
      helium_level_value: "76.5",
      cryo_comp_malf_value: "60", // alarm-minutes: "off" all period
      cryo_comp_temp_alarm_state: "0", tech_room_temp_value: "21", quenched_state: "0"
    });
  }
  const identity = { system_id: "SME99006", manufacturer: "Philips", modality: "MRI", site_name: "Dead Signal Clinic", city: "X", state: "TN", customer_name: "X" };
  const vm = build_render_model({
    identity, vendor: VENDORS.PHILIPS, series: normalize_philips(raw, VENDORS.PHILIPS), source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME99006", recipients: ["dev@example.com"],
      window: { start: "2026-07-01", end: "2026-07-31" }, output: { html: false, pdf: false, email: false }
    })
  });
  assert.strictEqual(vm.facts.left_censored, true);
  assert.strictEqual(vm.facts.offline_kind, "no_signal");
  assert.ok(vm.banner, "no-signal page carries the data-issue banner");
  assert.ok(vm.banner.label.startsWith(STATUS_LABELS.no_signal.toUpperCase()), `shared label: ${vm.banner.label}`);
  const comp = vm.tiles[0];
  assert.strictEqual(comp.v, "—", "no state claimed from a lying signal");
  assert.strictEqual(comp.s, `${STATUS_LABELS.no_signal}ᶜ`, `shared vocabulary: ${comp.s}`);
  // Unlike sensor-suspect, the magnet's own channels stay judged.
  const p_now = vm.tiles.find((t) => t.k === "PRESSURE NOW");
  assert.strictEqual(p_now.cls, "good", "pressure keeps its judgment — only the compressor channel is convicted");
  assert.ok(vm.story_html.includes("No compressor signalᶜ"), "story states the overlay");
  assert.ok(!vm.story_html.includes("off ~"), "no fabricated downtime");
  assert.ok(vm.pressure_chart_svg.includes('viewBox="0 0 640 100"'), "banner pages render short charts");
  const rec = build_summary_facts(vm.facts, identity);
  assert.strictEqual(rec.offline_kind, "no_signal");
  assert.strictEqual(effective_status(rec), "no_signal");
  assert.ok(is_data_issue(rec), "fleet files it as a data issue");
}

// --- stale NOW and single-channel ‡ without a conviction --------------------
{
  // The plausibility screen's silent failure mode: a channel that stops
  // reporting shows its last clean reading — days old — as "NOW". And one
  // garbage channel alone (helium 250%, not bone-dry) is a flag, not a
  // conviction: that tile greys, the rest of the page stays judged.
  const { normalize_ge } = require("../normalize");
  const { build_summary_facts } = require("../compute/summary_facts");
  const raw = [];
  const P_SILENT_H = 576; // pressure channel goes silent on day 24 of 30
  for (let h = 0; h < 720; h++) {
    const iso = new Date(Date.UTC(2026, 6, 1, h)).toISOString();
    raw.push({
      capture_datetime: iso, host_datetime: iso,
      he_pressure_value: h >= P_SILENT_H ? null : "1.2",
      he_level_value: h === 719 ? "250" : "70", // garbage only at the end
      coldhead_ruo_value: "4.2", shield_si410_value: "45"
    });
  }
  const identity = { system_id: "SME99007", manufacturer: "GE", modality: "MRI", site_name: "Stale Acres", city: "X", state: "TX", customer_name: "X" };
  const vm = build_render_model({
    identity, vendor: VENDORS.GE, series: normalize_ge(raw, VENDORS.GE), source: "synthetic",
    request: normalize_request({
      report_type: "magnet_health", system_id: "SME99007", recipients: ["dev@example.com"],
      window: { start: "2026-07-01", end: "2026-07-31" }, output: { html: false, pdf: false, email: false }
    })
  });
  assert.strictEqual(vm.facts.last_suspect, false, "one impossible channel alone never convicts");
  assert.strictEqual(vm.banner, null);
  const p_now = vm.tiles.find((t) => t.k === "PRESSURE NOW");
  assert.ok(p_now.s.startsWith("as of Jul 24 · "), `stale reading says which day it is from: ${p_now.s}`);
  assert.strictEqual(p_now.cls, "good", "stale is a caveat, not a conviction — judgment stands");
  const helium = vm.tiles.find((t) => t.k === "HELIUM");
  assert.strictEqual(helium.cls, "dim");
  assert.ok(helium.v.includes("250") && helium.v.includes("‡"), `flagged channel shows raw greyed: ${helium.v}`);
  assert.ok(helium.s.includes("not judged"), helium.s);
  assert.ok(vm.pressure_chart_svg.includes('viewBox="0 0 640 152"'), "no banner, full-height charts");
  const rec = build_summary_facts(vm.facts, identity);
  assert.strictEqual(rec.sensor_suspect, false);
  assert.strictEqual(rec.data_flags.helium, true, "fleet greys the same channel");
}

console.log("check_chart: all assertions passed");
