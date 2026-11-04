const fmt = require("./fmt");
const { STALE_MS } = require("../compute/staleness");
const { is_inferred } = require("../compute/provenance");

// Rules-based narrative: one template-literal builder per event archetype,
// producing the .story block and the three .rx footnote cards. Free-text
// overrides from the request (narrative_overrides.story / rx_cards) replace
// the generated output wholesale in render/model.js.

const p_fmt = (facts, v) => fmt.num(v, facts.vendor.pressure.decimals);
const units = (facts) => facts.units.pressure;
const thr = (facts) => facts.thr.high_gt;
// Display name of the primary escalation metric ("He pressure", "Shield temp")
const p_name = (facts) => facts.vendor.primary.name;
const he_sfx = (facts) =>
  facts.units.helium === "%" ? "%" : ` ${facts.units.helium}`;
// How the compressor state is known: measured on the EDU, or concluded from
// the coldhead (RULES.md §6). Inferred state words carry the ᶜ mark — the
// same convention as the fleet document, defined in the DATA NOTES card.
const comp_via = (facts) =>
  facts.compressor_source === "edu_comp_vib"
    ? " (per EDU vibration sensor)"
    : is_inferred(facts.compressor_source)
      ? " (inferred from coldhead temperature)"
      : "";
const comp_c = (facts) => (is_inferred(facts.compressor_source) ? "ᶜ" : "");

// The story is a lead line — "Timeline (UTC)" and what the period amounts
// to — then one bullet per moment, timestamp → note, in time order. The
// timestamp moves out of the sentence into its own column, so a reader
// scans the left edge for WHEN and reads across for WHAT; sorting by time
// means a peak that came after the recovery is listed after it, where the
// prose used to narrate it before.
//
// Each builder below returns an entry { t, label, html } or null; label
// defaults to the timestamp.
const entry = (t, html, label = fmt.ts(t)) => (html ? { t, label, html } : null);

// Single-reading dropouts with no thermal response are reported as probable
// sensor flickers, not treated as true compressor stops. One entry at the
// first; the rest ride along in its note.
const flicker_entry = (facts) => {
  const fl = facts.compressor_flickers;
  if (!fl) return null;
  const rest = fl.times.slice(1, 3).map(fmt.ts).join(", ");
  const more = fl.times.length > 3 ? `, +${fl.times.length - 3} more` : "";
  const also = fl.count > 1 ? ` (${fl.count} times: also ${rest}${more})` : "";
  return entry(
    fl.times[0],
    `The compressor signal dropped for a single reading${also} with no ${p_name(facts).toLowerCase()} response — <b>likely sensor flicker${fl.count === 1 ? "" : "s"}${comp_c(facts)}, not true stops</b>.`
  );
};

// When clustering yields multiple events, the timeline narrates the primary
// one; the rest get a single summary sentence in the lead so total downtime
// stays honest. The primary is whichever event is ongoing, else the longest
// — which is not necessarily the worst, so this deliberately does not call
// it the most significant.
const other_events_sentence = (facts) => {
  const evs = facts.compressor_events || [];
  if (evs.length <= 1) return "";
  const others = evs.filter((e) => e !== facts.compressor_event);
  const total = others.reduce((h, e) => h + (e.off_hours || 0), 0);
  // The day list is bounded (the one-page budget is finite); the count and
  // total hours above stay exact however many events the period produced.
  const listed = others.slice(0, 4).map((e) => fmt.day(e.start)).join(", ");
  const days =
    others.length > 4 ? `${listed}, +${others.length - 4} more` : listed;
  return ` <b>${others.length} other compressor stop event${others.length === 1 ? "" : "s"}${comp_c(facts)}</b> occurred this period (${days}; ${fmt.hours(total)} off in total) — the timeline below covers the primary event.`;
};

