const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const { esc } = require("../render/fleet_page");
const { CSS, CLIENT_JS } = require("./timeline");
const { brandbar, footer, json_script, PAGE_CSS, TZ_DEFAULT } = require("./system_page");

const APP_JS = fs.readFileSync(path.join(__dirname, "system_app.client.js"), "utf8");

// The System Activity APP (PLAN-SYSTEM-ACTIVITY-APP.md): one HTML file for
// a summary batch instead of one per flagged system. A dashboard lists every
// flagged system with the summary's own status; each row opens that
// system's view, which is exactly the standalone page's section
// (system_page.js) mounted by the same client. Views and their data are
// inert <template>s and JSON blocks, so a system costs nothing until opened.
//
// A batch too big for one email is split into parts. Each part is a whole
// app: its dashboard lists every flagged system in the batch and links the
// ones it carries; the rest say which part has them.
//
// Same audiences and rules as the page: an external app is built only from
// scrubbed sections; an internal one is marked Internal in the title,
// header and file name. Deterministic: no clock, no randomness.

const APP_CSS = `.appnav{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 18px;padding-top:22px;font-size:13.5px}
.appnav a{color:var(--blue);font-weight:700;text-decoration:none}
.appnav a:hover{text-decoration:underline}
.appnav .pos{color:var(--muted)}
.appnav .step{margin-left:auto;display:flex;gap:18px}
.appnav + header.title{padding-top:12px}
.tiles.four{grid-template-columns:repeat(4,minmax(0,1fr))}
@media (max-width:1100px){.tiles.four{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}}
.dtools{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:14px 14px 4px}
.dtools .ctl-label{margin:0}
.dtools input{font:inherit;font-size:14px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;min-width:min(280px,100%);color:var(--ink);background:var(--panel)}
.dtools input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
#dshown{color:var(--muted);font-size:13px}
#systems{min-width:860px}
#systems td small{display:block;color:var(--muted);font-size:12px}
#systems a{color:var(--blue);font-weight:700;text-decoration:none}
#systems tr[data-sys]{cursor:pointer}
#systems tr[data-sys]:hover{background:var(--hover)}
#systems tr.other{color:var(--muted)}
.sid{font-weight:700}`;

const num = (v) => String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const day = (ms) => DateTime.fromMillis(ms, { zone: TZ_DEFAULT }).toFormat("LLL d, yyyy");
const status_html = (s) => {
  const tag = s.strong ? "b" : "span";
  return `<${tag} style="color:${s.color}">${esc(s.label)}</${tag}>`;
};

const GROUPS = [
  ["attention", "need attention"],
  ["data_issue", "data issue"],
  ["failed", "could not be analyzed"]
];

// entries: every flagged system in the batch, in dashboard order:
//   { system_id, group: "attention" | "data_issue" | "failed",
//     status: { label, color, strong } — the summary's wording and color,
//     summary: system_section(...).summary, or null when its page failed,
//     part: the part (1..parts) carrying its view, or null when none does,
//     section: system_section(...) when part === this part, else null }
// opts: { scope_label, period_label, audience, date, span, part, parts }
const build_system_app = (entries, { scope_label, period_label = null, audience, date, span, part = 1, parts = 1 }) => {
  if (!["internal", "external"].includes(audience)) throw new Error(`build_system_app: unknown audience ${audience}`);
  const internal = audience === "internal";
  const here = entries.filter((e) => e.part === part);
  for (const e of here) {
    if (!e.section) throw new Error(`build_system_app: ${e.system_id} is in part ${part} with no section`);
    // One copy per file: an internal section can never reach an external app.
    if (e.section.internal !== internal) throw new Error(`build_system_app: ${e.system_id} section is not ${audience}`);
  }
  const title = `${scope_label} System Activity${internal ? " (Internal)" : ""}`;
  const counted = entries.filter((e) => e.summary);
  const total = (k) => num(counted.reduce((n, e) => n + e.summary[k], 0));
  const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;

  const tile = (k, v, s, cls = "") => `    <div class="tile${cls ? ` ${cls}` : ""}"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const tiles = [
    tile("Flagged systems", num(entries.length), GROUPS.map(([g, label]) => [entries.filter((e) => e.group === g).length, label]).filter(([n]) => n).map(([n, label]) => `${num(n)} ${label}`).join(" · ")),
    tile("Detections", total("detections"), `across ${plural(counted.length, "system")}`),
    tile("Notifications", total("notifications"), "to recipients, all systems"),
    tile("Reached", total("reached"), "sent by email or SMS", "good")
  ];

  const row = (e) => {
    const s = e.summary;
    const linked = e.part === part;
    const where = linked ? "" : e.part ? `<small>in part ${e.part} of ${parts}</small>` : "<small>activity not available</small>";
    const id_cell = linked ? `<a href="#${esc(e.system_id)}">${esc(e.system_id)}</a>` : `<span class="sid">${esc(e.system_id)}</span>`;
    const q = [e.system_id, s && s.cus_sys_id, s && s.site_name, s && s.customer_name, s && s.equipment, e.status.label].filter(Boolean).join(" ").toLowerCase();
    const cell = (v) => (s ? num(s[v]) : "—");
    return `          <tr${linked ? ` data-sys="${esc(e.system_id)}"` : ` class="other"`} data-q="${esc(q)}">
            <td>${id_cell}${s && s.cus_sys_id ? `<small>${esc(s.cus_sys_id)}</small>` : ""}${where}</td>
            <td>${s ? `${esc(s.site_name)}<small>${esc(s.customer_name)}</small>` : "—"}</td>
            <td>${s ? esc(s.equipment) : "—"}</td>
            <td>${status_html(e.status)}</td>
            <td class="num">${cell("detections")}</td>
            <td class="num">${cell("notifications")}</td>
            <td class="num">${cell("reached")}</td>
            <td>${s && s.last_detection ? day(s.last_detection) : "—"}</td>
          </tr>`;
  };

  const dashboard = `<template id="view-dashboard">
  <header class="title">
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(span)} · ${plural(entries.length, "flagged system")}</div>
  </header>
  <div class="tiles four" aria-label="Flagged systems, detections and notifications">
