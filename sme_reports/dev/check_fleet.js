// Fleet summary model + multi-page render checks with synthetic records
// (no DB required). Run: node sme_reports/dev/check_fleet.js
// Also writes sme_reports/out/Avante-dev-fleet-summary-Magnet-Health.{html,pdf}
// for eyeballing — page-BREAK placement is only observable in the PDF.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  build_fleet_model,
  customer_failure_reason,
  chunk_rows,
  group_failures,
  ROWS_PER_PAGE,
  ROWS_FIRST_PAGE,
  FAILURE_IDS_PER_ROW,
  section_limit,
  SECTIONS
} = require("../render/fleet_model");
const { build_fleet_page, esc, trunc } = require("../render/fleet_page");
const {
  build_summary_facts,
  is_centered_band,
  band_state,
  breach_direction
} = require("../compute/summary_facts");
const {
  severity_rank,
  by_severity,
  condition_label,
  condition_short,
  attention_sort,
  is_attention,
  is_urgent,
  is_data_issue,
  condition_cell_record,
  ATTENTION,
  URGENT
} = require("../conditions");
const write_html = require("../output/write_html");

const HOUR = 3600000;
const T0 = Date.UTC(2026, 7, 1);
const W_END = T0 + 30 * 24 * HOUR;

// A synthetic distilled record. Defaults describe a healthy Philips system;
// overrides shape each scenario.
const rec = (over = {}) => ({
  system_id: "SME00001",
  site_name: "Test Site",
  customer_name: "TestCo",
  city: "Testville",
  state: "TN",
  manufacturer: "Philips",
  modality: "MRI",
  vendor_key: "PHILIPS",
  archetype: "stable_healthy",
  primary_name: "He pressure",
  primary_value: 33,
  primary_units: "mbar",
  primary_decimals: 0,
  primary_pct: 41,
  primary_band: null,
  primary_band_pos: null,
  primary_breach: null,
  primary_severity: "ok",
  primary_peak: 35,
  primary_peak_t: T0,
  primary_min: 29,
  primary_delta: -2,
  primary_trend: null,
  thr_high_gt: 80,
  thr_high_lt: null,
  thr_source: "alert_model",
  helium_value: 76.5,
  helium_units: "%",
  helium_decimals: 1,
  helium_delta: -0.4,
  helium_low_high: 60,
  coldhead_k: null,
  coldhead_warm_k: null,
  shield_k: null,
  cabinet_c: null,
  cabinet_warn: null,
  cabinet_alarm: null,
  temp_alarm_runs: null,
  quenched: false,
  compressor_on: true,
  compressor_source: "cryo_comp_malf_value",
  event_count: 0,
  off_hours_total: 0,
  primary_event: null,
  flicker_count: 0,
  captures: 1440,
  valid_pressure: 1440,
  valid_helium: 1440,
  clock_skew_minutes: 0,
  window_start: T0,
  window_end: W_END,
  window_hours: 720,
  data_flags: { primary: false, helium: false, coldhead: false, shield: false, cabinet: false },
  implausible_count: 0,
  sensor_suspect: false,
  left_censored: false,
  offline_kind: null,
  ...over
});

// --- conditions vocabulary --------------------------------------------------
{
  // Severity order must match compute/archetype.js priority: a recovered
  // compressor stop outranks a threshold breach.
  assert.ok(
    severity_rank("compressor_stop_recovered") < severity_rank("threshold_exceeded"),
    "recovered stop outranks threshold exceeded"
  );
  assert.ok(
    severity_rank("compressor_stop_ongoing") < severity_rank("compressor_stop_recovered")
  );
  assert.ok(ATTENTION.has("compressor_stop_recovered"), "recovered stops need attention");
  assert.ok(!ATTENTION.has("stable_healthy"));
  assert.ok(!URGENT.has("compressor_stop_recovered"), "recovered is not urgent");
  assert.ok(URGENT.has("compressor_stop_ongoing"));
  // An unknown archetype must sort LAST, not first (indexOf would give -1).
  assert.ok(
    severity_rank("something_new") > severity_rank("stable_healthy"),
    "unknown archetype sorts last"
  );
  const sorted = [{ archetype: "stable_healthy" }, { archetype: "compressor_stop_ongoing" }].sort(
    by_severity
  );
  assert.strictEqual(sorted[0].archetype, "compressor_stop_ongoing");
}

// --- summary_facts distillation ---------------------------------------------
{
  const facts = {
    vendor: {
      key: "GE",
      primary: { name: "He pressure" },
      pressure: { decimals: 3 },
      helium: { decimals: 2 },
      coldhead: { warm_k: 10 }
    },
    thr: { high_gt: 5, high_lt: null, med_gt: null, med_lt: null, source: "alert_model" },
    he_thr: { low_high: 60, low_med: 70, units: "%" },
    units: { pressure: "PSI", helium: "%" },
    window_start: T0,
    window_end: W_END,
    // Real events always carry off_count — it is what distinguishes an
    // observed stop from a hand-supplied window with nothing in it.
    compressor_event: { start: T0, end: T0 + 4 * HOUR, off_hours: 4, cycles: 1, off_count: 5 },
    compressor_events: [
      { start: T0, end: T0 + 4 * HOUR, off_hours: 4, cycles: 1, off_count: 5 },
      { start: T0 + 200 * HOUR, end: T0 + 202 * HOUR, off_hours: 2, cycles: 1, off_count: 3 }
    ],
    temp_alarm: null,
    quenched: false,
    // Shaped like real metric_facts output: `all` is always present when the
    // metric object itself is non-null.
    pressure: {
      all: { min: { v: 1.2, t: T0 }, max: { v: 4.2, t: T0 }, first: { v: 1.5, t: T0 }, last: { v: 3.66, t: W_END } },
      last: { v: 3.66, t: W_END },
      peak: { v: 4.2, t: T0 },
      delta_vs_baseline: 0.5,
      rate_per_hr: null
    },
    helium: {
      all: { min: { v: 79.9, t: T0 }, max: { v: 81, t: T0 }, first: { v: 80, t: T0 }, last: { v: 80.69, t: W_END } },
      last: { v: 80.69, t: W_END },
      peak: { v: 81, t: T0 },
      delta_vs_baseline: 0.8
    },
    coldhead: { last: { v: 4.457, t: W_END } },
    shield: { last: { v: 51.2, t: W_END } },
    cabinet: null,
    room_temp: null,
    edu: null,
    compressor_source: "coldhead_ruo_value",
    compressor_flickers: { count: 2, times: [T0] },
    last_compressor_on: true,
    counts: { captures: 388, pressure: 380, helium: 379 },
    clock_skew_minutes: 72,
    chart_mode: "line",
    archetype: "compressor_stop_recovered"
  };
  const identity = {
    system_id: "SME21824",
    site_name: "MAK Algonquin",
    customer_name: "Northside",
    city: "Algonquin",
    state: "IL",
    manufacturer: "GE",
    modality: "MRI"
  };
  const s = build_summary_facts(facts, identity);

  assert.strictEqual(s.system_id, "SME21824");
  assert.strictEqual(s.vendor_key, "GE");
  assert.strictEqual(s.primary_value, 3.66);
  assert.strictEqual(s.primary_units, "PSI");
  assert.strictEqual(s.primary_pct, 73, "3.66 / 5 -> 73% of the line");
  assert.strictEqual(s.primary_band, null, "one-sided metric has no band state");
  assert.strictEqual(s.coldhead_k, 4.457);
  assert.strictEqual(s.coldhead_warm_k, 10);
  assert.strictEqual(s.shield_k, 51.2, "GE shield_si410 surfaced");
  assert.strictEqual(s.event_count, 2);
  assert.strictEqual(s.off_hours_total, 6, "off hours summed across events");
  assert.strictEqual(s.primary_event.off_hours, 4);
  assert.strictEqual(s.flicker_count, 2);
  assert.strictEqual(s.helium_low_high, 60, "matching units -> threshold applies");
  assert.strictEqual(s.captures, 388);

  // LTRS helium must not be judged against a % threshold.
  const ltrs = build_summary_facts(
    { ...facts, units: { pressure: "PSI", helium: "LTRS" } },
    identity
  );
  assert.strictEqual(ltrs.helium_low_high, null, "unit mismatch suppresses the threshold");

  // Centered band (Siemens absolute pressure, normal sits mid-band at ~15.3):
  // band state only. A percentage would call a healthy magnet "93% of line".
  const siemens_thr = {
    high_gt: 16.4,
    high_lt: 14.4,
    med_gt: null,
    med_lt: null,
    source: "alert_model"
  };
  const band = build_summary_facts(
    { ...facts, thr: siemens_thr, pressure: { ...facts.pressure, last: { v: 15.3, t: W_END } } },
    identity
  );
  assert.strictEqual(band.primary_pct, null, "no percentage against a centered band");
  assert.strictEqual(band.primary_band, "within");
  // 15.3 between 14.4 and 16.4 -> 45% of the way up the band.
  assert.ok(Math.abs(band.primary_band_pos - 0.45) < 1e-9, "band position computed");
  const above_band = build_summary_facts(
    { ...facts, thr: siemens_thr, pressure: { ...facts.pressure, last: { v: 16.9, t: W_END } } },
    identity
  );
  assert.ok(above_band.primary_band_pos > 1, "outside the band reads past 1");
  assert.strictEqual(s.primary_band_pos, null, "one-sided systems have no band position");
  const low = build_summary_facts(
    { ...facts, thr: siemens_thr, pressure: { ...facts.pressure, last: { v: 14.0, t: W_END } } },
    identity
  );
  assert.strictEqual(low.primary_band, "below");

  // A FLOOR alarm under a one-sided metric is not a centered band. Live GE
  // systems carry 0.5–5.2 PSI: normal sits near the bottom and rises toward
  // the high line, so the percentage is meaningful and must survive.
  const floored = build_summary_facts(
    {
      ...facts,
      thr: { high_gt: 5.2, high_lt: 0.5, med_gt: null, med_lt: null, source: "alert_model" },
      pressure: { ...facts.pressure, last: { v: 1.899, t: W_END } }
    },
    identity
  );
  assert.strictEqual(floored.primary_pct, 37, "1.899 / 5.2 -> 37% despite the floor alarm");
  assert.strictEqual(floored.primary_band, "within", "band state still tracked for breaches");
  assert.ok(is_centered_band(siemens_thr), "14.4/16.4 is centered");
  assert.ok(
    !is_centered_band({ high_gt: 5.2, high_lt: 0.5 }),
    "0.5/5.2 is a floor alarm, not a centered band"
  );

  // No metric data at all, and no configured threshold.
  const empty = build_summary_facts(
    {
      ...facts,
      thr: { high_gt: null, high_lt: null, med_gt: null, med_lt: null, source: "oem_constant" },
      pressure: null,
      helium: null,
      coldhead: null,
      shield: null,
      compressor_event: null,
      compressor_events: [],
      compressor_flickers: null,
      last_compressor_on: null
    },
    identity
  );
  assert.strictEqual(empty.primary_value, null);
  assert.strictEqual(empty.primary_pct, null);
  assert.strictEqual(empty.helium_value, null);
  assert.strictEqual(empty.compressor_on, null, "null state must stay null, never false");
  assert.strictEqual(empty.event_count, 0);
  assert.strictEqual(empty.off_hours_total, 0);
}

