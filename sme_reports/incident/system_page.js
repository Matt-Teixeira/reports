const { DateTime } = require("luxon");
// The downscaled logo (dev/gen_logo_small.js): the full-size one was ~240 KB
// of every zipped page.
const logo_base64 = require("../render/assets/logo_small");
const { esc } = require("../render/fleet_page");
const { CSS, CLIENT_JS, MOUNT_JS } = require("./timeline");

// The per-system ACTIVITY page: the Anomaly Report's interactive timeline
// (lanes, model and recipient filters, day-grouped slot table, detail pane,
// time-zone and clock toggles) with NOTHING that interprets the data — no
// hypothesis, no "what the data shows", no steps, no "expected, not
// detected", no inferred delivery status, no re-create queries. It states
// what the database holds for the system over the summary's window.
//
// Two audiences (incident/page_policy.js). External (customer-facing): built
// only from scrubbed rows (incident/scrub.js), so no Avante user, address or
// count reaches it. Internal: every recipient, Avante staff grouped under
// "Avante", marked Internal in the header, title and file name so it cannot
// pass for the customer copy. Avante's own branding stays on both.
// Deterministic: the date comes from the window end, never the clock.

const TZ_DEFAULT = "America/New_York";
// Site-local time needs a site zone the database does not carry yet; until
// then Eastern and UTC, the two every reader can place.
const ZONES = [
  { tz: "America/New_York", label: "Eastern", abbr: "ET" },
  { tz: "UTC", label: "UTC", abbr: "UTC" }
];

