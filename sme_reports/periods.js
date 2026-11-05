// One vocabulary for report PERIODS — the reader-facing name, the day
// count, the artifact tag, and the subject-line label for every span the
// reports support. Before this module each of those was an inline
// expression at five call sites (`lookback_days !== 30 ? -${lb}d : ""`,
// `${lb}-day`), which meant a new span had to be added in five places and
// could disagree with itself between a filename and the email announcing
// it. Adding the 6-month period (2026-08-14) is one entry here.
//
// Pure and DB-free: dev/check_oneoff.js exercises it without a database.
//
// Compatibility contract — the default and the named 7-day period keep
// EXACTLY their historical strings, so existing artifacts, subjects, and
// history sidecars are byte-identical to before this module existed:
//   30 days -> tag "" (no tag) and no subject label
//    7 days -> tag "-7d", label "7-day"
//    N days -> tag "-Nd",  label "N-day"   (unnamed spans, unchanged)
// The 6-month period is the one span whose tag is NOT its day count:
// `-6mo` reads as what was asked for, where `-180d` makes the reader do
// arithmetic. Nothing was archived under `-180d` before today.

const DEFAULT_DAYS = 30;

// Named periods, keyed by their canonical id. `aliases` are the other
// spellings a config file or CLI flag may use; they resolve to the same
// entry so "6mo", "180d", "6-month" and 180 can never diverge.
const PERIODS = {
  "7d": {
    key: "7d",
    days: 7,
    label: "7-day",
    tag: "-7d",
    aliases: ["7", "1w", "week", "weekly"]
  },
  "30d": {
    key: "30d",
    days: DEFAULT_DAYS,
    label: "30-day",
    tag: "",
    aliases: ["30", "1mo", "month", "monthly"]
  },
  "90d": {
    key: "90d",
    days: 90,
    label: "90-day",
    tag: "-90d",
    aliases: ["90", "3mo", "quarter", "quarterly"]
  },
  "6mo": {
    key: "6mo",
    days: 180,
    label: "6-month",
    tag: "-6mo",
    aliases: ["180", "180d", "6month", "6-month", "half-year", "semiannual"]
  }
};

const PERIOD_KEYS = Object.keys(PERIODS);

// spelling (lowercased) -> canonical key, built once.
const BY_ALIAS = new Map();
for (const p of Object.values(PERIODS)) {
  BY_ALIAS.set(p.key, p.key);
  for (const a of p.aliases) BY_ALIAS.set(a, p.key);
}
const BY_DAYS = new Map(Object.values(PERIODS).map((p) => [p.days, p]));

// The public shape of a period. Named entries carry their own tag/label;
// an unnamed day count gets the historical generic forms.
const of_days = (days) => {
  const named = BY_DAYS.get(days);
  if (named) return { key: named.key, days: named.days, label: named.label, tag: named.tag };
  return { key: `${days}d`, days, label: `${days}-day`, tag: `-${days}d` };
};

// A period from a config value: a named key/alias ("6mo"), a bare day
// count (180 or "180"), or an explicit "<n>d". Loud on anything else —
// a typo'd period must never fall back to the 30-day default and silently
// report the wrong span (the same stance cli_args.js takes on --config).
const resolve_period = (spec, at = "period") => {
  const fail = (msg) => {
    throw new Error(
      `${at} invalid: ${msg} — use one of ${PERIOD_KEYS.join(", ")} or a positive day count`
    );
  };
  if (spec === null || spec === undefined) fail("no value given");
  if (typeof spec === "number") {
    if (!Number.isInteger(spec) || spec <= 0) fail(`${JSON.stringify(spec)} is not a positive integer`);
    return of_days(spec);
  }
  if (typeof spec !== "string") fail(`${JSON.stringify(spec)} is not a string or number`);
  const s = spec.trim().toLowerCase();
  if (!s) fail("empty value");
  const key = BY_ALIAS.get(s);
  if (key) return of_days(PERIODS[key].days);
  // "<n>d" / "<n>" — an unnamed span stays expressible; anything past
  // integer precision would silently analyze a different window.
  const m = /^(\d+)d?$/.exec(s);
  if (m) {
    const days = parseInt(m[1], 10);
    if (days <= 0 || !Number.isSafeInteger(days)) fail(`"${spec}" is not a positive day count`);
    return of_days(days);
  }
  fail(`"${spec}" is not a known period`);
};

// Artifact-name tag for an EFFECTIVE batch period. Null (explicit-date
// windows: no chosen period) and the 30-day default both tag nothing.
const period_tag = (days) =>
  days === null || days === undefined || days === DEFAULT_DAYS ? "" : of_days(days).tag;

// Subject-line label, or null when there is nothing to say (default period
// or explicit dates). Callers compose their own separator.
const period_label = (days) =>
  days === null || days === undefined || days === DEFAULT_DAYS ? null : of_days(days).label;

// ---------------------------------------------------------------------------
// Explicit WINDOWS — a report over two chosen instants instead of a period
// ending today. The normalized window (request_loader.js window_of) carries
// { start, end, tz, explicit }: start/end as UTC DateTimes, tz the zone the
// bounds were typed in (and the zone they are spoken in back to the
// reader), explicit true when either bound was given rather than derived.
//
// One wording for a window, used by the cover, the chart headings, the
// summary document, the emails and the activity pages, so a document and
// the email announcing it can never describe the window differently.
// Rolling windows keep their historical rendering everywhere: a rolling
// window is whole UTC days, which span_text renders exactly as the old
// `fmt.day(start) – fmt.day(end)` did.

