const {
  clean_series,
  chart_mode,
  metric_points,
  median_interval_ms
} = require("./series");
const {
  find_off_runs,
  build_compressor_events,
  describe_event_window,
  select_primary_event,
  classify_compressor_runs,
  detect_temp_alarm,
  detect_quench
} = require("./events");
const {
  stats_for,
  metric_facts,
  clock_skew_minutes,
  valid_counts
} = require("./metrics");
const { classify } = require("./archetype");
const { steady_rise } = require("./judgments");
const { offline_state } = require("./summary_facts");
const {
  PLAUSIBLE,
  outside,
  primary_bounds,
  helium_bounds,
  last_raw_flags
} = require("./plausible");
const { fallback_thresholds } = require("../vendors");
const { is_inferred } = require("./provenance");
const { corroborate_event, overall_type, stale_times } = require("./corroborate");

// EDU environmental telemetry (vendor-independent, °F / %); supplemental.
// Screened against the EDU plausibility bounds first: an open probe input
// emits its scale floor (−196.6 °F on a live unit), and without the screen
// that default becomes the channel's period minimum and last reading. A
// channel with no plausible points at all reads as absent, and the drops
// are counted so the exclusion is stated, never silent.
// Drops are counted PER CHANNEL: "which probe is emitting garbage" is the
// diagnosis the brief's DATA NOTES states, and one aggregate number can't
// name the probe.
// Channel stats are computed BEFORE the facts literal: the rejected totals
// read the accumulator the four calls mutate, and having those calls
// inside the literal made correctness hang on property evaluation order.
// Exported: the limited-coverage path (identity + EDU only, no magnet
// channels) builds its environmental block through this SAME screen, so a
// limited row and an assessed row can never disagree about what an open
// probe input means.
const build_edu_facts = (edu, edu_source) => {
  if (!edu.length) return null;
  const edu_rejected = { room_temp: 0, humidity: 0, probe_0: 0, probe_1: 0 };
  const edu_channel_stats = (name, key, bounds) => {
    const points = metric_points(edu, key);
    const kept = points.filter((p) => !outside(p.v, bounds));
    edu_rejected[name] = points.length - kept.length;
    return stats_for(kept);
  };
  const edu_room_temp = edu_channel_stats("room_temp", "room_temp_f", PLAUSIBLE.edu_temp_f);
  const edu_humidity = edu_channel_stats("humidity", "humidity_pct", PLAUSIBLE.edu_humidity_pct);
  const edu_probe_0 = edu_channel_stats("probe_0", "probe_0_f", PLAUSIBLE.edu_temp_f);
  const edu_probe_1 = edu_channel_stats("probe_1", "probe_1_f", PLAUSIBLE.edu_temp_f);
  return {
    source: edu_source,
    count: edu.length,
    room_temp: edu_room_temp,
    humidity: edu_humidity,
    probe_0: edu_probe_0,
    probe_1: edu_probe_1,
    rejected: {
      ...edu_rejected,
      total: Object.values(edu_rejected).reduce((n, c) => n + c, 0)
    }
  };
};