// --- "Compressor stops": what the other data says about each EDU stop ---
// One card per EDU-reported stop in the window (activity.js a.stops, from
// compute/corroborate.js): the verdict, then the evidence that decided it,
// in the rule's order — the second compressor channel, then the magnet's
// thermal readings. Static text in Eastern time: the verdict never changes
// with the reader's zone, and the times sit beside the timeline's.
const VERDICT = {
  confirmed: { label: "Confirmed", lead: "The EDU vibration sensor read off, and other data agrees." },
  doubtful: { label: "May not be off", lead: "The EDU vibration sensor read off, but other data suggests the compressor may have kept running." },
  unconfirmed: { label: "Unconfirmed", lead: "The EDU vibration sensor read off. Other data neither confirms nor disputes it." }
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const et = (t) => DateTime.fromMillis(t, { zone: TZ_DEFAULT }).toFormat("LLL d HH:mm ZZZZ");

const stop_card = (ev, s, labels) => {
  const c = ev.corroboration;
  const d = c.detail || {};
  const v = VERDICT[c.type] || VERDICT.unconfirmed;
  const when = ev.end == null ? `${et(ev.start)} → still off at the end of the period` : `${et(ev.start)} → ${et(ev.end)}`;
  // off_count counts the merged stream; detail.edu_off only the EDU's. A stop
  // the backup helped fill says how its off readings split.
  const edu_off = d.edu_off == null ? ev.off_count : d.edu_off;
  const readings =
    edu_off === ev.off_count
      ? plural(ev.off_count, "EDU off reading")
      : `${plural(ev.off_count, "off reading")} (${edu_off} from the EDU, ${ev.off_count - edu_off} from ${s.secondary || "the backup"} where the EDU was silent)`;
  const meta = [`~${ev.off_hours.toFixed(1)} h off`, readings, ev.cycles > 1 ? `${ev.cycles} off-runs` : null].filter(Boolean).join(" · ");
  const why = [];

  // 1. The second compressor channel.
  if (!s.secondary) why.push("This system has no second compressor channel: the EDU is its only compressor signal.");
  else {
    const name = `${cap(s.secondary)}${s.table ? ` (${esc(s.table)}${s.secondary === "the coldhead" ? ", inferred: under its warm bar means running" : ""})` : ""}`;
    const frozen = d.sec_stale ? ` (at ${d.sec_stale} of them its only readings repeat one host time: a frozen feed)` : "";
    if (!d.sec_off && !d.sec_on)
      why.push(`${name} had no fresh reading within 45 minutes of any of the ${plural(d.edu_off, "EDU off reading")}${frozen}.`);
    else
      why.push(
        `${name} said off at ${d.sec_off} and running at ${d.sec_on} of the ${plural(d.edu_off, "EDU off reading")}` +
          (d.sec_missing ? `, and had no fresh reading within 45 minutes of the other ${d.sec_missing}${frozen}.` : ".")
      );
  }
  // 2. Thermal: pressure (the primary metric) at the stop's start.
  const u = labels.p_units ? ` ${esc(labels.p_units)}` : "";
  const n = (x) => (x == null ? "—" : Number(x).toFixed(labels.p_dec));
  const p = d.pressure;
  if (!p)
    why.push(
      d.pressure_frozen
        ? `${esc(labels.primary)}: only frozen-feed readings (one repeated host time) in the 2 hours after the stop began.`
        : `${esc(labels.primary)}: no live readings in the 2 hours after the stop began.`
    );
  else if (p.epsilon == null) why.push(`${esc(labels.primary)}: no alert limit is configured, so a rise cannot be judged.`);
  else
    why.push(
      `${esc(labels.primary)}: ${n(p.baseline)}${u} before the stop, peak ${n(p.peak)}${u} in the 2 hours after. ` +
        `Warming takes at least two readings ${n(p.epsilon)}${u} or more above that (2% of the alert limit); ${p.above} ${p.above === 1 ? "was" : "were"}.`
    );
  // 2b. Thermal: the coldhead against its warm bar, where the vendor has one.
  const ch = d.coldhead;
  if (ch)
    why.push(
      ch.readings
        ? `Coldhead: peaked at ${ch.max.toFixed(1)} K during the stop, ${ch.max >= ch.warm_k ? "past" : "under"} the ${ch.warm_k} K warm bar.`
        : ch.frozen
          ? "Coldhead: only frozen-feed readings during the stop."
          : "Coldhead: no live readings during the stop."
    );

  // The verdict, in the rule's words.
  const sec_off = c.secondary === "off", warm = c.thermal === "warming";
  const because =
    c.type === "confirmed"
      ? `Confirmed because ${[sec_off ? "the second channel also read off" : null, warm ? "the magnet warmed" : null].filter(Boolean).join(" and ")}.`
      : c.type === "doubtful"
        ? "Marked “may not be off” because the second channel read running and the magnet showed no warming at the stop."
        : c.secondary === "on"
          ? // on + steady is doubtful and on + warming confirmed, so thermal is unknown here.
            "Unconfirmed because the second channel read running, but there is no live thermal data to back it."
          : `Unconfirmed because ${s.secondary ? "the second channel had no fresh reading" : "there is no second channel"}, and ${
              c.thermal === "steady" ? "the magnet's steady readings alone cannot settle it" : "there is no live thermal data"
            }.`;

  return `      <article class="stopcard ${c.type}">
        <div class="stophead"><span class="verdict ${c.type}">${v.label}</span><span class="stopwhen">${when}</span></div>
        <p class="stopmeta">${meta}</p>
        <p>${v.lead}</p>
        <ul class="why">${why.map((w) => `<li>${w}</li>`).join("")}</ul>
        <p class="because">${because} The stop stays listed as the EDU reported it.</p>
      </article>`;
};

const stops_section = (a) => {
  const s = a.stops;
  if (!s || !s.events.length) return "";
  return `
  <section>
    <div class="panel stops">
      <h2 class="lanes-title">Compressor stops</h2>
      <p class="cap">Each stop the EDU vibration sensor reported, checked against the other data in order: the second compressor channel first, then the magnet's thermal readings. A reading that repeats the previous one's host time is a frozen feed and counts for nothing.</p>
${s.events.map((ev) => stop_card(ev, s, a.labels)).join("\n")}
    </div>
  </section>`;
};

// One system's part of a page: everything inside the page's .wrap, its
// timeline payload (serialized once, script-safe: a fleet batch holds every
// section until its app is written), and the figures the System Activity app's dashboard
// lists. The standalone page (build_system_page) wraps one section in the
// shell; the app (system_app.js) carries many.
//
// a: incident/activity.js output. ctx: { identity, meta, model_count,
// notice, audience } — notice is the one plain sentence a system that could
// not be analyzed carries instead of readings.
const system_section = (
  a,
  { identity: id, meta = {}, model_count, notice = null, audience = "external", span: span_override = null }
) => {
  if (!["internal", "external"].includes(audience)) throw new Error(`unknown audience ${audience}`);
  const internal = audience === "internal";
  const sys = id.system_id;
  const title = `${sys} System Activity${internal ? " (Internal)" : ""}`;
  const date = DateTime.fromMillis(a.window.to, { zone: TZ_DEFAULT }).toFormat("yyyy-MM-dd");

  // Where the compressor state came from: the EDU vibration sensor, or the
  // magnet monitor's own channel (scanner-reported or coldhead-inferred).
  const comp_table = a.sources.compressor === "edu_comp_vib" ? a.sources.edu : a.sources.mag;
  // A second compressor strip when the EDU is primary: the vendor channel
  // as it reported (activity.js sources.alt). The Compressor strip is the
  // merged state, with that channel standing in where the EDU was silent.
  const alt = a.sources.alt || null;
  const extra_table = [comp_table, alt && alt.table].find((t) => t && t !== a.sources.mag) || null;
  const backup = a.sources.backup || null;
  const strip_note = !alt
    ? ""
    : ` The Compressor strip is the EDU vibration sensor, which this report judges and the compressor alert watches.` +
      (backup ? ` Where the EDU was silent it shows the ${backup.toLowerCase()} reading instead, drawn lighter.` : "") +
      ` The ${alt.label} strip below it is the magnet monitor's own reading, every capture, for comparison. The two can disagree.`;
  const data_sub = a.analyzed
    ? `Readings from ${a.sources.mag}${extra_table ? ` and ${extra_table}` : ""}, one point per capture slot`
    : "No readings shown: this system could not be analyzed for this period";

  const payload = {
    system_id: sys,
    audience,
    show_missed: false,
    tz_default: TZ_DEFAULT,
    zones: ZONES,
    window: a.window,
    sources: { mag: a.sources.mag, edu: comp_table, alt, backup },
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
  // An explicit report window arrives already worded (periods.js
  // span_text: its times and zone); a rolling one is named by its days.
  const span =
    span_override ||
    `${DateTime.fromMillis(a.window.from, { zone: TZ_DEFAULT }).toFormat("LLL d")} – ${DateTime.fromMillis(a.window.to, { zone: TZ_DEFAULT }).toFormat("LLL d, yyyy")}`;
  const p_head = `${esc(a.labels.primary)}${a.labels.p_units ? ` (${esc(a.labels.p_units)})` : ""}`;
  const l_head = `${esc(a.labels.level)}${a.labels.l_units && a.labels.l_units !== "%" ? ` (${esc(a.labels.l_units)})` : ""}`;

  const body = `  <header class="title">
    <h1>${esc(title)}</h1>
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
      <p class="cap">Dashed lines in Data are alert thresholds, breaks in a line are missing readings, and the compressor strip${alt ? "s are" : " is"} green while running and red while off.${strip_note} Detection marks are colored by severity.</p>
    </div>
  </section>
${stops_section(a)}

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
            <thead><tr><th scope="col" id="th-time">Captured</th><th scope="col" class="num">${l_head}</th><th scope="col" class="num">${p_head}</th><th scope="col">Compressor</th>${alt ? `<th scope="col">${esc(alt.label)}</th>` : ""}<th scope="col">Alerts</th></tr></thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </div>
      <aside class="panel detailpane" id="detailpane" aria-label="Slot details" aria-live="polite"><div id="detail"></div></aside>
    </div>
  </section>

  <p class="method">Each row is a 30-minute capture slot. Readings are the values used for this period's Magnet Health Summary. Detections are tagged to the slot their alert check evaluated, and notifications to the check just before them. A detection does not always produce a notification: notification frequency limits and suppression rules decide what is sent. A notification counts as reached when it was sent by email or SMS.${internal ? " Internal copy: Avante staff recipients are included and grouped under Avante; the customer copy leaves them out." : ""}</p>`;

  // What the app's dashboard lists for this system: the period's figures as
  // the view itself counts them, nothing it does not show.
  const rows = a.notes.flatMap((n) => n.rows);
  const summary = {
    system_id: sys,
    cus_sys_id: id.cus_sys_id || null,
    site_name: id.site_name,
    customer_name: id.customer_name,
    equipment: `${id.manufacturer} ${id.model || ""}`.trim(),
    detections: a.counts.detections,
    notifications: a.counts.notifications,
    reached: rows.filter((r) => r.email === "SENT" || r.sms === "SENT").length,
    recipients: a.counts.recipients,
    last_detection: a.runs.length ? a.runs[a.runs.length - 1].slot : null
  };
  return { system_id: sys, internal, title, date, span, site_name: id.site_name, body, payload_json: json_script(payload), summary };
};

// Shell rules beside timeline.js's CSS.
const PAGE_CSS = `.notice{padding:14px 18px;border:1.5px solid var(--light);border-left:5px solid var(--blue);color:var(--ink)}
.stops{padding:18px 20px;margin-top:16px}
.stopcard{border:1px solid var(--line);border-left:5px solid var(--line);border-radius:8px;padding:12px 16px;margin-top:12px;background:var(--panel)}
.stopcard.confirmed{border-left-color:var(--high)} .stopcard.doubtful{border-left-color:var(--ok)} .stopcard.unconfirmed{border-left-color:var(--med)}
.stophead{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px}
.verdict{font-weight:800;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:6px}
.verdict.confirmed{background:var(--high-bg);color:var(--high)} .verdict.doubtful{background:var(--ok-bg);color:var(--ok)} .verdict.unconfirmed{background:var(--med-bg);color:var(--med)}
.stopwhen{font-weight:700;color:var(--head)}
.stopmeta{margin:4px 0 8px;color:var(--muted);font-size:13px}
.stopcard p{margin:6px 0}
.stopcard .why{margin:6px 0;padding-left:20px} .stopcard .why li{margin:3px 0}
.stopcard .because{color:var(--muted);font-size:13.5px}
.internal-tag{display:inline-block;margin-left:8px;padding:1px 7px;border:1.5px solid currentColor;border-radius:3px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;vertical-align:1px}`;

const brandbar = ({ period_label, internal, date }) => `<header class="brandbar"><div class="wrap">
  <div class="hdr"><img class="logo" alt="Avante" src="data:image/png;base64,${logo_base64}"><div class="r">System Activity${period_label ? ` · ${esc(period_label)}` : ""}${internal ? `<span class="internal-tag">Internal</span>` : ""}<br><b>${esc(date)}</b></div></div>
  <div class="brandband"></div>
</div></header>`;

const footer = (right) =>
  `<footer class="foot"><div class="wrap"><span>Avante · Moving Healthcare Forward</span><span>${right}</span></div></footer>`;

// A payload inside <script type="application/json">: no "<" can close it.
const json_script = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

// The standalone page: one system's section in the shell, mounted on load.
// ctx: system_section's, plus period_label for the brand header.
const build_system_page = (a, ctx) => {
  const s = system_section(a, ctx);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(s.title)}</title>
<style>${CSS}
${PAGE_CSS}
</style>
</head>
<body>
${brandbar({ period_label: ctx.period_label || null, internal: s.internal, date: s.date })}
<div class="wrap">
${s.body}
</div>
${footer(`${esc(s.system_id)} · ${esc(s.site_name)} · Prepared by Remote Solutions`)}
<script type="application/json" id="timeline-data">${s.payload_json}</script>
<script>${CLIENT_JS}
${MOUNT_JS}</script>
</body>
</html>
`;
};

// Artifact name: Avante-<system>-Activity[-Internal][-<period tag>]-<window end date>.html
// The customer copy keeps the plain name; the internal copy says so, and
// the two never overwrite each other.
const system_page_name = (system_id, window_to, period_tag = "", audience = "external") =>
  `Avante-${system_id}-Activity${audience === "internal" ? "-Internal" : ""}${period_tag}-${DateTime.fromMillis(window_to, { zone: TZ_DEFAULT }).toFormat("yyyy-MM-dd")}.html`;

module.exports = { build_system_page, system_section, system_page_name, brandbar, footer, json_script, PAGE_CSS, ZONES, TZ_DEFAULT };
