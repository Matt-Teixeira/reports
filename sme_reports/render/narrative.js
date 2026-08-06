const fmt = require("./fmt");

// Rules-based narrative: one template-literal builder per event archetype,
// producing the .story block and the three .rx footnote cards. Free-text
// overrides from the request (narrative_overrides.story / rx_cards) replace
// the generated output wholesale in render/model.js.

const p_fmt = (facts, v) => fmt.num(v, facts.vendor.pressure.decimals);
const units = (facts) => facts.units.pressure;
const thr = (facts) => facts.thr.high_gt;
const he_sfx = (facts) =>
  facts.units.helium === "%" ? "%" : ` ${facts.units.helium}`;

const baseline_sentence = (facts) => {
  const p = facts.pressure;
  const he = facts.helium;
  const parts = [];
  if (p && p.baseline)
    parts.push(
      `pressure held ${p_fmt(facts, p.baseline.min.v)}–${p_fmt(facts, p.baseline.max.v)} ${units(facts)}`
    );
  if (he && he.baseline)
    parts.push(
      `helium ${fmt.num(he.baseline.min.v, facts.vendor.helium.decimals)}–${fmt.num(he.baseline.max.v, facts.vendor.helium.decimals)}${he_sfx(facts)}`
    );
  if (facts.coldhead && facts.coldhead_baseline_max !== null)
    parts.push(`coldhead at base temperature`);
  return parts.length
    ? `<b>Baseline ${fmt.day(facts.window_start)} – ${fmt.day(facts.compressor_event ? facts.compressor_event.start : facts.window_end)}:</b> ${parts.join(", ")}.`
    : "";
};

const peak_sentence = (facts) => {
  const p = facts.pressure;
  if (!p || thr(facts) === null) return "";
  const over = p.peak.v - thr(facts);
  const vs =
    over >= 0
      ? `${p_fmt(facts, over)} ${units(facts)} over the ${thr(facts)} ${units(facts)} line`
      : `never reached the ${thr(facts)} ${units(facts)} threshold, ${p_fmt(facts, -over)} ${units(facts)} below the line`;
  const rate =
    p.rate_per_hr !== null
      ? ` (${fmt.signed(p.rate_per_hr, facts.vendor.pressure.decimals)} ${units(facts)}/h avg on the ramp)`
      : "";
  return `He pressure rose from ${p_fmt(facts, p.baseline_value)} to a <b>peak of ${p_fmt(facts, p.peak.v)} ${units(facts)} at ${fmt.ts(p.peak.t)}</b> — ${vs}${rate}.`;
};

const helium_sentence = (facts) => {
  const he = facts.helium;
  if (!he) return "";
  const d = he.delta_vs_baseline;
  const quench = facts.quenched
    ? " <b>A quench state was recorded in the window.</b>"
    : " No quench.";
  return `Helium ${d >= 0 ? "rose" : "fell"} to <b>${fmt.num(he.last.v, facts.vendor.helium.decimals)}${he_sfx(facts)}</b> (${fmt.signed(d, 2)} vs baseline).${quench}`;
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
    return `Pressure now reads ${p_fmt(facts, p.last.v)} ${units(facts)} (${fmt.ts(p.last.t)}) — ${state}.`;
  }
  const over = p.last.v - thr(facts);
  const vs =
    over >= 0
      ? `still ${p_fmt(facts, over)} ${units(facts)} over the line`
      : `${Math.round((p.last.v / thr(facts)) * 100)}% of the line`;
  return `Pressure now reads ${p_fmt(facts, p.last.v)} ${units(facts)} (${fmt.ts(p.last.t)}) — ${vs}.`;
};

const alarm_sentence = (facts) => {
  const ta = facts.temp_alarm;
  if (!ta) return "";
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
      ? ` Room temperature held ${fmt.num(facts.edu.alarm_room_temp.min.v, 1)}–${fmt.num(facts.edu.alarm_room_temp.max.v, 1)} °F over the alarm window.`
      : "";
  return ` A compressor temperature alarm was triggered ${fmt.ts(ta.start)} → ${fmt.ts(ta.end)} (${ta.count} readings${peak_min}${retrigger}; amber strip on the pressure chart).${room}`;
};

