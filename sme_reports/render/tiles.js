const fmt = require("./fmt");
const { STATUS_LABELS } = require("../conditions");

// Builds the 5 KPI tile view-models {cls, k, v, s} for the vendor's tile set.
// Status classes: good (teal) / warn (amber) / bad (red) / ink (navy).
// facts.thr / facts.he_thr are the per-system thresholds from alert.models
// defaults; facts.units carries the per-system display units.

// Severity of a pressure value against the threshold object.
const p_severity = (v, thr) => {
  if (v === null) return "none";
  if (thr.high_gt !== null && v >= thr.high_gt) return "high";
  if (thr.high_lt !== null && v <= thr.high_lt) return "high";
  if (thr.med_gt !== null && v >= thr.med_gt) return "med";
  if (thr.med_lt !== null && v <= thr.med_lt) return "med";
  return "ok";
};

// "Now" reads one notch softer than the peak (exemplar convention): over the
// line but easing shows warn, not bad.
const pressure_cls = (v, thr, easing) => {
  const sev = p_severity(v, thr);
  if (sev === "none") return "ink";
  if (sev === "high") return easing ? "warn" : "bad";
  if (sev === "med") return "warn";
  return "good";
};

const vs_line = (v, thr, units) => {
  if (thr.high_lt !== null) {
    // Band-alerted metric (Siemens absolute pressure).
    if (v >= thr.high_gt) return `above the ${thr.high_lt}–${thr.high_gt} ${units} band`;
    if (v <= thr.high_lt) return `below the ${thr.high_lt}–${thr.high_gt} ${units} band`;
    return `within the ${thr.high_lt}–${thr.high_gt} ${units} band`;
  }
  if (v >= thr.high_gt * 1.5)
    return `~${(v / thr.high_gt).toFixed(1)}× the ${thr.high_gt} ${units} line`;
  return `${Math.round((v / thr.high_gt) * 100)}% of the ${thr.high_gt} ${units} line`;
};

const trend_of = (pressure) => {
  if (!pressure) return null;
  if (pressure.last.v < pressure.peak.v * 0.995) return "easing";
  if (pressure.rate_per_hr !== null && pressure.rate_per_hr > 0) return "rising";
  return null;
};

const trend_word = (pressure) => {
  const trend = trend_of(pressure);
  return trend ? ` · ${trend}` : "";
};

// "%" reads attached (79.3%), other units read spaced (968 LTRS).
const he_suffix = (units) => (units === "%" ? "%" : ` ${units}`);

