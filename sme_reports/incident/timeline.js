const fs = require("fs");
const path = require("path");
const { DateTime } = require("luxon");
const logo_base64 = require("../render/assets/logo");
const { esc } = require("../render/fleet_page");

// The interactive Anomaly Report: the hand-built SME21284 timeline page,
// generated from the database and dressed in the Avante report design
// (logo header, gradient band, navy/blue palette, Helvetica, navy footer).
// Content and behavior follow the seed page section for section; the client
// script (timeline.client.js) is the seed's, driven by the payload below
// instead of hand-typed data.
//
// Two audiences from one build:
//   internal — "expected, not detected" and the re-create queries.
//   external — for the customer: neither of those.
// Both show only recipients associated with the system's customer.

const CLIENT_JS = fs.readFileSync(path.join(__dirname, "timeline.client.js"), "utf8");
const AVANTE = /avante/i;
const ORG_BY_DOMAIN = { "crothall.com": "Crothall", "intelashealth.com": "Intelas" };
const SOURCES = { mag: "mag.ge_mm3", edu: "edu.v3" };

// Seed-style model names: "He Pressure > 5.2 PSI", "He Level drop of 2%".
const model_name = (m) => {
  const u = m.threshold_units === "%" ? "%" : m.threshold_units ? ` ${m.threshold_units}` : "";
  if (m.operator === "greater_than") return `${m.field_name_alias} > ${m.threshold}${u}`;
  if (m.operator === "less_than") return `${m.field_name_alias} < ${m.threshold}${u}`;
  if (m.operator === "delta_neg") return `${m.field_name_alias} drop of ${m.threshold}${u}`;
  return m.field_name_alias;
};
const FIELD = { compressor: "comp_vib_status", pressure: "he_pressure_value", level: "he_level_value" };
const KIND_RANK = { compressor: 0, pressure: 1, level: 2, offline: 3, missing: 4, other: 5 };

const iso_sql = (t) => new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "+00");

