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
// CSS, footer and JSON-script helper, and the Avante logo, through the
// shared insights/page.js (PLAN-CV-INSIGHTS.md §13.3 Q1), which also holds
// the formatters, finding cards, navigation, period bar, CSS, brand bar,
// page shell and the client core. The page is byte-identical to the one
// built before the move.

const fs = require("fs");
const path = require("path");
const {
  esc, json_script, n0, n2, dlong, utc, SEV, open_cell, tile, finding_card, findings_section, appnav, periodbar, assemble_client, page_html
} = require("../insights/page");

const CLIENT_JS = assemble_client(fs.readFileSync(path.join(__dirname, "ct.client.js"), "utf8"));

const TITLE = "GE CT Insights — Internal";
const page_name = (as_of) => `Avante-GE-CT-Insights-Internal-${as_of}.html`;

// ------------------------------------------------------------------ format

// mA·s in millions for reading; the exact value is in the title attribute
const mmas = (v) => (v === null || v === undefined ? "—" : `${(Number(v) / 1e6).toFixed(1)} M`);

// ---------------------------------------------------------------- dashboard

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

function system_view(v, i, order, model) {
  const h = v.header;
  const stale = h.group === "not_reporting";
  const t = h.tube;
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
  const where = [h.site_name, h.customer_name, [h.city, h.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  return `<template id="view-${esc(v.system_id)}">
${appnav(i, order)}
  <header class="title">
    <h1>${esc(v.system_id)}${h.model ? ` · ${esc(h.model)}` : ""}</h1>
    <div class="sub">${esc(where)}${h.cus_sys_id ? ` · ${esc(h.cus_sys_id)}` : ""} · data ${dlong(v.d0)} – ${dlong(h.last_day)}</div>
  </header>
${stale ? `  <section><div class="panel notice"><p style="margin:0">No data since ${dlong(h.last_day)}. Columns, findings and panels are as of that day.</p></div></section>\n` : ""}  <div class="tiles four" aria-label="System summary">
${tiles.join("\n")}
  </div>
${findings_section(v.findings, v.system_id, stale ? h.last_day : null, { after_facts: trip_table })}
${periodbar(model)}
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

// model: ct/model.js build_model's output. Returns { html, name }.
function build_ct_page(model) {
  const order = [...model.reporting, ...model.not_reporting].map((r) => r.system_id);
  const views = order.map((sid, i) => system_view(model.views[sid], i, order, model));
  const index = { title: TITLE, default_period: model.default_period, periods: model.periods, systems: order.map((sid) => ({ id: sid, title: `${sid} · ${TITLE}` })) };
  const html = page_html({
    title: TITLE, product: "GE CT Insights", as_of: model.as_of,
    footer_text: `GE CT Insights · Internal · as of ${esc(model.as_of)} · Prepared by Remote Solutions`,
    body: `${dashboard(model)}\n${views.join("\n")}`, index, client: CLIENT_JS
  });
  return { html, name: page_name(model.as_of) };
}

module.exports = { build_ct_page, page_name, TITLE };
