// HTML for the GE CV Insights viewer (hhm_rpp_ge PLAN-CV-INSIGHTS.md §13.2
// items 1, 5, 6, 8): one self-contained file, "GE CV Insights — Internal".
//
// The CT viewer's app pattern through the shared insights/page.js (§13.3
// Q1): a dashboard and one view per system, all inert <template>s; each
// system's data is an inert JSON block, parsed only when the system is
// opened. The hash picks the view.
//
// The builder renders; the page only draws. Everything here is a pure
// function of the model (cv/model.js): no clock, no randomness.
//   - Server side (this file): the dashboard (fleet table, configured
//     systems without data, inventory footer, method) and each system's
//     header and findings cards.
//   - Client side (cv.client.js parts + insights/client_core.js): the
//     period-dependent panels from the system's JSON.

const fs = require("fs");
const path = require("path");
const {
  esc, json_script, n0, n2, dlong, utc, SEV, open_cell, tile, findings_section, appnav, periodbar, assemble_client, page_html
} = require("../insights/page");

const CLIENT_JS = assemble_client(fs.readFileSync(path.join(__dirname, "cv.client.js"), "utf8"));

const TITLE = "GE CV Insights — Internal";
const PRODUCT = "GE CV Insights";
const page_name = (as_of) => `Avante-GE-CV-Insights-Internal-${as_of}.html`;