const build_timeline = (data, a, { tz_site, analyzed_date, content, audience = "internal" }) => {
  if (!["internal", "external"].includes(audience)) throw new Error(`unknown audience ${audience}`);
  const external = audience === "external";
  const id = a.identity;
  const sys = id.system_id;

  // --- models: the ones that did something in the window, plus the offline
  // monitors (their silence is part of the story) ---
  const used = new Set();
  a.runs.forEach((r) => r.dets.forEach((d) => used.add(d.model.id)));
  data.notifications.forEach((n) => (n.detected_alert_models || []).forEach((x) => used.add(x)));
  const models = a.models
    .filter((m) => used.has(m.id) || m.operator === "offline")
    .sort(
      (p, q) =>
        KIND_RANK[p.kind] - KIND_RANK[q.kind] ||
        (p.kind === "level" ? (p.operator === "delta_neg") - (q.operator === "delta_neg") : 0) ||
        (q.value || 0) - (p.value || 0) ||
        p.field_name_alias.localeCompare(q.field_name_alias)
    )
    .map((m, i) => ({
      code: `m${i}`,
      id: m.id,
      name: model_name(m),
      sev: m.severity === "high" ? "high" : "medium",
      freq: m.notify_frequency,
      operator: m.operator,
      kind: m.kind,
      op: m.op || null,
      value: m.value === undefined ? null : m.value,
      field: FIELD[m.kind] || null
    }));
  const code_of = new Map(models.map((m) => [m.id, m.code]));

  // --- recipients: only users associated with the system's customer.
  // Avante staff, and anything else (a personal address on a multi-customer
  // account), are left off the page and counted in the query notes. ---
  const user_by_email = new Map(data.recipients.map((u) => [u.email_address.toLowerCase(), u]));
  const is_customer = (email) => {
    const u = user_by_email.get(email);
    return !AVANTE.test(email) && u && (u.customer_ids || []).length === 1 && u.customer_ids[0] === id.customer_id;
  };
  const users = {};
  const orgs = {};
  const excluded_staff = new Set();
  const excluded_other = new Set();
  const cust_orgs = new Set();
  for (const n of data.notifications) {
    const key = n.user_id.toLowerCase();
    if (AVANTE.test(key)) {
      excluded_staff.add(key);
      continue;
    }
    if (!is_customer(key)) {
      excluded_other.add(key);
      continue;
    }
    cust_orgs.add(ORG_BY_DOMAIN[key.split("@")[1]] || id.customer_name);
    if (!users[key]) users[key] = n.user_id;
  }
  const customer_org = [...cust_orgs].sort().join(" / ") || id.customer_name;
  for (const key of Object.keys(users)) if (!orgs[key]) orgs[key] = customer_org;

  const by_run = new Map();
  for (const n of data.notifications) {
    const key = n.user_id.toLowerCase();
    if (!users[key]) continue;
    const codes = (n.detected_alert_models || []).map((x) => code_of.get(x)).filter(Boolean);
    if (!codes.length) continue;
    const t = n.last_update.getTime();
    const b = by_run.get(n.run_id) || { start: t, end: t, rows: [] };
    b.start = Math.min(b.start, t);
    b.end = Math.max(b.end, t);
    b.rows.push({ u: key, email: n.email_status, sms: n.sms_status, codes });
    by_run.set(n.run_id, b);
  }
  const notes = [...by_run.values()].sort((p, q) => p.start - q.start);

  // --- slots and runs ---
  const mag_txt = new Map(data.mag.map((r) => [r.capture_datetime.getTime(), r]));
  const slots = a.slots.map((s) => {
    const raw = mag_txt.get(s.t);
    return {
      t: s.t,
      comp: s.comp,
      mag: s.mag
        ? { lvl: s.mag.level, pr: s.mag.pressure, lvlTxt: String(raw.he_level_value), prTxt: String(raw.he_pressure_value) }
        : null
    };
  });
  const runs = a.runs
    .map((r) => ({
      at: r.at,
      slot: r.slot_t,
      dets: r.dets
        .filter((d) => code_of.has(d.model.id))
        .map((d) => ({
          code: code_of.get(d.model.id),
          field: d.field_name,
          rfc: d.resolved_field_content,
          rfu: d.resolved_field_units,
          op: d.operator,
          th: d.threshold,
          rtc: d.resolved_threshold_content,
          thu: d.threshold_units,
          ins: d.inserted_at.getTime(),
          cap: d.capture_datetime.getTime()
        }))
    }))
    .filter((r) => r.dets.length && r.slot >= a.window.first_slot && r.slot <= a.window.last_slot);

  // --- scales: the seed's fixed axes, derived ---
  const mags = slots.filter((s) => s.mag);
  const p_lines = models.filter((m) => m.kind === "pressure" && m.op === ">").map((m) => m.value);
  const l_lines = models.filter((m) => m.kind === "level" && m.op === "<").map((m) => m.value);
  const max_p = Math.max(...mags.map((s) => s.mag.pr), ...p_lines);
  const lv = mags.map((s) => s.mag.lvl);
  const scales = {
    p_top: Math.ceil(max_p * 1.05 * 2) / 2,
    l_lo: Math.floor(Math.min(...lv) - 0.5),
    l_hi: Math.ceil(Math.max(...lv, ...l_lines.filter((v) => v <= Math.max(...lv) + 2)) + 0.8)
  };

  const site_zone = DateTime.fromMillis(a.window.from, { zone: tz_site }).toFormat("ZZZZ").replace(/[DS]T$/, "T");
  const zones = [
    { tz: "America/New_York", label: "Eastern", abbr: "ET" },
    ...(tz_site !== "America/New_York" && tz_site !== "UTC" ? [{ tz: tz_site, label: `Site (${site_zone})`, abbr: site_zone }] : []),
    { tz: "UTC", label: "UTC", abbr: "UTC" }
  ];

  // --- hypothesis: the stated cause (content.js) plus the facts it rests
  // on, generated. Times stay as epoch ms so the client renders them in
  // whatever zone and clock the reader picks. ---
  const hyp = content && content.hypothesis;
  const first_det = (alias) => {
    const r = a.runs.find((x) => x.dets.some((d) => d.model.field_name_alias === alias));
    return r ? { at: r.at, cap: r.dets.find((d) => d.model.field_name_alias === alias).capture_datetime.getTime() } : null;
  };
  const evidence = [];
  if (hyp) {
    const hhm = first_det("HHM Unreachable");
    const has_mmb = a.models.some((m) => m.field_name_alias === "MMB Unreachable");
    const mmb = first_det("MMB Unreachable");
    const gap = a.outage.never.reduce((m, x) => (!m || x.n > m.n ? x : m), null);
    // Detection is not notification (throttles and suppression sit between),
    // so "was notified" is only said when a batch actually carried it.
    const hhm_sent = a.batches.some((b) => b.models.some((m) => m.field_name_alias === "HHM Unreachable"));
    if (hhm) evidence.push({ t: hhm.cap, text: `The HHM (Hospital Host Machine) last checked in {0}. HHM Unreachable triggered {1}${hhm_sent ? " and was notified" : ", but no notification was sent"}.`, times: [hhm.cap, hhm.at] });
    evidence.push({ t: a.stop.t, text: "The compressor reported off from {0}.", times: [a.stop.t] });
    if (gap && gap.n >= 3) evidence.push({ t: gap.start, text: "No magnet readings were recorded from {0} to {1}.", times: [gap.start, gap.end] });
    // The backfill: readings captured during the outage that exist now but
    // were missing when their alert check ran.
    const late = a.slots.filter((x) => x.status === "late" && x.t >= a.outage.start && (!a.outage.resumed_slot || x.t < a.outage.resumed_slot));
    if (late.length && a.outage.seen_again_at)
      evidence.push({ t: a.outage.seen_again_at, text: `${late.length} half-hour readings captured from {0} to {1} were missing when their alert checks ran and reached us later, as a backfill. The first check to see current readings ran {2}.`, times: [late[0].t, late[late.length - 1].t, a.outage.seen_again_at] });
    if (has_mmb) evidence.push({ t: Infinity, text: mmb ? "MMB Unreachable triggered {0}." : "MMB Unreachable never triggered: the MMB (Magnet Monitor Box) stayed in contact throughout.", times: mmb ? [mmb.at] : [] });
    evidence.sort((p, q) => p.t - q.t);
  }

  const payload = {
    system_id: sys,
    audience,
    show_missed: !external,
    tz_default: "America/New_York",
    zones,
    window: { from: a.window.from, to: a.window.to },
    sources: SOURCES,
    models,
    runs,
    slots,
    notes,
    users,
    orgs,
    customer_org,
    scales,
    shade: a.outage.seen_again_at ? { start: a.outage.start, end: a.outage.seen_again_at } : null,
    jump: a.stop.t,
    evidence: evidence.map(({ text, times }) => ({ text, times }))
  };

  // --- static sections ---
  const offline_dets = a.runs.flatMap((r) => r.dets).filter((d) => d.model.operator === "offline");
  const last_checkin = offline_dets.length ? Math.max(...offline_dets.map((d) => d.capture_datetime.getTime())) : null;
  const offline_names = models.filter((m) => m.operator === "offline" && offline_dets.some((d) => d.model.id === m.id)).map((m) => m.name);
  const rule_text = (() => {
    const comp = models.filter((m) => m.kind === "compressor").map((m) => `${m.name} = false`);
    const group = (kind, alias) => {
      const ms = models.filter((m) => m.kind === kind && m.op);
      return ms.length ? [`${alias} ${ms.map((m) => `${m.op} ${m.value}`).join(" and ")}`] : [];
    };
    return [...comp, ...group("pressure", "He Pressure"), ...group("level", "He Level")].join(", ");
  })();
  const cust_id_empty = data.notifications.every((n) => !n.customer_id);
  const steps = (content && content.steps) || [];
  const W0 = iso_sql(a.window.from);
  const W1 = iso_sql(a.window.to);
  const queries = [
    {
      title: "Alert configuration",
      text: `The ${data.models.length} default alert models on ${sys}, with thresholds, severity, and notification throttle. This defines the lanes and filters.`,
      sql: `SELECT field_name_alias,
       operator,
       threshold,
       threshold_units,
       threshold_offset,
       severity,
       enabled,
       customized,
       notify_frequency,
       last_update,
       last_updated_by,
       last_update >= NOW() - INTERVAL '7 days' AS changed_this_week,
       id
FROM alert.models
WHERE system_id = '${sys}'
  AND user_id = 'default'
ORDER BY field_name_alias;`
    },
    {
      title: "Detections",
      text: "Every detection for those default models in the window, ordered by when the system recorded it. This feeds the detection runs and the swimlane chart.",
      sql: `SELECT alert_model_id,
       field_name,
       resolved_field_content,
       resolved_field_units,
       operator,
       threshold,
       resolved_threshold_content,
       threshold_units,
       inserted_at,
       capture_datetime
FROM alert.detections
WHERE alert_model_id IN (
        SELECT id
        FROM alert.models
        WHERE system_id = '${sys}'
          AND user_id = 'default'
      )
  AND capture_datetime >= '${W0}'
  AND capture_datetime <  '${W1}'
ORDER BY inserted_at, capture_datetime;`
    },
    {
      title: "Notifications",
      text: `Every notification that referenced any ${sys} model, for all recipients, with email and SMS status. This feeds the notification rows and the recipient filter.`,
      note: (() => {
        const parts = [`${excluded_staff.size} Avante staff address${excluded_staff.size === 1 ? "" : "es"}`];
        if (excluded_other.size) parts.push(`${excluded_other.size} other address${excluded_other.size === 1 ? "" : "es"} (${[...excluded_other].map(esc).join(", ")})`);
        const n = excluded_staff.size + excluded_other.size;
        return `Only users associated with ${esc(id.customer_name)} are shown: ${parts.join(" and ")} ${n === 1 ? "is" : "are"} excluded from the page after the query runs.`;
      })(),
      sql: `SELECT n.last_update,
       n.user_id,
       n.customer_id,
       n.email_status,
       n.sms_status,
       n.sms_sid,
       (
         SELECT array_agg(m.field_name_alias || ' ' || m.operator || ' ' || m.threshold
                          ORDER BY m.field_name_alias)
         FROM alert.models m
         WHERE m.system_id = '${sys}'
           AND m.id::text = ANY(n.detected_alert_models)
       ) AS alert_models,
       n.detected_alert_models,
       n.alert_detection_ids,
       n.run_id,
       n.job_id
FROM alert.notifications n
WHERE n.detected_alert_models && ARRAY(
        SELECT id::text
        FROM alert.models
        WHERE system_id = '${sys}'
      )
  AND n.last_update >= '${W0}'
  AND n.last_update <  '${W1}'
ORDER BY n.last_update, n.run_id;`
    },
    {
      title: "Magnet readings",
      text: "He level and He pressure for every capture slot. Together with step 5, this is the primary reference data: every row in the table is one capture_datetime.",
      sql: `SELECT capture_datetime, he_level_value, he_pressure_value
FROM ${SOURCES.mag}
WHERE system_id = '${sys}'
  AND capture_datetime >= '${W0}'
  AND capture_datetime <  '${W1}'
ORDER BY capture_datetime;`
    },
    {
      title: "Compressor readings",
      text: "Compressor status for every capture slot, joined to the magnet readings on capture_datetime.",
      sql: `SELECT capture_datetime, comp_vib_status
FROM ${SOURCES.edu}
WHERE system_id = '${sys}'
  AND capture_datetime >= '${W0}'
  AND capture_datetime <  '${W1}'
ORDER BY capture_datetime;`
    }
  ];

  const command = `node sme_reports/incident/run.js --system ${sys} --from ${new Date(a.window.from).toISOString().replace(":00.000Z", "Z")} --to ${new Date(a.window.to).toISOString().replace(":00.000Z", "Z")} --tz ${tz_site}`;
  const methodology_internal = `Each row is a 30-minute capture slot. Readings come from ${SOURCES.mag} and ${SOURCES.edu}, joined on capture_datetime. Detections from alert.detections are tagged to the slot their run evaluated${
    offline_names.length && last_checkin
      ? `; ${offline_names.join(" and ")} rows are tagged the same way even though they reference the monitor's last check-in (${DateTime.fromMillis(last_checkin, { zone: "utc" }).toFormat("LLL d, yyyy HH:mm:ss")} UTC)`
      : ""
  }. Notifications from alert.notifications are tagged to the slot of the detection run just before them. "Expected, not detected" applies each model's operator and threshold to the readings (${esc(rule_text)}) and flags slots where the run produced no matching detection; it ignores throttling, which only affects notifications. A recipient counts as reached when email_status or sms_status is SENT. Only notifications to ${esc(customer_org)} users are shown.${
    cust_id_empty ? " customer_id was empty on every notification row." : ""
  }`;
  const methodology = external
    ? `Each row is a 30-minute capture slot of magnet and compressor readings. Detections are tagged to the slot their alert check evaluated, and notifications to the check just before them. A detection does not always produce a notification: notification frequency limits and suppression rules decide what is sent. Only notifications to ${esc(customer_org)} users are shown, and a notification counts as reached when it was sent by email or SMS.`
    : methodology_internal;
  const label = external ? "External" : "Internal";

  // --- header tiles: what the system is (static), then the period and
  // alert figures (stat-tiles, filled client-side so they follow the
  // time-zone and clock toggles) ---
  const meta = data.meta || {};
  const feeds = [meta.process_mag && "Magnet", meta.process_edu && "EDU", meta.process_log && "Logs"].filter(Boolean);
  const tile = (t) => `    <div class="tile"><div class="k">${t.k}</div><div class="v">${t.v}</div><div class="s">${t.s}</div></div>`;
  const sys_tiles = [
    { k: "System", v: esc(sys), s: id.cus_sys_id ? `Customer system ID ${esc(id.cus_sys_id)}` : "" },
    { k: "Equipment", v: esc(`${id.manufacturer} ${id.model}`), s: [esc(id.modality), meta.serial_number && `serial ${esc(meta.serial_number)}`].filter(Boolean).join(" · ") },
    { k: "Site", v: esc(id.site_name), s: [meta.street_address, `${id.city}, ${id.state}${meta.zip ? ` ${meta.zip}` : ""}`].filter(Boolean).map(esc).join(", ") },
    { k: "Customer", v: esc(id.customer_name), s: [esc(id.customer_id), id.site_group_name && `site group ${esc(id.site_group_name)}`].filter(Boolean).join(" · ") },
    { k: "Monitoring", v: feeds.length ? feeds.join(" · ") : "—", s: `${data.models.length} alert models · notifications to ${esc(customer_org)}` }
  ];

  const span_label = `${DateTime.fromMillis(a.window.from, { zone: "America/New_York" }).toFormat("LLL d")} – ${DateTime.fromMillis(a.window.to, { zone: "America/New_York" }).toFormat("LLL d, yyyy")}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(sys)} Anomaly Report</title>