const BUILDERS = {
  compressor: (f) => {
    const ev = f.compressor_event;
    const fl = f.compressor_flickers;
    // The ᶜ provenance mark (RULES.md §6): a coldhead-inferred state is a
    // conclusion, not a reading — every ON/OFF this tile prints from that
    // source carries the mark, exactly like the fleet's compressor cells.
    const c = f.compressor_source === "coldhead_ruo_value" ? "ᶜ" : "";
    // Distinct clustered events beyond the primary; "other", not "earlier" —
    // they can fall on either side of it.
    const others = (f.compressor_events || []).length - 1;
    const more =
      others > 0 ? ` · +${others} other event${others === 1 ? "" : "s"}` : "";
    // A hand-supplied window with no OFF readings in it: say so rather than
    // implying a measured stop of ~0.0 h.
    if (ev && ev.off_count === 0)
      return {
        cls: "ink",
        k: "COMPRESSOR",
        v: "—",
        s: "no OFF readings in the specified event span"
      };
    if (!ev) {
      const on = f.last_compressor_on;
      // null means the window carried no compressor state at all — e.g. a
      // Philips whose only malf readings are −1 cable errors, or a non-TIM
      // on EDU1 hardware. "not false" used to render a green ON here, a
      // health claim fabricated from zero data.
      if (on === null)
        return {
          cls: "ink",
          k: "COMPRESSOR",
          v: "—",
          s: "no compressor state reported this period"
        };
      return {
        cls: on === false ? "bad" : "good",
        k: "COMPRESSOR",
        v: (on === false ? "OFF" : "ON") + c,
        s:
          on === false
            ? "off at last reading"
            : fl
              ? `running · ${fl.count} brief dropout${fl.count === 1 ? "" : "s"} — likely sensor flicker${fl.count === 1 ? "" : "s"}`
              : "running continuously through the period"
      };
    }
    if (ev.end === null) {
      // Left-censored overlays (RULES.md §5), labels from conditions.js.
      // A corroborated all-period stop is amber, not red — the fleet never
      // counts it urgent, and its start (and downtime) is unknown, so no
      // hour count is fabricated. A dead signal claims nothing at all.
      if (f.offline_kind === "warm")
        return {
          cls: "warn",
          k: "COMPRESSOR",
          v: `OFF${c}`,
          s: `${STATUS_LABELS.warm_offline.toLowerCase()}ᶜ · start predates the data`
        };
      if (f.offline_kind === "no_signal")
        return {
          cls: "ink",
          k: "COMPRESSOR",
          v: "—",
          s: `${STATUS_LABELS.no_signal}ᶜ`
        };
      // Left-censored but the overlay verdict was suppressed (quench or
      // suspect precedence): the FACT that the stop predates the data
      // still holds, so the tile must not fabricate a start time or an
      // hour count from the period boundary (review round-2 F1). "Every
      // reading" is only claimed when it is literally true — left_censored
      // requires no ON reading ever.
      if (f.left_censored)
        return {
          cls: "bad",
          k: "COMPRESSOR",
          v: `OFF${c}`,
          s: "off at every reading this period · start and downtime unknown"
        };
      // Start-truncated (review round-3 F1): the event's first off-run was
      // already underway when coverage began, but the compressor was later
      // seen running and stopped AGAIN — that trailing stop is observed
      // and anchors the claim; the event's `start` (the coverage boundary)
      // must not be presented as when the stop began.
      if (f.compressor_start_truncated)
        return {
          cls: "bad",
          k: "COMPRESSOR",
          v: `OFF${c}`,
          s: `already off at first reading · off again ${ev.last_stop_t != null ? fmt.ts(ev.last_stop_t) : "later in the period"}${more}`
        };
      return {
        cls: "bad",
        k: "COMPRESSOR",
        v: `OFF${c}`,
        s: `stopped ${fmt.ts(ev.start)} · off ${fmt.hours(ev.off_hours)}${more}`
      };
    }
    if (ev.cycles > 1)
      return {
        cls: "good",
        k: "COMPRESSOR",
        v: `ON${c}`,
        s: `recovered ${fmt.ts(ev.end)} · ${ev.cycles} cycles from ${fmt.ts(ev.start)}${more}`
      };
    return {
      cls: "good",
      k: "COMPRESSOR",
      v: `RESTARTED${c}`,
      s: `recovered ${fmt.ts(ev.end)} · off ${fmt.hours(ev.off_hours)}${more}`
    };
  },

  coldhead: (f) => {
    const ch = f.coldhead;
    if (!ch) return { cls: "ink", k: "COLDHEAD", v: "—", s: "no coldhead data" };
    const warm_k = f.vendor.coldhead.warm_k;
    const warm = ch.last.v >= warm_k;
    return {
      cls: warm ? "bad" : "good",
      k: "COLDHEAD",
      v: `${fmt.num(ch.last.v, 3)} K`,
      s:
        ch.max.v >= warm_k
          ? `from ${fmt.num(ch.max.v, 1)} K`
          : "steady at base temperature"
    };
  },

  pressure_now: (f) => {
    const p = f.pressure;
    if (!p)
      return { cls: "ink", k: "PRESSURE NOW", v: "—", s: "no pressure data" };
    return {
      cls: pressure_cls(p.last.v, f.thr, p.last.v < p.peak.v * 0.995),
      k: f.vendor.primary.tile_now,
      v: `${fmt.num(p.last.v, f.vendor.pressure.decimals)} ${f.units.pressure}`,
      s: vs_line(p.last.v, f.thr, f.units.pressure) + trend_word(p)
    };
  },

  // Siemens non-TIM electronics-cabinet temperature, judged against the
  // system's own warn/alarm levels reported alongside each reading.
  cabinet: (f) => {
    const cab = f.cabinet;
    if (!cab)
      return { cls: "ink", k: "CABINET", v: "—", s: "no cabinet temp data" };
    const cls =
      cab.alarm !== null && cab.last.v >= cab.alarm
        ? "bad"
        : cab.warn !== null && cab.last.v >= cab.warn
          ? "warn"
          : "good";
    const levels =
      cab.warn !== null && cab.alarm !== null
        ? `warn ${cab.warn} · alarm ${cab.alarm} °C`
        : "no warn/alarm levels reported";
    return {
      cls,
      k: "CABINET",
      v: `${fmt.num(cab.last.v, 1)} °C`,
      s: `${fmt.num(cab.min.v, 1)}–${fmt.num(cab.max.v, 1)} °C this period · ${levels}`
    };
  },

  event_peak: (f) => {
    const p = f.pressure;
    if (!p)
      return { cls: "ink", k: "EVENT PEAK", v: "—", s: "no pressure data" };
    const { decimals } = f.vendor.pressure;
    const sev = p_severity(p.peak.v, f.thr);
    const vs =
      f.thr.high_gt !== null
        ? `${fmt.num(Math.abs(p.peak.v - f.thr.high_gt), decimals)} ${f.units.pressure} ${p.peak.v >= f.thr.high_gt ? "over" : "under"} threshold`
        : "no high threshold configured";
    return {
      cls: sev === "high" ? "bad" : "ink",
      k: "EVENT PEAK",
      v: `${fmt.num(p.peak.v, decimals)} ${f.units.pressure}`,
      s: `${fmt.ts(p.peak.t)} · ${vs}`
    };
  },

  temp_alarm: (f) => {
    const ta = f.temp_alarm;
    if (!ta)
      return {
        cls: "good",
        k: "TEMP ALARM",
        v: "NONE",
        s: "no temperature alarm this period"
      };
    return {
      cls: "warn",
      k: "TEMP ALARM",
      v: "TRIGGERED",
      s: `${ta.count} readings · ${fmt.ts(ta.start)} → ${fmt.ts(ta.end)}`
    };
  },

  helium: (f) => {
    const he = f.helium;
    if (!he) return { cls: "ink", k: "HELIUM", v: "—", s: "no helium data" };
    const value = `${fmt.num(he.last.v, f.vendor.helium.decimals)}${he_suffix(f.units.helium)}`;
    if (f.quenched)
      return { cls: "bad", k: "HELIUM", v: value, s: "QUENCH detected this period" };
    const delta = he.delta_vs_baseline;
    // Per-system low-helium thresholds from alert.models defaults — applied
    // only when the model's units match the display units (a % threshold is
    // meaningless against an LTRS reading).
    const he_thr_applies =
      f.he_thr.units === null || f.he_thr.units === f.units.helium;
    if (he_thr_applies && f.he_thr.low_high !== null && he.last.v < f.he_thr.low_high)
      return {
        cls: "bad",
        k: "HELIUM",
        v: value,
        s: `below the ${f.he_thr.low_high}${he_suffix(f.units.helium)} alert level`
      };
    if (he_thr_applies && f.he_thr.low_med !== null && he.last.v < f.he_thr.low_med)
      return {
        cls: "warn",
        k: "HELIUM",
        v: value,
        s: `below the ${f.he_thr.low_med}${he_suffix(f.units.helium)} warning level`
      };
    // A null delta means no clean baseline survived event exclusion — report
    // the level without a comparison rather than implying it held steady.
    if (delta === null)
      return { cls: "good", k: "HELIUM", v: value, s: "no clean baseline this period" };
    const lost = delta < -0.2;
    return {
      cls: lost ? "warn" : "good",
      k: "HELIUM",
      v: value,
      s: `${fmt.signed(delta, 2)} ${f.units.helium === "%" ? "pts" : f.units.helium} · ${lost ? "level falling" : "no loss · no quench"}`
    };
  }
};