// The ANALYSIS of one system: normalized series + thresholds + units ->
// serializable facts. Moved verbatim out of render/model.js
// build_render_model (its lines 58-376) so analysis can run without
// building tiles, narrative, or charts — the render model is now a thin
// wrapper that calls this and adds presentation. No SVG, HTML, copy, or
// layout decision belongs here.
//
// `window` is the normalized request window ({start, end} luxon DateTimes);
// `event_window` the optional {start, end} ms override. The no-data error
// message must stay BYTE-IDENTICAL: fleet_model's failure grouping and
// customer_failure_reason pattern-match it.
//
// Returns { facts, views }: facts is the serializable analysis result
// (facts.chart_mode included — archived history sidecars serialize
// facts-derived records, so the field stays); views carries the prepared
// chart point arrays and the mode for the presentation half — private,
// never serialized.
const analyze_system = ({
  system_id,
  vendor,
  series,
  window,
  event_window = null,
  edu = [],
  edu_source = null,
  thresholds = null, // from data.fetch_thresholds(); null -> OEM fallback
  units = null, // from data.fetch_units(); null -> vendor defaults
  // Readings just OUTSIDE the window (data.fetch_boundary_context), for two
  // checks at its edges and nothing else: whether an EDU reading lies within
  // 45 min of a vendor reading, and whether a vendor reading repeats the
  // previous one's host timestamp. They never enter rows, events or charts.
  context = null
}) => {
  const ctx_series_before = (context && context.series_before) || [];
  const ctx_edu = [...((context && context.edu_before) || []), ...((context && context.edu_after) || [])];
  thresholds = thresholds || fallback_thresholds(vendor);
  units = units || { pressure: vendor.pressure.units, helium: vendor.helium.units };
  const thr = thresholds.pressure;
  const he_thr = thresholds.helium;
  const rows = clean_series(series);
  if (!rows.length)
    throw new Error(
      `no ${vendor.key} monitor data for ${system_id} in the requested period`
    );

  const mode = chart_mode(rows);

  // --- plausibility screen (RULES.md §5) --------------------------------
  // Bounds are applied PER POINT, before any metric is computed: a
  // disconnected sensor that emitted 200 PSI three weeks ago must not own
  // the period's peak, drive the archetype, or wreck the chart scale. The
  // last RAW value per channel is kept so the fleet summary can still show
  // the garbage, greyed and footnoted, and rejected counts are reported as
  // data-quality facts rather than silently vanishing.
  // Siemens non-TIM has ONE physical shield sensor that the normalizer maps
  // into both the primary slot and shield_k. For plausibility accounting the
  // alias must not exist: counting the same impossible reading under two
  // channel names convicted the sensor chain ("2 impossible readings") from
  // one physical failure.
  const shield_aliases_primary = vendor.key === "SIEMENS_NON_TIM";
  const CHANNEL_BOUNDS = {
    pressure: primary_bounds(units.pressure),
    helium: helium_bounds(units.helium),
    coldhead_k: PLAUSIBLE.coldhead_k,
    ...(shield_aliases_primary ? {} : { shield_k: PLAUSIBLE.shield_k }),
    cab_temp: PLAUSIBLE.cabinet_c
  };
  const raw_last_of = (field) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i][field];
      if (v != null && !Number.isNaN(v)) return v;
    }
    return null;
  };
  const raw_last = {
    pressure: raw_last_of("pressure"),
    helium: raw_last_of("helium"),
    coldhead_k: raw_last_of("coldhead_k"),
    shield_k: raw_last_of("shield_k"),
    cab_temp: raw_last_of("cab_temp")
  };
  const implausible = {};
  // Aliased channels (non-TIM shield_k) still get FILTERED — the garbage
  // point must not reach their metric either — but are never COUNTED: the
  // physical reading already counts once under its canonical channel.
  const screen = (points, key, bounds = CHANNEL_BOUNDS[key]) => {
    const kept = points.filter((p) => !outside(p.v, bounds));
    if (key in CHANNEL_BOUNDS) implausible[key] = points.length - kept.length;
    return kept;
  };
  // One impossible reading might be a catastrophe telling the truth — 0.00%
  // helium is exactly what a quenched magnet reports. It is the COMBINATION
  // IN ONE CAPTURE that convicts the sensor chain: two impossible channels
  // at once, or one impossible channel alongside bone-dry helium in the same
  // row. Two impossible readings weeks apart prove nothing about each other.
  const suspect_capture = (r) => {
    let n = 0;
    for (const [field, b] of Object.entries(CHANNEL_BOUNDS)) {
      const v = r[field];
      if (v != null && !Number.isNaN(v) && outside(v, b)) n++;
    }
    return n >= 2 || (n >= 1 && r.helium === 0);
  };
  const suspect_rows = rows.filter(suspect_capture).length;
  // Conviction is about NOW: the LATEST capture carrying the combination.
  // A single garbage row three weeks ago followed by clean data is history,
  // not a current monitoring outage.
  const last_suspect = rows.length
    ? suspect_capture(rows[rows.length - 1])
    : false;
  // Same per-channel "last raw reading is impossible" flags the fleet columns
  // grey — shared helper so the brief tiles and the fleet row can never
  // disagree about which sensor is currently emitting garbage.
  const data_flags = last_raw_flags(raw_last, units, {
    shield_alias: shield_aliases_primary
  });

  const p_points = screen(metric_points(rows, "pressure"), "pressure");
  const he_points = screen(metric_points(rows, "helium"), "helium");

  const window_start = window.start.toMillis();
  const window_end = window.end.toMillis();

  // Compressor state is merged PER READING. The EDU vibration sensor is
  // PRIMARY: a direct measurement of the compressor, and the sensor every
  // default compressor alert model watches (comp_vib_status = false), so the
  // report judges the signal the detections come from. The vendor channel
  // (Philips malf, Siemens status text, GE coldhead inference) is the
  // BACKUP: wherever the EDU is silent, its reading stands in, so an EDU
  // outage never blanks a period the scanner can still speak for. With no
  // EDU readings at all, the vendor channel is the whole signal.
  // SME19528 (Oct 2026) is why the EDU leads: its Siemens status text showed
  // a stop no alert could see while the EDU read running, then froze.
  const EDU_COVER_MS = 45 * 60e3; // an EDU reading this close speaks for the moment
  const edu_comp_rows = edu
    .filter((r) => r.comp_vib !== null)
    .map((r) => ({ t: r.t, compressor_on: r.comp_vib, src: "edu_comp_vib" }));
  const vendor_is_edu = vendor.compressor.source === "edu_comp_vib";
  const vendor_is_inference = is_inferred(vendor.compressor.source);
  // An inferred state is only as good as the reading it was inferred FROM.
  // The normalizer derives GE compressor_on from the RAW coldhead, so a
  // 382.8 K garbage reading — rejected from every metric by the screen —
  // still arrived here as compressor_on = false and manufactured an urgent
  // "ongoing stop" out of data the report says it excluded. An implausible
  // coldhead yields an UNKNOWN state, not "off".
  const source_rows = vendor_is_inference
    ? rows.map((r) =>
        r.compressor_on !== null &&
        outside(r.coldhead_k, CHANNEL_BOUNDS.coldhead_k)
          ? { ...r, compressor_on: null }
          : r
      )
    : rows;
  const vendor_src = vendor.compressor.source;
  const vendor_stateful = vendor_is_edu
    ? []
    : source_rows
        .filter((r) => r.compressor_on !== null)
        .map((r) => ({ t: r.t, host_t: r.host_t, compressor_on: r.compressor_on, src: vendor_src }));
  const use_edu = vendor_is_edu || edu_comp_rows.length > 0;
  // A backup reading fills an EDU gap only if it is FRESH: one that repeats
  // the previous reading's host timestamp is the scanner re-sending an old
  // snapshot (SME19528's feed repeated one host time for four days), and a
  // stale "running" must never stand in for a moment nobody measured.
  // The first in-window reading is compared with the last stateful vendor
  // reading BEFORE the window (boundary context), so a feed that froze
  // before the period cannot pass its first repeat off as fresh.
  const prior_stateful = vendor_is_edu
    ? []
    : ctx_series_before.filter((r) => r.compressor_on !== null && !(vendor_is_inference && outside(r.coldhead_k, CHANNEL_BOUNDS.coldhead_k)));
  const prev_host = (i) =>
    i > 0 ? vendor_stateful[i - 1].host_t : prior_stateful.length ? prior_stateful[prior_stateful.length - 1].host_t : undefined;
  const fresh = vendor_stateful.filter((r, i) => !(r.host_t != null && r.host_t === prev_host(i)));
  // EDU readings just outside the window count for proximity only: an EDU
  // reading at 23:40 still speaks for a vendor reading at 00:10.
  const edu_ts = [
    ...edu_comp_rows.map((r) => r.t),
    ...ctx_edu.filter((r) => r.comp_vib !== null && r.comp_vib !== undefined).map((r) => r.t)
  ].sort((a, b) => a - b);
  const edu_near = (t) => {
    // edu_ts is sorted above (in-window and boundary readings together).
    let lo = 0, hi = edu_ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (edu_ts[mid] < t) lo = mid + 1; else hi = mid; }
    return (lo < edu_ts.length && edu_ts[lo] - t <= EDU_COVER_MS) || (lo > 0 && t - edu_ts[lo - 1] <= EDU_COVER_MS);
  };
  const backup_rows = use_edu && !vendor_is_edu ? fresh.filter((r) => !edu_near(r.t)) : [];
  const stateful = use_edu
    ? [...edu_comp_rows, ...backup_rows].sort((a, b) => a.t - b.t)
    : vendor_stateful;
  const compressor_rows = stateful;
  // Names the PRIMARY source (EDU whenever it reported); the backup's share
  // is stated separately so no page credits the EDU for a reading it did
  // not take, or drops the ᶜ from a coldhead-inferred one.
  const compressor_source = use_edu ? "edu_comp_vib" : vendor_src;
  const compressor_backup = backup_rows.length
    ? { source: vendor_src, readings: backup_rows.length, inferred: is_inferred(vendor_src) }
    : null;
  // Split single-reading, thermally-uncorroborated dropouts (sensor
  // flickers) from real stops; only real runs form the event.
  const { real_runs, flicker_runs } = classify_compressor_runs(
    find_off_runs(compressor_rows),
    p_points,
    { response_epsilon: thr.high_gt !== null ? thr.high_gt * 0.02 : null }
  );
  // Distinct events (gap-clustered); the report anchors on the primary one.
  // A request-supplied event_window overrides detection but still gets its
  // reading counts from the data inside it.
  const interval_ms = median_interval_ms(stateful) || 0;
  const compressor_events = event_window
    ? [
        describe_event_window(event_window, real_runs, stateful, {
          interval_ms
        })
      ]
    : build_compressor_events(real_runs, { interval_ms });
  // Every EDU-reported stop stays a stop; the other data types it
  // (compute/corroborate.js). Only when the EDU is primary: the rule is
  // about what the EDU says, and a vendor-only system is unchanged.
  if (use_edu) {
    // The last row before the window lets the first in-window row be judged
    // stale too; it is never itself a reading here.
    const before_last = ctx_series_before.length ? [ctx_series_before[ctx_series_before.length - 1]] : [];
    const stale = stale_times([...before_last, ...rows]);
    const fresh_pts = (pts) => pts.filter((p) => !stale.has(p.t));
    const ctx = {
      secondary: vendor_is_edu ? [] : fresh,
      p_points: fresh_pts(p_points),
      coldhead: fresh_pts(
        rows
          .filter((r) => r.coldhead_k != null && !Number.isNaN(r.coldhead_k) && !outside(r.coldhead_k, CHANNEL_BOUNDS.coldhead_k))
          .map((r) => ({ t: r.t, v: r.coldhead_k }))
      ),
      warm_k: vendor.coldhead ? vendor.coldhead.warm_k : null,
      epsilon: thr.high_gt !== null ? thr.high_gt * 0.02 : null,
      window_end
    };
    // The frozen-feed readings set aside above, so the page can say a
    // channel was frozen rather than silent.
    const fresh_set = new Set(fresh);
    ctx.secondary_stale = vendor_is_edu ? [] : vendor_stateful.filter((r) => !fresh_set.has(r));
    ctx.p_stale = p_points.filter((p) => stale.has(p.t));
    ctx.coldhead_stale = rows
      .filter((r) => stale.has(r.t) && r.coldhead_k != null && !Number.isNaN(r.coldhead_k))
      .map((r) => ({ t: r.t, v: r.coldhead_k }));
    // Only the readings of the stop's REAL off-runs, the ones its off_count
    // counts: single-reading flickers inside the span are not the stop.
    const in_real_run = (t) => real_runs.some((run) => t >= run.start && t <= run.end);
    for (const ev of compressor_events) {
      const off_rows = stateful.filter(
        (r) =>
          r.src === "edu_comp_vib" &&
          r.compressor_on === false &&
          r.t >= ev.start &&
          (ev.end == null || r.t <= ev.end) &&
          in_real_run(r.t)
      );
      // A stop only the backup saw (the EDU was silent) is not an EDU-off
      // issue: it carries no corroboration record and reads as any stop.
      if (off_rows.length) ev.corroboration = corroborate_event(ev, off_rows, ctx);
    }
  }
  const compressor_event = select_primary_event(compressor_events);
  const compressor_flickers = flicker_runs.length
    ? { count: flicker_runs.length, times: flicker_runs.map((r) => r.start) }
    : null;
  const temp_alarm = detect_temp_alarm(rows);
  const quenched = detect_quench(rows);
  const other_events = compressor_events.filter((ev) => ev !== compressor_event);
  const pressure = metric_facts(p_points, compressor_event, { other_events });
  // Judged once, here, where the alert line is known: the classifier, the
  // tiles, the fleet arrows and the summary record all read this one answer.
  // Only without an OBSERVED stop — the classifier's own predicate
  // (archetype.js: a hand-supplied event_window holding no OFF readings is
  // not a stop). With one, the event ramp is the story and a stop outranks
  // a rise; without one, the steady rise alone decides, so the condition
  // and the trend word cannot disagree (rising-trend review F1).
  if (pressure) {
    pressure.event_observed = !!(compressor_event && compressor_event.off_count !== 0);
    pressure.steady_rise = pressure.event_observed ? null : steady_rise(pressure, thr);
  }
  const helium = metric_facts(he_points, compressor_event, { other_events });
  const coldhead_points = screen(metric_points(rows, "coldhead_k"), "coldhead_k");
  const coldhead = stats_for(coldhead_points);
  // Warmest coldhead reading BEFORE the primary event (whole period when no
  // event): the narrative's "coldhead at base temperature" baseline claim
  // is judged against this, never assumed — the field previously had no
  // producer, so `undefined !== null` called a 146 K coldhead "at base
  // temperature" (review round-2 F2). Null when no pre-event reading
  // exists (e.g. a left-censored stop covering the period).
  const coldhead_baseline_cutoff = compressor_event
    ? compressor_event.start
    : window_end;
  const coldhead_baseline_max = coldhead_points.reduce(
    (m, p) =>
      p.t < coldhead_baseline_cutoff && (m === null || p.v > m) ? p.v : m,
    null
  );
  // GE reports a shield sensor alongside the coldhead; Siemens non-TIM carries
  // shield temp here too (it doubles as that vendor's primary metric). Null
  // for Philips and Siemens TIM, which have no shield channel.
  const shield = stats_for(
    screen(metric_points(rows, "shield_k"), "shield_k", PLAUSIBLE.shield_k)
  );
  const room_temp = stats_for(metric_points(rows, "room_temp_c"));

  const edu_facts = build_edu_facts(edu, edu_source);
  if (edu_facts && temp_alarm) {
    edu_facts.alarm_room_temp = stats_for(
      metric_points(
        edu.filter((r) => r.t >= temp_alarm.start && r.t <= temp_alarm.end),
        "room_temp_f"
      ).filter((p) => !outside(p.v, PLAUSIBLE.edu_temp_f))
    );
  }

  // Cabinet temperature (Siemens non-TIM) judged against its own
  // system-reported warn/alarm levels carried on each row.
  const cab_stats = stats_for(screen(metric_points(rows, "cab_temp"), "cab_temp"));
  const last_cab_row = [...rows]
    .reverse()
    .find((r) => r.cab_warn != null || r.cab_alarm != null);
  const cabinet = cab_stats
    ? {
        ...cab_stats,
        warn: last_cab_row ? last_cab_row.cab_warn : null,
        alarm: last_cab_row ? last_cab_row.cab_alarm : null
      }
    : null;

  const facts = {
    vendor,
    thr,
    he_thr,
    units,
    window_start,
    window_end,
    compressor_event,
    compressor_events,
    temp_alarm,
    quenched,
    pressure,
    helium,
    coldhead,
    coldhead_baseline_max,
    shield,
    cabinet,
    room_temp,
    edu: edu_facts,
    // The source actually used for THIS system — drives the ᶜ provenance
    // mark and the "(per EDU vibration sensor)" narrative note.
    compressor_source,
    compressor_backup,
    // The period's EDU-off issue type (confirmed / doubtful / unconfirmed,
    // compute/corroborate.js), null without EDU-reported stops; and what the
    // secondary channel is called in the annotation.
    compressor_corroboration: overall_type(
      compressor_events.filter((ev) => ev.corroboration).map((ev) => ev.corroboration.type)
    ),
    compressor_secondary_label: vendor_is_edu ? null : is_inferred(vendor_src) ? "the coldhead" : "the magnet monitor",
    // How the secondary channel says "running" in the annotation.
    compressor_secondary_running: vendor_is_edu ? null : is_inferred(vendor_src) ? "the coldhead stayed cold" : "the magnet monitor read running",
    // Where the CURRENT state came from: a backup reading at the end of the
    // period carries the backup's provenance (a coldhead-inferred ONᶜ).
    compressor_last_source: stateful.length ? stateful[stateful.length - 1].src : null,
    compressor_flickers,
    last_compressor_on: stateful.length
      ? stateful[stateful.length - 1].compressor_on
      : null,
    // First reading that showed the compressor RUNNING, or null if it was
    // never seen on. An ongoing stop with no ON reading before it began was
    // never actually observed starting — it was already off when the window
    // opened (left-censored), and "stopped N hours ago" would overclaim.
    compressor_first_on_t: (() => {
      const first_on = stateful.find((r) => r.compressor_on === true);
      return first_on ? first_on.t : null;
    })(),
    // When compressor COVERAGE began — the first reading of either state.
    // Distinguishes "off since before the period" (coverage from the start,
    // all of it OFF) from "state unknown until hour 199, then OFF" (a late
    // first reading), which is an observed ongoing stop, not left-censoring.
    compressor_first_stateful_t: stateful.length ? stateful[0].t : null,
    // Per-channel counts of readings rejected by the plausibility screen,
    // the same-capture suspect-row count, and the last RAW value per channel
    // (pre-screen) so a flagged sensor's output can still be displayed.
    implausible,
    suspect_rows,
    last_suspect,
    raw_last,
    data_flags,
    counts: valid_counts(rows),
    clock_skew_minutes: clock_skew_minutes(rows),
    chart_mode: mode
  };
  facts.archetype = classify({ compressor_event, pressure, thr });
  // Left-censored ongoing stops (RULES.md §5), via the classifier shared
  // with the fleet record so the two documents cannot split the same stop
  // into different stories. The quench override lives inside the classifier
  // for the same reason.
  const offline = offline_state(facts);
  facts.left_censored = offline.left_censored;
  facts.compressor_start_truncated = offline.start_truncated;
  // Suspect conviction outranks the left-censor overlays — the same
  // precedence conditions.effective_status applies among data issues on the
  // fleet. facts.offline_kind is the ONE effective overlay driving banner,
  // tiles, story, and cards: a convicted page must not carry a second
  // verdict ("no compressor signalᶜ") stated with confidence the page has
  // just disclaimed.
  facts.offline_kind =
    last_suspect && !quenched ? null : offline.offline_kind;

  // compressor_rows: the stateful readings from the source chosen above
  // (EDU vs the vendor channel, implausible-coldhead inference blanked) —
  // exposed so the per-system activity page plots the same compressor
  // state this analysis judged, never a second derivation of it.
  // secondary_compressor: the vendor channel as it reported, every reading,
  // when the EDU is primary. The activity page draws it as a second strip:
  // the two sensors can disagree, and the merged strip only shows the
  // vendor where the EDU was silent.
  const secondary_compressor =
    use_edu && vendor_stateful.length ? { source: vendor_src, rows: vendor_stateful } : null;
  return {
    facts,
    views: { mode, p_points, he_points, compressor_rows: stateful, compressor_source, secondary_compressor }
  };
};

module.exports = { analyze_system, build_edu_facts };