<style>${CSS}</style>
</head>
<body>
<header class="brandbar"><div class="wrap">
  <div class="hdr"><img class="logo" alt="Avante" src="data:image/png;base64,${logo_base64}"><div class="r">Anomaly Report · ${label}<br><b>${esc(analyzed_date)}</b></div></div>
  <div class="brandband"></div>
</div></header>
<div class="wrap">
  <header class="title">
    <h1>${esc(sys)} Anomaly Report</h1>
    <div class="sub">${esc(id.site_name)} · ${esc(id.customer_name)} · ${esc(span_label)}</div>
  </header>
  <div class="tiles" aria-label="System">
${sys_tiles.map(tile).join("\n")}
  </div>
  <div class="tiles" id="stat-tiles" aria-label="Period, alerts and notifications"></div>
${
  hyp
    ? `
  <section>
    <div class="panel hypothesis">
      <h2>Hypothesis</h2>
      <h3>${esc(hyp.title)}</h3>
      ${[].concat(hyp.body).map((x) => `<p>${esc(x)}</p>`).join("\n      ")}
      ${evidence.length ? `<h4>What the data shows</h4><ul id="evidence"></ul>` : ""}
    </div>
  </section>`
    : ""
}
  <section>
    <div class="panel lanes">
      <h2 class="lanes-title">Timelines</h2>
      <div id="lanes"></div>
      <p class="cap">Dashed lines in Data are alert thresholds, breaks in a line are missing readings, and the compressor strip is green while running and red while off. Detection marks are colored by severity. The shaded span is when readings were not reaching the alert checks, from the compressor stop to the first run that saw readings again.</p>
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
              ${zones.map((z) => `<button type="button" data-tz="${z.tz}" aria-pressed="${z.tz === payload.tz_default}">${esc(z.label)}</button>`).join("\n              ")}
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
            <thead><tr><th scope="col" id="th-time">Captured</th><th scope="col" class="num">He level</th><th scope="col" class="num">He pressure (PSI)</th><th scope="col">Compressor</th><th scope="col">Alerts</th></tr></thead>
            <tbody id="rows"></tbody>
          </table>
        </div>
      </div>
      <aside class="panel detailpane" id="detailpane" aria-label="Slot details" aria-live="polite"><div id="detail"></div></aside>
    </div>
  </section>
