const { DateTime } = require("luxon");
const { PLOT, linear, y_ticks, x_ticks } = require("./scales");
const CHARW8 = require("./assets/charw8");

// Pure SVG time-series chart generator reproducing the reports_new exemplar
// geometry: gridlines + right-anchored y labels, x date ticks, orange event
// window, min/max band polygon, series polyline, dashed threshold line(s),
// and annotated circle markers. Returns the full <svg> string.
//
// Labels are LAID OUT, not just emitted: every text on the chart occupies a
// measured box, and the movable ones (marker annotations, threshold labels)
// try alternative positions until they overlap nothing already placed. A
// peak near the alert line used to print "peak 74 · Jul 26" straight through
// "UPPER LIMIT — 80 mbar" — both positions were fixed constants that had
// never met on the same few pixels until real data put them there.

// Text widths summed from the same Chromium-measured table the fleet tables
// use (assets/charw8.js, 8pt = 10.667px; SVG sizes scale linearly). The few
// non-ASCII glyphs chart labels use are pinned here; anything else falls
// back wide, which only makes a label yield its spot sooner.
const CHARW_EXTRA = { "·": 4.9, "—": 10.7, "→": 10.7, "ᶜ": 5 };
const text_px = (s, size) => {
  const plain = String(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  let w = 0;
  for (const ch of plain) w += CHARW8[ch] ?? CHARW_EXTRA[ch] ?? 16;
  return (w * size) / 10.667;
};

// A label's occupied box from its SVG anchor point. y is the text BASELINE.
const label_box = ({ x, y, anchor, w, size }) => ({
  x0: anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x,
  x1: anchor === "end" ? x : anchor === "middle" ? x + w / 2 : x + w,
  y0: y - size,
  y1: y + 2
});

const boxes_overlap = (a, b, pad = 2) =>
  a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

// Occupied boxes accumulate; each movable label takes the first of its
// candidate positions that fits the canvas and touches nothing placed so
// far. Nothing fitting falls back to the first candidate — the historical
// position, so layout can only improve on the old behavior, never invent a
// worse spot.
const make_layout = (width, height) => {
  const placed = [];
  return {
    block: (b) => placed.push(b),
    place: (candidates, obstacles = null) => {
      // Two passes: first honoring soft obstacles (the series stroke), then
      // without them — a label lying across the data line is legible, a
      // label lying across ANOTHER LABEL is not, so the line yields before
      // any text-over-text fallback. Obstacles carry no extra pad (their
      // boxes already include the stroke's radius); labels pad each other.
      for (const soft of [obstacles, null]) {
        for (const c of candidates) {
          const b = label_box(c);
          if (b.x0 < 2 || b.x1 > width - 2 || b.y0 < 1 || b.y1 > height - 1) continue;
          if (placed.some((p) => boxes_overlap(p, b))) continue;
          if (soft && soft.some((p) => boxes_overlap(p, b, 0))) continue;
          placed.push(b);
          return c;
        }
        if (!obstacles) break;
      }
      const c = candidates[0];
      placed.push(label_box(c));
      return c;
    }
  };
};

// The series polyline as obstacle boxes: each drawn segment sampled every
// ~8px into 2px-radius boxes. Threshold labels avoid these — a label lying
// across the data stroke reads as part of the trace — while marker labels
// deliberately do NOT: they belong beside their point, which is ON the line.
const series_obstacles = (pts) => {
  const boxes = [];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 8));
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps;
      const y = y0 + ((y1 - y0) * s) / steps;
      boxes.push({ x0: x - 2, x1: x + 2, y0: y - 2, y1: y + 2 });
    }
  }
  return boxes;
};

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
  // Axis labels are immovable, so they enter the layout as blockers —
  // movable labels route around them instead of sitting on them.
  const layout = make_layout(640, height);

  for (const v of y_ticks(y_spec)) {
    const y = r1(sy(v));
    parts.push(
      `<line x1="${plot.x0}" x2="${plot.x1}" y1="${y}" y2="${y}" stroke="${COLORS.grid}" stroke-width="1"/>`,
      `<text x="40" y="${r1(y + 3)}" text-anchor="end" font-size="8.5" fill="${COLORS.axis_text}">${y_format(v)}</text>`
    );
    layout.block(label_box({ x: 40, y: r1(y + 3), anchor: "end", w: text_px(y_format(v), 8.5), size: 8.5 }));
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
    layout.block(label_box({ x: r1(sx(tick.t)), y: label_y, anchor: tick.anchor, w: text_px(label, 8.5), size: 8.5 }));
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
  const line_obstacles = points.length
    ? series_obstacles(points.map((p) => [sx(p.t), sy(p.v)]))
    : [];

  for (const run of alarm_runs || []) {
    const ax0 = Math.max(plot.x0, r1(sx(run.start)));
    const ax1 = Math.min(plot.x1, r1(sx(run.end)));
    parts.push(
      `<rect x="${ax0}" y="${plot.y1}" width="${r1(Math.max(ax1 - ax0, 2))}" height="3" fill="#C25E00" opacity="0.8"/>`
    );
  }

  // Threshold LINES draw here (under the markers); their labels are placed
  // after the marker labels below, because a threshold label can slide
  // anywhere along its line while a marker label must stay at its point —
  // the more movable text yields.
  for (const threshold of thresholds || []) {
    const ty = r1(sy(threshold.value));
    parts.push(
      `<line x1="${plot.x0}" x2="${plot.x1}" y1="${ty}" y2="${ty}" stroke="${COLORS.threshold}" stroke-width="1.6" stroke-dasharray="5,4"/>`
    );
  }

  if (start_label && points.length) {
    const w = text_px(start_label, 9.5);
    const y = r1(sy(points[0].v) + 14);
    parts.push(
      `<text x="${plot.x0 + 4}" y="${y}" font-size="9.5" font-weight="700" fill="${COLORS.series}">${start_label}</text>`
    );
    layout.block(label_box({ x: plot.x0 + 4, y, anchor: "start", w, size: 9.5 }));
  }

  // Marker annotations: the historical spot first (left of the point, or
  // right near the left edge), then the mirrored side, then either side
  // pushed further along the label's own vertical direction.
  const label_texts = [];
  for (const m of markers || []) {
    const cx = r1(sx(m.t));
    const cy = r1(sy(m.v));
    const dy = m.dy === undefined ? 4 : m.dy;
    const flip = cx < plot.x0 + 110;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="4" fill="${m.color}" stroke="#fff" stroke-width="2"/>`);
    const w = text_px(m.label, 9.5);
    const side = (right) =>
      right ? { x: r1(cx + 8), anchor: "start" } : { x: r1(cx - 8), anchor: "end" };
    const away = dy >= 0 ? 1 : -1;
    const candidates = [];
    for (const step of [0, 8, 16])
      for (const right of [flip, !flip])
        candidates.push({ ...side(right), y: r1(cy + dy + step * away), w, size: 9.5 });
    const c = layout.place(candidates);
    label_texts.push(
      `<text x="${c.x}" y="${c.y}" text-anchor="${c.anchor}" font-size="9.5" font-weight="700" fill="${m.color}">${m.label}</text>`
    );
  }

  for (const threshold of thresholds || []) {
    if (!threshold.label) continue;
    const ty = r1(sy(threshold.value));
    const w = text_px(threshold.label, 9);
    // The exemplar spot first (right-aligned at x=300, above the line),
    // then the right end of the line, then the same spots below the line,
    // then the left end — above the line preferred so the label reads as a
    // ceiling, below as a floor.
    const candidates = [
      { x: 300, y: r1(ty - 5) },
      { x: plot.x1, y: r1(ty - 5) },
      { x: 300, y: r1(ty + 12) },
      { x: plot.x1, y: r1(ty + 12) },
      { x: r1(plot.x0 + 4 + w), y: r1(ty - 5) },
      { x: r1(plot.x0 + 4 + w), y: r1(ty + 12) }
    ].map((c) => ({ ...c, anchor: "end", w, size: 9 }));
    const c = layout.place(candidates, line_obstacles);
    label_texts.push(
      `<text x="${c.x}" y="${c.y}" text-anchor="end" font-size="9" font-weight="700" fill="${COLORS.threshold}">${threshold.label}</text>`
    );
  }

  return `<svg viewBox="0 0 640 ${height}" width="100%">${parts.concat(label_texts).join("")}</svg>`;
};

module.exports = { render_timeseries_chart, COLORS };