// --- pagination arithmetic --------------------------------------------------
{
  assert.deepStrictEqual(chunk_rows([], 26, 30), [], "no rows -> no pages");
  assert.strictEqual(chunk_rows(new Array(1).fill(0), 26, 30).length, 1);
  assert.strictEqual(chunk_rows(new Array(26).fill(0), 26, 30).length, 1, "exactly one page");
  assert.strictEqual(chunk_rows(new Array(27).fill(0), 26, 30).length, 2, "one over spills");
  assert.strictEqual(chunk_rows(new Array(56).fill(0), 26, 30).length, 2);
  assert.strictEqual(chunk_rows(new Array(57).fill(0), 26, 30).length, 3);
  // Every row lands on exactly one page.
  const rows = Array.from({ length: 163 }, (_, i) => i);
  const pages = chunk_rows(rows, ROWS_FIRST_PAGE, ROWS_PER_PAGE);
  assert.deepStrictEqual(pages.flat(), rows, "no row dropped or duplicated");
}

// --- failure grouping -------------------------------------------------------
{
  const grouped = group_failures([
    { system_id: "SME00001", message: "no PHILIPS monitor data for SME00001 in the requested window" },
    { system_id: "SME00002", message: "no PHILIPS monitor data for SME00002 in the requested window" },
    { system_id: "SME00003", message: "unsupported manufacturer" }
  ]);
  assert.strictEqual(grouped.length, 2, "identical causes collapse into one row");
  assert.strictEqual(grouped[0].count, 2, "most common reason first");
  assert.deepStrictEqual(grouped[0].systems, ["SME00001", "SME00002"]);
  assert.ok(!grouped[0].reason.includes("SME00001"), "system id stripped from the shared reason");
}

// --- model rollup -----------------------------------------------------------
{
  const records = [
    rec({ system_id: "SME00001", archetype: "compressor_stop_ongoing" }),
    rec({ system_id: "SME00002", archetype: "compressor_stop_recovered" }),
    rec({ system_id: "SME00003", archetype: "threshold_exceeded" }),
    rec({ system_id: "SME00004", archetype: "stable_healthy" }),
    rec({ system_id: "SME00005", archetype: "stable_healthy" })
  ];
  const vm = build_fleet_model(records, []);
  assert.strictEqual(vm.total, 5);
  assert.strictEqual(vm.attention_count, 3, "everything but the two stable systems");
  // Only the ongoing stop is urgent: the threshold_exceeded record's peak is
  // historical and its CURRENT reading is within limits.
  assert.strictEqual(vm.urgent_count, 1, "a settled breach is listed, not urgent");
  const breaching = build_fleet_model(
    records.map((r) =>
      r.archetype === "threshold_exceeded"
        ? { ...r, primary_breach: "high", primary_severity: "high" }
        : r
    ),
    []
  );
  assert.strictEqual(breaching.urgent_count, 2, "a live breach is urgent");
  assert.strictEqual(vm.attention[0].archetype, "compressor_stop_ongoing", "worst first");
  assert.strictEqual(vm.condition_rollup[0].label, "STOP, ONGOING");
  assert.strictEqual(vm.condition_rollup.find((c) => c.label === "stable").count, 2);
  assert.strictEqual(vm.page_count, 2, "overview + one Philips page");
  assert.strictEqual(vm.sections.length, 1, "vendors with no members are dropped");
  assert.strictEqual(vm.sections[0].vendor_key, "PHILIPS");
}

// --- empty / degenerate models ----------------------------------------------
{
  const none = build_fleet_model([], []);
  assert.strictEqual(none.total, 0);
  assert.strictEqual(none.page_count, 1, "overview only");
  assert.strictEqual(none.sections.length, 0);
  assert.ok(build_fleet_page(none).includes("No systems produced data"));

  const all_failed = build_fleet_model([], [{ system_id: "SME00001", message: "no data" }]);
  assert.strictEqual(all_failed.failure_count, 1);
  const html = build_fleet_page(all_failed);
  assert.ok(html.includes("NO REPORT PRODUCED"));
  for (const bad of ["undefined", "NaN"])
    assert.ok(!html.includes(bad), `all-failures page contains ${bad}`);
}

// --- escaping ---------------------------------------------------------------
{
  assert.strictEqual(esc(`Smith & Sons <West> "Main"`), "Smith &amp; Sons &lt;West&gt; &quot;Main&quot;");
  assert.strictEqual(esc(null), "");
  assert.strictEqual(trunc("abcdefghij", 5), "abcd…");
  assert.strictEqual(trunc("abc", 5), "abc");

  const vm = build_fleet_model([rec({ site_name: `Smith & Sons <script>` })], []);
  const html = build_fleet_page(vm);
  assert.ok(!html.includes("<script>"), "site name markup must not reach the document");
  assert.ok(html.includes("Smith &amp; Sons"), "ampersand escaped");
}

// --- per-vendor sections and cell rendering ---------------------------------
{
  const records = [
    rec({ system_id: "SME15822", vendor_key: "PHILIPS", temp_alarm_runs: 4 }),
    rec({
      system_id: "SME21824",
      vendor_key: "GE",
      manufacturer: "GE",
      primary_units: "PSI",
      primary_decimals: 3,
      primary_value: 3.66,
      primary_pct: 73,
      helium_decimals: 2,
      helium_value: 80.69,
      coldhead_k: 4.457,
      coldhead_warm_k: 10,
      shield_k: 51.2
    }),
    rec({
      system_id: "SME20557",
      vendor_key: "SIEMENS",
      manufacturer: "Siemens",
      primary_units: "PSI",
      primary_decimals: 2,
      primary_value: 15.3,
      primary_pct: null,
      primary_band: "within",
      primary_band_pos: 0.55,
      thr_high_lt: 14.4,
      thr_high_gt: 16.4,
      helium_units: "LTRS",
      helium_value: 968,
      helium_low_high: null,
      coldhead_k: 43,
      coldhead_warm_k: 55
    }),
    rec({
      system_id: "SME01136",
      vendor_key: "SIEMENS_NON_TIM",
      manufacturer: "Siemens",
      primary_name: "Shield temp",
      primary_units: "K",
      primary_decimals: 1,
      primary_value: 45,
      primary_pct: 45,
      thr_high_gt: 100,
      cabinet_c: 25,
      cabinet_warn: 38,
      cabinet_alarm: 43,
      compressor_source: "edu_comp_vib"
    })
  ];
  const vm = build_fleet_model(records, []);
  assert.strictEqual(vm.sections.length, 4, "all four variants present");
  assert.strictEqual(vm.page_count, 5, "overview + one page per variant");

  const html = build_fleet_page(vm);
  for (const bad of ["undefined", "NaN"])
    assert.ok(!html.includes(bad), `page contains ${bad}`);

  // Column sets differ per vendor and carry only channels that exist.
  assert.ok(html.includes(">ALARM<"), "Philips section has a temp alarm column");
  assert.ok(html.includes("SHIELD"), "GE section has a shield column");
  assert.ok(html.includes("CABINET"), "non-TIM section has a cabinet column");
  assert.ok(html.includes("COLDHD"), "GE/Siemens sections have a coldhead column");
  // Units live in the section heading, not the NOW header — that header has
  // no room for them, and "NOW (mbar)" was being clipped to "NOW (mbar".
  assert.ok(html.includes("&gt;80 mbar"), "Philips units stated in its heading");
  assert.ok(html.includes("PSI"), "GE/Siemens units stated in their headings");
  assert.ok(html.includes("100 K"), "non-TIM shield temp units stated in its heading");
  assert.ok(!html.includes("NOW (m"), "units are not crammed into the column header");

  // A centered band reads "in band"; a breach in either direction outranks
  // any percentage, because that is the fact worth seeing first.
  // Centered bands draw a miniature gauge — a dot between the two alert
  // edges — instead of the word "band", which told a reader nothing.
  assert.ok(html.includes('class="bg"'), "band gauge rendered");
  assert.ok(/class="d" style="left:55\.0%;"/.test(html), "dot sits at the reading's position");
  assert.ok(html.includes(">WITHIN BAND<"), "banded section titles its ratio column by the gauge");
  assert.ok(html.includes("% OF LIMIT"), "one-sided sections keep the percentage title");
  assert.strictEqual(
    (html.match(/\(16\.3\)/g) || []).length,
    1,
    "own-limit bracket survives only as the legend's example — gauges are self-relative"
  );
  // Near-edge dots turn amber.
  const edge_row = rec({
    system_id: "SME00009",
    vendor_key: "SIEMENS",
    manufacturer: "Siemens",
    primary_units: "PSI",
    primary_pct: null,
    primary_band: "within",
    primary_band_pos: 0.93,
    thr_high_lt: 14.4,
    thr_high_gt: 16.4
  });
  assert.ok(
    build_fleet_page(build_fleet_model([edge_row], [])).includes('class="d edge"'),
    "a dot in the outer tenth reads amber"
  );
  // Breaches still say it in words, in red — louder than any dot.
  const breach_row = rec({
    system_id: "SME00010",
    vendor_key: "SIEMENS",
    manufacturer: "Siemens",
    primary_units: "PSI",
    primary_pct: null,
    primary_band: "above",
    primary_band_pos: 1.2,
    primary_breach: "high",
    primary_severity: "high",
    thr_high_lt: 14.4,
    thr_high_gt: 16.4
  });
  assert.ok(
    build_fleet_page(build_fleet_model([breach_row], [])).includes(">over<"),
    "a breach outranks the gauge"
  );
  // Edge-proximity ordering: nearer an edge sorts first among banded rows.
  const mid = rec({ system_id: "SME00011", vendor_key: "SIEMENS", manufacturer: "Siemens", primary_pct: null, primary_band: "within", primary_band_pos: 0.5, thr_high_lt: 14.4, thr_high_gt: 16.4 });
  const near = rec({ system_id: "SME00012", vendor_key: "SIEMENS", manufacturer: "Siemens", primary_pct: null, primary_band: "within", primary_band_pos: 0.88, thr_high_lt: 14.4, thr_high_gt: 16.4 });
  const ordered = build_fleet_model([mid, near], []).sections[0].pages[0].map((r) => r.system_id);
  assert.deepStrictEqual(ordered, ["SME00012", "SME00011"], "closer to an edge ranks first");
  // The legend shows a sample gauge and defines it.
  assert.ok(html.includes("WITHIN BAND</b> <span class=\"bg\""), "legend carries a sample gauge");
  const breach = build_fleet_model(
    [
      rec({
        vendor_key: "SIEMENS",
        primary_pct: null,
        primary_band: "below",
        primary_breach: "low",
        primary_severity: "high"
      })
    ],
    []
  );
  const breach_html = build_fleet_page(breach);
  assert.ok(breach_html.includes(">under"), "a band breach is named outright");
  assert.ok(!/<td[^>]*>band/.test(breach_html), "a breach never reads as in band");

  // Where a percentage exists it carries the magnitude as well as the fact of
  // the breach, so it wins over the bare word.
  const over = build_fleet_page(
    build_fleet_model(
      [rec({ primary_pct: 194, primary_breach: "high", primary_severity: "high" })],
      []
    )
  );
  assert.ok(over.includes("194%"), "a breach with a percentage keeps the magnitude");
  assert.ok(!/>over</.test(over), "the word is redundant once the number is shown");
  // Helium formatting: % attaches, other units are spaced.
  assert.ok(html.includes("76.5%"), "percent helium attaches");
  // Litres read whole and spaced; percent reads with decimals and attached.
  assert.ok(html.includes("968 LTRS"), "litres helium is spaced and undecimated");
  assert.ok(!html.includes("968.0 LTRS"), "litres do not carry decimals");
  assert.ok(html.includes("4.5 K"), "coldhead in Kelvin");
  assert.ok(html.includes("25.0 °C"), "cabinet in Celsius");
  assert.ok(html.includes("4×"), "temp alarm run count");
}

