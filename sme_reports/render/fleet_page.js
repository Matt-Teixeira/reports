const logo_base64 = require("./assets/logo");
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
const { limit_key } = require("./fleet_model");

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
.sub { font-size: 10.5pt; color: ${COLORS.grey}; margin-top: .04in; }
h2 { font-size: 10pt; letter-spacing: .1em; color: ${COLORS.blue}; margin: .2in 0 .06in; }
h2 .n { color: ${COLORS.grey}; font-weight: 400; letter-spacing: 0; }
.lead { font-size: 12pt; color: ${COLORS.navy}; margin-top: .14in; }
.lead b { font-size: 14pt; }
.roll { display: flex; gap: .1in; margin-top: .1in; }
.roll .c { flex: 1; border-radius: .1in; padding: .09in .11in; background: ${COLORS.fill}; }
/* Fixed label height so the counts sit on one baseline even when a long
   condition name wraps to two lines. */
.roll .c .k { font-size: 7pt; letter-spacing: .08em; color: ${COLORS.grey}; text-transform: uppercase; height: .24in; }
.roll .c .v { font-size: 15pt; font-weight: 800; margin-top: .02in; }
.roll .c .s { font-size: 7.5pt; color: ${COLORS.grey}; }
/* Fixed layout with no wrapping anywhere: row height must be constant, since
   pagination is computed from it. A cell that wraps to a third line silently
   pushes rows past the page bottom, where overflow:hidden eats them. */
table { width: 100%; border-collapse: collapse; margin-top: .04in; table-layout: fixed; }
thead th { background: ${COLORS.navy}; color: #fff; font-size: 6pt; letter-spacing: .02em; padding: .04in .05in; text-align: left; font-weight: 600; white-space: nowrap; overflow: hidden; }
tbody td { font-size: 8pt; color: ${COLORS.navy}; padding: .035in .05in; border-bottom: .5pt solid ${COLORS.fill}; vertical-align: top; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.25; }
/* Two text lines plus padding. fleet_model.js's ROWS_* constants are derived
   from this height — change one and re-run check_fleet.js, which measures the
   real rendered geometry rather than trusting either number. */
tbody tr { height: .28in; }
tbody tr:nth-child(even) td { background: ${COLORS.fill}; }
td.n, th.n { text-align: right; }
/* Hairlines fencing the metric + % OF LIMIT pair from its neighbors.
   Positions 4 and 6 hold because every vendor's column list starts
   [system, site, condition, primary, line, helium, ...] — check_fleet.js
   asserts that ordering. */
table.vendor tbody td:nth-child(4),
table.vendor tbody td:nth-child(6) { border-left: .6pt solid ${COLORS.light}; }
table.vendor thead th:nth-child(4),
table.vendor thead th:nth-child(6) { border-left: .6pt solid rgba(255,255,255,.3); }
.sys { font-weight: 700; }
/* Miniature band gauge: two edge ticks and a dot at the current reading.
   Position IS the meaning — centered is healthy, an edge is an alert line —
   which is why centered-band (Siemens TIM) rows draw this instead of a
   percentage that would call a healthy magnet "93% of the line". */
.bg { position: relative; display: inline-block; width: 44px; height: 8px; vertical-align: middle; }
.bg::before, .bg::after { content: ""; position: absolute; top: 0; bottom: 0; width: 1.2px; background: ${COLORS.blue}; }
.bg::before { left: 0; }
.bg::after { right: 0; }
.bg .t { position: absolute; left: 1px; right: 1px; top: 3.5px; height: 1px; background: ${COLORS.light}; }
.bg .d { position: absolute; top: 1.5px; width: 5px; height: 5px; border-radius: 50%; background: ${COLORS.navy}; margin-left: -2.5px; }
.bg .d.edge { background: ${COLORS.amber}; }
.site .m { color: ${COLORS.grey}; font-size: 7pt; overflow: hidden; text-overflow: ellipsis; }
.dim { color: ${COLORS.grey}; }
.note { font-size: 8pt; color: ${COLORS.grey}; margin-top: .1in; line-height: 1.45; }
/* The legend: a bordered three-column glossary pinned above the footer on
   the cover, replacing what was one dense paragraph of prose. Pinned so it
   cannot trail the attention table and strand a blank half-page; bordered
   like the brief's rx cards so it reads as reference material, not story. */
.legend.pin { position: absolute; left: .5in; right: .5in; bottom: .5in; margin: 0; border: 1.5px solid ${COLORS.light}; border-radius: .1in; padding: .07in .12in .08in; background: #fff; }
.legend .lg-cap { font-size: 7pt; letter-spacing: .12em; color: ${COLORS.blue}; font-weight: 700; margin-bottom: .035in; }
.legend .lg-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: .022in .16in; }
.legend .lg-grid div { font-size: 6.8pt; color: ${COLORS.grey}; line-height: 1.32; }
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

const cell_system = (r) =>
  `<td class="sys">${esc(r.system_id)}</td>`;

const cell_site = (r) =>
  `<td class="site">${esc(trunc(r.site_name, 30))}<div class="m">${esc(trunc([r.city, r.state].filter(Boolean).join(", "), 26))}</div></td>`;

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

// State plus history in one cell. compressor_on === null means the system
// reported no compressor state at all (non-TIM on EDU1 hardware); it must
// read as missing data, never as a healthy "ON".
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
  // Abbreviated to hold one line: "OFF · 2 evt · 27.5h". The full phrasing
  // lives on the per-system brief.
  // A left-censored stop was never observed starting; claiming hours would
  // overclaim, so the cell says what we know: off for the whole window.
  const history = r.left_censored
    ? "entire period"
    : r.event_count
      ? `${r.event_count} evt · ${(Math.round(r.off_hours_total * 2) / 2).toFixed(1)}h`
      : "none";
  return `<td><span style="color:${color};font-weight:700;">${state}${mark}</span> <span class="dim">${esc(history)}</span></td>`;
};