const baseline_entry = (facts) => {
  const p = facts.pressure;
  const he = facts.helium;
  const ev = facts.compressor_event;
  // Earlier event windows are excluded from the baseline stats; say so.
  const qualified = (facts.compressor_events || []).some(
    (e) => e !== ev && e.start < ev.start
  );
  const parts = [];
  if (p && p.baseline)
    parts.push(
      `${p_name(facts).toLowerCase()} held ${p_fmt(facts, p.baseline.min.v)}–${p_fmt(facts, p.baseline.max.v)} ${units(facts)}`
    );
  if (he && he.baseline)
    parts.push(
      `helium ${fmt.num(he.baseline.min.v, facts.vendor.helium.decimals)}–${fmt.num(he.baseline.max.v, facts.vendor.helium.decimals)}${he_sfx(facts)}`
    );
  // A claim, so it is judged, never assumed: only when every pre-event
  // coldhead reading sits under the vendor's warm line. `!= null` also
  // rejects a stub that never produced the field.
  if (
    facts.coldhead &&
    facts.vendor.coldhead &&
    facts.coldhead_baseline_max != null &&
    facts.coldhead_baseline_max < facts.vendor.coldhead.warm_k
  )
    parts.push(`coldhead at base temperature`);
  if (!parts.length) return null;
  return entry(
    facts.window_start,
    `<b>Baseline${qualified ? " (outside other event spans)" : ""}:</b> ${parts.join(", ")}.`,
    `${fmt.day(facts.window_start)} – ${fmt.day(ev ? ev.start : facts.window_end)}`
  );
};

const peak_entry = (facts) => {
  const p = facts.pressure;
  if (!p || thr(facts) === null) return null;
  const over = p.peak.v - thr(facts);
  const vs =
    over >= 0
      ? `${p_fmt(facts, over)} ${units(facts)} over the ${thr(facts)} ${units(facts)} line`
      : `never reached the ${thr(facts)} ${units(facts)} threshold, ${p_fmt(facts, -over)} ${units(facts)} below the line`;
  const rate =
    p.rate_per_hr !== null
      ? ` (${fmt.signed(p.rate_per_hr, facts.vendor.pressure.decimals)} ${units(facts)}/h avg on the ramp)`
      : "";
  // No clean pre-event reading survived exclusion — report the peak on its
  // own rather than a rise from a value the magnet never rested at.
  const from =
    p.baseline_value === null
      ? `${p_name(facts)} reached a`
      : `${p_name(facts)} rose from ${p_fmt(facts, p.baseline_value)} to a`;
  return entry(p.peak.t, `${from} <b>peak of ${p_fmt(facts, p.peak.v)} ${units(facts)}</b> — ${vs}${rate}.`);
};

const helium_sentence = (facts) => {
  const he = facts.helium;
  if (!he) return "";
  const d = he.delta_vs_baseline;
  const quench = facts.quenched
    ? " <b>A quench state was recorded this period.</b>"
    : " No quench.";
  const move = d === null ? "now reads" : d >= 0 ? "rose to" : "fell to";
  const vs = d === null ? "" : ` (${fmt.signed(d, 2)} vs baseline)`;
  return `Helium ${move} <b>${fmt.num(he.last.v, facts.vendor.helium.decimals)}${he_sfx(facts)}</b>${vs}.${quench}`;
};

const now_sentence = (facts) => {
  const p = facts.pressure;
  if (!p || thr(facts) === null) return "";
  if (facts.thr.high_lt !== null) {
    const band = `${facts.thr.high_lt}–${facts.thr.high_gt} ${units(facts)}`;
    const state =
      p.last.v >= facts.thr.high_gt
        ? `above the ${band} band`
        : p.last.v <= facts.thr.high_lt
          ? `below the ${band} band`
          : `within the ${band} band`;
    return `${p_name(facts)} now reads ${p_fmt(facts, p.last.v)} ${units(facts)} — ${state}.`;
  }
  const over = p.last.v - thr(facts);
  const vs =
    over >= 0
      ? `still ${p_fmt(facts, over)} ${units(facts)} over the line`
      : `${Math.round((p.last.v / thr(facts)) * 100)}% of the line`;
  return `${p_name(facts)} now reads ${p_fmt(facts, p.last.v)} ${units(facts)} — ${vs}.`;
};