// --- the limit the percentages are measured against must be visible --------
{
  // "41%" is meaningless unless the reader can see what it is 41% OF. The
  // threshold is per-system but near-uniform within a vendor, so it belongs
  // in the section heading, with any system on a different limit saying so.
  const ge = (over) =>
    rec({
      vendor_key: "GE",
      manufacturer: "GE",
      primary_units: "PSI",
      thr_high_gt: 5.2,
      thr_high_lt: 0.5,
      ...over
    });
  // GE's 0.5 is a floor alarm under a one-sided metric, and the % column
  // divides by 5.2 — so the heading must say "limit >5.2", not "band". Only a
  // centered band is described as one, or the heading misdescribes the
  // number printed beside it.
  const limit = section_limit([ge({}), ge({}), ge({ system_id: "SME00009" })]);
  assert.strictEqual(limit.label, "alert limit >5.2 PSI, floor 0.5", "floor alarm is not a band");
  assert.strictEqual(limit.exceptions, 0);
  const centered = section_limit([
    rec({ thr_high_gt: 16.4, thr_high_lt: 14.4, primary_units: "PSI" })
  ]);
  assert.strictEqual(centered.label, "alert band 14.4–16.4 PSI", "centered band states both edges");

  // One-sided limits read as a ceiling.
  const one = section_limit([rec({ thr_high_gt: 80, thr_high_lt: null })]);
  assert.strictEqual(one.label, "alert limit >80 mbar");

  // The dominant limit wins and the stragglers are counted.
  const mixed = section_limit([
    rec({ thr_high_gt: 16.4, thr_high_lt: null, primary_units: "PSI" }),
    rec({ thr_high_gt: 16.4, thr_high_lt: null, primary_units: "PSI" }),
    rec({ thr_high_gt: 16.3, thr_high_lt: null, primary_units: "PSI" })
  ]);
  assert.strictEqual(mixed.label, "alert limit >16.4 PSI", "most common limit leads");
  assert.strictEqual(mixed.exceptions, 1, "the odd one out is counted");

  // A section where nothing has a threshold has no limit to state.
  assert.strictEqual(section_limit([rec({ thr_high_gt: null, thr_high_lt: null })]), null);

  // Rendered: heading carries the limit, and the outlier names its own.
  const vm = build_fleet_model(
    [
      rec({ system_id: "SME00001", thr_high_gt: 16.4, thr_high_lt: null, primary_units: "PSI" }),
      rec({ system_id: "SME00002", thr_high_gt: 16.4, thr_high_lt: null, primary_units: "PSI" }),
      rec({ system_id: "SME00003", thr_high_gt: 16.3, thr_high_lt: null, primary_units: "PSI" })
    ],
    []
  );
  const html = build_fleet_page(vm);
  assert.ok(html.includes("alert limit &gt;16.4 PSI"), "heading states the limit");
  assert.ok(html.includes("(1 differ)"), "heading admits the systems it does not cover");
  assert.ok(html.includes("(16.3)"), "the outlier states its own limit inline");
  // A system with no threshold at all says so rather than showing a number.
  assert.ok(
    build_fleet_page(build_fleet_model([rec({ thr_high_gt: null, primary_pct: null })], [])).includes("no limit"),
    "no configured threshold reads as no limit"
  );
}

// --- the renamed vocabulary -------------------------------------------------
{
  // The condition is historical — it fires on the window's peak — so the
  // label is past tense and names which reading crossed. The column is
  // present tense. They must not read as contradicting each other.
  const vm = build_fleet_model(
    [rec({ archetype: "threshold_exceeded", primary_pct: 38, primary_breach: null })],
    []
  );
  const html = build_fleet_page(vm);
  assert.ok(html.includes("PEAK OVER LIMIT"), "condition names the peak");
  assert.ok(html.includes("% OF LIMIT"), "column is titled by what it measures");
  assert.ok(!html.includes("OVER LINE"), "the old ambiguous label is gone");
  assert.ok(!html.includes("VS LINE"), "the old column title is gone");
  // Same name on the overview and in the dense tables — one word per concept.
  assert.strictEqual(condition_label("threshold_exceeded"), "PEAK OVER LIMIT");
  assert.strictEqual(condition_short("threshold_exceeded"), "PEAK OVER LIMIT");
}

// --- plausibility: garbage readings must not judge anything -----------------
{
  // Modeled on a live row: −3.625 PSI, 0.00% helium, 382.8 K shield, yet a
  // perfectly plausible 5.6 K coldhead — half the chain works, half emits
  // junk. Raw values stay; judgments must not.
  const ge_facts = (over = {}) => ({
    vendor: {
      key: "GE",
      primary: { name: "He pressure" },
      pressure: { decimals: 3 },
      helium: { decimals: 2 },
      coldhead: { warm_k: 10 }
    },
    thr: { high_gt: 5.2, high_lt: 0.5, med_gt: null, med_lt: null, source: "alert_model" },
    he_thr: { low_high: 60, low_med: 70, units: "%" },
    units: { pressure: "PSI", helium: "%" },
    window_start: T0,
    window_end: W_END,
    compressor_event: null,
    compressor_events: [],
    compressor_first_on_t: T0,
    temp_alarm: null,
    quenched: false,
    pressure: {
      all: { min: { v: -3.625, t: T0 }, max: { v: -3.625, t: T0 }, first: { v: -3.625, t: T0 }, last: { v: -3.625, t: W_END } },
      last: { v: -3.625, t: W_END },
      peak: { v: -3.625, t: T0 },
      delta_vs_baseline: null,
      rate_per_hr: null
    },
    helium: {
      all: { min: { v: 0, t: T0 }, max: { v: 0, t: T0 }, first: { v: 0, t: T0 }, last: { v: 0, t: W_END } },
      last: { v: 0, t: W_END },
      peak: { v: 0, t: T0 },
      delta_vs_baseline: -57.1
    },
    coldhead: { last: { v: 5.6, t: W_END } },
    shield: null, // every shield reading was 382.8 K -> all screened out
    cabinet: null,
    room_temp: null,
    edu: null,
    compressor_source: "coldhead_ruo_value",
    compressor_flickers: null,
    last_compressor_on: true,
    counts: { captures: 100, pressure: 100, helium: 100 },
    clock_skew_minutes: null,
    chart_mode: "line",
    archetype: "compressor_stop_recovered",
    // What the per-point screen in render/model.js reports for this system:
    // the last RAW values (garbage included), how many readings each channel
    // lost to the bounds, and whether the LATEST capture carried the
    // impossible combination.
    raw_last: { pressure: -3.625, helium: 0, coldhead_k: 5.6, shield_k: 382.8, cab_temp: null },
    implausible: { pressure: 100, helium: 0, coldhead_k: 0, shield_k: 100, cab_temp: 0 },
    suspect_rows: 100,
    last_suspect: true,
    compressor_first_stateful_t: T0,
    ...over
  });
  const id = { system_id: "SME20122", site_name: "Heart of Texas", customer_name: "x", city: "Brady", state: "TX", manufacturer: "GE", modality: "MRI" };

  const s = build_summary_facts(ge_facts({ pressure: null }), id);
  assert.strictEqual(s.data_flags.primary, true, "−3.625 PSI is impossible");
  assert.strictEqual(s.data_flags.shield, true, "382.8 K shield is impossible");
  assert.strictEqual(s.data_flags.helium, false, "0.00% alone is possible (quench looks like this)");
  assert.strictEqual(s.data_flags.coldhead, false, "the working sensor stays trusted");
  assert.strictEqual(s.sensor_suspect, true, "two impossible channels convict the chain");
  // Judgments from the garbage channel are gone; the raw value is not.
  assert.strictEqual(s.primary_value, -3.625, "raw value preserved");
  assert.strictEqual(s.primary_breach, null, "no breach from an impossible reading");
  assert.strictEqual(s.primary_severity, "none");
  assert.strictEqual(s.primary_pct, null);
  assert.strictEqual(s.helium_low_high, 60, "plausible helium keeps its threshold");
  assert.ok(!is_urgent(s), "garbage cannot manufacture urgency");
  assert.ok(is_data_issue(s), "the system is a monitoring problem now");
  assert.ok(!is_attention(s), "and leaves the attention list");

  // One impossible channel flags the value but does NOT convict the system.
  const one = build_summary_facts(
    ge_facts({
      pressure: null,
      shield: { last: { v: 51, t: W_END } },
      raw_last: { pressure: -3.625, helium: 0, coldhead_k: 5.6, shield_k: 51, cab_temp: null },
      implausible: { pressure: 1, helium: 0, coldhead_k: 0, shield_k: 0, cab_temp: 0 },
      suspect_rows: 1,
      last_suspect: true // impossible pressure NEXT TO 0.00% helium, same row
    }),
    id
  );
  assert.strictEqual(one.implausible_count, 1, "counts rejected READINGS, not channels");
  assert.strictEqual(one.sensor_suspect, true, "…except impossible + 0.00% helium in one capture, which does");
  const one_clean_he = build_summary_facts(
    ge_facts({
      pressure: null,
      shield: { last: { v: 51, t: W_END } },
      helium: { all: { min: { v: 80, t: T0 }, max: { v: 80, t: T0 }, first: { v: 80, t: T0 }, last: { v: 80, t: W_END } }, last: { v: 80, t: W_END }, peak: { v: 80, t: T0 }, delta_vs_baseline: 0 },
      raw_last: { pressure: -3.625, helium: 80, coldhead_k: 5.6, shield_k: 51, cab_temp: null },
      implausible: { pressure: 1, helium: 0, coldhead_k: 0, shield_k: 0, cab_temp: 0 },
      suspect_rows: 0,
      last_suspect: false
    }),
    id
  );
  assert.strictEqual(one_clean_he.sensor_suspect, false, "one bad channel alone is a flag, not a conviction");
  assert.ok(!is_data_issue(one_clean_he));

  // Two impossible readings WEEKS APART never convict: conviction requires
  // the combination in ONE capture, and it must still be true in the latest.
  const apart = build_summary_facts(
    ge_facts({
      raw_last: { pressure: 1.2, helium: 78, coldhead_k: 4.2, shield_k: 45, cab_temp: null },
      implausible: { pressure: 1, helium: 0, coldhead_k: 0, shield_k: 1, cab_temp: 0 },
      suspect_rows: 0, // never both in the same row
      last_suspect: false
    }),
    id
  );
  assert.strictEqual(apart.sensor_suspect, false, "impossible readings weeks apart prove nothing together");
  assert.strictEqual(apart.implausible_count, 2, "…but both are still reported");

  // A garbage capture three weeks ago followed by clean data is history:
  // the LATEST capture decides the conviction.
  const recovered_chain = build_summary_facts(
    ge_facts({
      raw_last: { pressure: 1.2, helium: 78, coldhead_k: 4.2, shield_k: 45, cab_temp: null },
      implausible: { pressure: 1, helium: 0, coldhead_k: 0, shield_k: 1, cab_temp: 0 },
      suspect_rows: 1,
      last_suspect: false
    }),
    id
  );
  assert.strictEqual(recovered_chain.sensor_suspect, false, "a recovered sensor chain is not convicted for its past");

  // A quench overrides suspect: missing a real quench is the costlier error.
  const quench_suspect = build_summary_facts(ge_facts({ pressure: null, quenched: true }), id);
  assert.ok(!is_data_issue(quench_suspect), "quench beats suspect");
  assert.ok(is_urgent(quench_suspect));
}

