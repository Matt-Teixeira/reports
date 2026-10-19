const { DateTime } = require("luxon");
const logo_base64 = require("../render/assets/logo");
const { esc } = require("../render/fleet_page");
const { CSS, CLIENT_JS } = require("./timeline");

// The per-system ACTIVITY page: the Anomaly Report's interactive timeline
// (lanes, model and recipient filters, day-grouped slot table, detail pane,
// time-zone and clock toggles) with NOTHING that interprets the data — no
// hypothesis, no "what the data shows", no steps, no "expected, not
// detected", no inferred delivery status, no re-create queries. It states
// what the database holds for the system over the summary's window.
//
// Customer-facing: built only from scrubbed rows (incident/scrub.js), so no
// Avante user, address or count reaches it. Avante's own branding stays.
// Deterministic: the date comes from the window end, never the clock.

const TZ_DEFAULT = "America/New_York";
// Site-local time needs a site zone the database does not carry yet; until
// then Eastern and UTC, the two every reader can place.
const ZONES = [
  { tz: "America/New_York", label: "Eastern", abbr: "ET" },
  { tz: "UTC", label: "UTC", abbr: "UTC" }
];

// a: incident/activity.js output. ctx: { identity, meta, model_count,
// period_label, notice } — notice is the one plain sentence a system that
// could not be analyzed carries instead of readings.
const build_system_page = (a, { identity: id, meta = {}, model_count, period_label = null, notice = null }) => {
  const sys = id.system_id;
  const date = DateTime.fromMillis(a.window.to, { zone: TZ_DEFAULT }).toFormat("yyyy-MM-dd");

  // Where the compressor state came from: the EDU vibration sensor, or the
  // magnet monitor's own channel (scanner-reported or coldhead-inferred).
  const comp_table = a.sources.compressor === "edu_comp_vib" ? a.sources.edu : a.sources.mag;
  const data_sub = a.analyzed
    ? `Readings from ${a.sources.mag}${comp_table && comp_table !== a.sources.mag ? ` and ${comp_table}` : ""}, one point per capture slot`
    : "No readings shown: this system could not be analyzed for this period";

  const payload = {
    system_id: sys,
    audience: "external",
    show_missed: false,
    tz_default: TZ_DEFAULT,
    zones: ZONES,
    window: a.window,
    sources: { mag: a.sources.mag, edu: comp_table },
    data_sub,
    labels: a.labels,
    models: a.models,
    runs: a.runs,
    slots: a.slots,
    notes: a.notes,
    users: a.users,
    orgs: a.orgs,
    org_order: a.org_order,
    customer_org: a.customer_org,
    recipients_label: "recipients",
    scales: a.scales,
    shade: null,
    jump: null,
    evidence: []
  };

  const feeds = [meta.process_mag && "Magnet", meta.process_edu && "EDU", meta.process_log && "Logs"].filter(Boolean);
  const tile = (t) => `    <div class="tile"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${t.s}</div></div>`;
  const sys_tiles = [
    { k: "System", v: esc(sys), s: id.cus_sys_id ? `Customer system ID ${esc(id.cus_sys_id)}` : "" },
    { k: "Equipment", v: esc(`${id.manufacturer} ${id.model || ""}`.trim()), s: [esc(id.modality), meta.serial_number && `serial ${esc(meta.serial_number)}`].filter(Boolean).join(" · ") },
    { k: "Site", v: esc(id.site_name), s: [meta.street_address, `${id.city}, ${id.state}${meta.zip ? ` ${meta.zip}` : ""}`].filter(Boolean).map(esc).join(", ") },
    { k: "Customer", v: esc(id.customer_name), s: [esc(id.customer_id), id.site_group_name && `site group ${esc(id.site_group_name)}`].filter(Boolean).join(" · ") },
    { k: "Monitoring", v: feeds.length ? feeds.join(" · ") : "—", s: `${model_count} alert models` }
  ];
  const span = `${DateTime.fromMillis(a.window.from, { zone: TZ_DEFAULT }).toFormat("LLL d")} – ${DateTime.fromMillis(a.window.to, { zone: TZ_DEFAULT }).toFormat("LLL d, yyyy")}`;
  const p_head = `${esc(a.labels.primary)}${a.labels.p_units ? ` (${esc(a.labels.p_units)})` : ""}`;
  const l_head = `${esc(a.labels.level)}${a.labels.l_units && a.labels.l_units !== "%" ? ` (${esc(a.labels.l_units)})` : ""}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(sys)} System Activity</title>
<style>${CSS}
.notice{padding:14px 18px;border:1.5px solid var(--light);border-left:5px solid var(--blue);color:var(--ink)}
</style>
</head>
<body>
<header class="brandbar"><div class="wrap">
  <div class="hdr"><img class="logo" alt="Avante" src="data:image/png;base64,${logo_base64}"><div class="r">System Activity${period_label ? ` · ${esc(period_label)}` : ""}<br><b>${esc(date)}</b></div></div>
  <div class="brandband"></div>
</div></header>
<div class="wrap">
  <header class="title">
    <h1>${esc(sys)} System Activity</h1>
    <div class="sub">${esc(id.site_name)} · ${esc(id.customer_name)} · ${esc(span)}</div>
  </header>
  <div class="tiles" aria-label="System">
${sys_tiles.map(tile).join("\n")}
  </div>
  <div class="tiles" id="stat-tiles" aria-label="Period, alerts and notifications"></div>
${notice ? `
  <section>
    <div class="panel notice"><p style="margin:0">${esc(notice)}</p></div>
  </section>` : ""}
  <section>
    <div class="panel lanes">
      <h2 class="lanes-title">Timelines</h2>
      <div id="lanes"></div>
      <p class="cap">Dashed lines in Data are alert thresholds, breaks in a line are missing readings, and the compressor strip is green while running and red while off. Detection marks are colored by severity.</p>
    </div>
  </section>

  <section>
    <details class="panel recips">
      <summary>Alert models <small id="mcount"></small></summary>
      <div class="rquick" id="mquick">
        <button type="button" data-q="all">Show all</button>
        <button type="button" data-q="none">Clear</button>
        <button type="button" data-q="high">High severity only</button>
        <button type="button" data-q="medium">Medium severity only</button>
      </div>
      <div class="filters mfilters" id="filters"></div>
    </details>

    <details class="panel recips">
      <summary>Recipients <small id="rcount"></small></summary>
      <div class="rquick" id="rquick">
        <button type="button" data-q="all">Show all</button>
        <button type="button" data-q="none">Clear</button>
        <button type="button" data-q="reached">Reached at least once</button>
        <button type="button" data-q="never">Never reached</button>
      </div>
      <div class="rgrid" id="rgrid"></div>
    </details>

    <div class="split">
      <div class="tabletools">
          <div>
            <span class="ctl-label">Time zone</span>
            <div class="seg" role="group" aria-label="Time zone">
              ${ZONES.map((z) => `<button type="button" data-tz="${z.tz}" aria-pressed="${z.tz === TZ_DEFAULT}">${esc(z.label)}</button>`).join("\n              ")}
            </div>
          </div>
          <div>
            <span class="ctl-label">Clock</span>
            <div class="seg" role="group" aria-label="Clock format">
              <button type="button" data-clock="24" aria-pressed="true">24-hour</button>
              <button type="button" data-clock="12" aria-pressed="false">12-hour</button>
            </div>
          </div>
        <button type="button" id="toggleDays" aria-controls="rows">Expand all</button>
      </div>
      <div class="leftcol">
        <div class="panel tablewrap">
          <table>
            <thead><tr><th scope="col" id="th-time">Captured</th><th scope="col" class="num">${l_head}</th><th scope="col" class="num">${p_head}</th><th scope="col">Compressor</th><th scope="col">Alerts</th></tr></thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </div>
      <aside class="panel detailpane" id="detailpane" aria-label="Slot details" aria-live="polite"><div id="detail"></div></aside>
    </div>
  </section>

  <p class="method">Each row is a 30-minute capture slot. Readings are the values used for this period's Magnet Health Summary. Detections are tagged to the slot their alert check evaluated, and notifications to the check just before them. A detection does not always produce a notification: notification frequency limits and suppression rules decide what is sent. A notification counts as reached when it was sent by email or SMS.</p>
</div>
<footer class="foot"><div class="wrap"><span>Avante · Moving Healthcare Forward</span><span>${esc(sys)} · ${esc(id.site_name)} · Prepared by Remote Solutions</span></div></footer>
<script type="application/json" id="timeline-data">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
};

// Artifact name: Avante-<system>-Activity[-<period tag>]-<window end date>.html
const system_page_name = (system_id, window_to, period_tag = "") =>
  `Avante-${system_id}-Activity${period_tag}-${DateTime.fromMillis(window_to, { zone: TZ_DEFAULT }).toFormat("yyyy-MM-dd")}.html`;

module.exports = { build_system_page, system_page_name };
