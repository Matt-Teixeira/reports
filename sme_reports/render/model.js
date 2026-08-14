const { chart_points } = require("../compute/series");
const { analyze_system } = require("../compute/analyze");
const { STATUS_LABELS } = require("../conditions");
const {
  pressure_domain,
  padded_domain
} = require("./scales");
const { render_timeseries_chart } = require("./chart");
const { build_tiles } = require("./tiles");
const { build_narrative } = require("./narrative");
const fmt = require("./fmt");

// Turns identity + normalized series + request into the flat view-model that
// page.js interpolates. All display strings are finalized here; the
// ANALYSIS itself (screening, events, metrics, facts, archetype, overlays)
// lives in compute/analyze.js — this wrapper adds only presentation:
// threshold-line labels, the data-quality banner, narrative + density
// tiering, the two chart SVGs, and the page's display strings.

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
  const { facts, views } = analyze_system({
    system_id: identity.system_id,
    vendor,
    series,
    window: request.window,
    event_window: request.event_window,
    edu,
    edu_source,
    thresholds,
    units
  });
  // Locals the presentation code below reads — all analysis products.
  // `units`/`thresholds` are re-bound to the RESOLVED values (analyze owns
  // the fallback defaulting).
  const { mode, p_points, he_points } = views;
  const {
    thr,
    window_start,
    window_end,
    compressor_events,
    pressure,
    helium,
    temp_alarm,
    quenched,
    last_suspect,
    implausible
  } = facts;
  units = facts.units;

  const x_domain = [window_start, window_end];
  const { decimals } = vendor.pressure;
  const breaches = (v) =>
    (thr.high_gt !== null && v >= thr.high_gt) ||
    (thr.high_lt !== null && v <= thr.high_lt);

  // Threshold line(s): a single upper line, or upper+lower pair for
  // band-alerted metrics (Siemens absolute PSIA). Deliberately NOT named
  // after the manufacturer ("PHILIPS ALERT — …"): these are OUR alert
  // limits from alert.models, and a vendor's name on the line read as an
  // OEM specification. "UPPER/LOWER LIMIT" names the line's role and
  // makes the >/< glyphs redundant.
  const threshold_lines = [];
  if (thr.high_gt !== null)
    threshold_lines.push({
      value: thr.high_gt,
      label: `UPPER LIMIT — ${thr.high_gt} ${units.pressure}`
    });
  if (thr.high_lt !== null)
    threshold_lines.push({
      value: thr.high_lt,
      label: `LOWER LIMIT — ${thr.high_lt} ${units.pressure}`
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

  // Narrative first: the page's density tier depends on how much prose the
  // period produced, and the charts' height depends on the tier.
  const overrides = request.narrative_overrides || {};
  const generated = build_narrative(facts);
  const story_html = overrides.story || generated.story_html;
  const rx_cards =
    Array.isArray(overrides.rx_cards) && overrides.rx_cards.length
      ? overrides.rx_cards
      : generated.rx_cards;

  // One page, hard (.page is 11in with overflow:hidden — anything past the
  // footer is clipped SILENTLY). Prose length is bounded but variable: a
  // period can legitimately produce ten events, six flickers, and two alarm
  // runs. Pages whose flowed text exceeds the measured capacity of the
  // normal layout switch to a compact tier (smaller story/card faces,
  // shorter charts) so the worst natural page still clears the footer.
  // Calibration (Chromium, review F1): normal capacity ≈ 1,600 chars —
  // 1,577 fit with 35px to spare, 1,648 clipped by 22px. The threshold
  // sits a safe margin under the cliff; the maximal fixtures in
  // dev/check_chart.js re-measure both tiers on every run.
  const COMPACT_AT = 1400;
  const text_len = (s) => String(s).replace(/<[^>]+>/g, "").length;
  const content_len =
    text_len(story_html) +
    rx_cards.reduce((n, c) => n + text_len(c.body) + text_len(c.heading), 0) +
    (banner ? text_len(banner.text) + text_len(banner.label) : 0);
  const density = content_len > COMPACT_AT ? "compact" : null;

  // Banner pages trade chart height for the banner's room; compact pages
  // trade a further notch for their extra prose. All measured, not assumed.
  const chart_height = banner ? (density ? 92 : 100) : density ? 128 : 152;

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
    // Identity + period only. The capture count lives in foot_source and the
    // analyzed date in the header, so the sub-line no longer repeats them —
    // it leads with the site id, the id a customer files this magnet under.
    sub_line: [
      identity.site_id,
      identity.customer_name,
      `${identity.manufacturer} ${identity.modality || ""}`.trim(),
      identity.city && identity.state
        ? `${identity.city}, ${identity.state}`
        : identity.city || identity.state,
      win_span
    ]
      .filter(Boolean)
      .join(" · "),
    tiles: build_tiles(facts),
    banner,
    density,
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