// --- left-censored stops: never observed starting ---------------------------
{
  const OFF_ALL = {
    start: T0,
    end: null,
    off_hours: 738,
    cycles: 1,
    off_count: 1400
  };
  const base = (over = {}) => ({
    archetype: "compressor_stop_ongoing",
    compressor_first_on_t: null, // never seen ON
    compressor_first_stateful_t: T0, // coverage from the period open
    compressor_event: OFF_ALL,
    compressor_events: [OFF_ALL],
    vendor: { key: "SIEMENS", primary: { name: "He pressure" }, pressure: { decimals: 2 }, helium: { decimals: 1 }, coldhead: { warm_k: 55 } },
    thr: { high_gt: 16.4, high_lt: 14.4, med_gt: null, med_lt: null, source: "alert_model" },
    he_thr: { low_high: null, low_med: null, units: null },
    units: { pressure: "PSI", helium: "LTRS" },
    window_start: T0,
    window_end: W_END,
    temp_alarm: null,
    quenched: false,
    pressure: { all: { min: { v: 15.1, t: T0 }, max: { v: 16.9, t: T0 }, first: { v: 16.8, t: T0 }, last: { v: 16.76, t: W_END } }, last: { v: 16.76, t: W_END }, peak: { v: 16.9, t: T0 }, delta_vs_baseline: null, rate_per_hr: null },
    helium: { all: { min: { v: 832, t: T0 }, max: { v: 900, t: T0 }, first: { v: 900, t: T0 }, last: { v: 832, t: W_END } }, last: { v: 832, t: W_END }, peak: { v: 900, t: T0 }, delta_vs_baseline: null },
    coldhead: { last: { v: 76.6, t: W_END } },
    shield: null,
    cabinet: null,
    room_temp: null,
    edu: null,
    compressor_source: "compressor_status",
    compressor_flickers: null,
    last_compressor_on: false,
    counts: { captures: 1400, pressure: 1400, helium: 1400 },
    clock_skew_minutes: null,
    chart_mode: "band",
    ...over
  });
  const id = { system_id: "SME10844", site_name: "RF - Station 1", customer_name: "x", city: "Rockford", state: "IL", manufacturer: "Siemens", modality: "MRI" };

  // Warm coldhead + over-band pressure: really off, already fully warm.
  const warm = build_summary_facts(base(), id);
  assert.strictEqual(warm.left_censored, true, "no ON reading before the stop = never observed");
  assert.strictEqual(warm.offline_kind, "warm", "the magnet's body corroborates");
  assert.ok(!is_urgent(warm), "a finished state pages nobody");
  assert.ok(is_attention(warm), "but it stays on the attention list");
  assert.ok(!is_data_issue(warm));

  // Calm, cold magnet with an "off" signal all window: the signal is lying.
  const calm = build_summary_facts(
    base({
      pressure: { all: { min: { v: 15.2, t: T0 }, max: { v: 15.4, t: T0 }, first: { v: 15.3, t: T0 }, last: { v: 15.3, t: W_END } }, last: { v: 15.3, t: W_END }, peak: { v: 15.4, t: T0 }, delta_vs_baseline: 0, rate_per_hr: null },
      coldhead: { last: { v: 41.2, t: W_END } }
    }),
    id
  );
  assert.strictEqual(calm.offline_kind, "no_signal", "no thermal response = dead signal");
  assert.ok(is_data_issue(calm));
  assert.ok(!is_attention(calm) && !is_urgent(calm));

  // An ongoing stop that WAS observed (compressor seen ON before it began)
  // is real and urgent no matter how long it has run.
  const observed = build_summary_facts(
    base({
      compressor_first_on_t: T0 + HOUR,
      compressor_event: { ...OFF_ALL, start: T0 + 48 * HOUR, off_hours: 690 },
      compressor_events: [{ ...OFF_ALL, start: T0 + 48 * HOUR, off_hours: 690 }]
    }),
    id
  );
  assert.strictEqual(observed.left_censored, false, "we saw it stop");
  assert.strictEqual(observed.offline_kind, null);
  assert.ok(is_urgent(observed), "an observed unrecovered stop stays urgent");

  // A channel silent until hour 199 that then reads OFF was never covered at
  // the period open — the stop is observed-late with an unknown start, NOT
  // "off since before the period". Before the coverage rule this claimed
  // no_signal (calm magnet) and suppressed urgency for a live stop.
  const LATE = { start: T0 + 199 * HOUR, end: null, off_hours: 10, cycles: 1, off_count: 20 };
  const late = build_summary_facts(
    base({
      compressor_first_stateful_t: T0 + 199 * HOUR,
      compressor_event: LATE,
      compressor_events: [LATE],
      pressure: { all: { min: { v: 15.2, t: T0 }, max: { v: 15.4, t: T0 }, first: { v: 15.3, t: T0 }, last: { v: 15.3, t: W_END } }, last: { v: 15.3, t: W_END }, peak: { v: 15.4, t: T0 }, delta_vs_baseline: 0, rate_per_hr: null },
      coldhead: { last: { v: 41.2, t: W_END } }
    }),
    id
  );
  assert.strictEqual(late.left_censored, false, "no coverage at the period open — not left-censored");
  assert.strictEqual(late.offline_kind, null, "and no offline overlay");
  assert.ok(is_urgent(late), "a late-observed ongoing stop stays urgent");
  assert.ok(is_attention(late) && !is_data_issue(late));
}

// --- the fleet document renders the new states honestly ---------------------
{
  const records = [
    rec({ system_id: "SME00001", archetype: "compressor_stop_ongoing" }), // fresh, urgent
    rec({
      system_id: "SME00002",
      archetype: "compressor_stop_ongoing",
      left_censored: true,
      offline_kind: "warm",
      coldhead_k: 76.6,
      coldhead_warm_k: 55
    }),
    rec({
      system_id: "SME00003",
      archetype: "compressor_stop_ongoing",
      left_censored: true,
      offline_kind: "no_signal"
    }),
    rec({
      system_id: "SME00004",
      archetype: "compressor_stop_recovered",
      sensor_suspect: true,
      implausible_count: 2,
      primary_value: -3.625,
      primary_units: "PSI",
      primary_decimals: 3,
      primary_pct: null,
      primary_severity: "none",
      data_flags: { primary: true, helium: false, coldhead: false, shield: true, cabinet: false },
      shield_k: 382.8
    }),
    rec({ system_id: "SME00005" })
  ];
  const vm = build_fleet_model(records, []);

  assert.strictEqual(vm.data_issue_count, 2, "no-signal + sensor-suspect are data issues");
  assert.strictEqual(vm.attention_count, 2, "fresh stop + warm offline");
  assert.strictEqual(vm.urgent_count, 1, "only the fresh stop is urgent");
  assert.strictEqual(vm.attention[0].system_id, "SME00001", "urgent leads warm offline");
  assert.strictEqual(vm.warm_offline_count, 1);
  // Rollup: each system counted once, overlays pulled OUT of their archetype.
  const ongoing = vm.condition_rollup.find((c) => c.label === "STOP, ONGOING");
  assert.strictEqual(ongoing.count, 1, "dead signal and warm magnet leave the ongoing bucket");
  assert.strictEqual(vm.condition_rollup.find((c) => c.label === "OFF ENTIRE PERIOD").count, 1);
  assert.strictEqual(vm.condition_rollup.find((c) => c.label === "DATA ISSUES").count, 2);
  assert.strictEqual(
    vm.condition_rollup.reduce((n, c) => n + c.count, 0),
    records.length,
    "rollup counts every system exactly once"
  );

  const html = build_fleet_page(vm);
  assert.ok(html.includes("2 data issues"), "headline carries the third tier");
  assert.ok(html.includes("DATA ISSUES"), "the section exists");
  assert.ok(html.includes("impossible readings — sensor suspect"), "suspect reason");
  assert.ok(html.includes("no magnet response"), "no-signal reason");
  assert.ok(html.includes("-3.625 PSI ✕"), "raw impossible reading shown, marked");
  assert.ok(html.includes("shield 382.8 K ✕"), "every flagged channel is named");
  assert.ok(html.includes(">OFF ENTIRE PERIODᶜ<"), "warm offline label is marked as concluded");
  assert.ok(html.includes(">no signalᶜ<"), "no-signal label is marked as concluded");
  assert.ok(html.includes(">sensor suspectᶜ<"), "suspect label is marked as concluded");
  assert.ok(html.includes(">entire period<"), "compressor cell claims only what was seen");
  assert.ok(
    html.includes("off the entire period — magnet already warm"),
    "warm offline attention reason"
  );
  assert.ok(html.includes("‡"), "flagged values are marked in the vendor table");
  for (const bad of ["undefined", "NaN"]) assert.ok(!html.includes(bad));

  // The email grades identically — counts, membership, and data-issue tier.
  const results = records.map((s) => ({ system_id: s.system_id, archetype: s.archetype, summary: s }));
  const facts_of = (r) => ({ ...(r.summary || {}), archetype: r.archetype });
  assert.strictEqual(results.filter((r) => is_attention(facts_of(r))).length, vm.attention_count);
  assert.strictEqual(results.filter((r) => is_data_issue(facts_of(r))).length, vm.data_issue_count);
  assert.strictEqual(
    results.filter((r) => is_attention(facts_of(r)) && is_urgent(facts_of(r))).length,
    vm.urgent_count
  );
}

// --- ᶜ marks conclusions, and only conclusions ------------------------------
{
  // Compressor source is per-SYSTEM: an EDU vibration sensor is a direct
  // measurement of the compressor and outranks the GE coldhead inference, so
  // one GE section can mix measured and inferred rows — the mark rides each
  // state word, not the header. EDU-sourced and scanner-reported states are
  // unmarked; only the coldhead inference concludes rather than reads.
  const ge_inferred = rec({
    system_id: "SME00002",
    vendor_key: "GE",
    manufacturer: "GE",
    compressor_source: "coldhead_ruo_value",
    coldhead_k: 4.2,
    coldhead_warm_k: 10,
    shield_k: 51
  });
  const ge_measured = rec({
    system_id: "SME00004",
    vendor_key: "GE",
    manufacturer: "GE",
    compressor_source: "edu_comp_vib",
    coldhead_k: 4.3,
    coldhead_warm_k: 10,
    shield_k: 48
  });
  const philips = rec({ system_id: "SME00001", compressor_source: "cryo_comp_malf_value" });
  const nontim = rec({
    system_id: "SME00003",
    vendor_key: "SIEMENS_NON_TIM",
    manufacturer: "Siemens",
    primary_name: "Shield temp",
    primary_units: "K",
    compressor_source: "edu_comp_vib",
    cabinet_c: 25
  });
  const html = build_fleet_page(build_fleet_model([ge_inferred, ge_measured, philips, nontim], []));
  assert.ok(!html.includes("COMPRESSORᶜ"), "headers are never marked — sections mix sources");
  assert.strictEqual(
    (html.match(/>ONᶜ</g) || []).length,
    1,
    "exactly the coldhead-inferred row carries the mark"
  );
  assert.ok(html.includes(">ON<"), "measured rows are unmarked");
  // The legend defines the mark; the email overlay labels still carry theirs.
  assert.ok(html.includes("ᶜ</b> — concluded"), "legend defines ᶜ");
  assert.ok(
    condition_cell_record({ archetype: "compressor_stop_ongoing", offline_kind: "warm" }).includes("<sup>c</sup>"),
    "email overlay labels carry the mark"
  );
  // Concluded reasons are marked; measured ones are not.
  const warm = rec({ archetype: "compressor_stop_ongoing", left_censored: true, offline_kind: "warm", coldhead_k: 76, coldhead_warm_k: 55 });
  const vm2 = build_fleet_model([warm], []);
  assert.ok(vm2.attention_reason(warm).endsWith("ᶜ"), "corroborated reason is marked");
  const fresh = rec({ archetype: "compressor_stop_ongoing", primary_event: { start: T0, end: null, off_hours: 9.5, cycles: 1 } });
  assert.ok(!build_fleet_model([fresh], []).attention_reason(fresh).includes("ᶜ"), "an observed stop reason is not marked");
}