const cell_temp_alarm = (r) =>
  r.temp_alarm_runs
    ? `<td style="color:${COLORS.amber};">${r.temp_alarm_runs}×</td>`
    : `<td class="dim">none</td>`;

// Widths are percentages of the 7.5in content column and must total 100 for
// each vendor's column set — table-layout is fixed, so anything that doesn't
// fit is ellipsised rather than allowed to wrap and break pagination.
const CELLS = {
  // SYSTEM must never ellipsise — a truncated id makes the row unusable.
  system: { label: "SYSTEM", render: cell_system, w: 13 },
  site: { label: "SITE", render: cell_site, w: 10 },
  condition: { label: "CONDITION", render: cell_condition, w: 20 },
  primary: { label: "NOW", render: cell_primary, numeric: true, w: 12 },
  line: { label: "% OF LIMIT", render: cell_line, numeric: true, w: 11 },
  helium: { label: "HELIUM", render: cell_helium, numeric: true, w: 15 },
  coldhead: { label: "COLDHD", render: cell_coldhead, numeric: true, w: 9 },
  shield: { label: "SHIELD", render: cell_shield, numeric: true, w: 8 },
  cabinet: { label: "CABINET", render: cell_cabinet, numeric: true, w: 9 },
  compressor: { label: "COMPRESSOR", render: cell_compressor, w: 18 },
  temp_alarm: { label: "ALARM", render: cell_temp_alarm, w: 7 }
};