const { DateTime } = require("luxon");

const ms_of = (t) => (typeof t === "number" ? t : t.toMillis());

// "ET" for any US zone (EDT and EST are the same clock to the reader and a
// window may straddle the change); otherwise luxon's short name ("GMT+1").
const zone_abbr = (dt) => dt.toFormat("ZZZZ").replace(/^([A-Z])[DS]T$/, "$1T");

const is_utc = (tz) => !tz || /^(utc|z|etc\/utc|gmt)$/i.test(tz);

// The window's two ends in its own zone, and whether they fall on whole
// days there. An end exactly at midnight is an exclusive bound — Oct 1
// 00:00 to Oct 2 00:00 is the single day Oct 1 — so it is displayed as the
// day before.
const window_parts = (win) => {
  const zone = is_utc(win.tz) ? "utc" : win.tz;
  const s = DateTime.fromMillis(ms_of(win.start), { zone });
  const e = DateTime.fromMillis(ms_of(win.end), { zone });
  const end_midnight = e.toMillis() === e.startOf("day").toMillis();
  const whole =
    s.toMillis() === s.startOf("day").toMillis() &&
    (end_midnight || e.toMillis() === e.endOf("day").toMillis());
  const last_day = whole && end_midnight ? e.minus({ days: 1 }) : e;
  return { s, e, whole, last_day, utc: zone === "utc" };
};

// "Oct 1 – Oct 31"            whole UTC days (every rolling window)
// "Oct 1 – Oct 31 ET"         whole days in another zone
// "Oct 9 18:00Z – Oct 11 22:00Z"   times, UTC (the brief's own style)
// "Oct 9 14:00 – Oct 11 18:00 ET"  times in another zone
// "Oct 9 14:00 – 18:00 ET"         same day
// opts.year adds the year to the end date (and to the start when the two
// differ) — the activity pages and the brief email name the year.
// opts.caps uppercases and joins with "→" (the brief's chart headings).
// opts.days words only the days the window touches, in its zone, with no
// times or zone ("Oct 9 – Oct 11") — for headings whose one-line budget the
// full span would break; the exact span is stated elsewhere on the page.
const span_text = (win, { year = false, caps = false, days = false } = {}) => {
  const parts = window_parts(win);
  if (days) {
    const { s, e, whole, last_day } = parts;
    const last = whole ? last_day : e;
    const sep = caps ? " → " : " – ";
    const text = s.hasSame(last, "day") ? s.toFormat("LLL d") : `${s.toFormat("LLL d")}${sep}${last.toFormat("LLL d")}`;
    return caps ? text.toUpperCase() : text;
  }
  const { s, e, whole, last_day, utc } = parts;
  const y_end = year ? ", yyyy" : "";
  const y_start = year && s.year !== last_day.year ? ", yyyy" : "";
  const sep = caps ? " → " : " – ";
  let text;
  if (whole) {
    const same = s.hasSame(last_day, "day");
    text = same
      ? last_day.toFormat(`LLL d${y_end}`)
      : `${s.toFormat(`LLL d${y_start}`)}${sep}${last_day.toFormat(`LLL d${y_end}`)}`;
    if (!utc) text += ` ${zone_abbr(s)}`;
  } else {
    const z = utc ? "Z" : "";
    const same = s.hasSame(e, "day");
    const end = same ? e.toFormat("HH:mm") : e.toFormat(`LLL d${y_end} HH:mm`);
    const start = s.toFormat(`LLL d${same ? y_end : y_start} HH:mm`);
    text = `${start}${z}${sep}${end}${z}`;
    if (!utc) text += ` ${zone_abbr(e)}`;
  }
  return caps ? text.toUpperCase() : text;
};

// Artifact tag for a window. Rolling windows keep their period tag; an
// explicit window is tagged by its two ends, in its own zone, so a custom
// window can never overwrite (or pass for) the 30-day brief archived the
// same day:  -20261001-to-20261031   -20261009T1400-to-20261011T1800
const window_tag = (win) => {
  if (!win || !win.explicit) return period_tag(win ? win.lookback_days : null);
  const { s, e, whole, last_day } = window_parts(win);
  return whole
    ? `-${s.toFormat("yyyyMMdd")}-to-${last_day.toFormat("yyyyMMdd")}`
    : `-${s.toFormat("yyyyMMdd'T'HHmm")}-to-${e.toFormat("yyyyMMdd'T'HHmm")}`;
};

// Subject-line label: the span itself for an explicit window (the inbox
// list must say WHICH window), the period label otherwise.
const window_label = (win) => {
  if (!win || !win.explicit) return period_label(win ? win.lookback_days : null);
  return span_text(win, { year: true });
};

module.exports = {
  DEFAULT_DAYS,
  PERIODS,
  PERIOD_KEYS,
  resolve_period,
  period_of_days: of_days,
  period_tag,
  period_label,
  span_text,
  window_tag,
  window_label,
  is_utc
};