// --- a quenched record can NEVER render healthy in an email cell ------------
{
  // Codex F2 (blocker): {stable_healthy, quenched} counted as attention and
  // urgent while the email cell said "stable / healthy". Both email senders
  // now grade the distilled record; the cell must lead with QUENCH.
  const q = { archetype: "stable_healthy", quenched: true };
  const cell = condition_cell_record(q);
  assert.ok(cell.includes("QUENCH"), "the cell says QUENCH");
  assert.ok(!cell.includes("stable"), "and never the healthy label");
  assert.ok(!cell.includes("<sup>c</sup>"), "a recorded quench is a reading, not a conclusion");
  assert.ok(is_attention(q) && is_urgent(q), "grading agrees with the cell");
  // Quench outranks even the overlay states in the cell, matching the PDF.
  const q2 = condition_cell_record({ archetype: "compressor_stop_ongoing", quenched: true, offline_kind: "warm" });
  assert.ok(q2.includes("QUENCH"), "quench outranks overlays");
  // The batch-email grading path: distilled record + top-level archetype.
  const batch_shape = { ...rec({ quenched: true }), archetype: "stable_healthy" };
  assert.ok(condition_cell_record(batch_shape).includes("QUENCH"), "batch-email shape grades the same");
}

// --- observed-events-only history: off_count 0 is not an event --------------
{
  // A hand-supplied event_window with no OFF readings inside it must not
  // count as history — "1 event" would invent one.
  const facts = {
    vendor: { key: "GE", primary: { name: "He pressure" }, pressure: { decimals: 3 }, helium: { decimals: 2 }, coldhead: { warm_k: 30 } },
    thr: { high_gt: 5.2, high_lt: 0.5, med_gt: null, med_lt: null, source: "alert_model" },
    he_thr: { low_high: null, low_med: null, units: null },
    units: { pressure: "PSI", helium: "%" },
    window_start: T0, window_end: W_END,
    compressor_event: { start: T0, end: T0 + 4 * HOUR, off_hours: 0, cycles: 0, off_count: 0 },
    compressor_events: [{ start: T0, end: T0 + 4 * HOUR, off_hours: 0, cycles: 0, off_count: 0 }],
    temp_alarm: null, quenched: false,
    pressure: { all: { min: { v: 1.2, t: T0 }, max: { v: 1.3, t: T0 }, first: { v: 1.2, t: T0 }, last: { v: 1.25, t: W_END } }, last: { v: 1.25, t: W_END }, peak: { v: 1.3, t: T0 }, delta_vs_baseline: 0, rate_per_hr: null },
    helium: null, coldhead: null, shield: null, cabinet: null, room_temp: null, edu: null,
    compressor_source: "coldhead_ruo_value", compressor_flickers: null,
    last_compressor_on: null, compressor_first_on_t: null, compressor_first_stateful_t: null,
    counts: { captures: 10, pressure: 10, helium: 0 },
    clock_skew_minutes: null, chart_mode: "line", archetype: "stable_healthy"
  };
  const empty_event = build_summary_facts(facts, { system_id: "SME00042", site_name: "X", customer_name: "X", city: "X", state: "TX", manufacturer: "GE", modality: "MRI" });
  assert.strictEqual(empty_event.event_count, 0, "an event with no OFF readings is not history");
  assert.strictEqual(empty_event.off_hours_total, 0);
}

// --- mixed band modes get a truthful header ---------------------------------
{
  // Codex F7: one centered-band row beside one high-only row shared a
  // WITHIN BAND header over a percentage cell. Mixed sections now say
  // VS ALERT LIMIT; single-mode sections keep their precise labels.
  const banded_row = rec({
    system_id: "SME30001", vendor_key: "SIEMENS", manufacturer: "Siemens",
    primary_units: "PSI", primary_value: 15.3, primary_pct: null,
    primary_band: "within", primary_band_pos: 0.45,
    thr_high_gt: 16.4, thr_high_lt: 14.4
  });
  const pct_row = rec({
    system_id: "SME30002", vendor_key: "SIEMENS", manufacturer: "Siemens",
    primary_units: "PSI", primary_value: 15.2, primary_pct: 93,
    primary_band: null, primary_band_pos: null,
    thr_high_gt: 16.4, thr_high_lt: null
  });
  const mixed_html = build_fleet_page(build_fleet_model([banded_row, pct_row], []));
  assert.ok(mixed_html.includes('<th class="n">VS ALERT LIMIT</th>'), "mixed section uses the neutral header");
  assert.ok(!mixed_html.includes('<th class="n">WITHIN BAND</th>'), "and not the band-only header (legend entry aside)");
  assert.ok(mixed_html.includes("93%"), "the percentage row still renders its value");
  const pure_html = build_fleet_page(build_fleet_model([banded_row], []));
  assert.ok(pure_html.includes('<th class="n">WITHIN BAND</th>'), "all-banded section keeps the precise header");

  // Gauge clamp: a reading beyond an edge keeps its dot visible at the rim,
  // amber-flagged — never drawn outside the track or hidden.
  const over = rec({
    system_id: "SME30003", vendor_key: "SIEMENS", manufacturer: "Siemens",
    primary_units: "PSI", primary_value: 17.1, primary_pct: null,
    primary_band: "above", primary_band_pos: 1.35,
    thr_high_gt: 16.4, thr_high_lt: 14.4
  });
  const under = rec({
    system_id: "SME30004", vendor_key: "SIEMENS", manufacturer: "Siemens",
    primary_units: "PSI", primary_value: 13.9, primary_pct: null,
    primary_band: "below", primary_band_pos: -0.2,
    thr_high_gt: 16.4, thr_high_lt: 14.4
  });
  const clamp_html = build_fleet_page(build_fleet_model([over, under], []));
  assert.ok(clamp_html.includes("left:97.0%"), "over-band dot clamps to the right rim");
  assert.ok(clamp_html.includes("left:3.0%"), "under-band dot clamps to the left rim");
  assert.ok((clamp_html.match(/class="d edge"/g) || []).length >= 2, "both rim dots are amber-flagged");
}

// --- an all-excluded request still produces the exclusion document ----------
{
  // Codex F6: requests[0].output.out_dir on an empty list crashed, and the
  // reader lost the document that names what was excluded. The loader now
  // resolves out_dir independently, and the model/page pair renders (and
  // counts) an exclusion-only document.
  const { load_requests } = require("../request_loader");
  const os = require("os");
  const tmp = path.join(os.tmpdir(), `check-fleet-all-excluded-${process.pid}.json`);
  fs.writeFileSync(tmp, JSON.stringify({
    summary_only: true,
    exclude: ["SME10844"],
    exclude_note: "service station",
    batch_email: { recipients: ["dev@example.com"], summary: true, summary_pdf: true },
    reports: [{ report_type: "magnet_health", system_id: "SME10844" }]
  }));
  try {
    const loaded = load_requests(tmp);
    assert.strictEqual(loaded.requests.length, 0, "every request excluded");
    assert.deepStrictEqual(loaded.excluded.ids, ["SME10844"]);
    assert.ok(typeof loaded.out_dir === "string" && loaded.out_dir.length, "out_dir survives an empty request list");
  } finally {
    fs.unlinkSync(tmp);
  }

  const vm = build_fleet_model([], [], { excluded: { ids: ["SME10844"], note: "service station" } });
  const html = build_fleet_page(vm);
  assert.ok(html.includes("EXCLUDED BY REQUEST"), "the exclusion is still stated");
  assert.strictEqual(
    (html.match(/<div class="page">/g) || []).length,
    vm.page_count,
    "exclusion-only document pages match the modeled count"
  );
  assert.ok(html.includes(`page ${vm.page_count} of ${vm.page_count}`), "footers agree");
  assert.ok(!html.includes("undefined") && !html.includes("NaN"), "no artifacts with zero systems");
}

// --- fatal run errors exit nonzero ------------------------------------------
{
  // Codex F5: the orchestrator's outer catch swallowed fatal errors (bad
  // request file, failed fleet render in summary-only mode) and returned []
  // with exit code 0 — cron read "success" with nothing delivered. The CLI
  // must exit nonzero. Spawns the real entrypoint, so it needs the app env;
  // skipped cleanly where none exists (e.g. a sandboxed review).
  const { spawnSync } = require("child_process");
  const repo_root = path.join(__dirname, "..", "..");
  if (fs.existsSync(path.join(repo_root, ".env"))) {
    const run = spawnSync(
      process.execPath,
      ["index.js", "sme_report", "./requests/definitely-not-a-real-file.json"],
      { cwd: repo_root, timeout: 90000, encoding: "utf8" }
    );
    assert.notStrictEqual(run.status, 0, "a missing request file must not exit 0");
    assert.ok(
      `${run.stderr}${run.stdout}`.includes("request file not found"),
      "and the error names the cause"
    );
  } else {
    console.log("  (skipped fatal-exit CLI test: no .env in this environment)");
  }
}

// --- exclusions are stated, never silent ------------------------------------
{
  const meta = { excluded: { ids: ["SME10844", "SME13604"], note: "RF/SC service stations, not fleet" } };
  const vm = build_fleet_model([rec()], [{ system_id: "SME99999", message: "no data" }], meta);
  const html = build_fleet_page(vm);
  assert.ok(html.includes("EXCLUDED BY REQUEST"), "exclusion section present");
  assert.ok(html.includes("SME10844, SME13604"), "every excluded id named");
  assert.ok(html.includes("RF/SC service stations"), "the note explains why");
  assert.ok(html.includes("1 systems · Philips 1 · 2 excluded".replace("1 systems","1 systems")) || html.includes("2 excluded"), "cover sub-line counts them");
  assert.ok(html.includes("Not analyzed and not counted"), "totals are scoped honestly");

  // With no failures the statement gets its own page rather than vanishing —
  // and that page is COUNTED, or every footer reads "page N of N−1".
  const no_fail = build_fleet_model([rec()], [], meta);
  const nf_html = build_fleet_page(no_fail);
  assert.ok(nf_html.includes("EXCLUDED BY REQUEST"), "still stated with no failures page");
  assert.strictEqual(
    (nf_html.match(/<div class="page">/g) || []).length,
    no_fail.page_count,
    "the exclusion page is part of the modeled page count"
  );
  assert.ok(
    nf_html.includes(`page ${no_fail.page_count} of ${no_fail.page_count}`),
    "the last footer agrees with the total"
  );

  // No exclusions -> no section, no sub-line mention.
  const plain = build_fleet_page(build_fleet_model([rec()], []));
  assert.ok(!plain.includes("EXCLUDED BY REQUEST"));
  assert.ok(!/\d+ excluded/.test(plain), "no phantom count in the sub-line");
}

