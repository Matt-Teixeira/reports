const { p_severity, trend_of } = require("../render/tiles");

// Distills the full per-system view-model facts into one flat, serializable
// record for the fleet summary. This is the whole contract the fleet document
// renders from — it must carry everything the table needs so the renderer
// never reaches back into facts (which holds SVG strings, luxon objects, and
// full point series that have no business crossing into an aggregate doc).

const HOUR_MS = 3600000;

// Two alert lines can mean two different things, and the difference decides
// whether a percentage is meaningful:
//
//   GE:      0.5 – 5.2 PSI   — normal sits near the bottom (~1-3.7) and rises
//                              toward the high line. The low line is a floor
//                              alarm for lost pressure, not a band edge.
//   Siemens: 14.4 – 16.4 PSIA — absolute pressure, normal sits mid-band at
//                              ~15.3. Both directions are faults.
//
// A percentage of the high line is honest for the first and misleading for
// the second, where a perfectly healthy magnet would read "93% of the line".
// The two are told apart by how close the low line sits to the high one.
const CENTERED_BAND_RATIO = 0.5;

const is_centered_band = (thr) =>
  thr.high_lt !== null &&
  thr.high_gt !== null &&
  thr.high_gt !== 0 &&
  thr.high_lt / thr.high_gt >= CENTERED_BAND_RATIO;

// A dimensionless position against the system's own alert line, so systems on
// four incomparable scales (mbar, gauge PSI, absolute PSIA, K) share one
// sortable column. Null for centered bands, which report band_state instead.
const pct_of_line = (v, thr) => {
  if (v === null || v === undefined) return null;
  if (thr.high_gt === null || thr.high_gt === 0) return null;
  if (is_centered_band(thr)) return null;
  return Math.round((v / thr.high_gt) * 100);
};

// Position within a centered band, 0 at the low edge, 1 at the high edge —
// the fleet table draws this as a dot on a miniature gauge, which reads at a
// glance where "band"/"93% of the line" both misled. Values outside 0..1
// mean the reading sits beyond an edge; null when there is no centered band.
const band_position = (v, thr) => {
  if (v === null || v === undefined) return null;
  if (!is_centered_band(thr)) return null;
  return (v - thr.high_lt) / (thr.high_gt - thr.high_lt);
};

// Only meaningful when BOTH lines exist — a config with only a low line is
// not a band, and comparing against a null high line would coerce to zero
// and call every healthy reading "above".
const band_state = (v, thr) => {
  if (v === null || v === undefined) return null;
  if (thr.high_lt === null || thr.high_gt === null) return null;
  if (v >= thr.high_gt) return "above";
  if (v <= thr.high_lt) return "below";
  return "within";
};

// Whether the CURRENT reading is outside its alert line, and which way.
// Distinct from the archetype, which is historical: a system that peaked over
// the line and has since recovered is still `threshold_exceeded` but is not
// breaching now. Each line is tested independently so a one-sided config
// cannot be compared against a null.
const breach_direction = (v, thr) => {
  if (v === null || v === undefined) return null;
  if (thr.high_gt !== null && v >= thr.high_gt) return "high";
  if (thr.high_lt !== null && v <= thr.high_lt) return "low";
  return null;
};

const metric_value = (metric) => (metric ? metric.last.v : null);

// --- plausibility ------------------------------------------------------
// Bounds live in compute/plausible.js and are applied PER POINT by
// render/model.js BEFORE any metric is computed — peaks, minima, trends,
// severity, and the archetype are already clean by the time facts arrive
// here. What remains at this layer is display and conviction: a channel
// whose LAST RAW reading is impossible shows that raw value greyed and
// judges nothing about "now", and a system whose LATEST capture carries the
// impossible combination (two channels at once, or one alongside bone-dry
// helium, in the SAME row — model.js `last_suspect`) is a monitoring
// problem, not a magnet problem. Two impossible readings weeks apart prove
// nothing about each other. Documented in RULES.md §5.
const { PLAUSIBLE, last_raw_flags } = require("./plausible");

// --- left-censored stops (RULES.md §5) ---------------------------------
// Shared by the fleet record and the per-system brief so the two documents
// classify the same ongoing stop identically. An ongoing stop whose channel
// had coverage from (near) the period start but was never seen ON predates
// the period — its true start is unknown. The magnet's body then decides:
// thermal corroboration -> "warm" (OFF ENTIRE PERIOD, a real finished
// state); no response at all -> "no_signal" (the signal is lying, a
// monitoring problem).
const LEFT_CENSOR_GRACE_MS = 24 * HOUR_MS;