${
  steps.length
    ? `
  <section>
    <div class="panel steps">
      <h2>Steps for improvement</h2>
      <p class="lede">What we plan to change so an event like this is clearer to everyone receiving alerts.</p>
      <ol>
${steps.map((s) => `        <li>\n          <h3>${esc(s.title)}</h3>\n          <p>${esc(s.body)}</p>\n        </li>`).join("\n")}
      </ol>
    </div>
  </section>`
    : ""
}

${
  external
    ? ""
    : `  <section>
    <div class="panel guide">
      <h2>Re-create this timeline</h2>
      <p>Run these five queries. Steps 4 and 5 build the primary reference data (one row per capture slot); steps 1 to 3 supply the alert configuration, detections and notifications that are tagged onto it. This page is generated from them by <code>${esc(command)}</code>.</p>
      <ol>
${queries
  .map(
    (q, i) => `        <li>
          <h3>${esc(q.title)}</h3>
          <p>${q.text}</p>
          <div class="codewrap"><button type="button" class="copy" data-copy="q${i + 1}">Copy</button><pre id="q${i + 1}"><code>${esc(q.sql)}</code></pre></div>
          ${q.note ? `<p class="note">${q.note}</p>` : ""}
        </li>`
  )
  .join("\n")}
      </ol>
    </div>
  </section>`
}

  <p class="method">${methodology}</p>