// --- the value column is titled by its datum --------------------------------
{
  // "NOW" said when; the header should say WHAT. Each section's value column
  // carries its own metric name — He pressure for three vendors, shield temp
  // for non-TIM, where "pressure" would be a lie — with % OF LIMIT beside it
  // and hairlines fencing the pair. Units stay in the section heading: the
  // alert limit names them, and "HE PRESSURE (PSI)" does not fit the column.
  const records = [
    rec({ system_id: "SME00001" }),
    rec({
      system_id: "SME00002",
      vendor_key: "GE",
      manufacturer: "GE",
      primary_units: "PSI",
      compressor_source: "coldhead_ruo_value",
      coldhead_k: 4.2,
      coldhead_warm_k: 10,
      shield_k: 51
    }),
    rec({
      system_id: "SME00003",
      vendor_key: "SIEMENS_NON_TIM",
      manufacturer: "Siemens",
      primary_name: "Shield temp",
      primary_units: "K",
      cabinet_c: 25,
      cabinet_warn: 38,
      cabinet_alarm: 43
    })
  ];
  const html = build_fleet_page(build_fleet_model(records, []));
  assert.ok(html.includes(">HE PRESSURE</th>"), "pressure sections name the metric");
  assert.ok(html.includes(">SHIELD TEMP</th>"), "non-TIM names shield temp, not pressure");
  assert.ok(html.includes("% OF LIMIT"), "the ratio column stays");
  assert.ok(!/>NOW</.test(html), "the vague NOW header is gone");
  assert.ok(!html.includes('class="grp"'), "no redundant banner repeating the name");
  // Units live in the section heading, not the column header.
  assert.ok(!html.includes("HE PRESSURE (PSI)"), "no units squeezed into the header");
  assert.ok(html.includes("alert limit &gt;80 mbar"), "units arrive via the limit");

  // The hairline CSS addresses the pair by position; that only holds while
  // every vendor's columns start [system, site, condition, primary, line].
  for (const s of SECTIONS) {
    assert.strictEqual(s.columns[3], "primary", `${s.vendor_key} primary at position 4`);
    assert.strictEqual(s.columns[4], "line", `${s.vendor_key} line at position 5`);
  }

  // The legend ties the pair together and the other columns to their own
  // thresholds.
  // The legend is a structured glossary, not prose: every term the document
  // uses without inline explanation has an entry, including per-system
  // vocabulary like "flicker" that readers meet when they open a brief.
  assert.ok(html.includes('class="legend pin"'), "legend box pinned to the cover");
  assert.ok(html.includes(">LEGEND<"), "captioned");
  for (const term of [
    "% OF LIMIT</b> — that reading as a share",
    "PEAK OVER LIMIT</b> — the period",
    "flicker</b> — single-reading compressor dropout",
    "OFF ENTIRE PERIOD</b> — off since before the period",
    "no signal · sensor suspect",
    "‡ ✕</b> — reading outside plausible",
    "judged against their own thresholds",
    "urgent</b> — wrong right now"
  ])
    assert.ok(html.includes(term), `legend covers: ${term.slice(0, 30)}`);
  // The old prose paragraph is fully replaced, not duplicated.
  assert.ok(
    !html.includes("Each system's full one-page brief — charts, timeline"),
    "the verbose paragraph is gone"
  );
  // One legend, cover only.
  assert.strictEqual((html.match(/class="legend pin"/g) || []).length, 1);
}

// --- a quench must never hide behind a healthy primary metric ---------------
{
  // A quench is recorded independently of pressure, so a quenched magnet can
  // read perfectly normal and classify `stable_healthy`. It must still reach
  // the attention list, the urgent count, and the page.
  const vm = build_fleet_model([rec({ quenched: true })], []);
  assert.strictEqual(vm.quench_count, 1);
  assert.strictEqual(vm.attention_count, 1, "a quenched system needs attention");
  assert.strictEqual(vm.urgent_count, 1, "a quench is urgent");
  assert.strictEqual(vm.attention[0].archetype, "stable_healthy", "archetype is unchanged");
  const html = build_fleet_page(vm);
  assert.ok(/QUENCH/.test(html), "the quench is stated on the page");
  assert.ok(
    html.includes("quench state recorded"),
    "the attention list explains why"
  );
  // Quenched systems lead the attention list regardless of archetype.
  const mixed = build_fleet_model(
    [rec({ system_id: "SME00002", archetype: "compressor_stop_recovered" }), rec({ system_id: "SME00001", quenched: true })],
    []
  );
  assert.strictEqual(mixed.attention[0].system_id, "SME00001", "quench sorts first");
  // ...and a clean system still reports nothing.
  assert.strictEqual(build_fleet_model([rec()], []).quench_count, 0);
}

// --- the email and the PDF must agree ---------------------------------------
{
  // They are two views of one run. The summary email grades the same records
  // the attached PDF does, via the same helpers — an email headline saying a
  // different number from its own attachment is indefensible, and grading on
  // the bare archetype used to lose quenched systems entirely.
  const records = [
    rec({ system_id: "SME00001", quenched: true }),
    rec({ system_id: "SME00002", archetype: "threshold_exceeded", primary_breach: null }),
    rec({
      system_id: "SME00003",
      archetype: "threshold_exceeded",
      primary_breach: "high",
      primary_severity: "high"
    }),
    rec({ system_id: "SME00004", archetype: "compressor_stop_ongoing" }),
    rec({ system_id: "SME00005" })
  ];
  const vm = build_fleet_model(records, []);
  // How send_summary_email sees them: a result wrapper around the record.
  const results = records.map((s) => ({
    system_id: s.system_id,
    archetype: s.archetype,
    summary: s
  }));
  // Mirrors send_summary_email exactly: sort the whole list, then filter.
  const facts_of = (r) => ({ ...(r.summary || {}), archetype: r.archetype });
  const email_sorted = [...results].sort((a, b) => attention_sort(facts_of(a), facts_of(b)));
  const email_attention = email_sorted.filter((r) => is_attention(facts_of(r)));
  const email_urgent = email_attention.filter((r) => is_urgent(facts_of(r)));
  assert.strictEqual(email_attention.length, vm.attention_count, "attention counts agree");
  assert.strictEqual(email_urgent.length, vm.urgent_count, "urgent counts agree");
  assert.deepStrictEqual(
    email_attention.map((r) => r.system_id),
    vm.attention.map((r) => r.system_id),
    "the two views list the same systems in the same order"
  );

  // A caller with no distilled record still errs toward flagging rather than
  // silently dropping a system.
  assert.ok(is_urgent({ archetype: "threshold_exceeded" }), "bare archetype falls back");
  assert.ok(!is_urgent({ archetype: "stable_healthy" }));
}

// --- urgency is about now, classification is about the window ---------------
{
  // `threshold_exceeded` fires on the window's PEAK. A system that spiked and
  // has since settled is worth listing, but it is not a live problem, and the
  // reason must be built from the reading that triggered it — quoting the
  // current band state produced "within its alert band" as the reason a
  // system needed attention.
  const eased = rec({
    archetype: "threshold_exceeded",
    primary_value: 1.9,
    primary_peak: 6.0,
    primary_min: 1.5,
    primary_pct: 37,
    primary_band: "within",
    primary_breach: null,
    primary_severity: "ok",
    thr_high_gt: 5.2,
    thr_high_lt: 0.5,
    primary_units: "PSI",
    primary_decimals: 3
  });
  const vm = build_fleet_model([eased], []);
  assert.strictEqual(vm.attention_count, 1, "a historical breach is still listed");
  assert.strictEqual(vm.urgent_count, 0, "but it is not urgent once it has eased");
  const why = vm.attention_reason(eased);
  assert.ok(why.includes("peaked at 6.000"), `reason cites the peak: ${why}`);
  assert.ok(why.includes("since eased"), `reason says it has eased: ${why}`);
  assert.ok(!why.includes("within its alert band"), "reason must not contradict itself");

  // Still breaching now -> urgent, and no "since eased" qualifier.
  const live = { ...eased, primary_value: 6.0, primary_breach: "high", primary_severity: "high" };
  assert.strictEqual(build_fleet_model([live], []).urgent_count, 1, "a live breach is urgent");
  assert.ok(!build_fleet_model([live], []).attention_reason(live).includes("since eased"));

  // A rising system on a centered band has no percentage to quote, and must
  // not fall back to an em dash — "trending up at — of its limit" reached a
  // delivered document on eleven Siemens rows.
  const rising_band = rec({
    archetype: "pressure_rising",
    primary_pct: null,
    primary_band: "within",
    primary_value: 15.53,
    primary_units: "PSI",
    primary_decimals: 2,
    thr_high_gt: 16.4,
    thr_high_lt: 14.4
  });
  const band_why = build_fleet_model([rising_band], []).attention_reason(rising_band);
  assert.ok(!band_why.includes("—"), `band reason must not contain a dash: ${band_why}`);
  assert.ok(band_why.includes("15.53 PSI"), `band reason gives the reading: ${band_why}`);
  assert.ok(band_why.includes("16.4"), "band reason names the top of the band");
  // And one with no configured limit at all.
  const rising_none = rec({
    archetype: "pressure_rising",
    primary_pct: null,
    primary_band: null,
    thr_high_gt: null
  });
  const none_why = build_fleet_model([rising_none], []).attention_reason(rising_none);
  assert.ok(!none_why.includes("—"), `no-limit reason must not contain a dash: ${none_why}`);
  assert.ok(none_why.includes("no limit set"), `no-limit reason says so: ${none_why}`);
  // Every attention reason must fit the WHY column's truncation budget.
  for (const r of [rising_band, rising_none, eased])
    assert.ok(
      build_fleet_model([r], []).attention_reason(r).length <= 46,
      `reason too long for the column: ${build_fleet_model([r], []).attention_reason(r)}`
    );

  // Low-side historical breach explains from the window minimum.
  const dipped = { ...eased, primary_min: 0.3, primary_peak: 2.0 };
  const dip_why = build_fleet_model([dipped], []).attention_reason(dipped);
  assert.ok(dip_why.includes("dipped to 0.300"), `low-side reason: ${dip_why}`);
}

