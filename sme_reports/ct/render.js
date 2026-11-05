// HTML for the GE CT Insights viewer (hhm_rpp_ge PLAN-CT-INSIGHTS.md §16.2
// items 1, 5, 6): one self-contained file, "GE CT Insights — Internal".
//
// The System Activity app pattern (incident/system_app.js): a dashboard and
// one view per system, all inert <template>s; each system's data is an inert
// JSON block, parsed only when the system is opened. The hash picks the view.
//
// The builder renders; the page only draws. Everything here is a pure
// function of the model (ct/model.js), so a build is deterministic for a
// snapshot and as-of date: no clock, no randomness.
//   - Server side (this file): the dashboard (fleet table, inventory footer)
//     and each system's header and findings cards.
//   - Client side (ct.client.js): the period-dependent panels (charts,
//     heatmap, prep calendar, period totals), from the system's JSON.
//
// Imported, not copied (§16.2 item 2): the HTML escape helper, the brand
// CSS, footer and JSON-script helper, and the Avante logo.

const fs = require("fs");
const path = require("path");
const { esc } = require("../render/fleet_page");
const { CSS } = require("../incident/timeline");
const { footer, json_script, PAGE_CSS } = require("../incident/system_page");
const logo_base64 = require("../render/assets/logo_small");

const CLIENT_JS = fs.readFileSync(path.join(__dirname, "ct.client.js"), "utf8");

const TITLE = "GE CT Insights — Internal";
const page_name = (as_of) => `Avante-GE-CT-Insights-Internal-${as_of}.html`;

// ------------------------------------------------------------------ format

const n0 = (v) => (v === null || v === undefined ? "—" : String(Math.round(Number(v))).replace(/\B(?=(\d{3})+(?!\d))/g, ","));
const n2 = (v) => (v === null || v === undefined ? "—" : Number(v).toFixed(2));
// mA·s in millions for reading; the exact value is in the title attribute
const mmas = (v) => (v === null || v === undefined ? "—" : `${(Number(v) / 1e6).toFixed(1)} M`);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dlong = (d) => (d ? `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}` : "—");
const utc = (ms) => (ms === null || ms === undefined ? "—" : `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`);
const SEV = ["high", "medium", "low", "info"];
const sev_badge = (s) => `<span class="sev ${esc(s)}">${esc(s)}</span>`;

// ---------------------------------------------------------------- dashboard

const open_cell = (o) => {
  const parts = ["high", "medium", "low"].filter((s) => o[s]).map((s) => `<span class="sevn ${s}" title="${o[s]} ${s}">${o[s]} ${s[0].toUpperCase()}</span>`);
  if (o.info) parts.push(`<span class="sevn info" title="${o.info} info">${o.info} info</span>`);
  return parts.length ? `<span class="sevs">${parts.join("")}</span>` : `<span class="to">none</span>`;
};
const tube_cell = (t) => {
  if (!t) return "—";
  const since = t.since_data_start ? `since ${dlong(t.since_data_start)} (data start)` : t.install_date ? `since install ${dlong(t.install_date)}` : "install date unknown";
  return `<span title="${n0(t.mas)} mA·s">${mmas(t.mas)}</span><small>${esc(since)}${t.confidence && !t.since_data_start ? ` · ${esc(t.confidence)}` : ""}</small>`;
};

// clock_flag "ok" (or none) is not a flag; anything else is shown with the
// estimated offset when there is one
const clock_bad = (r) => !!r.clock_flag && r.clock_flag !== "ok";
const offset = (m) => (m === null || m === undefined || Number(m) === 0 ? "" : `${m > 0 ? "+" : ""}${n0(m)} min`);
const clock_cell = (r) => (clock_bad(r) ? `<span class="warn">${esc(r.clock_flag)}</span>${offset(r.clock_offset_min) ? `<small>${offset(r.clock_offset_min)}</small>` : ""}` : `<span class="to">${esc(r.clock_flag || "—")}</span>`);

function fleet_row(r) {
  const q = [r.system_id, r.cus_sys_id, r.model, r.site_name, r.customer_name, r.city, r.state].filter(Boolean).join(" ").toLowerCase();
  const a = r.abort_28d, p = r.prep_14d;
  return `          <tr data-sys="${esc(r.system_id)}" data-q="${esc(q)}">
            <td><a href="#${esc(r.system_id)}">${esc(r.system_id)}</a>${r.cus_sys_id ? `<small>${esc(r.cus_sys_id)}</small>` : ""}</td>
            <td>${esc(r.model || "—")}</td>
            <td>${esc(r.site_name || "—")}<small>${esc([r.customer_name, [r.city, r.state].filter(Boolean).join(", ")].filter(Boolean).join(" · "))}</small></td>
            <td class="nw">${dlong(r.last_day)}</td>
            <td class="num">${n2(r.exams.per_day)}<small>${n0(r.exams.exams)} in ${r.exams.data_days} d</small></td>
            <td class="num">${n0(r.mas.per_day)}</td>
            <td>${tube_cell(r.tube)}</td>
            <td class="num">${a.per_100 === null ? "—" : n2(a.per_100)}<small>${n0(a.aborts)} / ${n0(a.exams)}</small></td>
            <td class="num">${p.share === null ? "—" : `${n2(p.share)}%`}<small>${p.without_fast_cal} of ${p.scan_days} d</small></td>
            <td>${open_cell(r.open)}</td>
            <td>${clock_cell(r)}</td>
          </tr>`;
}