// The K1 statement (§13.2 item 8, §13.3 Q7).
const K1 = "Times and days are the device's own clock. CV has no clock correction (K1).";
// A stored device timestamp, shown in UTC and labelled as uncorrected (review CV6-PAGE, clock wording).
const dev_ts = (ms) => `${utc(ms).replace(" UTC", "")} (uncorrected, in UTC)`;
const clock_cell = (r) => (r.clock_ahead_min ? `<span class="warn">ahead ≥ ${n0(r.clock_ahead_min)} min</span><small>vs this report's snapshot</small>` : `<span class="to">no offset visible</span>`);
const named_cell = (x) => (x === null ? `<span class="to">not logged</span>` : n0(x));
const where_of = (r) => [r.customer_name, [r.city, r.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");

// ---------------------------------------------------------------- dashboard

function fleet_row(r) {
  const q = [r.system_id, r.cus_sys_id, r.model, r.site_name, r.customer_name, r.city, r.state].filter(Boolean).join(" ").toLowerCase();
  const e = r.errors, b = r.busiest;
  return `          <tr data-sys="${esc(r.system_id)}" data-q="${esc(q)}">
            <td><a href="#${esc(r.system_id)}">${esc(r.system_id)}</a>${r.cus_sys_id ? `<small>${esc(r.cus_sys_id)}</small>` : ""}</td>
            <td>${esc(r.model || "—")}</td>
            <td>${esc(r.site_name || "—")}<small>${esc(where_of(r))}</small></td>
            <td class="nw">${dlong(r.last_day)}<small>newest device timestamp ${esc(dev_ts(r.last_seen))}</small></td>
            <td>${open_cell(r.open)}</td>
            <td>${clock_cell(r)}</td>
            <td class="num">${n2(e.per_day)}<small>${n0(e.errors)} in ${e.data_days} d</small></td>
            <td class="num">${b ? n0(b.n) : "—"}<small>${b ? dlong(b.day) : ""}</small></td>
            <td class="num">${named_cell(r.named.detector)}</td>
            <td class="num">${named_cell(r.named.anticollision)}</td>
            <td class="num">${named_cell(r.named.table)}</td>
            <td class="num">${named_cell(r.named.pib)}</td>
          </tr>`;
}

function dashboard(model) {
  const all = [...model.reporting, ...model.not_reporting];
  const open = { high: 0, medium: 0, low: 0, info: 0 };
  for (const r of all) for (const s of SEV) open[s] += r.open[s];
  const head = `<thead><tr><th scope="col">System</th><th scope="col">Model</th><th scope="col">Site / customer</th><th scope="col">Last data</th>
          <th scope="col">Open findings</th><th scope="col">Clock</th><th scope="col" class="num">Errors/day (30 d)</th><th scope="col" class="num">Busiest day (30 d)</th><th scope="col" class="num">Detector com (30 d)</th>
          <th scope="col" class="num">Anticollision (30 d)</th><th scope="col" class="num">Table encoder (30 d)</th><th scope="col" class="num">PIB com loss (30 d)</th></tr></thead>`;
  const inv = model.inventory, nd = model.no_data;
  return `<template id="view-dashboard">
  <header class="title">
    <h1>${esc(TITLE)}</h1>
    <div class="sub">As of ${dlong(model.as_of)} (device days) · ${all.length} GE CV systems with log data · ${model.configured} configured for CV log collection</div>
  </header>
  <div class="tiles" aria-label="Fleet summary">
${[
  tile("Reporting", n0(model.reporting.length), "data in the last 7 device days"),
  tile("Not reporting", n0(model.not_reporting.length), "data, but none in the last 7 device days", model.not_reporting.length ? "warn" : ""),
  tile("Configured, no log data", n0(nd.length), "no sysError rows since the log starts", nd.length ? "warn" : ""),
  tile("Open findings", n0(open.high + open.medium + open.low), `${open.high} high · ${open.medium} medium · ${open.low} low${open.info ? ` · ${open.info} info` : ""}`, open.high ? "bad" : ""),
  tile("Not configured", n0(inv.length), "GE CV/IR systems in inventory")
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
          <tr class="grp"><th colspan="12" scope="colgroup">Reporting <small>${model.reporting.length} systems · most attention first: highest open severity (not info), then open findings, then errors/day</small></th></tr>
${model.reporting.map(fleet_row).join("\n")}
        </tbody>
${model.not_reporting.length ? `        <tbody>
          <tr class="grp"><th colspan="12" scope="colgroup">Not reporting <small>${model.not_reporting.length} systems · no data in the last 7 device days; columns and findings are as of each system's last data</small></th></tr>
${model.not_reporting.map(fleet_row).join("\n")}
        </tbody>` : ""}
      </table>
    </div>
  </section>
  <section>
    <div class="panel nodatalist">
      <h2>Configured, no log data <small>${n0(nd.length)} systems</small></h2>
      <p class="src">Configured to collect <code>sysError.log</code>, but no rows have arrived since the log starts (2026-04-30). This is a collection gap upstream of the insight pipeline; each system joins the page when its file arrives again.</p>
      <div class="tablewrap"><table>
        <thead><tr><th scope="col">System</th><th scope="col">Model</th><th scope="col">Site</th><th scope="col">Customer</th></tr></thead>
        <tbody>
${nd.map((s) => `          <tr><td>${esc(s.system_id)}</td><td>${esc(s.model || "—")}</td><td>${esc(s.site_name || "—")}</td><td>${esc(s.customer_name || "—")}</td></tr>`).join("\n")}
        </tbody>
      </table></div>
    </div>
  </section>
  <section>
    <details class="panel inv">
      <summary>${n0(inv.length)} GE CV/IR systems in inventory are not configured for CV log collection</summary>
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
    <p>${esc(K1)} Device timestamps are shown as stored, in UTC, without correction. This report's snapshot was taken at ${esc(utc(model.snapshot_at))}. Where a system's newest record is dated after that moment, its clock is at least that far ahead (a record cannot be written in the future), and the Clock column says so; the bound shrinks as a report is built later. Otherwise no offset is visible in the data, which does not mean the clock is right.</p>
    <p>The source is GE's <code>sysError.log</code>, an error log only: a day with no rows means no log at all (the system was off, or nothing was collected), not a day without errors; a quiet day has about 8–50 rows. Each system's columns end on its last data day D. Errors/day: error-log entries over the 30 device days ending on D, divided by the days with data in that window. Busiest day: the day in that window with the most entries. Detector com, anticollision, table encoder and PIB communication loss: entries over the same window; "not logged" means the system has never logged that event. No column repeats a finding rule: findings use 7-day trip windows and 28-day baselines, and are shown in the findings column.</p>
    <p>Internal: for Avante staff. Code labels are the most common readable debug-text template of each code, with numbers masked; they are internal wording derived from the data, not a decoding of GE's encoded fields. The columns, daily series, code tables and period totals on this page were checked against independent SQL (cv/verify.js); rates over a chosen period are computed in the page from those checked totals. The stored rule evidence inside finding cards is shown as the rule recorded it, not recomputed.</p>
  </div>
</template>`;
}

// ------------------------------------------------------------- system view

// What "observed" means for each rule (§13.1; hhm_rpp_ge insight/cv/findings/rules.js).
const OBSERVED = {
  cv_error_storm: "Residual errors, last storm day",
  cv_detector_com_errors: "Detector com errors, last trip day",
  cv_anticollision_burst: "Anticollision errors, last burst day",
  cv_table_encoder_fault: "Table encoder failures, 7 d",
  cv_pib_com_loss: "PIB resets / fails, 7 d"
};
// Readable evidence: every object with a code gets the code's label next
// to it (the raw JSON stays the stored evidence).
function with_labels(codes) {
  const add = (x) => {
    if (Array.isArray(x)) return x.map(add);
    if (x && typeof x === "object") {
      const o = {};
      for (const [k, v] of Object.entries(x)) o[k] = add(v);
      if ("code" in x && (typeof x.code === "string" || typeof x.code === "number")) {
        const c = codes[String(x.code)];
        o.label = c ? (c.label === null ? "no readable label" : c.label) : "—";
      }
      return o;
    }
    return x;
  };
  return add;
}

function system_view(v, i, order, model) {
  const h = v.header;
  const stale = h.group === "not_reporting";
  const open_n = h.open.high + h.open.medium + h.open.low;
  const nm = (k, label) => tile(label, h.named[k] === null ? "—" : n0(h.named[k]), h.named[k] === null ? "not logged by this system" : "30 d to the last data day");
  const tiles = [
    tile("Last data", dlong(h.last_day), `${stale ? "not reporting" : "reporting"} · newest device timestamp ${esc(dev_ts(h.last_seen))}`, stale ? "warn" : ""),
    tile("Errors/day", n2(h.errors.per_day), `${n0(h.errors.errors)} entries in ${h.errors.data_days} data days (30 d)`),
    tile("Busiest day", h.busiest ? n0(h.busiest.n) : "—", h.busiest ? `${dlong(h.busiest.day)} (30 d)` : ""),
    nm("detector", "Detector com"),
    nm("anticollision", "Anticollision"),
    nm("table", "Table encoder"),
    tile("Open findings", n0(open_n), `${h.open.high} high · ${h.open.medium} medium · ${h.open.low} low${h.open.info ? ` · ${h.open.info} info` : ""}`, h.open.high ? "bad" : open_n ? "warn" : ""),
    tile("Clock", h.clock_ahead_min ? `≥ ${n0(h.clock_ahead_min)} min ahead` : "—",
      h.clock_ahead_min
        ? `the newest record is dated ${n0(h.clock_ahead_min)} min after this report's snapshot (${esc(utc(model.snapshot_at))}), so the device clock is at least that far ahead. Device time; no correction (K1)`
        : "no offset visible in the data (not proof the clock is right). Device time; no correction (K1)", h.clock_ahead_min ? "warn" : "")
  ];
  const where = [h.site_name, h.customer_name, [h.city, h.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ");
  const card_opts = { observed_label: (f) => OBSERVED[f.finding_key] || "Observed", display: with_labels(model.codes) };
  return `<template id="view-${esc(v.system_id)}">
${appnav(i, order)}
  <header class="title">
    <h1>${esc(v.system_id)}${h.model ? ` · ${esc(h.model)}` : ""}</h1>
    <div class="sub">${esc(where)}${h.cus_sys_id ? ` · ${esc(h.cus_sys_id)}` : ""} · data ${dlong(v.d0)} – ${dlong(h.last_day)} (device days)</div>
  </header>
${stale ? `  <section><div class="panel notice"><p style="margin:0">No data since ${dlong(h.last_day)}. Columns, findings and panels are as of that day.</p></div></section>\n` : ""}  <div class="tiles four" aria-label="System summary">
${tiles.join("\n")}
  </div>
${findings_section(v.findings, v.system_id, stale ? h.last_day : null, card_opts)}
${periodbar(model)}
  <div class="panels" data-panels="${esc(v.panels.join(" "))}"></div>
</template>
<script type="application/json" id="data-${esc(v.system_id)}">${json_script(strip(v))}</script>`;
}

// The JSON block carries what the client draws; the header and findings are
// already HTML (the bands carry the findings' days for the timeline).
function strip(v) {
  const { header, findings, ...rest } = v;
  return { ...rest, last_day: header.last_day, group: header.group };
}

const CV_CSS = `.nodatalist{padding:16px 18px;margin-top:16px}
.nodatalist h2 small{font-weight:400;color:var(--muted);letter-spacing:0;text-transform:none;font-size:13px;margin-left:8px}
.nodatalist .src,.panelbox .note{color:var(--muted);font-size:13px;max-width:110ch;margin:4px 0 8px}
.nodatalist table{min-width:560px}
.scalebar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin-top:12px}
.scalebar .ctl-label{margin:0}
svg .bandr.high{fill:var(--high)} svg .bandr.medium{fill:var(--med)} svg .bandr.low{fill:var(--blue)} svg .bandr.info{fill:var(--muted)}
svg .bandr.resolved{opacity:.55}
svg text.bandt{font-size:10.5px;fill:var(--ink)}
svg text.bandt.in{paint-order:stroke;stroke:var(--panel);stroke-width:3px;stroke-linejoin:round}
svg .peak{fill:var(--ink)}
table.codes{min-width:760px}
table.codes td.lbl{min-width:280px;max-width:520px;white-space:normal;overflow-wrap:anywhere}
#systems td:nth-child(7){min-width:0}
#systems td:nth-child(6){min-width:130px}
table.codes td small{display:block;color:var(--muted);font-size:11.5px}
table.codes tr.dim td{color:var(--muted)}
details.allcodes{margin-top:10px}
details.allcodes > summary{cursor:pointer;font-weight:700;color:var(--blue);font-size:13.5px}`;

// model: cv/model.js build_model's output. Returns { html, name }.
function build_cv_page(model) {
  const order = [...model.reporting, ...model.not_reporting].map((r) => r.system_id);
  const views = order.map((sid, i) => system_view(model.views[sid], i, order, model));
  const index = {
    title: TITLE, default_period: model.default_period, periods: model.periods,
    systems: order.map((sid) => ({ id: sid, title: `${sid} · ${TITLE}` })),
    codes: model.codes
  };
  const html = page_html({
    title: TITLE, product: PRODUCT, as_of: model.as_of,
    footer_text: `GE CV Insights · Internal · as of ${esc(model.as_of)} · Prepared by Remote Solutions`,
    extra_css: CV_CSS,
    body: `${dashboard(model)}\n${views.join("\n")}`, index, client: CLIENT_JS
  });
  return { html, name: page_name(model.as_of) };
}

module.exports = { build_cv_page, page_name, TITLE, OBSERVED, with_labels };