</div>
<footer class="foot"><div class="wrap"><span>Avante · Moving Healthcare Forward</span><span>${esc(sys)} · ${esc(id.site_name)} · Prepared by Remote Solutions</span></div></footer>
<script type="application/json" id="timeline-data">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>
<script>${CLIENT_JS}</script>
</body>
</html>
`;
};

// Avante report palette (output/email_theme COLORS) on the seed's layout.
// Light only, like every Avante report; Helvetica, not the seed's Archivo.
const CSS = `
:root{
  --navy:#002B43; --blue:#004E79; --light:#97C6E9; --fill:#EBF0F5;
  --bg:#F4F6F8; --panel:#FFFFFF; --ink:#070809; --head:#002B43; --muted:#57585A; --line:#DCE4EB;
  --accent:#004E79; --high:#E50B14; --high-bg:#FDECEC; --med:#C25E00; --med-bg:#FBF0E4;
  --band:#EBF0F5; --hover:#F2F6F9; --day:#F7F9FB; --ok:#00695C; --ok-bg:#E3F2EF; --note-bg:#F3F7FB;
  color-scheme:light;
}
*,*::before,*::after{box-sizing:border-box}
body{margin:0; background:var(--bg); color:var(--ink); font-family:"Helvetica Neue",Helvetica,Arial,sans-serif; font-size:14.5px; line-height:1.5; font-variant-numeric:tabular-nums}
.wrap{max-width:1360px; margin:0 auto; padding:0 24px}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:12.5px}

