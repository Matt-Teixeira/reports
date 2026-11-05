// Corroboration of an EDU-reported compressor stop (RULES.md §1, the
// "EDU-off annotation"; docs/MAGNET-HEALTH-DATA-AND-RULES.md §5.1).
//
// The EDU vibration sensor is primary and is never overruled: when it reads
// off, the report says off. Each stop then gets a TYPE from the other data,
// in this order:
//   1. the secondary compressor channel (the scanner's own reading, or the
//      GE coldhead inference), where it has a fresh reading during the stop;
//   2. the thermal channels: the primary metric's response in the 2 hours
//      after the stop began (the flicker rule's 2%-of-limit / 2 h test, held
//      to the stop's start so a multi-day stop cannot pass on the magnet's
//      ordinary daily swing), and the coldhead against its vendor warm bar
//      anywhere in the stop.
// Types:
//   confirmed   — the secondary channel also read off, or the magnet warmed.
//   doubtful    — the secondary channel read running AND the magnet showed
//                 no warming: "based on other data, it may not be off".
//   unconfirmed — anything else: the other data is missing, frozen, or
//                 only half-speaks.
// Stale readings (a host timestamp repeating the previous reading's) speak
// for nothing: a frozen feed re-sends one snapshot.
//
// Pure: no I/O, no clock.

const COVER_MS = 45 * 60e3; // a secondary reading this close speaks for the moment
const RESPONSE_LAG_MS = 2 * 3600e3; // the flicker rule's response window

// The upper median: with an even count it takes the higher middle value,
// so one low glitch (a 0 reading) can never drag the baseline down and fake
// a rise.
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Times of rows whose host timestamp repeats the previous row's.
const stale_times = (rows) => {
  const out = new Set();
  for (let i = 1; i < rows.length; i++) {
    const h = rows[i].host_t;
    if (h != null && h === rows[i - 1].host_t) out.add(rows[i].t);
  }
  return out;
};

// ev: an event from compute/events.js (start, end — null while open).
// off_rows: the merged stream's EDU off readings inside the event.
// ctx: { secondary: fresh vendor stateful rows [{t, compressor_on}],
//        p_points: screened primary-metric points [{t, v}] (fresh only),
//        coldhead: fresh plausible coldhead points [{t, v}],
//        warm_k: vendor coldhead warm bar or null,
//        epsilon: primary-metric response threshold or null,
//        window_end: period end (ms) }
const corroborate_event = (ev, off_rows, ctx) => {
  const end = ev.end == null ? ctx.window_end : ev.end;

  // 1. The secondary channel at the moments the EDU read off.
  let sec_on = 0;
  let sec_off = 0;
  let sec_stale = 0; // no fresh reading, but a frozen-feed one nearby
  const stale_sec = ctx.secondary_stale || [];
  for (const r of off_rows) {
    let best = null;
    for (const s of ctx.secondary) {
      const d = Math.abs(s.t - r.t);
      if (d <= COVER_MS && (!best || d < best.d)) best = { d, on: s.compressor_on };
    }
    if (!best) {
      if (stale_sec.some((s) => Math.abs(s.t - r.t) <= COVER_MS)) sec_stale++;
      continue;
    }
    if (best.on) sec_on++;
    else sec_off++;
  }
  const secondary = sec_off > 0 ? "off" : sec_on > 0 ? "on" : "none";

  // 2. The thermal channels. Pressure: the 2 hours after the stop began,
  // against the median of the 2 hours before it (the stop's own first
  // readings when it began before the data), and at least two readings past
  // the bar, so one glitch reading neither fakes nor hides a rise. Coldhead:
  // any plausible reading past the warm bar during the stop.
  const early = ctx.p_points.filter((p) => p.t >= ev.start && p.t <= ev.start + RESPONSE_LAG_MS);
  const before = ctx.p_points.filter((p) => p.t < ev.start && p.t >= ev.start - RESPONSE_LAG_MS);
  const baseline = median((before.length ? before : early.slice(0, 3)).map((p) => p.v));
  const above = baseline == null || ctx.epsilon == null ? 0 : early.filter((p) => p.v - baseline >= ctx.epsilon).length;
  const pressure_rose = above >= 2 || (early.length === 1 && above === 1);
  const ch_span = ctx.coldhead.filter((p) => p.t >= ev.start && p.t <= end);
  const coldhead_warm = ctx.warm_k != null && ch_span.some((p) => p.v >= ctx.warm_k);
  const thermal =
    pressure_rose || coldhead_warm ? "warming" : early.length || ch_span.length ? "steady" : "unknown";

  const type =
    secondary === "off" || thermal === "warming"
      ? "confirmed"
      : secondary === "on" && thermal === "steady"
        ? "doubtful"
        : "unconfirmed";
  // The evidence behind the type, for the System Activity page's "why":
  // how the secondary channel answered each EDU off reading, and the
  // thermal numbers against their bars. pressure is null with no readings in
  // its window; coldhead is null only where the vendor has no warm bar
  // (Philips), and carries readings: 0 when the channel was silent.
  const detail = {
    edu_off: off_rows.length,
    sec_off,
    sec_on,
    sec_missing: off_rows.length - sec_off - sec_on,
    sec_stale,
    pressure: early.length
      ? { baseline, peak: Math.max(...early.map((p) => p.v)), epsilon: ctx.epsilon, readings: early.length, above }
      : null,
    // Pressure had only frozen-feed readings in its window.
    pressure_frozen: !early.length && (ctx.p_stale || []).some((p) => p.t >= ev.start && p.t <= ev.start + RESPONSE_LAG_MS),
    coldhead:
      ctx.warm_k == null
        ? null
        : {
            max: ch_span.length ? Math.max(...ch_span.map((p) => p.v)) : null,
            warm_k: ctx.warm_k,
            readings: ch_span.length,
            frozen: !ch_span.length && (ctx.coldhead_stale || []).some((p) => p.t >= ev.start && p.t <= end)
          }
  };
  return { type, secondary, thermal, detail };
};

// The system-level type across its events: one confirmed stop makes the
// period's issue confirmed; doubtful only when every stop is doubtful.
const overall_type = (types) =>
  !types.length
    ? null
    : types.includes("confirmed")
      ? "confirmed"
      : types.every((t) => t === "doubtful")
        ? "doubtful"
        : "unconfirmed";

module.exports = { corroborate_event, overall_type, stale_times, COVER_MS };
