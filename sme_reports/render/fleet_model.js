const fmt = require("./fmt");
const { is_centered_band } = require("../compute/summary_facts");
const {
  SEVERITY_ORDER,
  by_severity,
  attention_sort,
  is_attention,
  is_urgent,
  is_data_issue,
  effective_status,
  STATUS_LABELS,
  condition_label,
  condition_short,
  condition_color
} = require("../conditions");

// View-model for the fleet summary document. Pure: takes the distilled
// per-system records from compute/summary_facts.js plus the batch failures,
// and returns the rollup and the already-paginated section structure. No
// HTML — render/fleet_page.js does the interpolation.

// Rows that fit on one 11in sheet, derived from the fixed .28in row height
// in fleet_page.js. These were originally set by eye and silently dropped 40
// of 150 systems off the bottom of a real run: overflow:hidden clips without
// complaint, and asserting "page count matches the model" proves nothing when
// the model chose the count. check_fleet.js now measures the real rendered
// geometry instead — re-run it after touching either number or the CSS.
// One row lower than the flat-header era: the vendor tables now carry a
// two-row header (the spanned metric group), which costs roughly 16px a page.
const ROWS_PER_PAGE = 25;
const ROWS_FIRST_PAGE = 23;

// The overview's own budgets: page 1 spends most of its height on the
// headline and the condition rollup, so it holds fewer attention rows than a
// continuation page.
// The pinned legend box claims the bottom of page 1; every time it grows,
// this shrinks — check_fleet.js measures the real geometry, so a mismatch
// fails loudly instead of clipping rows.
const ATTENTION_FIRST_PAGE = 15;
const ATTENTION_PER_PAGE = 24;
const FAILURES_PER_PAGE = 20;

// Section order and per-variant column sets. Each variant lists only the
// channels it actually has — Philips has no coldhead, GE has no cabinet,
// only non-TIM has cabinet temperature — so no section carries a column
// that is dashes all the way down.
const SECTIONS = [
  {
    vendor_key: "PHILIPS",
    title: "Philips",
    columns: ["system", "site", "condition", "primary", "line", "helium", "compressor", "temp_alarm"]
  },
  {
    vendor_key: "GE",
    title: "GE",
    columns: ["system", "site", "condition", "primary", "line", "helium", "coldhead", "shield", "compressor"]
  },
  {
    vendor_key: "SIEMENS",
    title: "Siemens (TIM)",
    columns: ["system", "site", "condition", "primary", "line", "helium", "coldhead", "compressor"]
  },
  {
    vendor_key: "SIEMENS_NON_TIM",
    title: "Siemens (non-TIM)",
    columns: ["system", "site", "condition", "primary", "line", "helium", "cabinet", "compressor"]
  }
];

// The alert limit a section's percentages are measured against. Thresholds
// come from alert.models per system, but in practice they are near-uniform
// within a vendor — every GE system on the fleet shares >5.2 PSI — so the
// number belongs in the section heading rather than a per-row column there
// is no width for. Rows that differ carry their own limit inline.
const limit_key = (r) => `${r.thr_high_gt}|${r.thr_high_lt}|${r.primary_units}`;

const section_limit = (members) => {
  const counts = new Map();
  for (const r of members) {
    if (r.thr_high_gt === null && r.thr_high_lt === null) continue;
    const key = limit_key(r);
    if (!counts.has(key)) counts.set(key, { row: r, n: 0 });
    counts.get(key).n += 1;
  }
  if (!counts.size) return null;
  const ranked = [...counts.values()].sort((a, b) => b.n - a.n);
  const { row } = ranked[0];
  // The heading must describe what the % column actually divides by. Only a
  // CENTERED band is reported as a band; a floor alarm under a one-sided
  // metric (GE's 0.5 under 5.2) still measures against the ceiling, so
  // calling it a band would misdescribe the number beside it.
  const thr = { high_gt: row.thr_high_gt, high_lt: row.thr_high_lt };
  const label = is_centered_band(thr)
    ? `alert band ${row.thr_high_lt}–${row.thr_high_gt} ${row.primary_units}`
    : row.thr_high_gt !== null
      ? `alert limit >${row.thr_high_gt} ${row.primary_units}${row.thr_high_lt !== null ? `, floor ${row.thr_high_lt}` : ""}`
      : `alert floor <${row.thr_high_lt} ${row.primary_units}`;
  return {
    key: limit_key(row),
    label,
    units: row.primary_units,
    // Systems measured against something other than the heading's number.
    exceptions: ranked.slice(1).reduce((n, r) => n + r.n, 0)
  };
};

const chunk_rows = (rows, first, rest) => {
  if (!rows.length) return [];
  const pages = [rows.slice(0, first)];
  for (let i = first; i < rows.length; i += rest) pages.push(rows.slice(i, i + rest));
  return pages;
};