// The latest readings close the timeline, each stamped with its own
// channel's last capture: one bullet when the primary metric and helium
// were last read together (the usual case — one row carries both), two
// when they were not, so a helium value never wears a pressure reading's
// time.
const now_entries = (facts) => {
  const p = now_sentence(facts);
  const he = helium_sentence(facts);
  const pt = p ? facts.pressure.last.t : null;
  const ht = he ? facts.helium.last.t : null;
  if (p && he && pt === ht) return [entry(pt, `${p} ${he}`)];
  return [p ? entry(pt, p) : null, he ? entry(ht, he) : null];
};

const alarm_entry = (facts) => {
  const ta = facts.temp_alarm;
  if (!ta) return null;
  const retrigger =
    ta.runs > 1
      ? ` — not continuous, it re-triggered ${ta.runs - 1} ${ta.runs - 1 === 1 ? "time" : "times"}`
      : "";
  // Alarm-state values are usually a 0/1 flag in practice; only call out the
  // peak when it carries real duration information.
  const peak_min =
    ta.max_minutes !== null && ta.max_minutes > 1
      ? `, peaking at ${fmt.num(ta.max_minutes, 0)} alarm-minutes`
      : "";
  const room =
    facts.edu && facts.edu.alarm_room_temp
      ? ` Room temperature held ${fmt.num(facts.edu.alarm_room_temp.min.v, 1)}–${fmt.num(facts.edu.alarm_room_temp.max.v, 1)} °F while the alarm was active.`
      : "";
  return entry(
    ta.start,
    `A compressor temperature alarm was triggered, active through ${fmt.ts(ta.end)} (${ta.count} readings${peak_min}${retrigger}; amber strip on the pressure chart).${room}`
  );
};

const readings_off = (ev) => `${ev.off_count} reading${ev.off_count === 1 ? "" : "s"} off`;

// The first compressor reading, on the left-censored stories: the stop was
// already underway when coverage began.
const first_reading_entry = (facts, html) =>
  entry(facts.compressor_first_stateful_t, html);

