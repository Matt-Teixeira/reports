// Turns the raw incident rows (data.js) into the facts the report states.
// Pure: no I/O, no formatting. Every number on the page traces to a field
// computed here.
//
// The spine is the 30-minute capture slot. Each slot carries what is in the
// database NOW (readings) next to what the alert engine saw AT THE TIME
// (the run that evaluated it). The gap between the two is the delivery
// story: a slot whose run logged "absent data" but which has readings today
// was delivered late; a slot with no readings today was never delivered.

const SLOT_MS = 30 * 60e3;
const HOUR = 3600e3;

const MAG_FIELDS = new Set(["he_level_value", "he_pressure_value"]);
const AVANTE = /avante/i;
const ORG_BY_DOMAIN = { "crothall.com": "Crothall", "intelashealth.com": "Intelas" };

// Plain-language names for the customer. Internal names (HHM, MMB,
// "Absent/Null Mag Data") mean nothing outside Avante.
const model_meta = (m) => {
  const th = m.threshold;
  const unit = m.threshold_units === "%" ? "%" : m.threshold_units ? ` ${m.threshold_units}` : "";
  const field = { "He Level": "Helium level", "He Pressure": "Helium pressure" }[m.field_name_alias] || m.field_name_alias;
  switch (m.operator) {
    case "equals":
      return m.field_name_alias === "Compressor"
        ? { kind: "compressor", label: "Compressor off", short: "Compressor off" }
        : { kind: "other", label: `${field} = ${th}`, short: field };
    case "greater_than":
      return { kind: m.field_name_alias === "He Pressure" ? "pressure" : "other", label: `${field} above ${th}${unit}`, short: `Pressure > ${th}`, value: Number(th), op: ">" };
    case "less_than":
      return { kind: m.field_name_alias === "He Level" ? "level" : m.field_name_alias === "He Pressure" ? "pressure" : "other", label: `${field} below ${th}${unit}`, short: m.field_name_alias === "He Level" ? `Level < ${th}%` : `Pressure < ${th}`, value: Number(th), op: "<" };
    case "delta_neg":
      return { kind: "level", label: `${field} dropped ${th}${unit}`, short: `Level −${th}%` };
    case "offline":
      // HHM: the connection that pulls log data from the MRI host. MMB:
      // the Magnet Monitoring Box Avante places on site for magnet data.
      return m.field_name_alias === "MMB Unreachable"
        ? { kind: "offline", label: "MMB (Magnet Monitoring Box) unreachable", short: "MMB offline" }
        : { kind: "offline", label: "HHM (host log data) unreachable", short: "HHM offline" };
    case "absent_null_data":
      return { kind: "missing", label: "Magnet readings missing", short: "Readings missing" };
    case "frozen_host":
      return { kind: "missing", label: "Host data frozen", short: "Host frozen" };
    default:
      return { kind: "other", label: m.field_name_alias, short: m.field_name_alias };
  }
};

