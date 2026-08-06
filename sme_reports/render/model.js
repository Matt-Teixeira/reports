const {
  clean_series,
  chart_mode,
  metric_points,
  chart_points
} = require("../compute/series");
const {
  find_off_runs,
  build_compressor_event,
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
      `no ${vendor.key} monitor data for ${identity.system_id} in the requested window`
    );

  const mode = chart_mode(rows);
  const p_points = metric_points(rows, "pressure");
  const he_points = metric_points(rows, "helium");

  // Compressor state normally rides on the mag rows; vendors flagged
  // edu_comp_vib (Siemens non-TIM) read the EDU vibration sensor instead.
  const compressor_rows =
    vendor.compressor.source === "edu_comp_vib"
      ? edu
          .filter((r) => r.comp_vib !== null)
          .map((r) => ({ t: r.t, compressor_on: r.comp_vib }))
      : rows;
  // Split single-reading, thermally-uncorroborated dropouts (sensor
  // flickers) from real stops; only real runs form the event.
  const { real_runs, flicker_runs } = classify_compressor_runs(
    find_off_runs(compressor_rows),
    p_points,
    { response_epsilon: thr.high_gt !== null ? thr.high_gt * 0.02 : null }
  );
  const compressor_event =
    request.event_window || build_compressor_event(real_runs);
  const compressor_flickers = flicker_runs.length
    ? { count: flicker_runs.length, times: flicker_runs.map((r) => r.start) }
    : null;
  const temp_alarm = detect_temp_alarm(rows);
  const quenched = detect_quench(rows);
  const pressure = metric_facts(p_points, compressor_event);
  const helium = metric_facts(he_points, compressor_event);
  const coldhead = stats_for(metric_points(rows, "coldhead_k"));
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
  const cab_stats = stats_for(metric_points(rows, "cab_temp"));
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

  const window_start = request.window.start.toMillis();
  const window_end = request.window.end.toMillis();
  const stateful = compressor_rows.filter((r) => r.compressor_on !== null);
  const facts = {
    vendor,
    thr,
    he_thr,
    units,
    window_start,
    window_end,
    compressor_event,
    temp_alarm,
    quenched,
    pressure,
    helium,
    coldhead,
    cabinet,
    room_temp,
    edu: edu_facts,
    compressor_source: vendor.compressor.source,
    compressor_flickers,
    last_compressor_on: stateful.length
      ? stateful[stateful.length - 1].compressor_on
      : null,
    counts: valid_counts(rows),
    clock_skew_minutes: clock_skew_minutes(rows),
    chart_mode: mode
  };
  facts.archetype = classify({ compressor_event, pressure, thr });

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
      event_window: compressor_event,
      thresholds: threshold_lines,
      markers,
      stroke_width: 2,
      alarm_runs: temp_alarm ? temp_alarm.intervals : null
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
      event_window: compressor_event,
      thresholds: null,
      markers: [
        {
          t: helium.last.t,
          v: helium.last.v,
          color: "#004E79",
          label: `${fmt.num(helium.last.v, vendor.helium.decimals)}${he_sfx} · ${fmt.signed(helium.delta_vs_baseline, 2)}${units.helium === "%" ? " pts" : ""}`,
          dy: -8
        }
      ],
      stroke_width: 2.4,
      start_label: `${fmt.num(helium.all.first.v, vendor.helium.decimals)}${he_sfx}`
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
  const orange = compressor_event ? " · orange shade = the event window" : "";
  const prepared_by =
    overrides.prepared_by || process.env.SME_REPORT_AUTHOR || "Remote Solutions";
  const data_source =
    overrides.data_source ||
    `${fmt.count(facts.counts.captures)} captures · ${source}`;

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