const STORIES = {
  compressor_stop_recovered: (f) => {
    const ev = f.compressor_event;
    const cycles =
      ev.cycles > 1
        ? ` and then cycled on/off${comp_c(f)} ${ev.cycles} times through ${fmt.ts(ev.end)} (${readings_off(ev)})`
        : ` and stayed off ${fmt.hours(ev.off_hours)} (${readings_off(ev)})`;
    // "has held since" is only true when no other event postdates this one.
    const later = (f.compressor_events || []).some(
      (e) => e !== ev && e.start > ev.end
    );
    return {
      lead: `The compressor stopped${comp_c(f)} and recovered.${other_events_sentence(f)}`,
      entries: [
        baseline_entry(f),
        entry(ev.start, `<b>The compressor stopped${comp_c(f)}</b>${comp_via(f)}${cycles}.`),
        alarm_entry(f),
        peak_entry(f),
        entry(ev.end, `<b>The compressor recovered${comp_c(f)}</b>${later ? "" : " and has held since"}.`),
        flicker_entry(f),
        ...now_entries(f)
      ]
    };
  },
  compressor_stop_ongoing: (f) => {
    const ev = f.compressor_event;
    // Left-censored overlays (RULES.md §5): the stop was never observed
    // starting, so the ongoing-stop story would fabricate a start time and
    // an hour count. A corroborated all-period stop is a real but finished
    // state; a dead signal is a monitoring problem wearing a stop's clothes.
    if (f.offline_kind === "warm")
      return {
        lead:
          `<b>The compressor was off the entire periodᶜ</b>${comp_via(f)} — its true start and total downtime are unknown. ` +
          `The magnet's own readings corroborate the stopᶜ.`,
        entries: [
          first_reading_entry(f, `Already off at the first compressor reading.`),
          peak_entry(f),
          ...now_entries(f)
        ]
      };
    if (f.offline_kind === "no_signal")
      return {
        lead:
          `<b>No compressor signalᶜ</b>${comp_via(f)} — the channel has read "off" since before the period began, with no thermal response from the magnet — ` +
          `the signal, not the compressor, is the likely faultᶜ. Compressor downtime is not reported.`,
        entries: [
          baseline_entry(f),
          first_reading_entry(f, `First compressor reading, already "off".`),
          ...now_entries(f)
        ]
      };
    // Left-censored with the overlay verdict suppressed (quench or suspect
    // precedence): the stop was never observed starting, so the story must
    // not invent the period boundary as its start, claim a downtime total,
    // or frame an event whose timing is unknown as OPEN (review round-2
    // F1). The neutral coverage wording states exactly what was read —
    // and "every reading" is only claimed when left_censored guarantees no
    // ON reading exists.
    if (f.left_censored)
      return {
        lead: `<b>The compressor read OFF at every reading this period${comp_c(f)}</b>${comp_via(f)} — its true start and total downtime are unknown.`,
        entries: [
          first_reading_entry(f, `Already off at the first compressor reading.`),
          peak_entry(f),
          ...now_entries(f)
        ]
      };
    // Start-truncated (review round-3 F1): the event's first off-run was
    // underway when coverage began, but the compressor was later seen
    // running and stopped again. The observed trailing stop anchors the
    // story; the initial run's start and earlier downtime stay unclaimed.
    if (f.compressor_start_truncated)
      return {
        lead:
          `<b>The compressor was already off when the data begins${comp_c(f)}</b>${comp_via(f)} — ` +
          `that initial stop predates the period, so its start and earlier downtime are unknown. ` +
          `<b>Warming event OPEN at end of data.</b>${other_events_sentence(f)}`,
        entries: [
          entry(f.compressor_first_on_t, `First seen running${comp_c(f)}.`),
          ev.last_stop_t != null
            ? entry(ev.last_stop_t, `<b>Stopped again${comp_c(f)} and has not recovered</b> — off ${fmt.hours(ev.off_hours)} observed across ${ev.cycles} off-runs (${readings_off(ev)}).`)
            : entry(f.compressor_first_on_t + 1, `<b>Stopped again${comp_c(f)} later in the period and has not recovered</b> — off ${fmt.hours(ev.off_hours)} observed across ${ev.cycles} off-runs (${readings_off(ev)}).`, "Later"),
          alarm_entry(f),
          peak_entry(f),
          ...now_entries(f)
        ]
      };
    return {
      lead: `<b>Warming event OPEN at end of data.</b>${other_events_sentence(f)}`,
      entries: [
        baseline_entry(f),
        entry(ev.start, `<b>The compressor stopped${comp_c(f)} and has not recovered</b>${comp_via(f)} — off ${fmt.hours(ev.off_hours)} at the last capture (${readings_off(ev)}).`),
        alarm_entry(f),
        peak_entry(f),
        ...now_entries(f)
      ]
    };
  },
  threshold_exceeded: (f) => ({
    lead: `No compressor stop${comp_c(f)} was detected this period, but ${p_name(f).toLowerCase()} crossed its alert line.`,
    entries: [baseline_entry(f), alarm_entry(f), peak_entry(f), flicker_entry(f), ...now_entries(f)]
  }),
  pressure_rising: (f) => ({
    lead: `No compressor stop${comp_c(f)} and no threshold breach this period, but ${p_name(f).toLowerCase()} is trending up.`,
    entries: [baseline_entry(f), peak_entry(f), flicker_entry(f), ...now_entries(f)]
  }),
  stable_healthy: (f) => ({
    lead: `No compressor events${comp_c(f)}, alarms, or threshold breaches detected across ${fmt.count(f.counts.captures)} captures.`,
    entries: [baseline_entry(f), flicker_entry(f), ...now_entries(f)]
  })
};

// Stable sort: entries sharing a timestamp keep the order the story lists
// them in (a stop before the alarm it triggered).
const timeline_html = ({ lead, entries }) => {
  const items = entries.filter(Boolean).sort((a, b) => a.t - b.t);
  return (
    `<p class="tl-lead"><b>Timeline (UTC):</b> ${lead}</p>` +
    (items.length
      ? `<ul class="tl">${items.map((e) => `<li><span class="ts">${e.label}</span><span>${e.html}</span></li>`).join("")}</ul>`
      : "")
  );
};