// --- thresholds configured on one side only ---------------------------------
{
  // A low-only config is not a band. Comparing against a null high line
  // coerces to zero and calls every healthy reading "above".
  assert.strictEqual(
    band_state(15.3, { high_gt: null, high_lt: 14.4 }),
    null,
    "a low-only config is not a band"
  );
  assert.strictEqual(breach_direction(15.3, { high_gt: null, high_lt: 14.4 }), null);
  assert.strictEqual(breach_direction(14.0, { high_gt: null, high_lt: 14.4 }), "low");
  assert.strictEqual(breach_direction(90, { high_gt: 80, high_lt: null }), "high");
  assert.strictEqual(breach_direction(30, { high_gt: 80, high_lt: null }), null);
  assert.strictEqual(breach_direction(null, { high_gt: 80, high_lt: null }), null);
  // Genuine two-sided bands still work.
  assert.strictEqual(band_state(15.3, { high_gt: 16.4, high_lt: 14.4 }), "within");
  assert.strictEqual(band_state(16.9, { high_gt: 16.4, high_lt: 14.4 }), "above");
  assert.strictEqual(band_state(14.0, { high_gt: 16.4, high_lt: 14.4 }), "below");

  // A low-only system that is healthy must not render a red breach.
  const ok_low = rec({
    thr_high_gt: null,
    thr_high_lt: 14.4,
    primary_value: 15.3,
    primary_pct: null,
    primary_band: null,
    primary_breach: null,
    primary_severity: "ok"
  });
  const html = build_fleet_page(build_fleet_model([ok_low], []));
  assert.ok(!/>over</.test(html) && !/>under</.test(html), "no fabricated breach");
}

// --- every failed system stays identifiable ---------------------------------
{
  // Grouping 17 no-data systems into one row is right; ellipsising eleven of
  // their ids out of that row is not — the section exists to say WHICH.
  const failures = Array.from({ length: 17 }, (_, i) => ({
    system_id: `SME${String(90000 + i)}`,
    message: `no PHILIPS monitor data for SME${String(90000 + i)} in the requested window`
  }));
  const vm = build_fleet_model([], failures);
  const html = build_fleet_page(vm);
  // Presence in the HTML string is necessary but NOT sufficient — a cell can
  // carry the id in the DOM and still ellipsise it away on the page. The
  // rendered-width check below (PROTECTED includes SYSTEMS) is what actually
  // proves they are readable.
  for (const f of failures)
    assert.ok(html.includes(f.system_id), `${f.system_id} missing from the failures section`);
  assert.strictEqual(vm.failure_count, 17);
  // Chunk size must leave the ids room to render; the model and the CSS have
  // to agree, so pin the row count the chunking produces.
  assert.strictEqual(
    vm.failure_pages.flat().length,
    Math.ceil(17 / FAILURE_IDS_PER_ROW),
    "failure ids are chunked into renderable rows"
  );
  // The reason is stated once per group, not repeated on every id row.
  assert.strictEqual(
    (html.match(/no PHILIPS monitor data/g) || []).length,
    1,
    "the shared reason is stated once"
  );
}

// --- state rendering that must not fabricate health -------------------------
{
  // A system with no compressor readings at all (non-TIM on EDU1 hardware,
  // where comp_vib_status is NULL) must read as missing data. The per-system
  // tile renders this as a green "ON"; the fleet table must not repeat that.
  const vm = build_fleet_model(
    [rec({ vendor_key: "SIEMENS_NON_TIM", compressor_on: null, event_count: 0 })],
    []
  );
  const html = build_fleet_page(vm);
  assert.ok(html.includes("no data"), "null compressor state reads as no data");
  assert.ok(!/>ON</.test(html), "null compressor state must never render ON");

  // ...including when an event exists. A request event_window override
  // produces an event for a hand-supplied window; on a system with no
  // compressor channel at all that used to render "ON · 1 evt · 0.0h".
  const with_event = build_fleet_page(
    build_fleet_model(
      [rec({ vendor_key: "SIEMENS_NON_TIM", compressor_on: null, event_count: 1, off_hours_total: 0 })],
      []
    )
  );
  assert.ok(with_event.includes("no data"), "no compressor channel still reads no data");
  assert.ok(!/>ON</.test(with_event), "an event must not fabricate a running compressor");
}
{
  // A system riding an OEM default threshold is marked, since its percentage
  // is against a vendor constant rather than its own configured line.
  const vm = build_fleet_model([rec({ thr_source: "oem_constant" })], []);
  assert.ok(build_fleet_page(vm).includes("41%*"), "OEM-default systems are asterisked");
  const configured = build_fleet_model([rec()], []);
  assert.ok(!build_fleet_page(configured).includes("41%*"));
}
{
  // Compressor history reads state plus event count and total downtime.
  const vm = build_fleet_model(
    [rec({ archetype: "compressor_stop_recovered", event_count: 4, off_hours_total: 54.5 })],
    []
  );
  const html = build_fleet_page(vm);
  assert.ok(html.includes("4 evt"), "event count shown");
  assert.ok(html.includes("54.5h"), "total downtime shown");
}
{
  // Null helium delta (no clean baseline) renders as an em dash, never +0.0.
  const vm = build_fleet_model([rec({ helium_delta: null })], []);
  const html = build_fleet_page(vm);
  assert.ok(!html.includes("+0.0"), "a null delta must not read as zero");
}

// --- scoped (customer-facing) summary variant (plan A2) ---------------------
{
  // Counts reconcile (round-2 fixture audit): 6 in scope = 4 analyzed +
  // 2 failed, so the cover's arithmetic is validated, not just rendered.
  const scope = {
    label: "Acme Health Network",
    detail: { kind: "customer_id", customers: 1, sites: 3, systems: 6 }
  };
  const records = [
    rec({ system_id: "SME90001", archetype: "compressor_stop_ongoing" }),
    rec({ system_id: "SME90002", vendor_key: "GE", manufacturer: "GE" }),
    rec({ system_id: "SME90003" }),
    rec({ system_id: "SME90004" })
  ];
  const failures = [
    { system_id: "SME90005", message: "no GE monitor data for SME90005 in the requested period" },
    // Round-1 F5: an arbitrary internal error must never reach a customer
    // page verbatim — the whitelist collapses it to a generic line.
    { system_id: "SME90006", message: `relation "mag.secret_table" does not exist` }
  ];
  const vm = build_fleet_model(records, failures, { scope });
  assert.strictEqual(vm.title, "Magnet Health Summary — Acme Health Network");
  const html = build_fleet_page(vm);
  assert.ok(html.includes("<h1>Magnet Health Summary — Acme Health Network</h1>"), "scoped h1");
  assert.ok(!html.includes("Fleet Magnet Health Summary"), "scoped document never says fleet");
  assert.ok(html.includes("% of these systems"), "scoped rollup wording");
  assert.ok(!html.includes("% of fleet"), "no fleet wording on a scoped page");
  // Round-1 F4: the cover states the RESOLUTION, not just the survivors —
  // 5 in scope, 4 analyzed, and where the rest went.
  assert.ok(html.includes("6 systems in scope"), "resolved count on the cover");
  assert.ok(html.includes("4 analyzed"), "analyzed count on the cover");
  assert.ok(html.includes("2 failed"), "failed count on the cover");
  assert.strictEqual(
    vm.scope.detail.systems,
    records.length + failures.length,
    "fixture counts reconcile: in scope = analyzed + failed"
  );
  assert.ok(html.includes("· 3 sites ·"), "site count on the cover");
  // Customer-facing failure reasons: the fact, not the pipeline.
  assert.ok(
    html.includes("no monitor data received in the requested period"),
    "vendor-variant tokens stripped from customer-facing reasons"
  );
  assert.ok(!html.includes("no GE monitor data"), "internal reason wording absent");
  assert.ok(!html.includes("secret_table"), "arbitrary internal errors never reach a customer page");
  assert.ok(html.includes("report could not be generated"), "unknown failures collapse to the generic line");
  // Round-2 F3: the classifier strips system ids ITSELF, so the email
  // (which classifies the raw message) and the PDF (which groups first)
  // produce identical customer wording.
  assert.strictEqual(
    customer_failure_reason("no GE monitor data for SME90005 in the requested period"),
    "no monitor data received in the requested period",
    "raw-message classification matches the grouped PDF wording"
  );
  // Round-1 F2/escaping: a hostile DB-sourced label renders escaped in
  // every sink, never as markup.
  const hostile = build_fleet_page(
    build_fleet_model(records, [], {
      scope: { label: `Smith & Sons <script>alert(1)</script>`, detail: { kind: "customer_id", customers: 1, sites: 1, systems: 4 } }
    })
  );
  assert.ok(!hostile.includes("<script>alert(1)</script>"), "label markup is escaped");
  assert.ok(hostile.includes("Smith &amp; Sons"), "escaped label renders");
  // The internal document is untouched: fleet title, fleet wording,
  // vendor-token reasons, raw internal errors (ops needs them).
  const internal = build_fleet_page(build_fleet_model(records, failures, {}));
  assert.ok(internal.includes("<h1>Fleet Magnet Health Summary</h1>"));
  assert.ok(internal.includes("% of fleet"));
  assert.ok(internal.includes("no GE monitor data in the requested period"));
  assert.ok(internal.includes("secret_table"), "the internal document keeps the raw error");
}