/* Avante brand header: logo, document label, the tri-color band */
.brandbar{background:var(--panel); padding-top:22px; border-bottom:1px solid var(--line)}
.hdr{display:flex; align-items:center; justify-content:space-between; gap:16px}
.hdr .logo{height:46px; width:auto; display:block}
.hdr .r{text-align:right; font-size:13.5px; color:var(--muted); line-height:1.35}
.brandband{height:8px; border-radius:5px; margin:14px 0 0; background:linear-gradient(90deg,var(--navy) 0 30%,var(--blue) 30% 62%,var(--light) 62% 100%); transform:translateY(4px)}
header.title{padding-top:30px}
h1{margin:0; font-size:clamp(28px,4vw,40px); line-height:1.1; color:var(--head); font-weight:800; letter-spacing:-.005em}
.sub{margin-top:6px; font-size:14px; color:var(--muted)}
.tiles{display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:10px; margin-top:10px}
header.title + .tiles{margin-top:18px}
@media (max-width:1100px){.tiles{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}}
.tile{background:var(--fill); border-radius:12px; padding:12px 14px; min-width:0}
.tile .k{font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--muted)}
.tile .v{font-size:22px; line-height:1.2; font-weight:800; color:var(--head); margin-top:3px; overflow-wrap:anywhere}
.tile .s{font-size:12.5px; color:var(--muted); margin-top:3px; line-height:1.35}
.tile.good .v{color:var(--ok)} .tile.bad .v{color:var(--high)} .tile.warn .v{color:var(--med)}
.story{margin:16px 0 0; max-width:none; background:var(--fill); border-radius:12px; padding:14px 18px; color:var(--ink); font-size:14.5px; line-height:1.55}
.story strong{color:var(--head); font-weight:700}

