// GE Insights viewers: the shared page code (hhm_rpp_ge
// PLAN-CV-INSIGHTS.md §13.3 Q1). Moved out of ct/render.js unchanged, so
// the CT page is byte-identical (§13.5 step 1); CT, CV and later MRI
// import it.
//
// Pure functions of their arguments: no clock, no randomness, so a build
// stays deterministic for a snapshot and as-of date.
//   - formatters, severity badges, the summary tile;
//   - finding cards (open / resolved) with the stored rule evidence in
//     readable form and the raw JSON behind a toggle;
//   - the system view's navigation, findings section and period bar;
//   - the shared CSS, the brand bar and the page shell;
//   - assemble_client(): the shared client core (client_core.js) with a
//     viewer's parts file in place of its markers.
//
// Imported, not copied (CT §16.2 item 2): the HTML escape helper, the brand
// CSS, footer and JSON-script helper, and the Avante logo.

const fs = require("fs");
const path = require("path");
const { esc } = require("../render/fleet_page");
const { CSS } = require("../incident/timeline");
const { footer, json_script, PAGE_CSS } = require("../incident/system_page");
const logo_base64 = require("../render/assets/logo_small");

// ------------------------------------------------------------------ format

const n0 = (v) => (v === null || v === undefined ? "—" : String(Math.round(Number(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const n2 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dlong = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : "—");
const utc = (ms) => (ms === null || ms === undefined ? "—" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`);
const SEV = ["high", "medium", "low", "info"];
const sev_badge = (s) => `<span class="sev ${esc(s)}">${esc(s)}</span>`;

// Open findings by severity, as small badges (dashboard column).
const open_cell = (o) => {
  const parts = ["high", "medium", "low"].filter((s) => o[s]).map((s) => `<span class="sevn ${s}" title="${o[s]} ${s}">${o[s]} ${s[0].toUpperCase()}</span>`);
  if (o.info) parts.push(`<span class="sevn info" title="${o.info} info">${o.info} info</span>`);
  return parts.length ? `<span class="sevs">${parts.join("")}</span>` : `<span class="to">none</span>`;
};

// A summary tile (dashboard and system header).
const tile = (k, v, s, cls = "") => `    <div class="tile${cls ? ` ${cls}` : ""}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;

// ---------------------------------------------------------------- findings

// Readable form of a stored evidence object: scalars as rows, arrays of
// objects as small tables, arrays of scalars as lists.
const BOOKKEEPING = new Set(["rule_version", "severity_history", "first", "last", "quiet_days", "thresholds", "opened_day", "last_trip_day", "trip_days", "resolved_day"]);
const label_of = (k) => k.replace(/_/g, " ");
function ev_value(v, depth = 0) {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) {
    if (!v.length) return `<span class="to">none</span>`;
    if (v.every((x) => x === null || typeof x !== "object")) {
      const shown = v.slice(0, 24).map((x) => esc(String(x))).join(", ");
      return `${shown}${v.length > 24 ? ` <span class="to">… ${v.length - 24} more</span>` : ""}`;
    }
    if (depth > 1) return `<span class="to">${v.length} items (see raw evidence)</span>`;
    const cols = [...new Set(v.flatMap((x) => (x && typeof x === "object" ? Object.keys(x) : [])))];
    return `<div class="scroll"><table><thead><tr>${cols.map((c) => `<th scope="col">${esc(label_of(c))}</th>`).join("")}</tr></thead><tbody>${v.slice(0, 20)
      .map((x) => `<tr>${cols.map((c) => `<td>${x && typeof x[c] === "object" && x[c] !== null ? `<code>${esc(JSON.stringify(x[c]))}</code>` : esc(x ? x[c] ?? "" : "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${v.length > 20 ? `<span class="to">… ${v.length - 20} more rows (see raw evidence)</span>` : ""}`;
  }
  if (typeof v === "object") return depth > 1 ? `<code>${esc(JSON.stringify(v))}</code>` : ev_list(v, depth + 1);
  return esc(String(v));
}
function ev_list(obj, depth = 0) {
  const keys = Object.keys(obj).filter((k) => !BOOKKEEPING.has(k));
  if (!keys.length) return `<span class="to">none</span>`;
  return `<dl class="ev">${keys.map((k) => `<dt>${esc(label_of(k))}</dt><dd>${ev_value(obj[k], depth)}</dd>`).join("")}</dl>`;
}

// One finding card. f: a model finding_view (ct/model.js). Options, for
// what differs between viewers (defaults give the CT card):
//   after_facts(f)      HTML after the facts grid (CT: the trip table);
//   observed_label(f)   the label of the Observed fact;
//   display(recorded)   the object the readable evidence list shows (CV:
//                       codes with their labels). The raw JSON is always
//                       the stored evidence, unchanged.
function finding_card(f, i, sid, { after_facts = () => "", observed_label = () => "Observed", display = (x) => x } = {}) {
  const ev = f.evidence || {};
  const recorded = ev.last && typeof ev.last === "object" ? ev.last : ev;
  const when = f.status === "open"
    ? `Open since ${dlong(f.opened_day)}${f.last_trip_day ? ` · last tripped ${dlong(f.last_trip_day)}` : ""}`
    : `Resolved ${utc(f.resolved_at)} · opened ${dlong(f.opened_day)}`;
  const facts = [
    [observed_label(f), f.observed === null ? "—" : esc(String(f.observed))],
    ["Baseline", f.baseline === null ? "—" : esc(String(f.baseline))],
    ["Window", `${utc(f.window_start)} → ${utc(f.window_end)}`],
    ["Trip days", f.trip_days === null ? "—" : String(f.trip_days)],
    ["Data through", dlong(f.data_through)]
  ];
  const thresholds = ev.thresholds && typeof ev.thresholds === "object" ? `<h4>Thresholds</h4>${ev_list(ev.thresholds, 1)}` : "";
  return `    <article class="fcard ${esc(f.severity)}${f.status === "open" ? "" : " resolved"}">
      <div class="fhead">${sev_badge(f.severity)}<h3>${esc(f.label || f.finding_key)}</h3><span class="fstat">${f.status === "open" ? "open" : "resolved"}</span></div>
      <p class="fwhen">${when} · ${esc(f.category || "")}</p>
      <p>${esc(f.description || "")}</p>
      <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
      ${after_facts(f)}
      <details class="stored"><summary>Stored rule evidence${recorded.day ? ` (recorded ${dlong(recorded.day)})` : ""}</summary>
        <p class="src">As the rule stored it; not recomputed for this page. The panels below show the checked daily data behind it.</p>
        ${ev_list(display(recorded))}
        ${thresholds}
        <details class="raw"><summary>Raw evidence JSON</summary><pre id="raw-${esc(sid)}-${i}">${esc(JSON.stringify(ev, null, 2))}</pre></details>
      </details>
    </article>`;
}

// The findings section of a system view: open cards, then the resolved ones
// behind a toggle. stale_day: the last data day of a system that is not
// reporting (null when it reports). card_opts: finding_card options.
function findings_section(findings, sid, stale_day, card_opts) {
  const open = findings.filter((f) => f.status === "open"), resolved = findings.filter((f) => f.status !== "open");
  return `  <section class="findings">
    <h2>Findings${stale_day ? ` <small>as of ${dlong(stale_day)}</small>` : ""}</h2>
${findings.length ? `${open.length ? open.map((f, k) => finding_card(f, k, sid, card_opts)).join("\n") : `    <p class="nodata">No open findings.</p>`}
${resolved.length ? `    <details class="resolvedlist"><summary>${resolved.length} resolved</summary>
${resolved.map((f, k) => finding_card(f, open.length + k, sid, card_opts)).join("\n")}
    </details>` : ""}` : `    <p class="nodata">No findings for this system.</p>`}
  </section>`;
}

// ------------------------------------------------------------- system view

// Back to the list, position, previous / next system.
const appnav = (i, order) => `  <nav class="appnav" aria-label="Systems">
    <a href="#">← All systems</a>
    <span class="pos">System ${i + 1} of ${order.length}</span>
    <span class="step">${order[i - 1] ? `<a href="#${esc(order[i - 1])}">← ${esc(order[i - 1])}</a>` : ""}${order[i + 1] ? `<a href="#${esc(order[i + 1])}">${esc(order[i + 1])} →</a>` : ""}</span>
  </nav>`;

// The period bar and the (client-drawn) panels container.
const periodbar = (model) => `  <div class="periodbar">
    <span class="ctl-label">Period</span>
    <div class="seg" role="group" aria-label="Period">${model.periods.map((p) => `<button type="button" data-period="${p.key}" aria-pressed="${p.key === model.default_period}">${esc(p.label)}</button>`).join("")}</div>
    <span class="pspan"></span>
  </div>`;

// ------------------------------------------------------------------- page

const INSIGHTS_CSS = `.appnav{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 18px;padding-top:22px;font-size:13.5px}
.appnav a{color:var(--blue);font-weight:700;text-decoration:none}
.appnav a:hover{text-decoration:underline}
.appnav .pos{color:var(--muted)}
.appnav .step{margin-left:auto;display:flex;gap:18px}
.appnav + header.title{padding-top:12px}
.tiles.four{grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:1100px){.tiles.four{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}}
@media (max-width:480px){.tiles,.tiles.four{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.wrap{padding:0 16px}.appnav .step{margin-left:0}}
.dtools{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:14px 14px 4px}
.dtools .ctl-label{margin:0}
.dtools input{font:inherit;font-size:14px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;min-width:min(280px,100%);color:var(--ink);background:var(--panel)}
.dtools input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#dshown{color:var(--muted);font-size:13px}
#systems{min-width:1180px}
#systems td small{display:block;color:var(--muted);font-size:12px}
#systems a{color:var(--blue);font-weight:700;text-decoration:none}
#systems tr[data-sys]{cursor:pointer}
#systems tr[data-sys]:hover{background:var(--hover)}
#systems tr.grp th{text-align:left;background:var(--fill);color:var(--head);font-size:14px;padding:12px 14px 8px}
#systems tr.grp small{font-weight:400;color:var(--muted);margin-left:8px;font-size:12.5px}
td.nw{white-space:nowrap}
.sevs{display:flex;flex-wrap:wrap;gap:4px}
.sevn{display:inline-block;padding:1px 7px;border-radius:6px;font-size:12px;font-weight:700;white-space:nowrap}
.sevn.high,.sev.high{background:var(--high-bg);color:var(--high)}
.sevn.medium,.sev.medium{background:var(--med-bg);color:var(--med)}
.sevn.low,.sev.low{background:var(--band);color:var(--blue)}
.sevn.info,.sev.info{background:var(--fill);color:var(--muted);font-weight:400}
.tile.warn{font-weight:400}
#systems td:nth-child(7){min-width:150px}
.inv summary{cursor:pointer;padding:14px 18px;font-weight:700;color:var(--head)}
.inv table{min-width:640px}
.method{margin:22px 0 10px;color:var(--muted);font-size:13px;max-width:110ch}
.method h2{margin-bottom:6px}
.findings h2 small,.panelbox h2 small{font-weight:400;color:var(--muted);letter-spacing:0;text-transform:none;font-size:13px;margin-left:8px}
.fcard{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--line);border-radius:10px;padding:14px 18px;margin-top:12px}
.fcard.high{border-left-color:var(--high)} .fcard.medium{border-left-color:var(--med)} .fcard.low{border-left-color:var(--blue)}
.fcard.resolved{opacity:.92}
.fhead{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px}
.fhead h3{margin:0;font-size:17px;color:var(--head)}
.sev{font-weight:800;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:6px}
.fstat{color:var(--muted);font-size:12.5px;text-transform:uppercase;letter-spacing:.06em}
.fwhen{margin:4px 0;color:var(--muted);font-size:13px}
.fcard p{margin:6px 0;max-width:110ch}
.facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px 14px;margin:10px 0}
.facts div{background:var(--fill);border-radius:8px;padding:6px 10px;min-width:0}
.facts dt{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.facts dd{margin:0;font-weight:700;color:var(--head);overflow-wrap:anywhere}
.stored{margin-top:10px}
.stored summary,.raw summary,.resolvedlist > summary{cursor:pointer;font-weight:700;color:var(--blue);font-size:13.5px}
.resolvedlist{margin-top:14px}
.raw pre{overflow:auto;max-height:340px;background:var(--fill);border-radius:8px;padding:10px;font-size:12px}
dl.ev{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:4px 14px;margin:8px 0;font-size:13px}
dl.ev dt{color:var(--muted)} dl.ev dd{margin:0;overflow-wrap:anywhere;min-width:0}
.fcard h4{margin:10px 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--blue)}
.periodbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;margin-top:26px;padding:10px 0;background:var(--bg);border-bottom:1px solid var(--line)}
.periodbar .ctl-label{margin:0}
.pspan{color:var(--muted);font-size:13px}
.panelbox{padding:16px 18px;margin-top:16px}
.stats{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}
.chart{margin-top:14px;min-width:0}
.chart h3{margin:0 0 4px;font-size:13.5px;color:var(--head)}
.chart .cap{margin:2px 0 0;color:var(--muted);font-size:12px}
.chart svg{display:block;width:100%;height:auto}
.chart .cw{overflow-x:auto}
.chart .cw svg{min-width:640px}
.chart .cw svg.heat{min-width:560px}
.chart svg text{font-size:11px;fill:var(--muted)}
.lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12.5px;color:var(--muted);margin:2px 0 4px}
.lg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.two{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 22px}
@media (max-width:860px){.two{grid-template-columns:minmax(0,1fr)}}
#tip{position:fixed;z-index:20;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12.5px;color:var(--ink);box-shadow:0 2px 10px rgba(0,0,0,.12);max-width:260px}
#tip[hidden]{display:none}
#tip b{color:var(--head)}`;

// product: e.g. "GE CT Insights" (the bar adds the Internal tag).
const brandbar = (product, as_of) => `<header class="brandbar"><div class="wrap">
  <div class="hdr"><img class="logo" alt="Avante" src="data:image/png;base64,${logo_base64}"><div class="r">${esc(product)}<span class="internal-tag">Internal</span><br><b>As of ${esc(dlong(as_of))}</b></div></div>
  <div class="brandband"></div>
</div></header>`;

// The client: the shared core with a viewer's parts file (text) in place of
// the four marker lines. Text before the first marker of either file is
// documentation and is dropped. Throws when a section is missing, extra,
// repeated or empty, or when a marker line is left in the result.
const CORE_PATH = path.join(__dirname, "client_core.js");
const MARKERS = ["header", "charts", "panel-keys", "panels"];
function assemble_client(parts_text, core_text = fs.readFileSync(CORE_PATH, "utf8")) {
  const parts = {};
  let cur = null;
  for (const line of parts_text.split(/(?<=\n)/)) {
    const m = /^\/\/@@([a-z-]+)@@\n$/.exec(line);
    if (m) {
      if (!MARKERS.includes(m[1]) || m[1] in parts) throw new Error(`assemble_client: bad or repeated section ${m[1]}`);
      cur = m[1];
      parts[cur] = "";
    } else if (cur) parts[cur] += line;
  }
  for (const k of MARKERS) if (!(k in parts)) throw new Error(`assemble_client: the parts file has no ${k} section`);
  // review CV6-SHARED (optional hardening): an empty section is a mistake
  for (const k of MARKERS) if (!parts[k].trim()) throw new Error(`assemble_client: the ${k} section is empty`);
  const start = core_text.indexOf("//@@header@@\n");
  if (start < 0) throw new Error("assemble_client: the core has no header marker");
  let out = core_text.slice(start);
  for (const k of MARKERS) {
    const mark = `//@@${k}@@\n`;
    if (out.split(mark).length !== 2) throw new Error(`assemble_client: the core must have exactly one ${k} marker`);
    out = out.replace(mark, () => parts[k]);
  }
  if (/^\/\/@@[a-z-]+@@$/m.test(out)) throw new Error("assemble_client: a marker line is left in the client");
  return out;
}

// The whole page. title: the <title> (with "Internal"); product: the brand
// bar name; footer_text: escaped by the caller; extra_css: viewer CSS after
// the shared CSS (none for CT); body: dashboard and view templates; index:
// the app index object; client: assemble_client()'s output.
function page_html({ title, product, as_of, footer_text, extra_css = "", body, index, client }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>${CSS}
${PAGE_CSS}
${INSIGHTS_CSS}${extra_css ? `\n${extra_css}` : ""}
</style>
</head>
<body>
${brandbar(product, as_of)}
<div class="wrap" id="app"></div>
<div id="tip" role="tooltip" hidden></div>
<noscript><div class="wrap"><p class="panel notice">This report needs JavaScript. Open it in a web browser such as Chrome, Edge, Safari or Firefox.</p></div></noscript>
${footer(footer_text)}
${body}
<script type="application/json" id="app-index">${json_script(index)}</script>
<script>${client}</script>
</body>
</html>
`;
}

module.exports = {
  esc, json_script, n0, n2, MONTHS, dlong, utc, SEV, sev_badge, open_cell, tile,
  BOOKKEEPING, label_of, ev_value, ev_list, finding_card, findings_section,
  appnav, periodbar, INSIGHTS_CSS, brandbar, assemble_client, page_html, MARKERS
};
