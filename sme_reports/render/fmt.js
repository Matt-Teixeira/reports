const { DateTime } = require("luxon");

// Display formatting for the Magnet Health Brief. Unlike the legacy email
// reports (America/New_York), this report displays UTC with a Z suffix,
// matching the hand-authored exemplars in reports_new/.

const utc = (t) => DateTime.fromMillis(t, { zone: "utc" });

const fmt = {
  // "Jul 21 02:45Z"
  ts: (t) => `${utc(t).toFormat("LLL d HH:mm")}Z`,
  // "02:45Z"
  time: (t) => `${utc(t).toFormat("HH:mm")}Z`,
  // "Jul 21"
  day: (t) => utc(t).toFormat("LLL d"),
  // "JUL 21"
  day_caps: (t) => utc(t).toFormat("LLL d").toUpperCase(),
  // "2026-07-22"
  iso_date: (t) => utc(t).toFormat("yyyy-MM-dd"),
  // "20,000"
  count: (n) => Number(n).toLocaleString("en-US"),
  // fixed decimals
  num: (v, decimals) =>
    v === null || v === undefined ? "—" : Number(v).toFixed(decimals),
  // "+2.8" / "-0.4"
  signed: (v, decimals) =>
    `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(decimals)}`,
  // "~17.5 h"
  hours: (h) => `~${(Math.round(h * 2) / 2).toFixed(1)} h`
};

module.exports = fmt;