const offline_state = (facts) => {
  const { vendor, thr, units, pressure } = facts;
  const shield_alias = vendor.key === "SIEMENS_NON_TIM";
  const data_flags = last_raw_flags(facts.raw_last || {}, units, {
    shield_alias
  });
  const primary = facts.compressor_event;
  const p_ok = !data_flags.primary;
  const p_now = pressure ? pressure.last.v : null;
  const coldhead_k =
    !data_flags.coldhead && facts.coldhead ? facts.coldhead.last.v : null;
  const primary_trend = p_ok ? trend_of(pressure) : null;
  const boundary_covered =
    facts.compressor_first_stateful_t !== null &&
    facts.compressor_first_stateful_t - facts.window_start <=
      LEFT_CENSOR_GRACE_MS;
  // Left-censored means NO ON reading EVER — "off the entire period" is a
  // categorical claim and one observed ON reading falsifies it (review
  // round-3 F1: an OFF→ON→OFF boundary event clusters into one event whose
  // first ON postdates its start; it must not be narrated "off at every
  // reading"). Such an event is instead START-TRUNCATED: its trailing stop
  // was observed — real, urgent-eligible — and only its initial run's
  // start (and earlier downtime) is unknown.
  const left_censored =
    facts.archetype === "compressor_stop_ongoing" &&
    primary !== null &&
    primary !== undefined &&
    facts.compressor_first_on_t === null &&
    boundary_covered;
  const start_truncated =
    !left_censored &&
    facts.archetype === "compressor_stop_ongoing" &&
    primary !== null &&
    primary !== undefined &&
    primary.start === facts.compressor_first_stateful_t &&
    boundary_covered;
  const warm_corroborated =
    (p_ok &&
      p_now !== null &&
      (breach_direction(p_now, thr) !== null ||
        p_severity(p_now, thr) === "high")) ||
    (coldhead_k !== null &&
      vendor.coldhead &&
      coldhead_k >= vendor.coldhead.warm_k) ||
    primary_trend === "rising";
  // A recorded quench overrides the overlay VERDICT — missing a real quench
  // is the costlier error — but not the censoring FACT: whether the stop
  // was observed starting is coverage arithmetic, and the fleet's history
  // cell still reads "entire period" rather than fabricating an hour count.
  // The override lives here, not in the callers, so the brief and the fleet
  // record cannot gate it differently.
  return {
    left_censored,
    start_truncated,
    offline_kind:
      !left_censored || facts.quenched === true
        ? null
        : warm_corroborated
          ? "warm"
          : "no_signal"
  };
};