function dashboard(model) {
  const all = [...model.reporting, ...model.not_reporting];
  const open = { high: 0, medium: 0, low: 0, info: 0 };
  for (const r of all) for (const s of SEV) open[s] += r.open[s];
  const tile = (k, v, s, cls = "") => `    <div class="tile${cls ? ` ${cls}` : ""}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const head = `<thead><tr><th scope="col">System</th><th scope="col">Model</th><th scope="col">Site / customer</th><th scope="col">Last data</th>
          <th scope="col" class="num">Exams/day</th><th scope="col" class="num">mA·s/day</th><th scope="col">Current tube</th>
          <th scope="col" class="num">Aborts /100 exams (28 d)</th><th scope="col" class="num">No Fast Cal (14 d)</th><th scope="col">Open findings</th><th scope="col">Clock</th></tr></thead>`;
  const inv = model.inventory;
  return `<template id="view-dashboard">
  <header class="title">
    <h1>${esc(TITLE)}</h1>
    <div class="sub">As of ${dlong(model.as_of)} (device days) · ${all.length} GE CT systems with log data</div>
  </header>
  <div class="tiles" aria-label="Fleet summary">
${[
  tile("Reporting", n0(model.reporting.length), "data in the last 7 device days"),
  tile("Not reporting", n0(model.not_reporting.length), "no data in the last 7 device days", model.not_reporting.length ? "warn" : ""),
  tile("Open findings", n0(open.high + open.medium + open.low), `${open.high} high · ${open.medium} medium · ${open.low} low${open.info ? ` · ${open.info} info` : ""}`, open.high ? "bad" : ""),
  tile("Systems with log data", n0(all.length), "GE CT and PET/CT"),
  tile("No log data", n0(inv.length), "GE CT systems in inventory")
].join("\n")}
  </div>
  <section>
    <div class="panel tablewrap">
      <div class="dtools">
        <label class="ctl-label" for="dfilter">Find a system</label>
        <input id="dfilter" type="search" placeholder="System, model, site or customer" autocomplete="off">
        <span id="dshown" aria-live="polite"></span>
      </div>
      <table id="systems">
        ${head}
        <tbody>
          <tr class="grp"><th colspan="11" scope="colgroup">Reporting <small>${model.reporting.length} systems · most attention first: highest open severity (not info), then open findings, then exams/day</small></th></tr>
${model.reporting.map(fleet_row).join("\n")}
        </tbody>
${model.not_reporting.length ? `        <tbody>
          <tr class="grp"><th colspan="11" scope="colgroup">Not reporting <small>${model.not_reporting.length} systems · no data in the last 7 device days; columns and findings are as of each system's last data</small></th></tr>
${model.not_reporting.map(fleet_row).join("\n")}
        </tbody>` : ""}
      </table>
    </div>
  </section>
  <section>
    <details class="panel inv">
      <summary>${n0(inv.length)} GE CT systems in inventory have no log data</summary>
      <div class="tablewrap"><table>
        <thead><tr><th scope="col">System</th><th scope="col">Modality</th><th scope="col">Model</th><th scope="col">Site</th><th scope="col">Customer</th></tr></thead>
        <tbody>
${inv.map((s) => `          <tr><td>${esc(s.system_id)}</td><td>${esc(s.modality || "—")}</td><td>${esc(s.model || "—")}</td><td>${esc(s.site_name || "—")}</td><td>${esc(s.customer_name || "—")}</td></tr>`).join("\n")}
        </tbody>
      </table></div>
    </details>
  </section>
  <div class="method">
    <h2>How the columns are computed</h2>
    <p>Days are device wall-clock days. Each system's columns end on its last data day D. Exams/day: exam starts over the 30 device days ending on D, divided by the days with data in that window. mA·s/day: tube counter increments over the same window, divided by the same days (a counter drop at a tube replacement counts 0). Aborts per 100 exams: system aborts over exam starts, D−27..D, exactly as the <i>abort rate</i> finding computes it. No Fast Cal: the share of scan days in D−13..D without a Fast Calibration, exactly as the <i>daily prep</i> finding computes it. Current tube: mA·s since install, or since the first data for a tube installed before the data starts. Open findings ignore <i>info</i> for the order.</p>
    <p>Internal: for Avante staff. The columns, daily series and period totals on this page were checked against independent SQL (ct/verify.js); rates over a chosen period (per 100 exams, per exam, per data day) are computed in the page from those checked totals. The stored rule evidence inside finding cards is shown as the rule recorded it, not recomputed.</p>
  </div>
</template>`;
}

// ------------------------------------------------------------- system view

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

function trip_table(f) {
  if (!f.trip) return "";
  const rows = ["first", "last"].map((w) => [w, f.trip[w]]);
  if (f.finding_key === "abort_rate_high") {
    return `<div class="scroll"><table><thead><tr><th scope="col">Trip day</th><th scope="col">Day</th><th scope="col" class="num">System aborts (28 d)</th><th scope="col" class="num">Exams (28 d)</th><th scope="col" class="num">Per 100 exams</th></tr></thead><tbody>${rows
      .map(([w, t]) => `<tr><td>${w}</td><td>${esc(t.day)}</td><td class="num">${n0(t.aborts)}</td><td class="num">${n0(t.exams)}</td><td class="num">${n2(t.per_100)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  return `<div class="scroll"><table><thead><tr><th scope="col">Trip day</th><th scope="col">Day</th><th scope="col" class="num">Scan days (14 d)</th><th scope="col" class="num">Without Fast Cal</th><th scope="col" class="num">Share</th></tr></thead><tbody>${rows
    .map(([w, t]) => `<tr><td>${w}</td><td>${esc(t.day)}</td><td class="num">${t.scan_days}</td><td class="num">${t.without_fast_cal}</td><td class="num">${n2(t.share)}%</td></tr>`).join("")}</tbody></table></div>`;
}

function finding_card(f, i, sid) {
  const ev = f.evidence || {};
  const recorded = ev.last && typeof ev.last === "object" ? ev.last : ev;
  const when = f.status === "open"
    ? `Open since ${dlong(f.opened_day)}${f.last_trip_day ? ` · last tripped ${dlong(f.last_trip_day)}` : ""}`
    : `Resolved ${utc(f.resolved_at)} · opened ${dlong(f.opened_day)}`;
  const facts = [
    ["Observed", f.observed === null ? "—" : esc(String(f.observed))],
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
      ${trip_table(f)}
      <details class="stored"><summary>Stored rule evidence${recorded.day ? ` (recorded ${dlong(recorded.day)})` : ""}</summary>
        <p class="src">As the rule stored it; not recomputed for this page. The panels below show the checked daily data behind it.</p>
        ${ev_list(recorded)}
        ${thresholds}
        <details class="raw"><summary>Raw evidence JSON</summary><pre id="raw-${esc(sid)}-${i}">${esc(JSON.stringify(ev, null, 2))}</pre></details>
      </details>
    </article>`;
}

function system_view(v, i, order, model) {
  const h = v.header, prev = order[i - 1], next = order[i + 1];
  const stale = h.group === "not_reporting";
  const t = h.tube;
  const tile = (k, val, s, cls = "") => `    <div class="tile${cls ? ` ${cls}` : ""}"><div class="k">${k}</div><div class="v">${val}</div><div class="s">${s}</div></div>`;
  const open_n = h.open.high + h.open.medium + h.open.low;
  const tiles = [
    tile("Last data", dlong(h.last_day), stale ? "not reporting" : "reporting", stale ? "warn" : ""),
    tile("Exams/day", n2(h.exams.per_day), `${n0(h.exams.exams)} exams in ${h.exams.data_days} data days (30 d)`),
    tile("mA·s/day", n0(h.mas.per_day), `30 d, ${h.mas.data_days} data days`),
    tile("Current tube", t ? `<span title="${n0(t.mas)} mA·s">${mmas(t.mas)}</span>` : "—",
      t ? (t.since_data_start ? `mA·s since data start ${dlong(t.since_data_start)}` : t.install_date ? `mA·s since install ${dlong(t.install_date)} (${esc(t.confidence || "")})` : "mA·s, install date unknown") : "no tube data"),
    tile("Aborts /100 exams", h.abort_28d.per_100 === null ? "—" : n2(h.abort_28d.per_100), `${n0(h.abort_28d.aborts)} system aborts / ${n0(h.abort_28d.exams)} exams, 28 d`),
    tile("No Fast Cal", h.prep_14d.share === null ? "—" : `${n2(h.prep_14d.share)}%`, `${h.prep_14d.without_fast_cal} of ${h.prep_14d.scan_days} scan days, 14 d`),
    tile("Open findings", n0(open_n), `${h.open.high} high · ${h.open.medium} medium · ${h.open.low} low${h.open.info ? ` · ${h.open.info} info` : ""}`, h.open.high ? "bad" : open_n ? "warn" : ""),
    tile("Clock", esc(h.clock_flag || "—"), clock_bad(h) ? (offset(h.clock_offset_min) ? `estimated offset ${offset(h.clock_offset_min)}` : "device clock flagged") : "no clock problem flagged", clock_bad(h) ? "warn" : "")
  ];
  const open = v.findings.filter((f) => f.status === "open"), resolved = v.findings.filter((f) => f.status !== "open");
  const where = [h.site_name, h.customer_name, [h.city, h.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  return `<template id="view-${esc(v.system_id)}">
  <nav class="appnav" aria-label="Systems">
    <a href="#">← All systems</a>
    <span class="pos">System ${i + 1} of ${order.length}</span>
    <span class="step">${prev ? `<a href="#${esc(prev)}">← ${esc(prev)}</a>` : ""}${next ? `<a href="#${esc(next)}">${esc(next)} →</a>` : ""}</span>
  </nav>
  <header class="title">
    <h1>${esc(v.system_id)}${h.model ? ` · ${esc(h.model)}` : ""}</h1>
    <div class="sub">${esc(where)}${h.cus_sys_id ? ` · ${esc(h.cus_sys_id)}` : ""} · data ${dlong(v.d0)} – ${dlong(h.last_day)}</div>
  </header>
${stale ? `  <section><div class="panel notice"><p style="margin:0">No data since ${dlong(h.last_day)}. Columns, findings and panels are as of that day.</p></div></section>\n` : ""}  <div class="tiles four" aria-label="System summary">
${tiles.join("\n")}
  </div>
  <section class="findings">
    <h2>Findings${stale ? ` <small>as of ${dlong(h.last_day)}</small>` : ""}</h2>
${v.findings.length ? `${open.length ? open.map((f, k) => finding_card(f, k, v.system_id)).join("\n") : `    <p class="nodata">No open findings.</p>`}
${resolved.length ? `    <details class="resolvedlist"><summary>${resolved.length} resolved</summary>
${resolved.map((f, k) => finding_card(f, open.length + k, v.system_id)).join("\n")}
    </details>` : ""}` : `    <p class="nodata">No findings for this system.</p>`}
  </section>
  <div class="periodbar">
    <span class="ctl-label">Period</span>
    <div class="seg" role="group" aria-label="Period">${model.periods.map((p) => `<button type="button" data-period="${p.key}" aria-pressed="${p.key === model.default_period}">${esc(p.label)}</button>`).join("")}</div>
    <span class="pspan"></span>
  </div>
  <div class="panels" data-panels="${esc(v.panels.join(" "))}"></div>
</template>
<script type="application/json" id="data-${esc(v.system_id)}">${json_script(strip(v))}</script>`;
}

// The JSON block carries what the client draws; the header and findings are
// already HTML.
function strip(v) {
  const { header, findings, ...rest } = v;
  return { ...rest, last_day: header.last_day, group: header.group, tube_now: header.tube };
}

const CT_CSS = `.appnav{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 18px;padding-top:22px;font-size:13.5px}
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

const brandbar = (as_of) => `<header class="brandbar"><div class="wrap">
  <div class="hdr"><img class="logo" alt="Avante" src="data:image/png;base64,${logo_base64}"><div class="r">GE CT Insights<span class="internal-tag">Internal</span><br><b>As of ${esc(dlong(as_of))}</b></div></div>
  <div class="brandband"></div>
</div></header>`;

// model: ct/model.js build_model's output. Returns { html, name }.
function build_ct_page(model) {
  const order = [...model.reporting, ...model.not_reporting].map((r) => r.system_id);
  const views = order.map((sid, i) => system_view(model.views[sid], i, order, model));
  const index = { title: TITLE, default_period: model.default_period, periods: model.periods, systems: order.map((sid) => ({ id: sid, title: `${sid} · ${TITLE}` })) };
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(TITLE)}</title>
<style>${CSS}
${PAGE_CSS}
${CT_CSS}
</style>
</head>
<body>
${brandbar(model.as_of)}
<div class="wrap" id="app"></div>
<div id="tip" role="tooltip" hidden></div>
<noscript><div class="wrap"><p class="panel notice">This report needs JavaScript. Open it in a web browser such as Chrome, Edge, Safari or Firefox.</p></div></noscript>
${footer(`GE CT Insights · Internal · as of ${esc(model.as_of)} · Prepared by Remote Solutions`)}
${dashboard(model)}
${views.join("\n")}
<script type="application/json" id="app-index">${json_script(index)}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
  return { html, name: page_name(model.as_of) };
}

module.exports = { build_ct_page, page_name, TITLE };
