const logo_base64 = require("./assets/logo");
const CHARW8 = require("./assets/charw8");
const fmt = require("./fmt");
const { COLORS } = require("../output/email_theme");
const {
  condition_label,
  condition_short,
  condition_color,
  effective_status,
  URGENT
} = require("../conditions");
const { he_suffix } = require("./tiles");
const { limit_key, edu_channel_fresh } = require("./fleet_model");

// Renders the fleet summary view-model to a multi-page HTML document.
// Interpolation only — all decisions live in fleet_model.js.
//
// Pagination is deterministic: the model has already chunked rows, and each
// chunk becomes one <div class="page"> of exactly 8.5x11in. Chromium is never
// asked to choose a break. That keeps the branded header/band/footer working
// per sheet (.foot is absolutely positioned inside .page) and makes the page
// count assertable from the HTML string alone, without rendering a PDF.
//
// This does NOT share render/page.js's CSS. The per-system brief is a shipped,
// pixel-verified one-pager and its density rules are wrong here; only the
// palette is shared, via COLORS.

// Everything below reaches the page from the database (site names, customer
// names, failure messages), so it must be escaped — nothing else in this
// codebase escapes anything, and a site named "Smith & Sons <West>" would
// otherwise corrupt the markup.
const esc = (v) => {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
};