section{margin-top:26px}
.panel{background:var(--panel); border:1px solid var(--line); border-radius:10px}
h2{margin:0; font-size:13px; letter-spacing:.1em; text-transform:uppercase; color:var(--blue); font-weight:700}
.lanes{padding:18px 18px 10px; overflow-x:auto}
.lanes-title{margin:0 0 12px 2px}
.lanes svg{display:block; width:100%; min-width:760px; height:auto}
.lanes .cap{margin:6px 2px 0; color:var(--muted); font-size:12.5px}
svg text{font-family:inherit; fill:var(--ink); font-size:12px}
svg .tick{fill:var(--muted); font-size:11px}
svg .grid{stroke:var(--line); stroke-width:1}
svg .laneline{stroke:var(--line); stroke-width:1; stroke-dasharray:2 3}
svg .band{fill:#F58025; opacity:.09}
svg .mk.high{fill:var(--high)}
svg .mk.medium{fill:var(--med)}
svg g.off{opacity:.22}
svg .sep{stroke:var(--line);stroke-width:1}
svg .nk.ok{fill:var(--ok)}
svg .nk.no{fill:var(--panel);stroke:var(--muted);stroke-width:1.2}
svg .pframe{fill:none;stroke:var(--line)}
svg .plabel{font-weight:700; fill:var(--head)}
svg .thr{stroke-dasharray:5 4;stroke-width:1.3}
svg .thr.high{stroke:var(--high)} svg .thr.med{stroke:var(--med)}
svg .pline{fill:none;stroke:var(--blue);stroke-width:1.8;stroke-linejoin:round}
svg .lline{fill:none;stroke:var(--navy);stroke-width:1.5;stroke-linejoin:round}
svg .con{fill:var(--ok)} svg .coff{fill:var(--high)}
svg .sechead{fill:var(--fill)}
svg .secrule{stroke:var(--line);stroke-width:1}
svg .sect{font-size:12.5px;font-weight:700;letter-spacing:.1em;fill:var(--blue)}
svg .secsub{font-size:11.5px;fill:var(--muted)}

.ctl-label{display:block; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin-bottom:6px}
.seg{display:inline-flex; border:1px solid var(--line); border-radius:8px; overflow:hidden; background:var(--panel)}
.seg button{all:unset; cursor:pointer; padding:6px 12px; font-size:13.5px; color:var(--head)}
.seg button[aria-pressed="true"]{background:var(--navy); color:#fff}
.filters{display:flex; flex-wrap:wrap; gap:6px}
.filters button{all:unset; cursor:pointer; display:inline-flex; align-items:center; gap:8px; padding:5px 10px 5px 8px; border:1px solid var(--line); border-radius:8px; background:var(--panel); font-size:13.5px; line-height:1.25; color:var(--head)}
.filters button[aria-pressed="false"]{opacity:.45; text-decoration:line-through}
.filters .sw{width:9px; height:22px; border-radius:2px}
.filters .sw.high{background:var(--high)} .filters .sw.medium{background:var(--med)}
.filters small{display:block; color:var(--muted); font-size:11.5px}
button:focus-visible,tr:focus-visible{outline:2px solid var(--accent); outline-offset:2px}

.tablewrap{overflow-x:auto}
table{width:100%; border-collapse:collapse}
thead th{text-align:left; font-weight:700; font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--head); padding:12px 14px; border-bottom:1.5px solid var(--navy)}
tbody td{padding:9px 14px; border-bottom:1px solid var(--line); vertical-align:top}
tr.day th{text-align:left; padding:14px 14px 8px; background:var(--fill); font-weight:700; font-size:15px; color:var(--head); border-bottom:1px solid var(--line)}
tr.run,tr.group,tr.ghead{cursor:pointer}
tr.run:hover,tr.group:hover,tr.ghead:hover{background:var(--hover)}
td.t{white-space:nowrap; width:1%}
td.t .exp{display:inline-block; width:14px; color:var(--muted); transition:transform .15s}
tr[aria-expanded="true"] .exp{transform:rotate(90deg)}
.count{display:inline-block; margin-left:8px; padding:0 7px; border-radius:6px; background:var(--band); color:var(--accent); font-size:12.5px; font-weight:600}
.chips{display:flex; flex-wrap:wrap; gap:5px}
.chip{display:inline-flex; gap:6px; align-items:baseline; padding:2px 8px; border-radius:6px; font-size:13px; white-space:nowrap}
.chip.high{background:var(--high-bg)} .chip.medium{background:var(--med-bg)}
.chip b{font-weight:700}
.chip.high b{color:var(--high)} .chip.medium b{color:var(--med)}
.chip.miss{background:none;border:1px dashed var(--high);padding:1px 7px;color:var(--muted)}
.chip.miss b{color:var(--high)}
.nb{display:inline-block;padding:1px 8px;border-radius:6px;font-size:12.5px;font-weight:700}
.nb.ok{background:var(--ok-bg);color:var(--ok)}
.nb.off{background:var(--band);color:var(--muted)}
.nb.err{background:var(--high-bg);color:var(--high)}
.st-SENT{color:var(--ok);font-weight:700}
.st-DISABLED{color:var(--muted)}
.st-ERROR{color:var(--high);font-weight:700}
.st-none{color:var(--muted);font-style:italic}

.recips{margin-bottom:12px}
.recips summary{cursor:pointer;padding:14px 18px;font-weight:700;color:var(--head);font-size:13px;letter-spacing:.1em;text-transform:uppercase}
.recips summary small{font-weight:400;color:var(--muted);margin-left:8px;letter-spacing:0;text-transform:none;font-size:13px}
.rquick{display:flex;flex-wrap:wrap;gap:6px;padding:0 18px 6px}
.rquick button,.jump,.copy,.split > .tabletools #toggleDays{all:unset;cursor:pointer;padding:4px 11px;border:1px solid #D3DCE5;border-radius:8px;font-size:13px;background:var(--fill);color:var(--head)}
.rquick button:hover,.jump:hover,.copy:hover,.split > .tabletools #toggleDays:hover{background:#DCE5EE}
.rquick button:focus-visible,.jump:focus-visible,.copy:focus-visible,.rc input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px 18px;padding:4px 18px 18px}
.rorg{grid-column:1/-1;font-weight:700;font-size:14px;color:var(--head);margin-top:10px;border-bottom:1.5px solid var(--light);padding-bottom:4px}
.rc{display:flex;gap:8px;align-items:flex-start;font-size:13.5px;cursor:pointer;word-break:break-all}
.rc input{margin-top:3px;accent-color:var(--accent)}
.rc small{display:block;color:var(--muted);font-size:11.5px;word-break:normal}
.rc.never small{color:var(--high)}
.mfilters{padding:4px 18px 18px}