${tiles.join("\n")}
  </div>
${parts > 1 ? `  <section>
    <div class="panel notice"><p style="margin:0">This is part ${part} of ${parts}. Every flagged system is listed; the ${plural(here.length, "system")} linked below ${here.length === 1 ? "is" : "are"} in this file, and the rest say which part carries them.</p></div>
  </section>
` : ""}  <section>
    <div class="panel tablewrap">
      <div class="dtools">
        <label class="ctl-label" for="dfilter">Find a system</label>
        <input id="dfilter" type="search" placeholder="System, site, equipment or status" autocomplete="off">
        <span id="dshown" aria-live="polite"></span>
      </div>
      <table id="systems">
        <thead><tr><th scope="col">System</th><th scope="col">Site</th><th scope="col">Equipment</th><th scope="col">Status</th><th scope="col" class="num">Detections</th><th scope="col" class="num">Notifications</th><th scope="col" class="num">Reached</th><th scope="col">Last detection</th></tr></thead>
        <tbody>
${entries.map(row).join("\n")}
        </tbody>
      </table>
    </div>
  </section>
  <p class="method">Every system the Magnet Health Summary flagged for this period: it needs attention, has a data issue, or could not be analyzed. Healthy and limited-coverage systems are not listed. Status is the summary's own. Select a system to see its alert detections, notifications and readings over the period.${internal ? " Internal copy: Avante staff recipients are included in every count and view; the customer copy leaves them out." : ""}</p>
</template>`;

  const views = here.map((e, i) => {
    const prev = here[i - 1];
    const next = here[i + 1];
    return `<template id="view-${esc(e.system_id)}">
  <nav class="appnav" aria-label="Systems">
    <a href="#">← All systems</a>
    <span class="pos">System ${i + 1} of ${here.length}${parts > 1 ? " in this part" : ""} · ${status_html(e.status)}</span>
    <span class="step">${prev ? `<a href="#${esc(prev.system_id)}">← ${esc(prev.system_id)}</a>` : ""}${next ? `<a href="#${esc(next.system_id)}">${esc(next.system_id)} →</a>` : ""}</span>
  </nav>
${e.section.body}
</template>
<script type="application/json" id="data-${esc(e.system_id)}">${e.section.payload_json}</script>`;
  });

  const index = { title, systems: here.map((e) => ({ id: e.system_id, title: e.section.title })) };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<style>${CSS}
${PAGE_CSS}
${APP_CSS}
</style>
</head>
<body>
${brandbar({ period_label, internal, date })}
<div class="wrap" id="app"></div>
<noscript><div class="wrap"><p class="panel notice">This report needs JavaScript. Open it in a web browser such as Chrome, Edge, Safari or Firefox.</p></div></noscript>
${footer(`${esc(scope_label)}${parts > 1 ? ` · part ${part} of ${parts}` : ""} · Prepared by Remote Solutions`)}
${dashboard}
${views.join("\n")}
<script type="application/json" id="app-index">${json_script(index)}</script>
<script>${CLIENT_JS}</script>
<script>${APP_JS}</script>
</body>
</html>
`;
};

// Artifact name: Avante-<scope>-System-Activity[-Internal][-<period tag>]-<date>[-part-n-of-N].html
const system_app_name = ({ scope_tag, period_tag = "", date, audience = "external", part = 1, parts = 1 }) =>
  `Avante-${scope_tag}-System-Activity${audience === "internal" ? "-Internal" : ""}${period_tag}-${date}${parts > 1 ? `-part-${part}-of-${parts}` : ""}.html`;

module.exports = { build_system_app, system_app_name };
