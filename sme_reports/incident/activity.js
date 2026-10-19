// The per-system ACTIVITY page's facts: what the database holds for one
// system over one window — readings, alert detections, notifications —
// placed on a 30-minute capture-slot spine. Pure: no I/O, no formatting,
// no clock.
//
// Deliberately NOT incident/analyze.js. That module tells a story (the
// compressor stop, the outage, late vs never-delivered readings, what
// should have triggered). This one states only what is recorded: a slot
// has a reading or it does not, a run logged these detections, these
// notifications went to these recipients. A rule that would need to infer
// why says nothing. Every vendor, any condition, no event required.
//
// Output is the browser payload incident/timeline.client.js consumes (the
// same shape the Anomaly Report embeds), so both pages share one client.

const SLOT_MS = 30 * 60e3;
const RUN_GAP_MS = 5 * 60e3;

// Model names as the alert emails show them ("He Pressure > 5.2 PSI").
const model_name = (m) => {
  const u = m.threshold_units === "%" ? "%" : m.threshold_units ? ` ${m.threshold_units}` : "";
  if (m.operator === "greater_than") return `${m.field_name_alias} > ${m.threshold}${u}`;
  if (m.operator === "less_than") return `${m.field_name_alias} < ${m.threshold}${u}`;
  if (m.operator === "delta_neg") return `${m.field_name_alias} drop of ${m.threshold}${u}`;
  return m.field_name_alias;
};

// Which chart a model's threshold belongs on. "pressure" is the PRIMARY
// metric panel — He pressure for most vendors, shield temperature for
// Siemens non-TIM, whose primary slot is the shield sensor.
const model_kind = (m, primary_alias) => {
  const a = m.field_name_alias;
  if (m.operator === "equals" && a === "Compressor") return "compressor";
  if (m.operator === "offline") return "offline";
  if (m.operator === "absent_null_data" || m.operator === "frozen_host") return "missing";
  if (a === primary_alias) return "pressure";
  if (a === "He Level") return "level";
  return "other";
};
const KIND_RANK = { compressor: 0, pressure: 1, level: 2, offline: 3, missing: 4, other: 5 };
const FIELD = { compressor: "comp_vib_status", pressure: "pressure", level: "helium" };

const mode_of = (xs) => {
  if (!xs.length) return null;
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
};

const fixed = (v, d) => (v === null || v === undefined ? null : Number(v).toFixed(d));