// --- full-scale pagination + artifacts --------------------------------------
{
  const VENDORS = [
    { key: "PHILIPS", manufacturer: "Philips" },
    { key: "GE", manufacturer: "GE" },
    { key: "SIEMENS", manufacturer: "Siemens" },
    { key: "SIEMENS_NON_TIM", manufacturer: "Siemens" }
  ];
  const ARCH = [
    "compressor_stop_ongoing",
    "compressor_stop_recovered",
    "threshold_exceeded",
    "pressure_rising",
    "stable_healthy"
  ];
  const records = Array.from({ length: 163 }, (_, i) => {
    const v = VENDORS[i % 4];
    // Every condition must appear in every vendor section: column widths
    // differ per section, so a label that fits in Siemens (8 columns) can
    // still ellipsise in GE (9). 4 vendors x 5 conditions = the first 20.
    const archetype = i < 20 ? ARCH[Math.floor(i / 4) % 5] : "stable_healthy";
    // Records 20-27: every overlay state, in every vendor, so the browser
    // measurement covers the DATA ISSUES section and warm/no-signal rows —
    // the SYSTEM column of that section shipped truncated once because no
    // measured fixture contained a data-issue row.
    if (i >= 20 && i < 24)
      return rec({
        system_id: `SME${String(10000 + i)}`,
        site_name: `Site ${i} Regional Medical Center`,
        city: `City ${i}`,
        vendor_key: v.key,
        manufacturer: v.manufacturer,
        archetype: "compressor_stop_ongoing",
        left_censored: true,
        offline_kind: i % 2 ? "warm" : "no_signal",
        coldhead_k: i % 2 ? 76.6 : null,
        coldhead_warm_k: i % 2 ? 55 : null
      });
    if (i >= 24 && i < 28)
      return rec({
        system_id: `SME${String(10000 + i)}`,
        site_name: `Site ${i} Regional Medical Center`,
        city: `City ${i}`,
        vendor_key: v.key,
        manufacturer: v.manufacturer,
        archetype: "compressor_stop_recovered",
        sensor_suspect: true,
        implausible_count: 2,
        primary_value: -3.625,
        primary_decimals: 3,
        primary_pct: null,
        primary_severity: "none",
        data_flags: { primary: true, helium: false, coldhead: false, shield: true, cabinet: false },
        shield_k: 382.8
      });
    return rec({
      system_id: `SME${String(10000 + i)}`,
      site_name: `Site ${i} Regional Medical Center`,
      city: `City ${i}`,
      vendor_key: v.key,
      manufacturer: v.manufacturer,
      archetype,
      primary_pct: 20 + (i % 70),
      coldhead_k: v.key === "GE" ? 4.4 : v.key === "SIEMENS" ? 43 : null,
      coldhead_warm_k: v.key === "GE" ? 10 : v.key === "SIEMENS" ? 55 : null,
      shield_k: v.key === "GE" ? 51 : null,
      cabinet_c: v.key === "SIEMENS_NON_TIM" ? 25 : null,
      cabinet_warn: v.key === "SIEMENS_NON_TIM" ? 38 : null,
      cabinet_alarm: v.key === "SIEMENS_NON_TIM" ? 43 : null,
      event_count: archetype.startsWith("compressor") ? 2 : 0,
      off_hours_total: archetype.startsWith("compressor") ? 12.5 : 0
    });
  });
  const failures = Array.from({ length: 17 }, (_, i) => ({
    system_id: `SME${String(90000 + i)}`,
    message: `no PHILIPS monitor data for SME${String(90000 + i)} in the requested window`
  }));

  const vm = build_fleet_model(records, failures);
  assert.strictEqual(vm.total, 163);
  assert.strictEqual(vm.failure_count, 17);
  assert.strictEqual(vm.failures.length, 1, "17 identical no-data failures collapse to one row");

  const expected_pages =
    vm.overview_pages.length +
    vm.data_issue_pages.length +
    vm.failure_pages.length +
    vm.sections.reduce((n, s) => n + s.pages.length, 0);
  assert.strictEqual(vm.page_count, expected_pages);
  assert.strictEqual(
    vm.sections.reduce((n, s) => n + s.count, 0),
    163,
    "every system lands in exactly one vendor section"
  );
  // The attention list is shown in full, not truncated with a "+N more".
  assert.strictEqual(
    vm.overview_pages.flat().length,
    vm.attention_count,
    "every attention system is listed on the overview"
  );

  const html = build_fleet_page(vm);
  const page_divs = (html.match(/<div class="page">/g) || []).length;
  assert.strictEqual(page_divs, vm.page_count, "one .page div per modeled page");
  for (const bad of ["undefined", "NaN"])
    assert.ok(!html.includes(bad), `163-system page contains ${bad}`);
  // Every system appears exactly once across the vendor sections. (The
  // overview's attention list repeats a handful of them by design, so it is
  // excluded from this count.)
  const first_section = 1 + vm.overview_pages.length + vm.failure_pages.length;
  const sections_html = html
    .split('<div class="page">')
    .slice(first_section)
    .join("");
  for (const r of records) {
    const hits = sections_html.split(r.system_id).length - 1;
    assert.strictEqual(hits, 1, `${r.system_id} appears ${hits} times in sections, expected 1`);
  }
  // ...and every attention system also appears on the overview.
  const overview_html = html
    .split('<div class="page">')
    .slice(1, 1 + vm.overview_pages.length)
    .join("");
  for (const r of vm.attention)
    assert.ok(overview_html.includes(r.system_id), `${r.system_id} missing from attention list`);
  // Continuation pages repeat their section heading.
  assert.ok(html.includes("(cont.)"), "multi-page sections mark continuations");
  // The logo is 412KB of base64 — it must appear once, not once per page.
  const logo_hits = html.split("data:image/png;base64,").length - 1;
  assert.strictEqual(logo_hits, 1, `logo embedded ${logo_hits} times, expected 1`);
  // ...and only the cover may USE it. Chromium re-embeds the image on every
  // sheet it appears on, which took a 9-page document to 4.6MB.
  assert.strictEqual(
    (html.match(/class="brand"/g) || []).length,
    1,
    "the logo lockup belongs on the cover page only"
  );
  // Footer paging is present on every sheet.
  assert.strictEqual(
    (html.match(/page \d+ of \d+/g) || []).length,
    vm.page_count,
    "every page carries a footer"
  );

  const out_dir = path.join(__dirname, "..", "out");
  const html_path = write_html(out_dir, "dev-fleet-summary", html);
  assert.ok(fs.existsSync(html_path));

  // A measured SCOPED document too (plan A2): a realistic customer-sized
  // slice — including the overlay and data-issue rows at indices 16–31 —
  // through the same geometry pass, since the scoped cover carries
  // different masthead content and its tables must obey the same
  // truncation rules.
  const scoped_html = build_fleet_page(
    build_fleet_model(
      records.slice(16, 32),
      [{ system_id: "SME99991", message: "no PHILIPS monitor data for SME99991 in the requested period" }],
      {
        scope: {
          label: "Scoped Fixture Health Network",
          detail: { kind: "customer_id", customers: 1, sites: 4, systems: 16 }
        }
      }
    )
  );
  const scoped_path = write_html(out_dir, "dev-scoped-summary", scoped_html);

  // Render a real PDF and MEASURE the result. Page-break placement is
  // invisible in the HTML string, and `.page` is a fixed 11in with
  // overflow:hidden — content past the bottom is clipped without any error.
  // Asserting "the PDF has as many sheets as the model said" proves nothing,
  // because the model chose the count: an early version of this file passed
  // that check while dropping 40 of 150 systems off the page bottoms. The
  // only honest test is to lay the document out in a browser and look at
  // where things actually landed.
  (async () => {
    const puppeteer = require("puppeteer");
    const { render_pdf_document, close_pdf_renderer } = require("../output/render_pdf");
    try {
      const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      try {
        const page = await browser.newPage();
        await page.setViewport({ width: 816, height: 1056 });
        // Both artifacts go through the same geometry pass. The fullness
        // guard applies to the internal fleet document only: a small
        // customer's scoped summary legitimately produces sparse pages.
        for (const doc of [
          { name: "fleet", file: html_path, dense: true },
          { name: "scoped", file: scoped_path, dense: false }
        ]) {
        await page.goto(`file://${doc.file}`, { waitUntil: "networkidle0" });
        const measured = await page.evaluate(() => {
          const FOOTER_PX = 0.38 * 96; // .foot height, reserved at the bottom
          return [...document.querySelectorAll(".page")].map((pg, i) => {
            const top = pg.getBoundingClientRect().top;
            let usable = pg.clientHeight - FOOTER_PX;
            // A pinned legend sits above the footer and claims that space,
            // so flowed content has to stop short of it.
            const pinned = pg.querySelector(".pin");
            if (pinned) usable = Math.min(usable, pinned.getBoundingClientRect().top - top);
            let overflowing = 0;
            let lowest = 0;
            for (const el of pg.querySelectorAll("tbody tr, h1, h2, table, .roll")) {
              const bottom = el.getBoundingClientRect().bottom - top;
              lowest = Math.max(lowest, bottom);
              if (el.tagName === "TR" && bottom > usable) overflowing += 1;
            }
            // A cell whose text is wider than its column is ellipsised.
            // Tolerable for a site name, never for a system id or the
            // condition — those are what the row is read by.
            //
            // Measured with a Range over the cell's contents, NOT scrollWidth:
            // on a table-layout:fixed cell scrollWidth tracks clientWidth even
            // when the text is visibly cut, so a scrollWidth check reports
            // clean while system ids render as "SME158…".
            // Headers count too: a clipped column TITLE is worse than a
            // clipped value, because it misnames every number beneath it.
            // Column names are resolved by walking the header with colspan /
            // rowspan in mind — a flat index into "thead th" breaks the
            // moment a table grows a second header row, and a detector that
            // misnames columns quietly mis-protects them.
            const keys_of = (table) => {
              const trs = table.querySelectorAll("thead tr");
              if (!trs.length) return [];
              const r2 = trs[1] ? [...trs[1].children] : [];
              let j = 0;
              const keys = [];
              for (const th of trs[0].children) {
                const span = parseInt(th.getAttribute("colspan") || "1", 10);
                if (span === 1) keys.push(th.textContent.trim());
                else
                  for (let k = 0; k < span; k++) {
                    keys.push(r2[j] ? r2[j].textContent.trim() : "?");
                    j += 1;
                  }
              }
              return keys;
            };
            const clipped_cells = {};
            pg.querySelectorAll("table").forEach((table) => {
              const keys = keys_of(table);
              table.querySelectorAll("thead th, tbody td").forEach((td) => {
                const style = getComputedStyle(td);
                const pad =
                  parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
                const range = document.createRange();
                range.selectNodeContents(td);
                const text_width = range.getBoundingClientRect().width;
                range.detach();
                if (text_width <= td.clientWidth - pad + 1) return;
                const label =
                  td.tagName === "TH"
                    ? `${td.textContent.trim()} (header)`
                    : keys[[...td.parentNode.children].indexOf(td)] ||
                      `col${[...td.parentNode.children].indexOf(td)}`;
                clipped_cells[label] = (clipped_cells[label] || 0) + 1;
              });
            });
            return {
              page: i + 1,
              lowest: Math.round(lowest),
              usable: Math.round(usable),
              overflowing,
              clipped_cells
            };
          });
        });
        const clipped = measured.filter((m) => m.overflowing > 0);
        assert.strictEqual(
          clipped.reduce((n, m) => n + m.overflowing, 0),
          0,
          `${doc.name}: rows clipped off the page bottom: ${JSON.stringify(clipped)}`
        );
        const spilled = measured.filter((m) => m.lowest > m.usable);
        assert.strictEqual(
          spilled.length,
          0,
          `${doc.name}: content overruns the footer on ${spilled.length} page(s): ${JSON.stringify(spilled)}`
        );
        // Every page should also be reasonably full — a document that never
        // overflows because it wastes half of each sheet is its own bug.
        if (doc.dense) {
          const worst = Math.max(...measured.map((m) => m.lowest / m.usable));
          assert.ok(worst > 0.55, `no page uses more than ${Math.round(worst * 100)}% of its height`);
        }

        // Columns that must stay legible in full. SYSTEMS is here too: the
        // failure rows are chunked precisely so every failed id stays named,
        // and an ellipsis there silently undoes that.
        const PROTECTED = new Set([
          "SYSTEM",
          "CONDITION",
          "COMPRESSOR",
          "SYSTEMS",
          "REASON"
        ]);
        const squeezed = {};
        for (const m of measured)
          for (const [col, n] of Object.entries(m.clipped_cells))
            if (PROTECTED.has(col) || col.endsWith("(header)"))
              squeezed[col] = (squeezed[col] || 0) + n;
        assert.deepStrictEqual(
          squeezed,
          {},
          `${doc.name}: columns truncated that must not be: ${JSON.stringify(squeezed)}`
        );
        }
      } finally {
        await browser.close();
      }

      const pdf_path = await render_pdf_document(
        out_dir,
        "Avante-dev-fleet-summary.pdf",
        html
      );
      const size = fs.statSync(pdf_path).size;
      assert.ok(size > 50000, `fleet PDF looks truncated at ${size} bytes`);
      // This must stay email-attachable. The logo dominates page one; every
      // further sheet should cost kilobytes, not another half-megabyte.
      const per_page = size / vm.page_count;
      assert.ok(
        per_page < 200000,
        `${Math.round(per_page / 1024)} KB per page — the logo is probably being re-embedded`
      );
      // Chromium writes one /Type /Page object per sheet.
      const pdf = fs.readFileSync(pdf_path, "latin1");
      const sheets = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
      assert.strictEqual(
        sheets,
        vm.page_count,
        `PDF has ${sheets} sheets, model says ${vm.page_count}`
      );
      console.log(
        `check_fleet: all assertions passed (${vm.page_count} pages, ${Math.round(size / 1024)} KB)`
      );
    } finally {
      await close_pdf_renderer();
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
