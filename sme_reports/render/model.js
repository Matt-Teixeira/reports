const {
  clean_series,
  chart_mode,
  metric_points,
  median_interval_ms,
  chart_points
} = require("../compute/series");
const {
  find_off_runs,
  build_compressor_events,
  describe_event_window,
  select_primary_event,
  classify_compressor_runs,
  detect_temp_alarm,
  detect_quench
} = require("../compute/events");
const {
  stats_for,
  metric_facts,
  clock_skew_minutes,
  valid_counts
} = require("../compute/metrics");
const { classify } = require("../compute/archetype");
const { offline_state } = require("../compute/summary_facts");
const {
  PLAUSIBLE,
  outside,
  primary_bounds,
  helium_bounds,
  last_raw_flags
} = require("../compute/plausible");
const { STATUS_LABELS } = require("../conditions");
const { fallback_thresholds } = require("../vendors");
const {
  pressure_domain,
  padded_domain
} = require("./scales");
const { render_timeseries_chart } = require("./chart");
const { build_tiles } = require("./tiles");
const { build_narrative } = require("./narrative");
const fmt = require("./fmt");

// Turns identity + normalized series + request into the flat view-model that
// page.js interpolates. All display strings are finalized here.

const build_render_model = ({
  identity,
  vendor,
  series,
  source,
  request,
  edu = [],
  edu_source = null,
  thresholds = null, // from data.fetch_thresholds(); null -> OEM fallback
  units = null // from data.fetch_units(); null -> vendor defaults
}) => {
  thresholds = thresholds || fallback_thresholds(vendor);
  units = units || { pressure: vendor.pressure.units, helium: vendor.helium.units };
  const thr = thresholds.pressure;
  const he_thr = thresholds.helium;
  const rows = clean_series(series);
  if (!rows.length)
    throw new Error(
      `no ${vendor.key} monitor data for ${identity.system_id} in the requested period`
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

  const window_start = request.window.start.toMillis();
  const window_end = request.window.end.toMillis();

  // Compressor source is a per-SYSTEM choice, not a per-vendor one. The EDU
  // vibration sensor is a direct measurement of the compressor itself, so
  // where a system has one reporting, it outranks the GE coldhead INFERENCE
  // and fills in when the scanner channel yields nothing (e.g. a Philips
  // whose only malf readings are cable errors). Scanner-reported channels
  // (Philips malf, Siemens status text) otherwise keep priority — measured
  // beats inferred, but a report from the machine itself is not displaced.
  // The floor keeps a nearly-empty EDU from displacing dense inference.
  const EDU_MIN_READINGS = 24;
  const edu_comp_rows = edu
    .filter((r) => r.comp_vib !== null)
    .map((r) => ({ t: r.t, compressor_on: r.comp_vib }));
  const vendor_is_edu = vendor.compressor.source === "edu_comp_vib";
  const vendor_is_inference =
    vendor.compressor.source === "coldhead_ruo_value";
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
  const vendor_stateful = vendor_is_edu
    ? []
    : source_rows.filter((r) => r.compressor_on !== null);
  // The floor is SYMMETRIC: just as a nearly-empty EDU cannot displace dense
  // inference, a nearly-empty scanner channel cannot displace a dense EDU.
  // Without this, a Philips with one stray malf reading and 1,400 EDU
  // readings would keep the scanner source, detect zero events, and render
  // "running continuously" over a measured six-hour stop.
  const use_edu =
    vendor_is_edu ||
    (edu_comp_rows.length >= EDU_MIN_READINGS &&
      (vendor_is_inference || vendor_stateful.length < EDU_MIN_READINGS));
  const compressor_rows = use_edu ? edu_comp_rows : source_rows;
  const compressor_source = use_edu ? "edu_comp_vib" : vendor.compressor.source;
  const stateful = compressor_rows.filter((r) => r.compressor_on !== null);
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
  const compressor_events = request.event_window
    ? [
        describe_event_window(request.event_window, real_runs, stateful, {
          interval_ms
        })
      ]
    : build_compressor_events(real_runs, { interval_ms });
  const compressor_event = select_primary_event(compressor_events);
  const compressor_flickers = flicker_runs.length
    ? { count: flicker_runs.length, times: flicker_runs.map((r) => r.start) }
    : null;
  const temp_alarm = detect_temp_alarm(rows);
  const quenched = detect_quench(rows);
  const other_events = compressor_events.filter((ev) => ev !== compressor_event);
  const pressure = metric_facts(p_points, compressor_event, { other_events });
  const helium = metric_facts(he_points, compressor_event, { other_events });
  const coldhead = stats_for(screen(metric_points(rows, "coldhead_k"), "coldhead_k"));
  // GE reports a shield sensor alongside the coldhead; Siemens non-TIM carries
  // shield temp here too (it doubles as that vendor's primary metric). Null
  // for Philips and Siemens TIM, which have no shield channel.
  const shield = stats_for(
    screen(metric_points(rows, "shield_k"), "shield_k", PLAUSIBLE.shield_k)
  );
  const room_temp = stats_for(metric_points(rows, "room_temp_c"));

  // EDU environmental telemetry (vendor-independent, °F / %); supplemental.
  const edu_facts = edu.length
    ? {
        source: edu_source,
        count: edu.length,
        room_temp: stats_for(metric_points(edu, "room_temp_f")),
        humidity: stats_for(metric_points(edu, "humidity_pct")),
        probe_0: stats_for(metric_points(edu, "probe_0_f")),
        probe_1: stats_for(metric_points(edu, "probe_1_f"))
      }
    : null;
  if (edu_facts && temp_alarm) {
    edu_facts.alarm_room_temp = stats_for(
      metric_points(
        edu.filter((r) => r.t >= temp_alarm.start && r.t <= temp_alarm.end),
        "room_temp_f"
      )
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
    shield,
    cabinet,
    room_temp,
    edu: edu_facts,
    // The source actually used for THIS system — drives the ᶜ provenance
    // mark and the "(per EDU vibration sensor)" narrative note.
    compressor_source,
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
  // into different stories. A recorded quench overrides every overlay —
  // the quench story must never be reframed as a monitoring caveat.
  const offline = quenched
    ? { left_censored: false, offline_kind: null }
    : offline_state(facts);
  facts.left_censored = offline.left_censored;
  facts.offline_kind = offline.offline_kind;

  const x_domain = [window_start, window_end];
  const { decimals } = vendor.pressure;
  const breaches = (v) =>
    (thr.high_gt !== null && v >= thr.high_gt) ||
    (thr.high_lt !== null && v <= thr.high_lt);

  // Threshold line(s): single OEM-style line, or high+low pair for
  // band-alerted metrics (Siemens absolute PSIA).
  const alert_prefix = vendor.key.split("_")[0]; // SIEMENS_NON_TIM -> SIEMENS
  const threshold_lines = [];
  if (thr.high_gt !== null)
    threshold_lines.push({
      value: thr.high_gt,
      label: `${alert_prefix} ALERT — ${thr.high_lt !== null ? ">" : ""}${thr.high_gt} ${units.pressure}`
    });
  if (thr.high_lt !== null)
    threshold_lines.push({
      value: thr.high_lt,
      // &lt; — a literal "<" inside SVG text is unsafe markup
      label: `${alert_prefix} ALERT — &lt;${thr.high_lt} ${units.pressure}`
    });

  // Data-quality banner (RULES.md §5): a convicted sensor chain reframes the
  // whole page; failing that, a dead compressor signal explains why the page
  // carries no stop headline. Suspect wins when both apply — it is the wider
  // conviction. Labels are shared with the fleet document and summary email
  // via conditions.js so the views cannot drift. A recorded quench overrides
  // both (offline_kind is already null when quenched).
  const rejected_total = Object.values(implausible).reduce((n, c) => n + c, 0);
  const banner =
    last_suspect && !quenched
      ? {
          label: `${STATUS_LABELS.sensor_suspect.toUpperCase()}ᶜ`,
          text:
            `${rejected_total} impossible reading${rejected_total === 1 ? "" : "s"} this period; the latest capture combines impossible values — ` +
            `the monitoring chain, not the magnet, is the likely fault. Values below are the sensor's claims, not magnet state. ` +
            `ᶜ = concluded, not measured · ‡ = outside plausible bounds.`
        }
      : facts.offline_kind === "no_signal"
        ? {
            label: `${STATUS_LABELS.no_signal.toUpperCase()}ᶜ`,
            text:
              `the compressor channel has read "off" since before the period began, and the magnet shows no thermal response — ` +
              `the signal, not the compressor, is the likely fault. Compressor state and downtime are not reported. ` +
              `ᶜ = concluded, not measured.`
          }
        : null;

  // A banner page must still fit ONE page: the charts give up height to buy
  // the banner its room. Measured in Chromium — at 152 the rx cards run
  // past the footer.
  const chart_height = banner ? 100 : 152;

  // Pressure chart markers: peak is red when breaching, orange otherwise;
  // "now" is one notch softer (orange breaching / green not) — exemplar convention.
  const markers = [];
  let pressure_chart_svg = "";
  if (pressure) {
    if (pressure.peak.t !== pressure.last.t) {
      markers.push({
        t: pressure.peak.t,
        v: pressure.peak.v,
        color: breaches(pressure.peak.v) ? "#E50B14" : "#C25E00",
        label: `peak ${fmt.num(pressure.peak.v, decimals)} · ${fmt.day(pressure.peak.t)}`,
        dy: -9
      });
    }
    markers.push({
      t: pressure.last.t,
      v: pressure.last.v,
      color: breaches(pressure.last.v) ? "#C25E00" : "#00695C",
      label: `now ${fmt.num(pressure.last.v, decimals)}`,
      dy: 15
    });
    pressure_chart_svg = render_timeseries_chart({
      points: chart_points(p_points, mode),
      x_domain,
      y_spec: pressure_domain(
        pressure.all.min.v,
        pressure.all.max.v,
        thr,
        vendor.primary.zero_anchor
      ),
      y_format: (v) => `${Number.isInteger(v) ? v : v.toFixed(1)}`,
      event_windows: compressor_events,
      thresholds: threshold_lines,
      markers,
      stroke_width: 2,
      alarm_runs: temp_alarm ? temp_alarm.intervals : null,
      height: chart_height
    });
  }

  const he_sfx = units.helium === "%" ? "%" : ` ${units.helium}`;
  let helium_chart_svg = "";
  if (helium) {
    helium_chart_svg = render_timeseries_chart({
      // Helium renders as a line in both modes (no min/max band), per exemplars.
      points: chart_points(he_points, mode).map((p) => ({
        ...p,
        min: p.v,
        max: p.v
      })),
      x_domain,
      y_spec: padded_domain(helium.all.min.v, helium.all.max.v),
      y_format: (v) => (units.helium === "%" ? `${v}%` : `${v}`),
      event_windows: compressor_events,
      thresholds: null,
      markers: [
        {
          t: helium.last.t,
          v: helium.last.v,
          color: "#004E79",
          label:
            `${fmt.num(helium.last.v, vendor.helium.decimals)}${he_sfx}` +
            (helium.delta_vs_baseline === null
              ? ""
              : ` · ${fmt.signed(helium.delta_vs_baseline, 2)}${units.helium === "%" ? " pts" : ""}`),
          dy: -8
        }
      ],
      stroke_width: 2.4,
      start_label: `${fmt.num(helium.all.first.v, vendor.helium.decimals)}${he_sfx}`,
      height: chart_height
    });
  }

  const overrides = request.narrative_overrides || {};
  const generated = build_narrative(facts);
  const story_html = overrides.story || generated.story_html;
  const rx_cards =
    Array.isArray(overrides.rx_cards) && overrides.rx_cards.length
      ? overrides.rx_cards
      : generated.rx_cards;

  const win_span = `${fmt.day(window_start)} – ${fmt.day(window_end)}`;
  const win_span_caps = `${fmt.day_caps(window_start)} → ${fmt.day_caps(window_end)}`;
  const analyzed = fmt.iso_date(Date.now());
  // "every capture" keeps the line-mode pressure heading on one line.
  const mode_desc = mode === "band" ? "daily range" : "every capture";
  const orange = !compressor_events.length
    ? ""
    : compressor_events.length > 1
      ? " · orange shades = the event spans"
      : " · orange shade = the event span";
  const prepared_by =
    overrides.prepared_by || process.env.SME_REPORT_AUTHOR || "Remote Solutions";
  const data_source =
    overrides.data_source ||
    `${fmt.count(facts.counts.captures)} captures · ${source}` +
      (rejected_total
        ? ` · ${rejected_total} implausible reading${rejected_total === 1 ? "" : "s"} excluded`
        : "");

  return {
    title: `Avante — ${identity.system_id} Magnet Health`,
    analyzed_date: analyzed,
    h1_text: `${identity.system_id} — ${identity.site_name} ${identity.modality || ""}`.trim(),
    sub_line: [
      identity.customer_name,
      `${identity.manufacturer} ${identity.modality || ""}`.trim(),
      identity.city && identity.state
        ? `${identity.city}, ${identity.state}`
        : identity.city || identity.state,
      `${win_span} monitor data (${fmt.count(facts.counts.captures)} captures)`,
      `analyzed ${analyzed}`
    ]
      .filter(Boolean)
      .join(" · "),
    tiles: build_tiles(facts),
    banner,
    pressure_heading: `${vendor.primary.heading} — ${win_span_caps}`,
    pressure_heading_note: `(${mode_desc}, ${units.pressure}${orange})`,
    pressure_chart_svg,
    helium_heading: `HELIUM LEVEL — ${win_span_caps}`,
    helium_heading_note: `(${mode === "band" ? "daily reading" : "every capture"}, ${units.helium})`,
    helium_chart_svg,
    story_html,
    rx_cards,
    foot_source: `Source: ${data_source} · Prepared by ${prepared_by}`,
    facts
  };
};

module.exports = { build_render_model };