// data: incident/activity_data.js rows, ALREADY SCRUBBED (incident/scrub.js).
// readings: run_one's result.activity, or null for a system the batch could
// not analyze (its page carries alerts only and says so).
// window: { from, to } epoch ms, half-open.
const analyze_activity = (data, readings, { from, to }) => {
  const { identity, models: model_rows, detections, notifications, recipients } = data;
  const r = readings || null;
  const primary_alias = r && r.vendor_key === "SIEMENS_NON_TIM" ? "Shield Temp" : "He Pressure";

  // --- slot spine ---------------------------------------------------------
  // Aligned to where the readings actually land (captures are on a fixed
  // half-hour phase per system); detections' capture times when there are
  // no readings; the clock half-hour otherwise.
  const reading_ts = r ? [...r.pressure, ...r.helium].map((p) => p.t) : [];
  const phase_src = reading_ts.length
    ? reading_ts
    : detections.filter((d) => d.operator !== "offline").map((d) => d.capture_datetime.getTime());
  const offset = mode_of(phase_src.map((t) => ((t % SLOT_MS) + SLOT_MS) % SLOT_MS)) || 0;
  const snap = (t) => Math.floor((t - offset) / SLOT_MS) * SLOT_MS + offset;
  const first = snap(from) < from ? snap(from) + SLOT_MS : snap(from);
  const slots = [];
  const slot_at = new Map();
  for (let t = first; t < to; t += SLOT_MS) {
    const s = { t, comp: null, mag: null };
    slots.push(s);
    slot_at.set(t, s);
  }
  const in_slot = (t) => slot_at.get(snap(t));

  // --- readings: the screened points the batch analysis judged ------------
  // Last reading in a slot wins; a channel with no reading stays null.
  const dec = (r && r.decimals) || { pressure: 3, helium: 2 };
  if (r) {
    for (const p of r.pressure) {
      const s = in_slot(p.t);
      if (!s) continue;
      s.mag = s.mag || { pr: null, lvl: null, prTxt: null, lvlTxt: null };
      s.mag.pr = p.v;
      s.mag.prTxt = fixed(p.v, dec.pressure);
    }
    for (const p of r.helium) {
      const s = in_slot(p.t);
      if (!s) continue;
      s.mag = s.mag || { pr: null, lvl: null, prTxt: null, lvlTxt: null };
      s.mag.lvl = p.v;
      s.mag.lvlTxt = fixed(p.v, dec.helium);
    }
    for (const c of r.compressor) {
      const s = in_slot(c.t);
      if (s) s.comp = c.on;
    }
  }

  // --- alert runs -----------------------------------------------------------
  // A run's detections share an inserted_at to within seconds; runs are 30
  // minutes apart, so a 5-minute gap separates them. A run belongs to the
  // slot it evaluated: its latest non-offline capture time (offline models
  // carry the monitor's last check-in instead), else the slot it ran in.
  const all_models = model_rows.map((m) => ({ ...m, kind: model_kind(m, primary_alias) }));
  const model_by_id = new Map(all_models.map((m) => [String(m.id), m]));
  const runs = [];
  for (const d of [...detections].sort((a, b) => a.inserted_at - b.inserted_at)) {
    if (!model_by_id.has(String(d.alert_model_id))) continue;
    const at = d.inserted_at.getTime();
    let run = runs[runs.length - 1];
    if (!run || at - run.last > RUN_GAP_MS) runs.push((run = { at, last: at, dets: [] }));
    run.last = at;
    run.dets.push(d);
  }
  for (const run of runs) {
    const evaluated = run.dets
      .filter((d) => model_by_id.get(String(d.alert_model_id)).operator !== "offline")
      .map((d) => d.capture_datetime.getTime());
    run.slot_t = snap(evaluated.length ? Math.max(...evaluated) : run.at);
  }

  // --- models: the ones that did something in the window, plus the offline
  // monitors (a lane that stayed empty is information too) ---
  const used = new Set();
  runs.forEach((x) => x.dets.forEach((d) => used.add(String(d.alert_model_id))));
  notifications.forEach((n) => (n.detected_alert_models || []).forEach((id) => used.add(String(id))));
  const models = all_models
    .filter((m) => used.has(String(m.id)) || m.operator === "offline")
    .sort(
      (p, q) =>
        KIND_RANK[p.kind] - KIND_RANK[q.kind] ||
        (p.operator === "delta_neg") - (q.operator === "delta_neg") ||
        Number(q.threshold) - Number(p.threshold) ||
        String(p.field_name_alias).localeCompare(String(q.field_name_alias)) ||
        String(p.id).localeCompare(String(q.id))
    )
    .map((m, i) => {
      const op = m.operator === "greater_than" ? ">" : m.operator === "less_than" ? "<" : null;
      const value = op && m.threshold !== null && !Number.isNaN(Number(m.threshold)) ? Number(m.threshold) : null;
      return {
        code: `m${i}`,
        id: String(m.id),
        name: model_name(m),
        sev: m.severity === "high" ? "high" : "medium",
        freq: m.notify_frequency,
        operator: m.operator,
        kind: m.kind,
        op,
        value,
        field: FIELD[m.kind] || null
      };
    });
  const code_of = new Map(models.map((m) => [m.id, m.code]));

  const first_slot = slots.length ? slots[0].t : from;
  const last_slot = slots.length ? slots[slots.length - 1].t : from;
  const page_runs = runs
    .map((x) => ({
      at: x.at,
      slot: x.slot_t,
      dets: x.dets
        .filter((d) => code_of.has(String(d.alert_model_id)))
        .map((d) => ({
          code: code_of.get(String(d.alert_model_id)),
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
    .filter((x) => x.dets.length && x.slot >= first_slot && x.slot <= last_slot);

  // --- recipients and notification batches ---------------------------------
  // Grouped by whether the user's access names this system's customer. No
  // "Avante" group exists: the scrub already removed every Avante user.
  const customer_org = identity.customer_name;
  const OTHER = "Other recipients";
  const user_by_email = new Map(recipients.map((u) => [String(u.email_address).toLowerCase(), u]));
  const users = {};
  const orgs = {};
  for (const n of notifications) {
    const key = String(n.user_id).toLowerCase();
    if (users[key]) continue;
    users[key] = n.user_id;
    const u = user_by_email.get(key);
    orgs[key] = u && (u.customer_ids || []).includes(identity.customer_id) ? customer_org : OTHER;
  }
  const by_run = new Map();
  for (const n of notifications) {
    const key = String(n.user_id).toLowerCase();
    const codes = (n.detected_alert_models || []).map((x) => code_of.get(String(x))).filter(Boolean);
    if (!codes.length) continue;
    const t = n.last_update.getTime();
    const b = by_run.get(n.run_id) || { start: t, end: t, rows: [] };
    b.start = Math.min(b.start, t);
    b.end = Math.max(b.end, t);
    b.rows.push({ u: key, email: n.email_status, sms: n.sms_status, codes });
    by_run.set(n.run_id, b);
  }
  const notes = [...by_run.values()].sort((p, q) => p.start - q.start);

  // --- chart scales ---------------------------------------------------------
  // Extents of the readings and the threshold lines that sit near them. A
  // primary metric that lives far from zero (Siemens absolute PSIA, shield
  // kelvin) gets a floating floor so its movement is visible.
  const pr = slots.map((s) => s.mag && s.mag.pr).filter((v) => v !== null && v !== undefined);
  const lv = slots.map((s) => s.mag && s.mag.lvl).filter((v) => v !== null && v !== undefined);
  const p_lines = models.filter((m) => m.kind === "pressure" && m.value !== null).map((m) => m.value);
  const l_lines = models.filter((m) => m.kind === "level" && m.op === "<" && m.value !== null).map((m) => m.value);
  const scales = (() => {
    const s = { p_lo: 0, p_top: 1, l_lo: 0, l_hi: 100 };
    if (pr.length) {
      const near = p_lines.filter((v) => v <= Math.max(...pr) * 1.5);
      const hi = Math.max(...pr, ...near);
      const lo = Math.min(...pr, ...near);
      const span = Math.max(hi - lo, Math.abs(hi) * 0.02, 1e-6);
      if (lo > 0.4 * hi) {
        s.p_lo = +(lo - span * 0.1).toPrecision(4);
        s.p_top = +(hi + span * 0.1).toPrecision(4);
      } else s.p_top = Math.ceil(hi * 1.05 * 2) / 2 || 1;
    }
    if (lv.length) {
      const near = l_lines.filter((v) => v <= Math.max(...lv) + 2 && v >= Math.min(...lv) - 2);
      s.l_lo = Math.floor(Math.min(...lv, ...near) - 0.5);
      s.l_hi = Math.ceil(Math.max(...lv, ...near) + 0.8);
    }
    return s;
  })();

  const units = (r && r.units) || { pressure: "", helium: "%" };
  return {
    slot_ms: SLOT_MS,
    window: { from, to },
    analyzed: !!r,
    sources: {
      mag: (r && r.sources.mag) || null,
      edu: (r && r.sources.edu) || null,
      compressor: (r && r.compressor_source) || null
    },
    labels: {
      primary: (r && r.primary_name) || "He pressure",
      p_units: units.pressure || "",
      p_dec: dec.pressure,
      level: "He level",
      l_units: units.helium || "%",
      l_dec: dec.helium
    },
    models,
    runs: page_runs,
    slots,
    notes,
    users,
    orgs,
    org_order: [customer_org, OTHER],
    customer_org,
    scales,
    counts: {
      detections: page_runs.reduce((n, x) => n + x.dets.length, 0),
      notifications: notes.reduce((n, b) => n + b.rows.length, 0),
      recipients: Object.keys(users).length
    }
  };
};

module.exports = { analyze_activity, SLOT_MS };