// The value column is titled by its datum — HE PRESSURE, or SHIELD TEMP on
// non-TIM, where "pressure" would be a lie — with % OF LIMIT beside it and
// hairlines fencing the pair. Units live in the section heading (the alert
// limit names them), because "HE PRESSURE (PSI)" does not fit the column.
// An earlier design spanned a group header over a "NOW" sub-column; once the
// column carries the metric name itself, the banner repeating it above was
// pure redundancy and the header flattened back to one row.
const section_table = (section, rows) => {
  const total = section.columns.reduce((n, key) => n + CELLS[key].w, 0);
  const colgroup =
    `<colgroup>` +
    section.columns
      .map((key) => `<col style="width:${((CELLS[key].w / total) * 100).toFixed(2)}%;">`)
      .join("") +
    `</colgroup>`;

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
    .map((r) => `<tr>${section.columns.map((key) => CELLS[key].render(r, section)).join("")}</tr>`)
    .join("\n");
  return `<table class="vendor">${colgroup}<thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
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
        `<div class="c"><div class="k">${esc(c.label)}</div><div class="v" style="color:${c.color || COLORS.grey};">${c.count}</div><div class="s">${c.pct}% of ${vm.scope ? "these systems" : "fleet"}</div></div>`
    )
    .join("");

  const vendors = vm.vendor_rollup
    .map((v) => `${esc(v.title)} ${v.count}`)
    .join(" · ");

  // The masthead and rollup ride the first overview page only; continuation
  // pages carry the attention table alone.
  // A scoped cover states the resolution — who this document is about and
  // how many sites/systems that became — so a reader can spot a system
  // missing from THEIR summary as loudly as the fleet spots one missing
  // from the fleet.
  const scope_line = vm.scope
    ? ` · ${vm.scope.detail.sites} site${vm.scope.detail.sites === 1 ? "" : "s"}`
    : "";
  let body = first
    ? `<h1>${esc(vm.title)}</h1>` +
      `<div class="sub">${esc(vm.window_span)} · ${vm.total} systems${scope_line} · ${esc(vendors || "no vendor sections")}${vm.excluded ? ` · ${vm.excluded.ids.length} excluded` : ""}</div>` +
      `<div class="lead">${lead}</div>` +
      (rollup ? `<div class="roll">${rollup}</div>` : "")
    : "";

  if (rows.length) {
    body +=
      `<h2>NEEDS ATTENTION <span class="n">— ${vm.attention.length} system${vm.attention.length === 1 ? "" : "s"}${first ? "" : " (cont.)"}</span></h2>` +
      attention_table(vm, rows);
  }

  if (first)
    body += `<div class="legend pin"><div class="lg-cap">LEGEND</div><div class="lg-grid">
<div><b>period</b> — the span of dates this report covers, shown beside every page number &nbsp; <b>HE PRESSURE · SHIELD TEMP</b> — current reading of the section's metric; units and limit in the heading</div>
<div><b>% OF LIMIT</b> — that reading as a share of the alert limit, comparable across mbar, PSI and Kelvin</div>
<div><b>↑ ↓</b> — rising · easing back from the period's peak &nbsp; <b>*</b> vendor-default limit &nbsp; <b>(16.3)</b> own limit differs from heading</div>
<div><b>PEAK OVER LIMIT</b> — the period's peak crossed the limit; the current reading may since have come back under it</div>
<div><b>STOP, ONGOING · recovered</b> — compressor stop observed this period; red while unrecovered</div>
<div><b>2 evt · 12.5h</b> — stop events this period · total observed downtime</div>
<div><b>WITHIN BAND</b> <span class="bg"><span class="t"></span><span class="d" style="left:62%;"></span></span> — dot = reading between the low and high alert edges (Siemens TIM); centered is healthy, an edge is an alert</div>
<div><b>flicker</b> — single-reading compressor dropout with no thermal response; noted on the system's brief, never counted as a stop</div>
<div><b>OFF ENTIRE PERIOD</b> — off since before the period began, start unknown; magnet already warm, so listed but not urgent</div>
<div><b>no signal · sensor suspect</b> — monitoring faults, not magnet faults; counted as DATA ISSUES with raw readings shown</div>
<div><b>‡ ✕</b> — reading outside plausible physical bounds; shown greyed but excluded from all status judgments</div>
<div><b>ᶜ</b> — concluded, not directly read: inferred (GE compressor from coldhead) or corroborated; unmarked = a reading or arithmetic on one</div>
<div><b>HELIUM · COLDHD · CABINET</b> — judged against their own thresholds; red or amber marks a reading past them</div>
<div><b>urgent</b> — wrong right now (unrecovered stop, live breach, quench); each system's full one-page brief is generated separately</div>
</div></div>`;

  return body;
};

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
  // on the failures page where there is room, or on their own page if the
  // run had no failures. A system missing from this document should always
  // be findable as either a failure, a data issue, or a named exclusion.
  if (vm.excluded) {
    const body =
      `<h2>EXCLUDED BY REQUEST <span class="n">— ${vm.excluded.ids.length} system${vm.excluded.ids.length === 1 ? "" : "s"}</span></h2>` +
      `<div class="note">${esc(vm.excluded.ids.join(", "))}${vm.excluded.note ? ` — ${esc(vm.excluded.note)}` : ""}. Not analyzed and not counted in any total above.</div>`;
    if (vm.failure_pages.length) pages[pages.length - 1] += body;
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

  const html = pages
    .map((body, i) => page_wrap(vm, i + 1, body))
    .join("\n");

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(vm.title)} — ${esc(vm.analyzed_date)}</title></head><style>${CSS}</style><body>
${html}
</body></html>
`;
};

module.exports = { build_fleet_page, esc, trunc };