const build_cards = (f) => {
  const p = f.pressure;
  const he = f.helium;
  const current = [];
  if (f.compressor_event || f.last_compressor_on !== null) {
    const on = f.compressor_event
      ? f.compressor_event.end !== null
      : f.last_compressor_on;
    if (f.offline_kind === "warm")
      current.push(`Compressor off entire periodᶜ`);
    else if (f.offline_kind === "no_signal")
      current.push(`Compressor: no signalᶜ`);
    else current.push(`Compressor ${on ? "ON" : "OFF"}${comp_c(f)}`);
  }
  if (p)
    current.push(
      `${p_name(f)} ${p_fmt(f, p.last.v)} ${units(f)} (${fmt.time(p.last.t)})`
    );
  if (he)
    current.push(
      `Helium ${fmt.num(he.last.v, f.vendor.helium.decimals)}${he_sfx(f)}`
    );

  const rates = [];
  if (p) {
    rates.push(
      p.baseline_value === null
        ? `${p_name(f)} ${p_fmt(f, p.last.v)} ${units(f)}; peak ${p_fmt(f, p.peak.v)} (no clean baseline this period).`
        : `${p_name(f)} ${fmt.signed(p.last.v - p.baseline_value, f.vendor.pressure.decimals)} ${units(f)} vs baseline (${p_fmt(f, p.baseline_value)} → ${p_fmt(f, p.last.v)}); peak ${p_fmt(f, p.peak.v)}.`
    );
    // A ramp rate is only meaningful against an event window.
    if (p.rate_per_hr !== null && f.compressor_event)
      rates.push(
        `Ramp averaged ${fmt.signed(p.rate_per_hr, f.vendor.pressure.decimals)} ${units(f)}/h.`
      );
  }
  if (he && he.delta_vs_baseline !== null)
    rates.push(
      `Helium ${fmt.signed(he.delta_vs_baseline, 2)} ${f.units.helium === "%" ? "points" : f.units.helium}.`
    );

  const notes = [];
  notes.push(
    `${fmt.count(f.counts.captures)} captures · ${fmt.count(f.counts.pressure)} valid pressure · ${fmt.count(f.counts.helium)} valid helium readings.`
  );
  if (f.chart_mode === "band")
    notes.push("Charts show the daily min–max range with the daily last value.");
  else notes.push("Charts plot every archived capture.");
  if (f.room_temp)
    notes.push(
      `Tech Room Temp ${fmt.num(f.room_temp.min.v, 1)}–${fmt.num(f.room_temp.max.v, 1)} °C this period.`
    );
  if (f.edu) {
    // Per-channel, never silent: the fleet section shows the clean screened
    // numbers, so the brief is where a probe problem gets NAMED. A channel
    // whose garbage was screened says how much was excluded; a channel with
    // ONLY garbage is diagnosed (an open input emitting its scale floor is
    // a disconnected probe, not a cold room); a channel that reported
    // nothing says so rather than vanishing from the line.
    const rej = f.edu.rejected || {};
    const range = (stats, decimals) =>
      `${fmt.num(stats.min.v, decimals)}–${fmt.num(stats.max.v, decimals)}`;
    // "implausible", not "open-sensor": the screen knows a reading was
    // outside physical bounds, not WHY — an open input emitting its scale
    // floor is the common cause, but a shorted probe reading 200 °F trips
    // the same bound and calling that "open-sensor" would misdiagnose it.
    // A channel whose last plausible reading predates the period end by
    // more than a day says WHEN it stopped — an old range must not read as
    // the room's current state (compute/staleness, the same 24h line the
    // tiles' "as of" uses).
    const stopped = (stats) =>
      f.window_end - stats.last.t > STALE_MS
        ? `stopped ${fmt.day(stats.last.t)}`
        : "";
    const channel = (label, stats, rejected, decimals, sfx) => {
      if (stats) {
        // Findings share one parenthetical — "(stopped Aug 9 · 3 implausible
        // readings excluded)" — two adjacent brackets read like a typo.
        const flags = [
          stopped(stats),
          rejected
            ? `${fmt.count(rejected)} implausible reading${rejected === 1 ? "" : "s"} excluded`
            : ""
        ].filter(Boolean);
        return `${label} ${range(stats, decimals)}${sfx}${flags.length ? ` (${flags.join(" · ")})` : ""}`;
      }
      if (rejected)
        return `${label}: no plausible readings (${fmt.count(rejected)} excluded) — sensor fault likely`;
      return `${label}: no readings this period`;
    };
    const parts = [channel("room", f.edu.room_temp, rej.room_temp, 1, " °F")];
    // Two clean, CURRENT probes keep the compact combined form; anything
    // remarkable on either — exclusions or an early stop — splits them so
    // the finding names its probe.
    if (
      f.edu.probe_0 &&
      f.edu.probe_1 &&
      !rej.probe_0 &&
      !rej.probe_1 &&
      !stopped(f.edu.probe_0) &&
      !stopped(f.edu.probe_1)
    )
      parts.push(
        `probes ${range(f.edu.probe_0, 1)} / ${range(f.edu.probe_1, 1)} °F`
      );
    else
      parts.push(
        channel("probe 0", f.edu.probe_0, rej.probe_0, 1, " °F"),
        channel("probe 1", f.edu.probe_1, rej.probe_1, 1, " °F")
      );
    parts.push(channel("humidity", f.edu.humidity, rej.humidity, 0, "%"));
    notes.push(`EDU (${fmt.count(f.edu.count)} captures): ${parts.join(" · ")}.`);
  }
  if (f.clock_skew_minutes !== null && f.clock_skew_minutes > 15)
    notes.push(
      `Host clock ~${Math.round(f.clock_skew_minutes)} min off vs capture time — times shown use capture time.`
    );
  // The brief's one legend line (RULES.md §6): defines the ᶜ mark on the
  // pages that carry it — a coldhead-inferred compressor state, or a
  // corroborated all-period stop. Banner pages (sensor suspect, no signal)
  // skip it: their banner already defines the mark inline.
  const has_banner =
    (f.last_suspect === true && !f.quenched) || f.offline_kind === "no_signal";
  if ((comp_c(f) || f.offline_kind === "warm") && !has_banner)
    notes.push("ᶜ = concluded — inferred or corroborated, not directly measured.");

  return [
    {
      // On a convicted sensor chain the "current" values are what the
      // sensor says, not what the magnet is — the heading says so.
      heading: `CURRENT — ${fmt.day_caps(f.window_end)} (${f.last_suspect === true && !f.quenched ? "sensor's claims" : "last readings"})`,
      body: `${current.join(". ")}.`
    },
    { heading: "RATES", body: rates.join(" ") },
    { heading: "DATA NOTES", body: notes.join(" ") }
  ];
};