.split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);row-gap:10px;column-gap:16px;align-items:start}
.split > .tabletools{grid-column:1;grid-row:1;display:flex;flex-wrap:wrap;align-items:flex-end;gap:12px 20px;margin:0}
.split > .tabletools #toggleDays{margin-left:auto;font-weight:700;padding:5px 12px}
.split > .leftcol{grid-column:1;grid-row:2}
.split > .detailpane{grid-column:2;grid-row:2}
.leftcol table{min-width:520px}
.detailpane{position:sticky;top:12px;max-height:calc(100vh - 24px);overflow:auto;padding:18px 20px}
@media (max-width:960px){.split{grid-template-columns:1fr}.split > .tabletools,.split > .leftcol,.split > .detailpane{grid-column:1;grid-row:auto}.detailpane{position:static;max-height:none}}
tr.sel td{background:var(--band)}
tr.sel td:first-child{box-shadow:inset 3px 0 0 var(--accent)}
td.mk{white-space:nowrap}
td.num,th.num{text-align:right;white-space:nowrap}
.warn{color:var(--med);font-weight:700}
.crit{color:var(--high);font-weight:700}
.nodata{color:var(--muted);font-style:italic;font-size:13px}
.to{color:var(--muted)}
.flag{margin-top:4px;font-size:12.5px;color:var(--high)}
.mkr{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:22px;padding:0 7px;border-radius:11px;font-size:12px;font-weight:700;margin-right:4px;box-sizing:border-box;line-height:1}
.mkr.red{background:var(--high);color:#fff}
.mkr.yellow{background:#E3A521;color:#2B1E00}
.mkr.green{background:var(--ok);color:#fff}
.mkr.grey{background:var(--band);color:var(--muted)}
.mkr.miss{border:1.5px dashed var(--high);color:var(--high)}
.mkr:hover{filter:brightness(1.08)}
.mkr:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.detailpane .empty h3,.dhead h3{margin:0;font-size:20px;font-weight:800;color:var(--head)}
.detailpane .empty p{color:var(--muted);max-width:52ch}
.legend{list-style:none;padding:0;margin:14px 0;display:grid;gap:8px;font-size:13.5px}
.legend li{display:flex;align-items:center;gap:8px}
.legend .mkr{cursor:default}
.jump{font-weight:700;padding:6px 12px}
.kicker{margin:0 0 2px;font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--blue);font-weight:700}
.dhead .sub{margin:2px 0 0;font-size:12.5px;color:var(--muted)}
.detailpane section{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}
.detailpane h4{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--blue);font-weight:700}
.stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.stat{background:var(--fill);border-radius:10px;padding:8px 10px}
.stat > span{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.stat b{font-size:17px;font-weight:800;color:var(--head)}
.src{margin:6px 0;font-size:12.5px;color:var(--muted)}
.scroll{overflow-x:auto;margin-top:8px;border:1px solid var(--line);border-radius:8px}
.scroll table{min-width:0;font-size:12.5px}
.scroll th,.scroll td{padding:5px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
.scroll th{font-size:10.5px;padding-top:7px}
.scroll tr.dim td{color:var(--muted)}
.scroll .org{display:block;font-size:11px;color:var(--muted)}
.misslist{list-style:none;padding:0;margin:0;display:grid;gap:6px}
.misslist code{color:var(--muted)}
.nbs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
tr.day{cursor:pointer}
tr.day th{user-select:none}
tr.day:hover th{background:#E2E9F0}
tr.day .exp{display:inline-block;width:14px;color:var(--blue);transition:transform .15s}
tr.day[aria-expanded="true"] .exp{transform:rotate(90deg)}
tr.day:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
.dsum{margin-left:10px;font-size:12.5px;font-weight:400;color:var(--muted)}
.dmk{margin-left:10px}
.dmk .mkr{cursor:inherit;height:20px;min-width:20px;font-size:11.5px}
@media (prefers-reduced-motion:reduce){tr.day .exp,td.t .exp{transition:none}}

.hypothesis{padding:18px 22px;border:1.5px solid var(--light);border-left:5px solid var(--blue)}
.hypothesis h3{margin:8px 0 0;font-size:18px;font-weight:800;color:var(--head)}
.hypothesis > p{margin:6px 0 0;max-width:90ch}
.hypothesis > p + p{margin-top:10px}
.hypothesis h4{margin:14px 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--blue)}
.hypothesis ul{margin:0;padding-left:1.2em;max-width:90ch}
.hypothesis li+li{margin-top:3px}
.steps{padding:18px 22px;border:1.5px solid var(--light);border-left:5px solid var(--ok)}
.steps .lede{margin:6px 0 12px;color:var(--muted);max-width:80ch}
.steps ol{margin:0;padding-left:1.4em}
.steps li+li{margin-top:16px}
.steps h3,.guide h3{margin:0;font-size:16px;font-weight:700;color:var(--head)}
.steps li p{margin:4px 0 0;max-width:80ch}
.guide{padding:18px 22px}
.guide > p{margin:8px 0 6px;color:var(--muted);max-width:90ch}
.guide ol{margin:12px 0 0;padding-left:1.4em}
.guide li+li{margin-top:22px}
.guide li p{margin:4px 0 8px;color:var(--muted);max-width:80ch}
.guide .note{font-size:13px}
.codewrap{position:relative}
.codewrap pre{margin:0;padding:14px 16px;background:var(--day);border:1px solid var(--line);border-radius:8px;overflow-x:auto;line-height:1.45}
.copy{position:absolute;top:8px;right:8px;font-size:12.5px;padding:3px 10px;background:var(--panel)}
.method{margin:22px 0 0;color:var(--muted);font-size:13px;max-width:110ch}
.foot{margin-top:36px;background:var(--navy);color:#fff;font-size:13px}
.foot .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:12px;padding-bottom:12px}
@media (max-width:640px){.wrap{padding:0 14px}.hdr .logo{height:36px}}
`;

module.exports = { build_timeline };