const trunc = (v, n) => {
  const s = String(v === null || v === undefined ? "" : v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const CSS = `
@page { size: letter; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #070809; }
.page { width: 8.5in; height: 11in; padding: .42in .5in 0; overflow: hidden; position: relative; background: #fff; page-break-after: always; break-after: page; }
.page:last-child { page-break-after: auto; break-after: auto; }
.hdr { display: flex; align-items: center; justify-content: space-between; height: .48in; }
/* The logo image costs ~520KB per sheet it appears on — Chromium embeds it
   as a separate object per page rather than sharing one. On a 9-page fleet
   document that is a 4.6MB email attachment, so the full lockup rides the
   cover only and continuation pages carry a text running head. */
.brand { width: 1.55in; height: .48in; background-image: url(data:image/png;base64,${logo_base64}); background-size: contain; background-repeat: no-repeat; background-position: left center; }
.wordmark { font-size: 12pt; font-weight: 800; color: ${COLORS.navy}; letter-spacing: .02em; align-self: center; }
.hdr .r { text-align: right; font-size: 9.5pt; color: ${COLORS.grey}; line-height: 1.35; }
.band { height: .08in; border-radius: .05in; margin: .09in 0 .16in; background: linear-gradient(90deg,${COLORS.navy} 0 30%,${COLORS.blue} 30% 62%,${COLORS.light} 62% 100%); }
h1 { font-size: 17.5pt; color: ${COLORS.navy}; }
/* One line, not two: at 10.5pt the internal variant's sub wrapped "7
   excluded" onto a second line and pushed the whole cover down. */
.sub { font-size: 9.5pt; color: ${COLORS.grey}; margin-top: .05in; }
h2 { font-size: 10pt; letter-spacing: .1em; color: ${COLORS.blue}; margin: .2in 0 .06in; }
h2 .n { color: ${COLORS.grey}; font-weight: 400; letter-spacing: 0; }
.lead { font-size: 12pt; color: ${COLORS.navy}; margin-top: .14in; }
.lead b { font-size: 14pt; }
/* Rollup tiles: a white card capped by a rule in the condition's OWN color —
   the same color already carried by the count below it, brought to the card
   edge so the rollup reads as graded data rather than six grey tubs. No new
   meaning: the cap color is set inline from the same c.color the count uses,
   so a state can never wear a cap it doesn't wear in its number. */
.roll { display: flex; gap: .085in; margin-top: .1in; }
.roll .c { flex: 1; border: .5pt solid #DCE4EB; border-top: 2.5pt solid ${COLORS.grey}; border-radius: .045in; padding: .075in .1in .08in; background: #fff; }
/* Fixed label height so the counts sit on one baseline even when a long
   condition name wraps to two lines. */
.roll .c .k { font-size: 7pt; letter-spacing: .08em; color: ${COLORS.grey}; text-transform: uppercase; height: .24in; }
.roll .c .v { font-size: 15pt; font-weight: 800; margin-top: .02in; }
.roll .c .s { font-size: 7.5pt; color: ${COLORS.grey}; }
/* Fixed layout with no wrapping anywhere: row height must be constant, since
   pagination is computed from it. A cell that wraps to a third line silently
   pushes rows past the page bottom, where overflow:hidden eats them. */
table { width: 100%; border-collapse: collapse; margin-top: .04in; table-layout: fixed; }
/* The header is a RULE, not a slab. A solid navy bar across nine columns
   out-weighed every row beneath it and spent contrast on the one line of the
   table that carries no data. Horizontal padding drops .05in -> .035in on both
   header and body: ~2px per column boundary, harvested straight into SITE
   (see SECTION_W). Vertical padding is deliberately UNCHANGED — row
   height is what fleet_model.js's ROWS_* constants are derived from. */
thead th { background: none; color: ${COLORS.navy}; font-size: 6pt; letter-spacing: .04em; padding: .04in .035in; text-align: left; font-weight: 700; white-space: nowrap; overflow: hidden; border-bottom: 1pt solid ${COLORS.navy}; }
tbody td { font-size: 8pt; color: ${COLORS.navy}; padding: .035in .035in; border-bottom: .4pt solid #E6EAEE; vertical-align: top; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.25; }
/* Two text lines plus padding. fleet_model.js's ROWS_* constants are derived
   from this height — change one and re-run check_fleet.js, which measures the
   real rendered geometry rather than trusting either number. */
tbody tr { height: .28in; }
/* Zebra fill removed: with a ruled header and a hairline under every row, the
   alternating band was a third tracking device competing with the other two,
   and its .05in of tinted padding was the widest thing on the page that
   carried no information. Row rules do the tracking now. */
td.n, th.n { text-align: right; }
/* Hairlines fencing the metric + % OF LIMIT pair from its neighbors.
   Positions 4 and 6 hold because every vendor's column list starts
   [system, site, condition, primary, line, helium, ...] — check_fleet.js
   asserts that ordering. Now that the header is white, its fences take the
   same light rule as the body instead of a white-on-navy ghost. */
table.vendor tbody td:nth-child(4),
table.vendor tbody td:nth-child(6) { border-left: .5pt solid #DCE4EB; }
table.vendor thead th:nth-child(4),
table.vendor thead th:nth-child(6) { border-left: .5pt solid #DCE4EB; }
.sys { font-weight: 700; }
/* Miniature band gauge: two edge ticks and a dot at the current reading.
   Position IS the meaning — centered is healthy, an edge is an alert line —
   which is why centered-band (Siemens 4K) rows draw this instead of a
   percentage that would call a healthy magnet "93% of the line". */
.bg { position: relative; display: inline-block; width: 44px; height: 8px; vertical-align: middle; }
.bg::before, .bg::after { content: ""; position: absolute; top: 0; bottom: 0; width: 1.2px; background: ${COLORS.blue}; }
.bg::before { left: 0; }
.bg::after { right: 0; }
.bg .t { position: absolute; left: 1px; right: 1px; top: 3.5px; height: 1px; background: ${COLORS.light}; }
.bg .d { position: absolute; top: 1.5px; width: 5px; height: 5px; border-radius: 50%; background: ${COLORS.navy}; margin-left: -2.5px; }
.bg .d.edge { background: ${COLORS.amber}; }
/* The shared second-line idiom: site carries city/state, system the SME id
   under a customer id, compressor its event history, data-issue readings
   their passing sensors. One selector so the four can never drift apart. */
td .m { color: ${COLORS.grey}; font-size: 7pt; font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
.dim { color: ${COLORS.grey}; }
.note { font-size: 8pt; color: ${COLORS.grey}; margin-top: .1in; line-height: 1.45; }
/* The legend: a bordered three-column glossary pinned above the footer on the
   LAST page, replacing what was one dense paragraph of prose. Bordered like
   the brief's rx cards so it reads as reference material, not story.
   It sat on the cover until the reference material was moved behind the
   findings: on a scoped document — five systems, one attention row — a
   bottom-pinned cover legend stranded a band of white in the MIDDLE of the
   flagship page, between the table and the box. Closing the document with it
   lets the cover flow top-down (whitespace collects at the foot, where it
   reads as margin) and puts the glossary where a reader reaches for it,
   after meeting the terms. fleet_model.js budgets the last page's rows
   against LEGEND_ROWS so content can never run into it.
   Column-count, not a 3-col grid: in a grid every row is as tall as its
   tallest cell, which cost the old legend ragged vertical gutters and about
   a quarter of its height for nothing. */
.legend.pin { position: absolute; left: .5in; right: .5in; bottom: .5in; margin: 0; border: 1.5px solid ${COLORS.light}; border-radius: .1in; padding: .07in .12in .08in; background: #fff; }
.legend .lg-cap { font-size: 7pt; letter-spacing: .12em; color: ${COLORS.blue}; font-weight: 700; margin-bottom: .035in; }
.legend .lg-grid { column-count: 3; column-gap: .16in; }
.legend .lg-grid div { font-size: 6.8pt; color: ${COLORS.grey}; line-height: 1.32; break-inside: avoid; margin-bottom: .028in; }
.legend .lg-grid b { color: ${COLORS.navy}; }
.foot { position: absolute; left: 0; right: 0; bottom: 0; height: .38in; background: ${COLORS.navy}; color: #fff; display: flex; align-items: center; justify-content: space-between; padding: 0 .5in; font-size: 8.5pt; }
`;

const page_wrap = (vm, n, body) => `<div class="page">
<div class="hdr">${n === 1 ? `<div class="brand"></div>` : `<div class="wordmark">Avante</div>`}<div class="r">${esc(vm.title)}<br><b>${esc(vm.analyzed_date)}</b></div></div>
<div class="band"></div>
${body}
<div class="foot"><span>Avante · Moving Healthcare Forward</span><span>${esc(vm.window_span)} · page ${n} of ${vm.page_count}</span></div>
</div>`;

// --- cell renderers ---------------------------------------------------
// Each returns a finished <td>. Null everywhere reads as an em dash rather
// than a fabricated value.

const dash = `<td class="dim">—</td>`;

// Where the customer has their own id for the magnet (systems.cus_sys_id),
// it leads the cell — it is the id the reader files this machine under —
// with the SME id beneath in the same small grey the site cell uses for
// city/state. Systems without one keep the SME id alone, full weight.
//
// Customer ids run 3–19 chars (median 7); the column is sized for the common
// shapes, and longer ids step down 8pt → 7pt → 6pt so they still render in
// FULL rather than ellipsising — an id is exactly the string a reader greps
// their asset list for, so "45630-130748…" is worth little. Width is summed
// from charw8 (per-char px measured in the same Chromium that lays out the
// PDF); KERN_MARGIN covers the kerning the per-char sum cannot see, 1.25px
// worst-measured (dev/gen_charw.js prints it — re-run after a font change).
// Ids too wide even at 6pt (a 19-char id in GE's narrow section) ellipsise;
// the SME id beneath always renders whole, so the row stays identifiable.
const KERN_MARGIN = 2.5;
const text_w8 = (s) => {
  let w = 0;
  // Non-ASCII falls back to 16px per char — wider than the widest measured
  // ASCII glyph (~14.6), wide Cyrillic (Щ ≈ 14.1), and the 1em advance of a
  // fullwidth CJK glyph at 8pt (10.7). A genuinely conservative fallback can
  // only step the font DOWN a tier or ellipsise; a mid-range guess (an
  // earlier 10px) let an 8-char Cyrillic id pass as fitting at 8pt and clip.
  for (const ch of String(s)) w += CHARW8[ch] ?? 16;
  return w;
};
const id_pt = (id, avail) =>
  [8, 7, 6].find((pt) => (text_w8(id) * pt) / 8 <= avail - KERN_MARGIN) || 6;

const cell_system = (r, section, geom) => {
  if (!r.cus_sys_id) return `<td class="sys">${esc(r.system_id)}</td>`;
  const pt = id_pt(r.cus_sys_id, geom.sys_avail);
  return (
    `<td class="sys"><span class="cid"${pt === 8 ? "" : ` style="font-size:${pt}pt;"`}>${esc(r.cus_sys_id)}</span>` +
    `<div class="m">${esc(r.system_id)}</div></td>`
  );
};

// The 30/26-char server-side caps are sized for the vendor tables' narrow
// SITE column; the EDU table's SITE is ~3× wider, so it gets the full name
// and lets CSS ellipsise the (rare) overflow instead.
const cell_site = (r, section) => {
  const wide = section && section.vendor_key === "EDU";
  return `<td class="site">${esc(wide ? r.site_name : trunc(r.site_name, 30))}<div class="m">${esc(trunc([r.city, r.state].filter(Boolean).join(", "), wide ? 60 : 26))}</div></td>`;
};

// Overlay states replace the archetype label — a dead compressor signal
// would otherwise wear "STOP, ONGOING" in red, which is the exact claim the
// data does not support.
const STATUS_SHORT = {
  warm_offline: "OFF ENTIRE PERIOD",
  no_signal: "no signal",
  sensor_suspect: "sensor suspect"
};

const cell_condition = (r) => {
  const status = effective_status(r);
  if (status) {
    const color = status === "warm_offline" ? COLORS.amber : COLORS.grey;
    return `<td style="color:${color};">${STATUS_SHORT[status]}ᶜ</td>`;
  }
  const color = condition_color(r.archetype);
  const weight = URGENT.has(r.archetype) ? "700" : "400";
  return `<td style="color:${color};font-weight:${weight};">${esc(condition_short(r.archetype))}</td>`;
};

// A reading outside its plausibility bounds renders greyed with a ‡ and
// judges nothing — the raw number stays visible so a human can assess the
// sensor, but it cannot color, breach, or page anyone.
const flagged = (r, key) => (r.data_flags ? r.data_flags[key] === true : false);

const cell_primary = (r) => {
  if (r.primary_value === null) return dash;
  if (flagged(r, "primary"))
    return `<td class="n dim">${fmt.num(r.primary_value, r.primary_decimals)}‡</td>`;
  return `<td class="n">${fmt.num(r.primary_value, r.primary_decimals)}</td>`;
};

// The dimensionless column: a percentage of this system's own alert line, or
// the band position for two-sided (Siemens absolute pressure) metrics. An
// asterisk marks a system with no configured alert model, where the
// denominator is a vendor default rather than its own line.
const cell_line = (r, section) => {
  if (flagged(r, "primary")) return dash;
  const oem = r.thr_source === "oem_constant" ? "*" : "";
  // The section heading states the limit these percentages are measured
  // against. A system on a different limit says so in its own row, so the
  // heading is never quietly wrong for it.
  const own =
    section && section.limit && limit_key(r) !== section.limit.key && r.thr_high_gt !== null
      ? ` <span class="dim">(${r.thr_high_gt})</span>`
      : "";
  const color =
    r.primary_severity === "high"
      ? COLORS.red
      : r.primary_severity === "med"
        ? COLORS.amber
        : COLORS.navy;
  // A current breach is the headline fact. Where a percentage exists it says
  // the same thing AND the magnitude — 194% beats "over" — so the word is
  // only used when there is no number to show (a centered band, or a
  // low-only threshold with no high line to measure against).
  if (r.primary_breach)
    return r.primary_pct === null
      ? `<td style="color:${COLORS.red};font-weight:700;">${r.primary_breach === "high" ? "over" : "under"}${oem}${own}</td>`
      : `<td class="n" style="color:${COLORS.red};font-weight:700;">${r.primary_pct}%${oem}${own}</td>`;
  if (r.primary_pct === null) {
    // Centered band: a dot on a miniature gauge, positioned within THIS
    // system's own edges — which is also why the "(16.3)" own-limit bracket
    // vanished here; a self-relative gauge has nothing to footnote. Dots in
    // the outer tenth turn amber: drifting toward an edge.
    if (r.primary_band_pos !== null && r.primary_band_pos !== undefined) {
      const pos = Math.min(0.97, Math.max(0.03, r.primary_band_pos));
      const edge = r.primary_band_pos < 0.1 || r.primary_band_pos > 0.9;
      return `<td class="n"><span class="bg"><span class="t"></span><span class="d${edge ? " edge" : ""}" style="left:${(pos * 100).toFixed(1)}%;"></span></span>${oem}</td>`;
    }
    return r.primary_band
      ? `<td style="color:${color};">band${oem}${own}</td>`
      : `<td class="dim">no limit</td>`;
  }
  // Trend as an arrow, not a word: "37% easing" ellipsises in this column,
  // and a clipped "37% e…" is worse than no trend at all. Legend explains it.
  const arrow =
    r.primary_trend === "rising" ? "↑" : r.primary_trend === "easing" ? "↓" : "";
  const trend = arrow ? ` <span class="dim">${arrow}</span>` : "";
  return `<td class="n" style="color:${color};">${r.primary_pct}%${oem}${own}${trend}</td>`;
};

// Level and change in one cell — two columns of numbers this narrow would
// each have to truncate. Litres read whole: "1392 LTRS", not "1392.40 LTRS".
const cell_helium = (r) => {
  // A quench is recorded independently of the primary metric, so it must be
  // stated outright — a quenched magnet can otherwise show a normal pressure
  // and a "stable / healthy" condition.
  if (r.quenched === true)
    return `<td class="n" style="color:${COLORS.red};font-weight:700;">QUENCH</td>`;
  if (r.helium_value === null) return dash;
  if (flagged(r, "helium")) {
    const decimals = r.helium_units === "%" ? r.helium_decimals : 0;
    return `<td class="n dim">${fmt.num(r.helium_value, decimals)}${esc(he_suffix(r.helium_units))}‡</td>`;
  }
  const low = r.helium_low_high !== null && r.helium_value < r.helium_low_high;
  const color = low ? COLORS.red : COLORS.navy;
  const decimals = r.helium_units === "%" ? r.helium_decimals : 0;
  // Percent helium carries its change; litres does not — a "+0.0 LTRS" costs
  // 30px of a column that has none to spare, and the per-system brief has it.
  const delta =
    r.helium_delta === null || r.helium_units !== "%"
      ? ""
      : ` <span class="dim">${esc(fmt.signed(r.helium_delta, 1))}</span>`;
  return `<td class="n" style="color:${color};">${fmt.num(r.helium_value, decimals)}${esc(he_suffix(r.helium_units))}${delta}</td>`;
};

const cell_coldhead = (r) => {
  if (r.coldhead_k === null) return dash;
  if (flagged(r, "coldhead")) return `<td class="n dim">${fmt.num(r.coldhead_k, 0)} K‡</td>`;
  const warm =
    r.coldhead_warm_k !== null && r.coldhead_k >= r.coldhead_warm_k;
  return `<td class="n" style="color:${warm ? COLORS.red : COLORS.navy};">${fmt.num(r.coldhead_k, 1)} K</td>`;
};

const cell_shield = (r) => {
  if (r.shield_k === null) return dash;
  if (flagged(r, "shield")) return `<td class="n dim">${fmt.num(r.shield_k, 0)} K‡</td>`;
  return `<td class="n">${fmt.num(r.shield_k, 1)} K</td>`;
};

const cell_cabinet = (r) => {
  if (r.cabinet_c === null) return dash;
  if (flagged(r, "cabinet")) return `<td class="n dim">${fmt.num(r.cabinet_c, 0)} °C‡</td>`;
  const alarm = r.cabinet_alarm !== null && r.cabinet_c >= r.cabinet_alarm;
  const warn = r.cabinet_warn !== null && r.cabinet_c >= r.cabinet_warn;
  const color = alarm ? COLORS.red : warn ? COLORS.amber : COLORS.navy;
  return `<td class="n" style="color:${color};">${fmt.num(r.cabinet_c, 1)} °C</td>`;
};

// The event history is CAPPED text, so the column width is a closed claim
// rather than a bet on the data: counts past 99 read "99+", totals from 100h
// lose their half-hour decimal, and totals past 999h read "999+h" (only
// reachable on a >41-day window). The widest possible line is
// "99+ evt · 999+h" — 78px at 7pt, measured — which is what SECTION_W's
// compressor column is solved against. Exact figures live on the brief.
const evt_short = (n) => (n > 99 ? "99+" : String(n));
const hours_short = (h) => {
  const half = Math.round(h * 2) / 2;
  if (half >= 1000) return "999+h";
  if (half >= 100) return `${Math.round(half)}h`;
  return `${half.toFixed(1)}h`;
};

// State plus history in one cell — state on the top line, history beneath in
// the same small grey the site and system cells use for their second lines.
// One line used to hold both, which made the cell the widest thing in every
// section and still clipped valid extremes ("ON 10 evt · 100.0h" needed
// 107px against 93 in Philips, 99 in GE). compressor_on === null means the
// system reported no compressor state at all (non-TIM on EDU1 hardware); it
// must read as missing data, never as a healthy "ON".
const cell_compressor = (r) => {
  // null means the system reported no compressor state at all — an EDU1
  // non-TIM box, or any vendor whose readings are all null. It must read as
  // missing regardless of anything else on the record; a hand-supplied event
  // window used to sneak such a system through as a healthy "ON".
  if (r.compressor_on === null) return `<td class="dim">no data</td>`;
  const state = r.compressor_on === false ? "OFF" : "ON";
  // GE systems without an EDU have their state inferred from the coldhead —
  // per-row, since one GE section now mixes measured (EDU vibration) and
  // inferred systems.
  const mark = r.compressor_source === "coldhead_ruo_value" ? "ᶜ" : "";
  const color = r.compressor_on === false ? COLORS.red : COLORS.teal;
  // A left-censored stop was never observed starting; claiming hours would
  // overclaim, so the cell says what we know: off for the whole window.
  const history = r.left_censored
    ? "entire period"
    : r.event_count
      ? `${evt_short(r.event_count)} evt · ${hours_short(r.off_hours_total)}`
      : "none";
  return `<td><span style="color:${color};font-weight:700;">${state}${mark}</span><div class="m">${esc(history)}</div></td>`;
};

const cell_temp_alarm = (r) =>
  r.temp_alarm_runs
    ? `<td style="color:${COLORS.amber};">${r.temp_alarm_runs}×</td>`
    : `<td class="dim">none</td>`;

// EDU channel cell: last reading on top, the period range beneath in the
// shared second-line grey. No alert limits are configured for environmental
// channels, so these cells state readings and judge nothing — no color.
// A STALE channel (last plausible reading >24h before the period end) is a
// different claim than a current one: the cell dims and the reading's date
// sits beside the value, so an old number can never pass as the room's
// state right now. The period range KEEPS its line — the data the sensor
// produced while it ran is good data, and a probe fault or a dead unit is
// no reason to hide the room's real Aug-6-to-Aug-10 span (product review:
// "I would not want to truncate all data because some column has a
// problem"). Only the claim of currency changes, never the record.
const edu_cell = (r, ch, sfx, decimals) => {
  if (!ch) return dash;
  if (!edu_channel_fresh(r, ch))
    return (
      `<td class="n dim">${fmt.num(ch.last, decimals)}${sfx} · ${fmt.day(ch.last_t)}` +
      `<div class="m">${fmt.num(ch.min, decimals)}–${fmt.num(ch.max, decimals)}</div></td>`
    );
  return (
    `<td class="n">${fmt.num(ch.last, decimals)}${sfx}` +
    `<div class="m">${fmt.num(ch.min, decimals)}–${fmt.num(ch.max, decimals)}</div></td>`
  );
};
const cell_edu_room = (r) => edu_cell(r, r.edu.room_temp, " °F", 1);
const cell_edu_humidity = (r) => edu_cell(r, r.edu.humidity, "%", 0);
const cell_edu_probe_0 = (r) => edu_cell(r, r.edu.probe_0, " °F", 1);
const cell_edu_probe_1 = (r) => edu_cell(r, r.edu.probe_1, " °F", 1);

const CELLS = {
  // The SME id (and the customer-id line, up to its font floor — see
  // cell_system) must never ellipsise — a truncated id makes the row unusable.
  system: { label: "SYSTEM", render: cell_system },
  site: { label: "SITE", render: cell_site },
  condition: { label: "CONDITION", render: cell_condition },
  primary: { label: "NOW", render: cell_primary, numeric: true },
  // Sized for "VS ALERT LIMIT", the widest of this column's three possible
  // headers — not for the "% OF LIMIT" that most sections happen to show. A
  // section wears the mixed header whenever one centered-band row sits beside
  // a one-sided one, which is a property of per-system THRESHOLD DATA, not of
  // the vendor, so any section can grow it at any time.
  line: { label: "% OF LIMIT", render: cell_line, numeric: true },
  helium: { label: "HELIUM", render: cell_helium, numeric: true },
  coldhead: { label: "COLDHD", render: cell_coldhead, numeric: true },
  shield: { label: "SHIELD", render: cell_shield, numeric: true },
  cabinet: { label: "CABINET", render: cell_cabinet, numeric: true },
  compressor: { label: "COMPRESSOR", render: cell_compressor },
  temp_alarm: { label: "ALARM", render: cell_temp_alarm },
  edu_room: { label: "ROOM TEMP", render: cell_edu_room, numeric: true },
  edu_humidity: { label: "HUMIDITY", render: cell_edu_humidity, numeric: true },
  edu_probe_0: { label: "PROBE 0", render: cell_edu_probe_0, numeric: true },
  edu_probe_1: { label: "PROBE 1", render: cell_edu_probe_1, numeric: true }
};

// Column widths, PER SECTION, in px of the 7.5in (720px) content column —
// each row sums to exactly 720. table-layout is fixed, so anything that
// doesn't fit its column is ellipsised rather than allowed to wrap and
// break pagination.
//
// Widths used to be one weight table shared by all four sections. That made
// the 9-column GE section the binding constraint: every shared weight had to
// satisfy GE's narrowest unit, so in the other sections every fixed column
// overshot its measured need and the overshoot came out of SITE — the one
// column allowed to truncate, and the one that was measurably broken for it
// ("Memori…" on 143 of 144 rows). Solving each section on its own pixel
// budget releases that overshoot: every non-SITE column gets its widest
// measured line (headers included — a clipped column title misnames every
// number under it) plus headroom, SITE takes the true remainder, and SYSTEM
// gets the budget the customer-id line is tiered against (cell_system).
// GE has no slack to release, so its SYSTEM stays narrow and its long
// customer ids leant hardest on the font tiers. Derived by
// dev/solve_widths.js from dev/colbudget.js measurements — re-run both after
// touching any width or label here.
const SECTION_W = {
  PHILIPS: { system: 111, site: 113, condition: 121, primary: 76, line: 85, helium: 81, compressor: 89, temp_alarm: 44 },
  GE: { system: 81, site: 77, condition: 121, primary: 76, line: 85, helium: 88, coldhead: 51, shield: 52, compressor: 89 },
  SIEMENS: { system: 111, site: 106, condition: 121, primary: 76, line: 85, helium: 81, coldhead: 51, compressor: 89 },
  SIEMENS_NON_TIM: { system: 111, site: 105, condition: 121, primary: 76, line: 85, helium: 81, cabinet: 52, compressor: 89 },
  // Six columns and no condition/limit machinery, so SITE still gets more
  // room than any vendor section even after the channel columns were sized
  // for their widest STALE line ("118.2 \u00b0F \u00b7 Aug 26", 93.3px measured) —
  // the dimmed date rides beside the value so the range line survives.
  EDU: { system: 111, site: 189, edu_room: 105, edu_humidity: 105, edu_probe_0: 105, edu_probe_1: 105 }
};

// td horizontal padding both sides, matching the tbody td CSS above.
const TD_PAD_PX = 0.035 * 96 * 2;

// The value column is titled by its datum — HE PRESSURE, or SHIELD TEMP on
// non-TIM, where "pressure" would be a lie — with % OF LIMIT beside it and
// hairlines fencing the pair. Units live in the section heading (the alert
// limit names them), because "HE PRESSURE (PSI)" does not fit the column.
// An earlier design spanned a group header over a "NOW" sub-column; once the
// column carries the metric name itself, the banner repeating it above was
// pure redundancy and the header flattened back to one row.
const section_table = (section, rows) => {
  const W = SECTION_W[section.vendor_key];
  const total = section.columns.reduce((n, key) => n + W[key], 0);
  const colgroup =
    `<colgroup>` +
    section.columns
      .map((key) => `<col style="width:${((W[key] / total) * 100).toFixed(2)}%;">`)
      .join("") +
    `</colgroup>`;
  // Content px the SYSTEM cell actually has — what the customer-id font
  // tier in cell_system is chosen against.
  const geom = { sys_avail: W.system - TD_PAD_PX };

  const metric = rows.length ? String(rows[0].primary_name).toUpperCase() : "NOW";
  // Centered-band sections draw a gauge, not a percentage, so their ratio
  // column says what the gauge shows. A section can MIX modes — one system
  // on a centered band beside one on a high-only limit — and a header that
  // says WITHIN BAND over a 93% cell (or % OF LIMIT over a gauge) lies about
  // half its rows. Mixed sections get the neutral VS ALERT LIMIT; each cell
  // already says which display it is.
  const banded_count = rows.filter(
    (r) => r.primary_band_pos !== null && r.primary_band_pos !== undefined
  ).length;
  const banded = rows.length > 0 && banded_count === rows.length;
  const mixed = banded_count > 0 && !banded;

  const head = section.columns
    .map((key) => {
      const c = CELLS[key];
      const label =
        key === "primary"
          ? esc(metric)
          : key === "line" && banded
            ? "WITHIN BAND"
            : key === "line" && mixed
              ? "VS ALERT LIMIT"
              : c.label;
      return `<th${c.numeric ? ' class="n"' : ""}>${label}</th>`;
    })
    .join("");

  const body = rows
    .map((r) => `<tr>${section.columns.map((key) => CELLS[key].render(r, section, geom)).join("")}</tr>`)
    .join("\n");
  // The EDU table skips the .vendor class: its nth-child hairlines fence the
  // metric + % OF LIMIT pair, positions the EDU column set does not have.
  const cls = section.vendor_key === "EDU" ? "edu" : "vendor";
  return `<table class="${cls}">${colgroup}<thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
};

// --- overview page ----------------------------------------------------

const attention_table = (vm, rows) =>
  `<table><thead><tr>` +
  `<th style="width:11%;">SYSTEM</th><th style="width:29%;">SITE</th>` +
  `<th style="width:24%;">CONDITION</th><th style="width:36%;">WHY</th>` +
  `</tr></thead><tbody>\n` +
  rows
    .map(
      (r) =>
        `<tr><td class="sys">${esc(r.system_id)}</td><td>${esc(trunc(r.site_name, 34))}</td>` +
        cell_condition(r) +
        `<td class="dim">${esc(trunc(vm.attention_reason(r), 46))}</td></tr>`
    )
    .join("\n") +
  `\n</tbody></table>`;

const failures_table = (rows) =>
  `<table><thead><tr>` +
  `<th class="n" style="width:4%;">N</th><th style="width:42%;">REASON</th><th style="width:54%;">SYSTEMS</th>` +
  `</tr></thead><tbody>\n` +
  rows
    .map(
      (f) =>
        `<tr><td class="n">${f.first ? f.count : ""}</td>` +
        `<td>${f.first ? esc(f.reason) : ""}</td>` +
        `<td class="dim">${esc(f.systems.join(", "))}</td></tr>`
    )
    .join("\n") +
  `\n</tbody></table>`;

const overview_body = (vm, rows, first) => {
  const lead = vm.total
    ? `<b>${vm.total}</b> systems analyzed — <b style="color:${vm.attention_count ? COLORS.amber : COLORS.teal};">${vm.attention_count} need${vm.attention_count === 1 ? "s" : ""} attention</b>${vm.urgent_count ? `, <b style="color:${COLORS.red};">${vm.urgent_count} urgent</b>` : ""}${vm.data_issue_count ? `, <b style="color:${COLORS.grey};">${vm.data_issue_count} data issue${vm.data_issue_count === 1 ? "" : "s"}</b>` : ""}.`
    : `<b>No systems produced data</b> in this period.`;

  const rollup = vm.condition_rollup
    .map(
      (c) =>
        // The cap and the count take the SAME color from the SAME source, so
        // a tile can never be capped in a color its number does not carry.
        `<div class="c" style="border-top-color:${c.color || COLORS.grey};"><div class="k">${esc(c.label)}</div><div class="v" style="color:${c.color || COLORS.grey};">${c.count}</div><div class="s">${c.pct}% of ${vm.scope ? "these systems" : "fleet"}</div></div>`
    )
    .join("");

  const vendors = vm.vendor_rollup
    .map((v) => `${esc(v.title)} ${v.count}`)
    .join(" · ");

  // The masthead and rollup ride the first overview page only; continuation
  // pages carry the attention table alone.
  // A scoped cover states the RESOLUTION, not just the survivors: N systems
  // in scope, how many analyzed, and where the rest went (failed /
  // excluded) — the loud-resolution contract. vm.total alone counts only
  // successful records, which silently understated the scope whenever a
  // system failed (review round-1 F4).
  const sub = vm.scope
    ? [
        esc(vm.window_span),
        `${vm.scope.detail.systems} system${vm.scope.detail.systems === 1 ? "" : "s"} in scope`,
        `${vm.total} analyzed`,
        vm.failure_count ? `${vm.failure_count} failed` : null,
        vm.excluded ? `${vm.excluded.ids.length} excluded` : null,
        `${vm.scope.detail.sites} site${vm.scope.detail.sites === 1 ? "" : "s"}`,
        esc(vendors || "no vendor sections")
      ]
        .filter(Boolean)
        .join(" · ")
    : `${esc(vm.window_span)} · ${vm.total} systems · ${esc(vendors || "no vendor sections")}${vm.excluded ? ` · ${vm.excluded.ids.length} excluded` : ""}`;
  let body = first
    ? `<h1>${esc(vm.title)}</h1>` +
      `<div class="sub">${sub}</div>` +
      `<div class="lead">${lead}</div>` +
      (rollup ? `<div class="roll">${rollup}</div>` : "")
    : "";

  if (rows.length) {
    body +=
      `<h2>NEEDS ATTENTION <span class="n">— ${vm.attention.length} system${vm.attention.length === 1 ? "" : "s"}${first ? "" : " (cont.)"}</span></h2>` +
      attention_table(vm, rows);
  }

  return body;
};

// The legend closes the document — see the .legend.pin CSS note for why it is
// no longer on the cover. One legend per document, on the last page.
const LEGEND = `<div class="legend pin"><div class="lg-cap">LEGEND</div><div class="lg-grid">
<div><b>period</b> — the span of dates this report covers, shown beside every page number &nbsp; <b>HE PRESSURE · SHIELD TEMP</b> — current reading of the section's metric; units and limit in the heading</div>
<div><b>% OF LIMIT</b> — that reading as a share of the alert limit, comparable across mbar, PSI and Kelvin</div>
<div><b>↑ ↓</b> — rising · easing back from the period's peak &nbsp; <b>*</b> vendor-default limit &nbsp; <b>(16.3)</b> own limit differs from heading</div>
<div><b>PEAK OVER LIMIT</b> — the period's peak crossed the limit; the current reading may since have come back under it</div>
<div><b>STOP, ONGOING · recovered</b> — compressor stop observed this period; red while unrecovered</div>
<div><b>2 evt · 12.5h</b> — stop events this period · total observed downtime</div>
<div><b>WITHIN BAND</b> <span class="bg"><span class="t"></span><span class="d" style="left:62%;"></span></span> — dot = reading between the low and high alert edges (Siemens 4K); centered is healthy, an edge is an alert</div>
<div><b>flicker</b> — single-reading compressor dropout with no thermal response; noted on the system's brief, never counted as a stop</div>
<div><b>OFF ENTIRE PERIOD</b> — off since before the period began, start unknown; magnet already warm, so listed but not urgent</div>
<div><b>no signal · sensor suspect</b> — monitoring faults, not magnet faults; counted as DATA ISSUES with raw readings shown</div>
<div><b>‡ ✕</b> — reading outside plausible physical bounds; shown greyed but excluded from all status judgments</div>
<div><b>ᶜ</b> — concluded, not directly read: inferred (GE compressor from coldhead) or corroborated; unmarked = a reading or arithmetic on one</div>
<div><b>HELIUM · COLDHD · CABINET</b> — judged against their own thresholds; red or amber marks a reading past them</div>
<div><b>ENVIRONMENTAL (EDU)</b> — room/probe temperature and humidity from the site's EDU hardware; no alert limits are configured, so readings are stated, not judged; readings outside physical bounds (e.g. open-sensor defaults) are excluded; a dimmed value paired with a date is the sensor's last reading, from that day — the channel stopped reporting early; its range still covers the days it ran</div>
<div><b>urgent</b> — wrong right now (unrecovered stop, live breach, quench); each system's full one-page brief is generated separately</div>
</div></div>`;

// Monitoring problems, not magnet problems: dead compressor signals and
// sensor chains emitting impossible combinations. Raw readings are shown so
// nobody has to take the classification on faith; ✕ marks the readings that
// failed their plausibility bounds.
const data_issues_body = (vm, rows, first) =>
  `<h2>DATA ISSUES <span class="n">— ${vm.data_issue_count} system${vm.data_issue_count === 1 ? "" : "s"}, monitoring suspect${first ? "" : " (cont.)"}</span></h2>` +
  `<table><thead><tr>` +
  `<th style="width:13%;">SYSTEM</th><th style="width:18%;">SITE</th>` +
  `<th style="width:34%;">PROBLEM</th><th style="width:35%;">READINGS</th>` +
  `</tr></thead><tbody>\n` +
  rows
    .map(
      (r) =>
        `<tr><td class="sys">${esc(r.system_id)}</td><td>${esc(trunc(r.site_name, 26))}</td>` +
        `<td class="dim">${esc(vm.data_issue_reason(r))}</td>` +
        ((rd) =>
          `<td class="dim">${esc(rd.bad || rd.ok)}${rd.bad && rd.ok ? `<div class="m">${esc(rd.ok)}</div>` : ""}</td>`)(
          vm.data_issue_readings(r)
        ) +
        `</tr>`
    )
    .join("\n") +
  `\n</tbody></table>`;

const failures_body = (vm, rows, first) =>
  `<h2>NO REPORT PRODUCED <span class="n">— ${vm.failure_count} system${vm.failure_count === 1 ? "" : "s"}${first ? "" : " (cont.)"}</span></h2>` +
  failures_table(rows);

const build_fleet_page = (vm) => {
  const pages = vm.overview_pages.map((rows, i) => overview_body(vm, rows, i === 0));

  vm.data_issue_pages.forEach((rows, i) => pages.push(data_issues_body(vm, rows, i === 0)));
  vm.failure_pages.forEach((rows, i) => pages.push(failures_body(vm, rows, i === 0)));

  // Exclusions are a decision, not an accident — they are stated in full,
  // riding the failures page only when vendor sections follow (the legend
  // then closes the document elsewhere), on their own page otherwise. This
  // placement condition mirrors fleet_model.js's exclusion_pages — keep the
  // two in sync, or the footer paging lies. A system missing from this
  // document should always be findable as either a failure, a data issue,
  // or a named exclusion.
  if (vm.excluded) {
    const body =
      `<h2>EXCLUDED BY REQUEST <span class="n">— ${vm.excluded.ids.length} system${vm.excluded.ids.length === 1 ? "" : "s"}</span></h2>` +
      `<div class="note">${esc(vm.excluded.ids.join(", "))}${vm.excluded.note ? ` — ${esc(vm.excluded.note)}` : ""}. Not analyzed and not counted in any total above.</div>`;
    if (vm.failure_pages.length && vm.sections.length) pages[pages.length - 1] += body;
    else pages.push(body);
  }

  for (const section of vm.sections) {
    section.pages.forEach((rows, i) => {
      const cont = i > 0 ? ` <span class="n">(cont.)</span>` : "";
      // The limit rides every page of the section, not just the first — a
      // reader landing on page 8 needs to know what the percentages are of.
      // The limit label carries the units too, which is why the NOW column
      // header no longer needs them. Sections with no configured limit still
      // have to say what the NOW column is measured in.
      const units = rows.length ? esc(rows[0].primary_units) : "";
      const limit = section.limit
        ? ` <span class="n">· ${esc(section.limit.label)}${section.limit.exceptions ? ` (${section.limit.exceptions} differ)` : ""}</span>`
        : units
          ? ` <span class="n">· ${units}</span>`
          : "";
      const count = i === 0 ? ` <span class="n">— ${section.count} system${section.count === 1 ? "" : "s"}</span>` : "";
      pages.push(
        `<h2>${esc(section.title).toUpperCase()}${count}${limit}${cont}</h2>` +
          section_table(section, rows)
      );
    });
  }

  // Environmental section closes the data: every analyzed system whose EDU
  // reported this period, hottest room first. Units ride the heading like
  // the vendor sections' limits do.
  if (vm.edu_section) {
    vm.edu_section.pages.forEach((rows, i) => {
      const cont = i > 0 ? ` <span class="n">(cont.)</span>` : "";
      const count =
        i === 0
          ? ` <span class="n">— ${vm.edu_section.count} system${vm.edu_section.count === 1 ? "" : "s"}</span>`
          : "";
      pages.push(
        `<h2>${esc(vm.edu_section.title).toUpperCase()}${count} <span class="n">· °F / Relative Humidity</span>${cont}</h2>` +
          section_table(vm.edu_section, rows)
      );
    });
  }

  // The legend closes the document, pinned above the last page's footer.
  // fleet_model.js has already reserved the room: the final page's row budget
  // is LEGEND_ROWS lower than a normal page, and a section whose last chunk
  // would otherwise fill that page is re-split. Appending it here — after
  // every section has been laid out — is what makes "the last page" a fact
  // rather than a guess.
  if (pages.length) pages[pages.length - 1] += LEGEND;

  const html = pages
    .map((body, i) => page_wrap(vm, i + 1, body))
    .join("\n");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(vm.title)} — ${esc(vm.analyzed_date)}</title></head><style>${CSS}</style><body>
${html}
</body></html>
`;
};

module.exports = { build_fleet_page, esc, trunc, SECTION_W };