// Data-quality degradation pass over the built tiles (RULES.md §4/§5), in
// priority order:
//
// 1. A channel whose LAST RAW reading failed its plausibility bounds shows
//    that raw value greyed with ‡ and judges nothing — conviction or not,
//    exactly like the fleet columns. The helium tile steps aside for a
//    recorded quench, which owns that tile's statement.
// 2. A clean channel whose newest plausible reading is more than a day older
//    than the period end says which day it is from ("as of Aug 5") rather
//    than passing an old reading off as current.
// 3. A convicted sensor chain (facts.last_suspect) suspends every remaining
//    judgment: tiles keep their value but drop status colors and claims —
//    0.00% helium on a convicted chain is the sensor's claim, not a live
//    emergency. The one exception is an EDU-measured compressor: a vibration
//    sensor on separate hardware, outside the convicted chain, so its state
//    stays confident — matching the fleet, which keeps the compressor cell
//    on a sensor-suspect row. A recorded quench overrides the conviction
//    entirely; missing a real quench is the costlier error.
const NOT_JUDGED = "sensor's claim — not judged";
const OUT_OF_BOUNDS = "outside plausible bounds — not judged";
const STALE_MS = 24 * 3600000;

// The channel behind each now-value tile: which last-raw flag greys it, how
// its raw value renders, and where its newest plausible reading lives.
const NOW_CHANNELS = {
  pressure_now: {
    flag: "primary",
    raw_v: (f) =>
      `${fmt.num(f.raw_last.pressure, f.vendor.pressure.decimals)} ${f.units.pressure}‡`,
    last: (f) => (f.pressure ? f.pressure.last : null)
  },
  helium: {
    flag: "helium",
    raw_v: (f) =>
      `${fmt.num(f.raw_last.helium, f.vendor.helium.decimals)}${he_suffix(f.units.helium)}‡`,
    last: (f) => (f.helium ? f.helium.last : null)
  },
  coldhead: {
    flag: "coldhead",
    raw_v: (f) => `${fmt.num(f.raw_last.coldhead_k, 0)} K‡`,
    last: (f) => (f.coldhead ? f.coldhead.last : null)
  },
  cabinet: {
    flag: "cabinet",
    raw_v: (f) => `${fmt.num(f.raw_last.cab_temp, 0)} °C‡`,
    last: (f) => (f.cabinet ? f.cabinet.last : null)
  }
};

const degrade_tile = (key, tile, f, suspect) => {
  const ch = NOW_CHANNELS[key];
  if (ch && (f.data_flags || {})[ch.flag] && !(key === "helium" && f.quenched))
    return { cls: "dim", k: tile.k, v: ch.raw_v(f), s: OUT_OF_BOUNDS };
  const last = ch ? ch.last(f) : null;
  const stale =
    last && f.window_end - last.t > STALE_MS ? `as of ${fmt.day(last.t)} · ` : "";
  if (suspect) {
    if (key === "compressor" && f.compressor_source === "edu_comp_vib")
      return tile;
    return { ...tile, cls: "dim", s: stale + NOT_JUDGED };
  }
  return stale ? { ...tile, s: stale + tile.s } : tile;
};

const build_tiles = (facts) => {
  const tiles = facts.vendor.tiles.map((key) => BUILDERS[key](facts));
  const suspect = facts.last_suspect === true && facts.quenched !== true;
  return facts.vendor.tiles.map((key, i) =>
    degrade_tile(key, tiles[i], facts, suspect)
  );
};

// p_severity / he_suffix / trend_of are shared with the fleet summary so the
// two documents grade and format the same reading identically.
module.exports = { build_tiles, p_severity, he_suffix, trend_of };