const STORIES = {
  compressor_stop_recovered: (f) => {
    const ev = f.compressor_event;
    const cycles =
      ev.cycles > 1
        ? ` and then cycled on/off ${ev.cycles} times through ${fmt.ts(ev.end)} (${ev.off_count} readings off)`
        : ` and stayed off ${fmt.hours(ev.off_hours)} (${ev.off_count} readings off)`;
    return (
      `<b>Timeline (UTC):</b> ${baseline_sentence(f)} ` +
      `<b>${fmt.ts(ev.start)}: the compressor stopped</b>${cycles}.${alarm_sentence(f)} ` +
      `${peak_sentence(f)} <b>The compressor recovered ${fmt.ts(ev.end)}</b> and has held since. ` +
      `${helium_sentence(f)} ${now_sentence(f)}`
    );
  },
  compressor_stop_ongoing: (f) => {
    const ev = f.compressor_event;
    return (
      `<b>Timeline (UTC):</b> ${baseline_sentence(f)} ` +
      `<b>${fmt.ts(ev.start)}: the compressor stopped and has not recovered</b> — off ${fmt.hours(ev.off_hours)} at the last capture (${ev.off_count} readings off).${alarm_sentence(f)} ` +
      `${peak_sentence(f)} ${helium_sentence(f)} ${now_sentence(f)} ` +
      `<b>Warming event OPEN at end of data.</b>`
    );
  },
  threshold_exceeded: (f) =>
    `<b>Timeline (UTC):</b> ${baseline_sentence(f)} No compressor stop was detected in the window, but ` +
    `${peak_sentence(f)}${alarm_sentence(f)} ${helium_sentence(f)} ${now_sentence(f)}`,
  pressure_rising: (f) =>
    `<b>Timeline (UTC):</b> ${baseline_sentence(f)} No compressor stop and no threshold breach in the window, but pressure is trending up: ` +
    `${peak_sentence(f)} ${helium_sentence(f)} ${now_sentence(f)}`,
  stable_healthy: (f) =>
    `<b>Timeline (UTC):</b> ${baseline_sentence(f)} No compressor events, alarms, or threshold breaches detected across ` +
    `${fmt.count(f.counts.captures)} captures. ${helium_sentence(f)} ${now_sentence(f)}`
};

const build_cards = (f) => {
  const p = f.pressure;
  const he = f.helium;
  const current = [];
  if (f.compressor_event || f.last_compressor_on !== null) {
    const on = f.compressor_event
      ? f.compressor_event.end !== null
      : f.last_compressor_on;
    current.push(`Compressor ${on ? "ON" : "OFF"}`);
  }
  if (p)
    current.push(
      `He pressure ${p_fmt(f, p.last.v)} ${units(f)} (${fmt.time(p.last.t)})`
    );
  if (he)
    current.push(
      `Helium ${fmt.num(he.last.v, f.vendor.helium.decimals)}${he_sfx(f)}`
    );

  const rates = [];
  if (p) {
    rates.push(
      `Pressure ${fmt.signed(p.last.v - p.baseline_value, f.vendor.pressure.decimals)} ${units(f)} vs baseline (${p_fmt(f, p.baseline_value)} → ${p_fmt(f, p.last.v)}); peak ${p_fmt(f, p.peak.v)}.`
    );
    // A ramp rate is only meaningful against an event window.
    if (p.rate_per_hr !== null && f.compressor_event)
      rates.push(
        `Ramp averaged ${fmt.signed(p.rate_per_hr, f.vendor.pressure.decimals)} ${units(f)}/h.`
      );
  }
  if (he)
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
      `Tech Room Temp ${fmt.num(f.room_temp.min.v, 1)}–${fmt.num(f.room_temp.max.v, 1)} °C in window.`
    );
  if (f.edu) {
    const parts = [];
    if (f.edu.room_temp)
      parts.push(
        `room ${fmt.num(f.edu.room_temp.min.v, 1)}–${fmt.num(f.edu.room_temp.max.v, 1)} °F`
      );
    if (f.edu.probe_0 && f.edu.probe_1)
      parts.push(
        `probes ${fmt.num(f.edu.probe_0.min.v, 1)}–${fmt.num(f.edu.probe_0.max.v, 1)} / ${fmt.num(f.edu.probe_1.min.v, 1)}–${fmt.num(f.edu.probe_1.max.v, 1)} °F`
      );
    if (f.edu.humidity)
      parts.push(
        `humidity ${fmt.num(f.edu.humidity.min.v, 0)}–${fmt.num(f.edu.humidity.max.v, 0)}%`
      );
    if (parts.length)
      notes.push(`EDU (${fmt.count(f.edu.count)} captures): ${parts.join(" · ")}.`);
  }
  if (f.clock_skew_minutes !== null && f.clock_skew_minutes > 15)
    notes.push(
      `Host clock ~${Math.round(f.clock_skew_minutes)} min off vs capture time — times shown use capture time.`
    );

  return [
    {
      heading: `CURRENT — ${fmt.day_caps(f.window_end)} (last readings)`,
      body: `${current.join(". ")}.`
    },
    { heading: "RATES", body: rates.join(" ") },
    { heading: "DATA NOTES", body: notes.join(" ") }
  ];
};

const build_narrative = (facts) => ({
  story_html: STORIES[facts.archetype](facts),
  rx_cards: build_cards(facts)
});

module.exports = { build_narrative };