// Worst first within a section, then by how close the primary metric is to
// its own alert line, so the systems nearest trouble sit at the top of each
// vendor's table regardless of which units that vendor reports in.
// One-sided systems rank by % of limit; centered-band systems rank by how
// far the dot sits from the band's center (0 = centered, 100 = at an edge,
// beyond 100 = outside) — both mean "closer to trouble first".
const closeness = (r) => {
  if (r.primary_pct !== null && r.primary_pct !== undefined) return r.primary_pct;
  if (r.primary_band_pos !== null && r.primary_band_pos !== undefined)
    return Math.abs(r.primary_band_pos - 0.5) * 200;
  return -1;
};

const rank_within_section = (a, b) => {
  const severity = by_severity(a, b);
  if (severity !== 0) return severity;
  const ca = closeness(a);
  const cb = closeness(b);
  if (ca !== cb) return cb - ca;
  return String(a.system_id).localeCompare(String(b.system_id));
};

// One short clause explaining why a system is on the attention list, in the
// terms that condition actually turns on.
const attention_reason = (r) => {
  if (r.quenched === true) return "quench state recorded this period";
  // Left-censored and corroborated warm: a real state, but a finished one.
  if (r.offline_kind === "warm") return "off the entire period — magnet already warmᶜ";
  if (r.archetype === "compressor_stop_ongoing")
    return r.primary_event
      ? `compressor off ${fmt.hours(r.primary_event.off_hours)} and not recovered`
      : "compressor off and not recovered";
  if (r.archetype === "compressor_stop_recovered") {
    const each = r.event_count > 1 ? ` across ${r.event_count} events` : "";
    return `off ${fmt.hours(r.off_hours_total)}${each}, recovered`;
  }
  if (r.archetype === "threshold_exceeded") {
    // Explain from the reading that triggered the classification, not from
    // the current one — they are often not the same reading, and quoting the
    // current band state produced "he pressure within its alert band" as the
    // reason a system needed attention.
    const name = r.primary_name.toLowerCase();
    if (
      r.thr_high_gt !== null &&
      r.primary_peak !== null &&
      r.primary_peak >= r.thr_high_gt
    )
      return `${name} peaked at ${fmt.num(r.primary_peak, r.primary_decimals)} ${r.primary_units}${r.primary_breach === "high" ? "" : ", since eased"}`;
    if (
      r.thr_high_lt !== null &&
      r.primary_min !== null &&
      r.primary_min <= r.thr_high_lt
    )
      return `${name} dipped to ${fmt.num(r.primary_min, r.primary_decimals)} ${r.primary_units}${r.primary_breach === "low" ? "" : ", since recovered"}`;
    return `${name} crossed its alert line this period`;
  }
  if (r.archetype === "pressure_rising") {
    const name = r.primary_name.toLowerCase();
    // Band-alerted systems have no percentage by design, so this cannot lean
    // on one — it used to print "trending up at — of its limit" for every
    // rising Siemens TIM system.
    if (r.primary_pct !== null) return `${name} at ${r.primary_pct}% of its limit`;
    if (r.primary_band !== null && r.primary_value !== null)
      return `${name} ${fmt.num(r.primary_value, r.primary_decimals)} ${r.primary_units}, band tops at ${r.thr_high_gt}`;
    if (r.primary_value !== null)
      return `${name} ${fmt.num(r.primary_value, r.primary_decimals)} ${r.primary_units}, no limit set`;
    return `${name} trending up`;
  }
  return condition_label(r.archetype);
};

// Customer-facing failure wording is a WHITELIST, not a rewrite (review
// round-1 F5): known failure classes map to reader-appropriate facts, and
// everything else — thrown SQL errors, identity failures, whatever a
// future code path produces — collapses to a generic line rather than
// leaking internal detail onto a customer page. Raw messages stay in the
// run log. Shared by the scoped PDF and the scoped summary email so the
// two can never disagree.
const customer_failure_reason = (message) => {
  // System-id stripping lives HERE, not in the callers (round-2 F3: the
  // PDF stripped ids before classifying while the email classified the
  // raw message, so the same failure wore two different customer
  // wordings). Both paths call this function with the raw message.
  const m = String(message)
    .replace(/\s*\bfor\s+SME\d+\b/g, "")
    .replace(/\bSME\d+\b/g, "that system");
  if (/^no [A-Z_]+ monitor data\b/.test(m))
    return m.replace(/^no [A-Z_]+ monitor data\b/, "no monitor data received");
  if (/unsupported manufacturer/i.test(m))
    return "unsupported system configuration";
  return "report could not be generated";
};