const mode = (xs) => {
  const c = new Map();
  for (const x of xs) c.set(x, (c.get(x) || 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0];
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Least-squares slope, units per hour.
const slope_per_hour = (pts) => {
  const xs = pts.map((p) => p.t / HOUR);
  const ys = pts.map((p) => p.v);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  const num = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? num / den : 0;
};

// Consecutive slots satisfying pred, as [{start, end}] where end is the
// slot AFTER the last match (a half-open span).
const spans = (slots, pred) => {
  const out = [];
  let open = null;
  for (const s of slots) {
    if (pred(s)) {
      if (!open) open = { start: s.t, n: 0 };
      open.n++;
      open.end = s.t + SLOT_MS;
    } else if (open) {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
};

const analyze_incident = (data, { from, to }) => {
  const { identity, models, detections, notifications, recipients, mag, edu } = data;
  const t_from = from.getTime();
  const t_to = to.getTime();

  // --- models ---------------------------------------------------------
  const model_by_id = new Map(models.map((m) => [m.id, { ...m, ...model_meta(m) }]));

  // --- slot spine -----------------------------------------------------
  const offset = mode(mag.map((r) => r.capture_datetime.getTime() % SLOT_MS));
  const first = Math.ceil((t_from - offset) / SLOT_MS) * SLOT_MS + offset;
  const slots = [];
  const slot_at = new Map();
  for (let t = first; t < t_to; t += SLOT_MS) {
    const s = { t, mag: null, comp: null, run: null, status: null };
    slots.push(s);
    slot_at.set(t, s);
  }
  for (const r of mag) {
    const s = slot_at.get(r.capture_datetime.getTime());
    if (s && r.he_level_value !== null && r.he_pressure_value !== null)
      s.mag = { level: Number(r.he_level_value), pressure: Number(r.he_pressure_value) };
  }
  for (const r of edu) {
    const s = slot_at.get(r.capture_datetime.getTime());
    if (s && r.comp_vib_status !== null) s.comp = r.comp_vib_status === true || r.comp_vib_status === "true";
  }

  // --- alert runs -----------------------------------------------------
  // A run's detections share an inserted_at to within seconds; runs are
  // 30 minutes apart, so a 5-minute gap separates them unambiguously.
  const runs = [];
  for (const d of [...detections].sort((a, b) => a.inserted_at - b.inserted_at)) {
    const model = model_by_id.get(d.alert_model_id);
    if (!model) continue;
    const at = d.inserted_at.getTime();
    let run = runs[runs.length - 1];
    if (!run || at - run.last > 5 * 60e3) runs.push((run = { at, last: at, dets: [] }));
    run.last = at;
    run.dets.push({ ...d, model });
  }
  for (const run of runs) {
    const evaluated = run.dets.filter((d) => d.model.operator !== "offline").map((d) => d.capture_datetime.getTime());
    run.slot_t = evaluated.length
      ? Math.max(...evaluated)
      : Math.floor((run.at - offset) / SLOT_MS) * SLOT_MS + offset;
    const s = slot_at.get(run.slot_t);
    if (s) s.run = run;
  }

  // Delivery status: compare what the run saw with what exists now.
  for (const s of slots) {
    if (!s.mag) s.status = "never";
    else if (!s.run) s.status = "unknown";
    else if (s.run.dets.some((d) => d.model.operator === "absent_null_data")) s.status = "late";
    else if (s.run.dets.some((d) => MAG_FIELDS.has(d.field_name))) s.status = "ontime";
    else s.status = "unknown";
  }

  // --- the compressor stop ---------------------------------------------
  let prev = null;
  let stop = null;
  for (const s of slots) {
    if (s.comp === null) continue;
    if (s.comp === false && prev === true) {
      stop = s;
      break;
    }
    prev = s.comp;
  }
  if (!stop) throw new Error("no compressor stop in the window: this report covers compressor-stop incidents only");
  const stop_t = stop.t;
  const after = slots.filter((s) => s.t >= stop_t);
  const before = slots.filter((s) => s.t < stop_t);
  const comp_known = slots.filter((s) => s.comp !== null);
  const last_comp = comp_known[comp_known.length - 1];
  const restarts = spans(after, (s) => s.comp === true);
  const comp_off_spans = spans(after, (s) => s.comp !== true);

  // --- delivery outage -------------------------------------------------
  const last_ontime = [...slots].reverse().find((s) => s.t <= stop_t && s.status === "ontime");
  const outage_start = last_ontime ? last_ontime.t + SLOT_MS : stop_t;
  const resumed = slots.find((s) => s.t >= outage_start && s.status === "ontime");
  const outage = {
    start: outage_start,
    // The first moment the alert engine saw a reading again is the run
    // that evaluated the first on-time slot, not the slot itself.
    seen_again_at: resumed ? resumed.run.at : null,
    resumed_slot: resumed ? resumed.t : null
  };
  const in_outage = slots.filter((s) => s.t >= outage.start && (!resumed || s.t < resumed.t));
  outage.never = spans(in_outage, (s) => s.status === "never");
  outage.late_slots = in_outage.filter((s) => s.status === "late" || s.status === "unknown").length;
  outage.never_slots = in_outage.filter((s) => s.status === "never").length;
  // Readings captured inside the outage that are in the database today
  // arrived after the fact; the earliest moment they could have arrived is
  // when the engine saw data again.
  outage.delivered_late = spans(in_outage, (s) => s.mag !== null);

  const pre_runs = before.filter((s) => s.run && s.mag);
  const pre_late = pre_runs.filter((s) => s.status === "late").length;
  const pre_late_longest = Math.max(0, ...spans(before, (s) => s.status === "late" || s.status === "unknown").map((x) => x.n));

  // --- readings ---------------------------------------------------------
  const pre_mag = before.filter((s) => s.mag);
  const post_mag = after.filter((s) => s.mag);
  const last_mag = [...slots].reverse().find((s) => s.mag);
  const level_baseline = median(pre_mag.map((s) => s.mag.level));
  const peak_level = post_mag.reduce((a, s) => (s.mag.level > a.mag.level ? s : a), post_mag[0]);
  const loss_pts = post_mag.filter((s) => s.t >= peak_level.t).map((s) => ({ t: s.t, v: s.mag.level }));
  const loss_rate = loss_pts.length >= 6 ? slope_per_hour(loss_pts) : null;
  const pressure_peak = post_mag.reduce((a, s) => (s.mag.pressure > a.mag.pressure ? s : a), post_mag[0]);

  // --- per-model timing --------------------------------------------------
  const batches_raw = new Map();
  const system_ids = new Set(models.map((m) => m.id));
  for (const n of notifications) {
    const codes = (n.detected_alert_models || []).filter((id) => system_ids.has(id));
    if (!codes.length) continue;
    const b = batches_raw.get(n.run_id) || { run_id: n.run_id, at: Infinity, rows: [], model_ids: new Set() };
    b.at = Math.min(b.at, n.last_update.getTime());
    b.rows.push({ email: n.user_id.toLowerCase(), email_status: n.email_status, sms_status: n.sms_status, model_ids: codes });
    codes.forEach((c) => b.model_ids.add(c));
    batches_raw.set(n.run_id, b);
  }
  const batches = [...batches_raw.values()].sort((a, b) => a.at - b.at);
  const reached = (r) => r.email_status === "SENT" || r.sms_status === "SENT";

  const timing = [...model_by_id.values()].map((m) => {
    const crossing = (() => {
      if (m.value === undefined || !["pressure", "level"].includes(m.kind)) return null;
      const key = m.kind;
      const hit = (s) => s.mag && (m.op === ">" ? s.mag[key] > m.value : s.mag[key] < m.value);
      const active_before = pre_mag.length && hit(pre_mag[pre_mag.length - 1]);
      if (active_before) return { already: true };
      const s = after.find(hit);
      return s ? { t: s.t } : null;
    })();
    const condition_t =
      m.kind === "compressor" ? stop_t : m.kind === "offline" || m.kind === "missing" ? outage.start : crossing && crossing.t ? crossing.t : null;
    const first_det = runs.find((r) => r.at >= stop_t && r.dets.some((d) => d.model.id === m.id));
    const first_batch = batches.find((b) => b.at >= stop_t && b.model_ids.has(m.id));
    return {
      model: m,
      already_active: Boolean(crossing && crossing.already),
      condition_t,
      detected_at: first_det ? first_det.at : null,
      notified_at: first_batch ? first_batch.at : null
    };
  });
  const by_kind = (k) => timing.filter((x) => x.model.kind === k);
  const comp_timing = by_kind("compressor")[0];

  // --- recipients ----------------------------------------------------------
  const user_by_email = new Map(recipients.map((u) => [u.email_address.toLowerCase(), u]));
  const is_customer_contact = (email) => {
    const u = user_by_email.get(email);
    return (
      !AVANTE.test(email) &&
      Boolean(u) &&
      (u.customer_ids || []).includes(identity.customer_id) &&
      // Multi-customer accounts are Avante field staff on personal
      // addresses, not this customer's people.
      (u.customer_ids || []).length === 1
    );
  };
  const contacts = new Map();
  for (const b of batches) {
    for (const r of b.rows) {
      if (!is_customer_contact(r.email)) continue;
      const u = user_by_email.get(r.email);
      const c = contacts.get(r.email) || {
        email: r.email,
        name: [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || r.email,
        org: ORG_BY_DOMAIN[r.email.split("@")[1]] || r.email.split("@")[1],
        status: u.status,
        rows: []
      };
      c.rows.push({ ...r, at: b.at, batch: b });
      contacts.set(r.email, c);
    }
  }
  const offline_ids = new Set(by_kind("offline").map((x) => x.model.id));
  const contact_list = [...contacts.values()].map((c) => {
    const during = c.rows.filter((r) => r.at >= stop_t);
    const last = c.rows[c.rows.length - 1];
    const first_reached = during.find(reached);
    return {
      ...c,
      email_on: c.rows.some((r) => r.email_status === "SENT"),
      sms_on: c.rows.some((r) => r.sms_status === "SENT"),
      errors: c.rows.filter((r) => r.email_status === "ERROR" || r.sms_status === "ERROR").length,
      last_email: last.email_status,
      last_sms: last.sms_status,
      during_listed: during.length,
      during_reached: during.filter(reached).length,
      first_reached_at: first_reached ? first_reached.at : null,
      offline_reached: during.some((r) => reached(r) && r.model_ids.some((id) => offline_ids.has(id)))
    };
  });

  const batch_list = batches.map((b) => {
    const cust = b.rows.filter((r) => is_customer_contact(r.email));
    return {
      at: b.at,
      models: [...b.model_ids].map((id) => model_by_id.get(id)).filter(Boolean),
      customer_listed: cust.length,
      customer_reached: cust.filter(reached).length,
      // Per-contact model lists differ within a run (different recipients
      // subscribe to different models), so which models reached ANY
      // customer contact is worth stating separately.
      customer_models: [...new Set(cust.filter(reached).flatMap((r) => r.model_ids))].map((id) => model_by_id.get(id)).filter(Boolean),
      customer_rows: cust.map((r) => ({
        name: contacts.get(r.email).name,
        org: contacts.get(r.email).org,
        email_status: r.email_status,
        sms_status: r.sms_status,
        reached: reached(r),
        models: r.model_ids.map((id) => model_by_id.get(id)).filter(Boolean)
      })),
      other_rows: b.rows.length - cust.length
    };
  });

  // Each notification belongs to the slot its run evaluated: the latest
  // alert run at or before the send.
  for (const b of batch_list) {
    const run = [...runs].reverse().find((r) => r.at <= b.at);
    const s = run && slot_at.get(run.slot_t);
    if (s) (s.batches = s.batches || []).push(b);
  }

  // What each slot's readings should have triggered, by applying every
  // model's own rule to them — and which of those its run did not log.
  // Throttling affects notifications, not detections, so it plays no part.
  const would_trigger = (m, s) => {
    if (m.kind === "compressor") return s.comp === false;
    if (!s.mag || m.value === undefined) return false;
    const v = m.kind === "pressure" ? s.mag.pressure : m.kind === "level" ? s.mag.level : null;
    if (v === null) return false;
    return m.op === ">" ? v > m.value : m.op === "<" ? v < m.value : false;
  };
  for (const s of slots) {
    s.expected = [...model_by_id.values()].filter((m) => m.enabled !== false && would_trigger(m, s));
    const logged = new Set(s.run ? s.run.dets.map((d) => d.model.id) : []);
    s.missed = s.run ? s.expected.filter((m) => !logged.has(m.id)) : [];
  }

  return {
    identity,
    window: { from: t_from, to: t_to, first_slot: first, last_slot: slots[slots.length - 1].t },
    slots,
    runs,
    counts: {
      slots: slots.length,
      mag: slots.filter((s) => s.mag).length,
      comp: slots.filter((s) => s.comp !== null).length,
      runs: runs.length,
      detections: runs.reduce((n, r) => n + r.dets.length, 0),
      notification_rows: batches.reduce((n, b) => n + b.rows.length, 0)
    },
    stop: { t: stop_t, restarts, off_spans: comp_off_spans, still_off: last_comp.comp === false, last_comp_t: last_comp.t },
    outage,
    pre_event: { runs_with_data: pre_runs.length, late: pre_late, longest_late_slots: pre_late_longest },
    level: {
      baseline: level_baseline,
      peak: peak_level.mag.level,
      peak_t: peak_level.t,
      last: last_mag.mag.level,
      last_t: last_mag.t,
      loss_per_hour: loss_rate,
      loss_since_peak: peak_level.mag.level - last_mag.mag.level,
      loss_hours: (last_mag.t - peak_level.t) / HOUR
    },
    pressure: {
      baseline_min: Math.min(...pre_mag.map((s) => s.mag.pressure)),
      baseline_max: Math.max(...pre_mag.map((s) => s.mag.pressure)),
      peak: pressure_peak.mag.pressure,
      peak_t: pressure_peak.t,
      last: last_mag.mag.pressure,
      last_t: last_mag.t
    },
    timing,
    comp_timing,
    alert_delay_hours: comp_timing && comp_timing.notified_at ? (comp_timing.notified_at - stop_t) / HOUR : null,
    batches: batch_list,
    contacts: contact_list,
    models: [...model_by_id.values()]
  };
};

module.exports = { analyze_incident, SLOT_MS };
