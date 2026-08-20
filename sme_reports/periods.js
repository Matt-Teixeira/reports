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

module.exports = {
  DEFAULT_DAYS,
  PERIODS,
  PERIOD_KEYS,
  resolve_period,
  period_of_days: of_days,
  period_tag,
  period_label
};