// Failures collapse to a reason -> systems map: 17 systems with no data in
// the window is one fact, not 17.
const group_failures = (failures, { customer_facing = false } = {}) => {
  const by_reason = new Map();
  for (const f of failures || []) {
    // Reasons embed the system id ("no PHILIPS monitor data for SME01234 in
    // the requested window"). Drop it so identical causes group together —
    // and drop the "for <system>" clause entirely rather than rewriting it to
    // "for that system", since the row already names them in its own column
    // and the reason has to fit on one line.
    const reason = customer_facing
      ? customer_failure_reason(f.message)
      : String(f.message)
          .replace(/\s*\bfor\s+SME\d+\b/g, "")
          .replace(/\bSME\d+\b/g, "that system");
    if (!by_reason.has(reason)) by_reason.set(reason, []);
    by_reason.get(reason).push(f.system_id);
  }
  return [...by_reason.entries()]
    .map(([reason, systems]) => ({ reason, systems, count: systems.length }))
    .sort((a, b) => b.count - a.count);
};

// System ids per failure row. Cells cannot wrap (row height drives
// pagination), so a group of 17 systems has to become several rows rather
// than one row that ellipsises away eleven of them — the whole point of this
// section is knowing WHICH systems produced nothing.
const FAILURE_IDS_PER_ROW = 5;

const expand_failures = (groups) => {
  const rows = [];
  for (const g of groups)
    for (let i = 0; i < g.systems.length; i += FAILURE_IDS_PER_ROW)
      rows.push({
        reason: g.reason,
        count: g.count,
        systems: g.systems.slice(i, i + FAILURE_IDS_PER_ROW),
        first: i === 0
      });
  return rows;
};

// One line saying WHY a system landed in DATA ISSUES, plus the raw readings
// that put it there — raw values always stay visible, so someone can judge
// the sensors rather than take our word for it.
const data_issue_reason = (r) => {
  if (r.sensor_suspect === true)
    return `${r.implausible_count} impossible reading${r.implausible_count === 1 ? "" : "s"} — sensor suspectᶜ`;
  return "off entire period, no magnet responseᶜ";
};

// Split into the readings that failed their bounds (shown first, marked ✕)
// and the ones that passed (shown on the cell's second line for context) —
// one line could not hold a full sensor roster at this column width.
const data_issue_readings = (r) => {
  const bad = [];
  const ok = [];
  const flags = r.data_flags || {};
  const put = (flagged, text) => (flagged ? bad.push(`${text} ✕`) : ok.push(text));
  if (r.primary_value !== null)
    put(flags.primary, `${fmt.num(r.primary_value, r.primary_decimals)} ${r.primary_units}`);
  if (r.helium_value !== null)
    put(flags.helium, `He ${fmt.num(r.helium_value, r.helium_units === "%" ? r.helium_decimals : 0)}${r.helium_units === "%" ? "%" : ` ${r.helium_units}`}`);
  if (r.coldhead_k !== null) put(flags.coldhead, `coldhead ${fmt.num(r.coldhead_k, 1)} K`);
  if (r.shield_k !== null) put(flags.shield, `shield ${fmt.num(r.shield_k, 1)} K`);
  if (r.cabinet_c !== null) put(flags.cabinet, `cabinet ${fmt.num(r.cabinet_c, 1)} °C`);
  if (!bad.length && !ok.length) return { bad: "", ok: "no readings this period" };
  return { bad: bad.join(" · "), ok: ok.join(" · ") };
};