const build_summary_facts = (facts, identity) => {
  const { vendor, thr, he_thr, units, pressure, helium } = facts;

  const events = facts.compressor_events || [];
  const observed_events = events.filter((e) => (e.off_count || 0) > 0);
  const primary = facts.compressor_event;

  // Flags judge the last RAW (pre-screen) reading per channel — the screen
  // removed those points from the metrics, so without the raw values the
  // garbage a sensor is emitting right now would be invisible on the page.
  const raw_last = facts.raw_last || {};
  // Siemens non-TIM's shield_k is an ALIAS of its primary slot — one
  // physical sensor. The record drops the alias entirely: its value would
  // render twice, and its flag would count one impossible reading as two.
  const shield_alias = vendor.key === "SIEMENS_NON_TIM";
  const data_flags = last_raw_flags(raw_last, units, { shield_alias });
  // Display values: the raw garbage when flagged (rendered greyed with ‡),
  // otherwise the last plausible reading from the screened metrics.
  const p_now = data_flags.primary ? raw_last.pressure : metric_value(pressure);
  const he_now = data_flags.helium ? raw_last.helium : metric_value(helium);
  const coldhead_k = data_flags.coldhead
    ? raw_last.coldhead_k
    : facts.coldhead
      ? facts.coldhead.last.v
      : null;
  const shield_k = shield_alias
    ? null
    : data_flags.shield
      ? raw_last.shield_k
      : facts.shield
        ? facts.shield.last.v
        : null;
  const cabinet_c = data_flags.cabinet
    ? raw_last.cab_temp
    : facts.cabinet
      ? facts.cabinet.last.v
      : null;
  // Total readings the screen rejected across channels — the count the DATA
  // ISSUES reason cites. Conviction itself rides the latest capture only.
  const implausible_count = Object.values(facts.implausible || {}).reduce(
    (n, c) => n + c,
    0
  );
  const sensor_suspect = facts.last_suspect === true;

  const p_ok = !data_flags.primary;
  const primary_trend = p_ok ? trend_of(pressure) : null;

  // Left-censoring and its warm/no-signal split — the shared classifier
  // above, so the brief's overlay can never disagree with this record. A
  // channel that stays silent until hour 199 and then reads OFF is an
  // observed ongoing stop with an unknown start — real, and urgent-eligible
  // — not a stop that predates the period.
  const { left_censored, offline_kind } = offline_state(facts);

  return {
    // --- identity -----------------------------------------------------
    system_id: identity.system_id,
    site_name: identity.site_name,
    customer_name: identity.customer_name,
    city: identity.city,
    state: identity.state,
    manufacturer: identity.manufacturer,
    modality: identity.modality,
    vendor_key: vendor.key,

    // --- condition ----------------------------------------------------
    archetype: facts.archetype,

    // --- primary escalation metric (He pressure, or shield temp on
    // --- Siemens non-TIM, which has no pressure channel) --------------
    primary_name: vendor.primary.name,
    primary_value: p_now,
    primary_units: units.pressure,
    primary_decimals: vendor.pressure.decimals,
    // Derived judgments come from the reading only when it is plausible; a
    // flagged channel keeps its raw value but judges nothing.
    primary_pct: p_ok ? pct_of_line(p_now, thr) : null,
    primary_band: p_ok ? band_state(p_now, thr) : null,
    primary_band_pos: p_ok ? band_position(p_now, thr) : null,
    primary_breach: p_ok ? breach_direction(p_now, thr) : null,
    primary_severity: p_ok ? p_severity(p_now, thr) : "none",
    primary_peak: pressure ? pressure.peak.v : null,
    primary_peak_t: pressure ? pressure.peak.t : null,
    // Window minimum, so a low-side breach can be explained from the reading
    // that actually triggered it rather than from the current value.
    primary_min: pressure && pressure.all ? pressure.all.min.v : null,
    primary_delta: pressure ? pressure.delta_vs_baseline : null,
    primary_trend,
    thr_high_gt: thr.high_gt,
    thr_high_lt: thr.high_lt,
    // "oem_constant" means no alert model is configured for this system, so
    // any percentage is against a vendor default rather than its own line.
    thr_source: thr.source,

    // --- helium -------------------------------------------------------
    helium_value: he_now,
    helium_units: units.helium,
    helium_decimals: vendor.helium.decimals,
    helium_delta: helium ? helium.delta_vs_baseline : null,
    // Threshold only applies when its units match the reading's — a percent
    // limit is meaningless against a litres reading.
    helium_low_high:
      !data_flags.helium && (he_thr.units === null || he_thr.units === units.helium)
        ? he_thr.low_high
        : null,

    // --- vendor-specific channels (null where the sensor doesn't exist) --
    coldhead_k,
    coldhead_warm_k: vendor.coldhead ? vendor.coldhead.warm_k : null,
    shield_k,
    cabinet_c,
    cabinet_warn: facts.cabinet ? facts.cabinet.warn : null,
    cabinet_alarm: facts.cabinet ? facts.cabinet.alarm : null,
    temp_alarm_runs: facts.temp_alarm ? facts.temp_alarm.runs : null,
    quenched: facts.quenched,

    // --- compressor state and history ---------------------------------
    // null (not false) means the system reported no compressor state at all,
    // e.g. Siemens non-TIM on EDU1 hardware where comp_vib_status is NULL.
    // It must never be rendered as "ON".
    compressor_on: facts.last_compressor_on,
    compressor_source: facts.compressor_source,
    // Only events with observed OFF readings count as history. A request
    // event_window override produces an event whose window was supplied by
    // hand; if no OFF reading falls inside it, there is no downtime to report
    // and claiming "1 event" would invent one.
    event_count: observed_events.length,
    off_hours_total: observed_events.reduce((h, e) => h + (e.off_hours || 0), 0),
    primary_event: primary
      ? {
          start: primary.start,
          end: primary.end,
          off_hours: primary.off_hours,
          cycles: primary.cycles
        }
      : null,
    flicker_count: facts.compressor_flickers ? facts.compressor_flickers.count : 0,

    // --- data quality -------------------------------------------------
    data_flags,
    implausible_count,
    sensor_suspect,
    left_censored,
    offline_kind,

    // --- data quality -------------------------------------------------
    captures: facts.counts.captures,
    valid_pressure: facts.counts.pressure,
    valid_helium: facts.counts.helium,
    clock_skew_minutes: facts.clock_skew_minutes,
    window_start: facts.window_start,
    window_end: facts.window_end,
    window_hours: (facts.window_end - facts.window_start) / HOUR_MS
  };
};

module.exports = {
  build_summary_facts,
  offline_state,
  PLAUSIBLE,
  pct_of_line,
  band_state,
  band_position,
  breach_direction,
  is_centered_band,
  CENTERED_BAND_RATIO
};