// A convicted sensor chain (RULES.md §5) reframes the whole story: the
// timeline still runs — its measured parts (an EDU compressor) are real —
// but everything read from the convicted chain is the sensor's claim. A
// recorded quench overrides suspect, so a quenched page never leads with a
// monitoring caveat.
const suspect_lead = (f) => {
  if (f.last_suspect !== true || f.quenched) return "";
  const total = Object.values(f.implausible || {}).reduce((n, c) => n + c, 0);
  return (
    `<b>Monitoring suspect:</b> ${fmt.count(total)} reading${total === 1 ? "" : "s"} this period fell outside plausible physical bounds, and the latest capture combines impossible values — ` +
    `the sensor chain, not the magnet, is the likely fault. The timeline below reports the sensor's claims. `
  );
};

const build_narrative = (facts) => {
  const story = STORIES[facts.archetype];
  // A named error, not a fallback: an unregistered archetype is a bug the
  // checks should have caught (STORY_KEYS coverage), and generating some
  // generic story here would hide it from the one person who can fix it.
  if (!story)
    throw new Error(
      `no narrative story registered for archetype "${facts.archetype}"`
    );
  return {
    story_html: suspect_lead(facts) + timeline_html(story(facts)),
    rx_cards: build_cards(facts)
  };
};

// STORY_KEYS: the archetypes this module can narrate. Exported for the
// check-time coverage assertion (check_compute: every registered archetype
// has a story). The lookup above throws a NAMED error on an unregistered
// key — still a render-time failure by design, so the check is what keeps
// it from ever firing.
module.exports = { build_narrative, STORY_KEYS: Object.keys(STORIES) };