const build_fleet_model = (records, failures, meta = {}) => {
  const rows = [...(records || [])];
  const failed = failures || [];
  // A scoped document (meta.scope = {label, detail} from scope.js) is the
  // customer-facing variant: it titles itself by the scope, states the
  // resolution on the cover, and speaks of "these systems" rather than
  // "the fleet". Everything else — rules, tiers, honesty about failures
  // and exclusions — is identical by construction.
  const scope = meta.scope || null;

  const attention = rows.filter(is_attention).sort(attention_sort);
  const urgent = attention.filter(is_urgent);
  const quenched = rows.filter((r) => r.quenched === true);

  const data_issues = rows
    .filter(is_data_issue)
    .sort((a, b) => (b.implausible_count || 0) - (a.implausible_count || 0));
  const warm_offline = rows.filter((r) => effective_status(r) === "warm_offline");

  // Rollup buckets count each system ONCE, by what its row actually says:
  // overlay states pull their systems out of the archetype buckets, so a
  // dead sensor no longer inflates "COMPRESSOR STOP — ONGOING".
  const bucket_of = (r) => effective_status(r) || r.archetype;
  const BUCKETS = [
    // Short labels: the rollup now runs seven tiles across, and the full
    // "COMPRESSOR STOP — ONGOING" wraps to three lines at that width.
    ...SEVERITY_ORDER.map((a) => ({ key: a, label: condition_short(a), color: condition_color(a) })),
    { key: "warm_offline", label: STATUS_LABELS.warm_offline, color: condition_color("compressor_stop_recovered") },
    { key: "sensor_suspect", label: "DATA ISSUES", color: null },
    { key: "no_signal", label: "DATA ISSUES", color: null }
  ];
  const rollup_map = new Map();
  for (const r of rows) {
    const b = BUCKETS.find((x) => x.key === bucket_of(r));
    const label = b ? b.label : condition_label(r.archetype);
    if (!rollup_map.has(label))
      rollup_map.set(label, { label, color: b ? b.color : null, count: 0 });
    rollup_map.get(label).count += 1;
  }
  const condition_rollup = [...BUCKETS.map((b) => b.label), "?"]
    .filter((label, i, arr) => arr.indexOf(label) === i)
    .map((label) => rollup_map.get(label))
    .filter(Boolean)
    .map((c) => ({ ...c, pct: rows.length ? Math.round((c.count / rows.length) * 100) : 0 }));

  const sections = SECTIONS.map((section) => {
    const members = rows
      .filter((r) => r.vendor_key === section.vendor_key)
      .sort(rank_within_section);
    return {
      ...section,
      count: members.length,
      limit: section_limit(members),
      pages: chunk_rows(members, ROWS_FIRST_PAGE, ROWS_PER_PAGE)
    };
    // Sections with no members are dropped below rather than rendered empty.
  }).filter((s) => s.count > 0);

  const vendor_rollup = sections.map((s) => ({ title: s.title, count: s.count }));

  // The overview paginates too. The attention list is the actionable part of
  // this document, so it is shown in full rather than truncated with a
  // "+N more" that sends the reader hunting through the vendor sections.
  const attention_pages = chunk_rows(attention, ATTENTION_FIRST_PAGE, ATTENTION_PER_PAGE);
  const data_issue_pages = chunk_rows(data_issues, FAILURES_PER_PAGE, FAILURES_PER_PAGE);
  const failure_pages = chunk_rows(
    expand_failures(group_failures(failed, { customer_facing: !!scope })),
    FAILURES_PER_PAGE,
    FAILURES_PER_PAGE
  );
  const overview_pages = attention_pages.length ? attention_pages : [[]];

  // The exclusion statement rides the last failures page when one exists;
  // with no failures it takes its own page (see fleet_page.js), which must
  // be counted HERE or every footer reads "page N of N−1".
  const excluded_meta =
    meta.excluded && meta.excluded.ids && meta.excluded.ids.length
      ? meta.excluded
      : null;
  const exclusion_pages = excluded_meta && !failure_pages.length ? 1 : 0;

  const page_count =
    overview_pages.length +
    data_issue_pages.length +
    failure_pages.length +
    exclusion_pages +
    sections.reduce((n, s) => n + s.pages.length, 0);

  const window_start = rows.length ? Math.min(...rows.map((r) => r.window_start)) : null;
  const window_end = rows.length ? Math.max(...rows.map((r) => r.window_end)) : null;

  return {
    title: scope
      ? `Magnet Health Summary — ${scope.label}`
      : "Fleet Magnet Health Summary",
    scope,
    analyzed_date: meta.analyzed_date || fmt.iso_date(Date.now()),
    window_span:
      window_start === null
        ? "no data this period"
        : `${fmt.day(window_start)} – ${fmt.day(window_end)}`,
    total: rows.length,
    attention,
    attention_count: attention.length,
    urgent_count: urgent.length,
    quenched,
    quench_count: quenched.length,
    condition_rollup,
    vendor_rollup,
    sections,
    overview_pages,
    data_issues,
    data_issue_count: data_issues.length,
    warm_offline_count: warm_offline.length,
    data_issue_pages,
    data_issue_reason,
    data_issue_readings,
    failure_pages,
    failures: group_failures(failed, { customer_facing: !!scope }),
    failure_count: failed.length,
    // Deliberate removals, stated rather than silent: {ids, note} or null.
    excluded: excluded_meta,
    page_count,
    attention_reason
  };
};

module.exports = {
  build_fleet_model,
  customer_failure_reason,
  attention_reason,
  data_issue_reason,
  data_issue_readings,
  group_failures,
  section_limit,
  limit_key,
  expand_failures,
  FAILURE_IDS_PER_ROW,
  chunk_rows,
  SECTIONS,
  ROWS_PER_PAGE,
  ROWS_FIRST_PAGE,
  ATTENTION_FIRST_PAGE,
  ATTENTION_PER_PAGE,
  FAILURES_PER_PAGE
};
