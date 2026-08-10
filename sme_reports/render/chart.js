const { DateTime } = require("luxon");
const { PLOT, linear, y_ticks, x_ticks } = require("./scales");

// Pure SVG time-series chart generator reproducing the reports_new exemplar
// geometry: gridlines + right-anchored y labels, x date ticks, orange event
// window, min/max band polygon, series polyline, dashed OEM threshold line,
// and annotated circle markers. Returns the full <svg> string.

const COLORS = {
  grid: "#EBF0F5",
  axis_text: "#57585A",
  band: "#97C6E9",
  series: "#004E79",
  event: "#F58025",
  threshold: "#E50B14"
};

const r1 = (n) => Math.round(n * 10) / 10;
const day_label = (t) => DateTime.fromMillis(t, { zone: "utc" }).toFormat("MM-dd");

const render_timeseries_chart = ({
  points, // [{t, min, max, v}] — min === max === v in line mode
  x_domain, // [t0, t1] epoch ms
  y_spec, // {domain: [lo, hi], step} from scales.pressure_domain/padded_domain
  y_format, // (v) => axis label string
  event_windows, // [{start, end|null}] epoch ms, or null
  thresholds, // [{value, label}] — dashed red alert line(s); [] or null for none
  markers, // [{t, v, color, label, dy?}]
  stroke_width = 2,
  start_label = null, // optional label drawn under the first point
  alarm_runs = null, // [{start, end}] — amber strip segments along the top edge
  height = 152 // viewBox height; sensor-suspect briefs render shorter charts
  // to buy the banner its room — the default preserves exemplar geometry
  // pixel-for-pixel on every other page
}) => {
  // Bottom margin (x labels + gap) is fixed; a shorter chart loses plot
  // area, not label room.
  const plot = { ...PLOT, y0: height - 26 };
  const label_y = height - 6;
  const sx = linear(x_domain, [plot.x0, plot.x1]);
  const sy = linear(y_spec.domain, [plot.y0, plot.y1]);
  const parts = [];

  for (const v of y_ticks(y_spec)) {
    const y = r1(sy(v));
    parts.push(
      `<line x1="${plot.x0}" x2="${plot.x1}" y1="${y}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`,
      `<text x="40" y="${r1(y + 3)}" text-anchor="end" font-size="8.5" fill="${COLORS.axis_text}">${y_format(v)}</text>`
    );
  }

  // Drop interior ticks that would repeat an endpoint's day label
  // (e.g. an interior midnight tick on the same day the window ends).
  const ticks = x_ticks(x_domain, sx);
  const end_labels = [day_label(x_domain[0]), day_label(x_domain[1])];
  for (const tick of ticks) {
    const label = day_label(tick.t);
    if (tick.anchor === "middle" && end_labels.includes(label)) continue;
    parts.push(
      `<text x="${r1(sx(tick.t))}" y="${label_y}" font-size="8.5" fill="${COLORS.axis_text}" text-anchor="${tick.anchor}">${label}</text>`
    );
  }

  for (const ev of event_windows || []) {
    const ex0 = Math.max(plot.x0, r1(sx(ev.start)));
    const ex1 = ev.end === null ? plot.x1 : r1(sx(ev.end));
    parts.push(
      `<rect x="${ex0}" y="${plot.y1}" width="${r1(Math.max(ex1 - ex0, 2))}" height="${plot.y0 - plot.y1}" fill="${COLORS.event}" opacity="0.09"/>`
    );
  }

  if (points.length) {
    const has_band = points.some((p) => p.max !== p.min);
    if (has_band) {
      const fwd = points.map((p) => `${r1(sx(p.t))},${r1(sy(p.max))}`);
      const rev = [...points]
        .reverse()
        .map((p) => `${r1(sx(p.t))},${r1(sy(p.min))}`);
      parts.push(
        `<polygon points="${fwd.concat(rev).join(" ")}" fill="${COLORS.band}" opacity="0.45"/>`
      );
    }
    const line = points.map((p) => `${r1(sx(p.t))},${r1(sy(p.v))}`).join(" ");
    parts.push(
      `<polyline points="${line}" fill="none" stroke="${COLORS.series}" stroke-width="${stroke_width}" stroke-linejoin="round"/>`
    );
  }

  for (const run of alarm_runs || []) {
    const ax0 = Math.max(plot.x0, r1(sx(run.start)));
    const ax1 = Math.min(plot.x1, r1(sx(run.end)));
    parts.push(
      `<rect x="${ax0}" y="${plot.y1}" width="${r1(Math.max(ax1 - ax0, 2))}" height="3" fill="#C25E00" opacity="0.8"/>`
    );
  }

  for (const threshold of thresholds || []) {
    const ty = r1(sy(threshold.value));
    parts.push(
      `<line x1="${plot.x0}" x2="${plot.x1}" y1="${ty}" y2="${ty}" stroke="${COLORS.threshold}" stroke-width="1.6" stroke-dasharray="5,4"/>`
    );
    if (threshold.label)
      parts.push(
        `<text x="300" y="${r1(ty - 5)}" text-anchor="end" font-size="9" font-weight="700" fill="${COLORS.threshold}">${threshold.label}</text>`
      );
  }

  if (start_label && points.length) {
    parts.push(
      `<text x="${plot.x0 + 4}" y="${r1(sy(points[0].v) + 14)}" font-size="9.5" font-weight="700" fill="${COLORS.series}">${start_label}</text>`
    );
  }

  for (const m of markers || []) {
    const cx = r1(sx(m.t));
    const cy = r1(sy(m.v));
    const dy = m.dy === undefined ? 4 : m.dy;
    // Labels sit left of the marker; near the left plot edge they would run
    // off the canvas, so flip them to the right side instead.
    const flip = cx < plot.x0 + 110;
    parts.push(
      `<circle cx="${cx}" cy="${cy}" r="4" fill="${m.color}" stroke="#fff" stroke-width="2"/>`,
      `<text x="${r1(flip ? cx + 8 : cx - 8)}" y="${r1(cy + dy)}" text-anchor="${flip ? "start" : "end"}" font-size="9.5" font-weight="700" fill="${m.color}">${m.label}</text>`
    );
  }

  return `<svg viewBox="0 0 640 ${height}" width="100%">${parts.join("")}</svg>`;
};

module.exports = { render_timeseries_chart, COLORS };
