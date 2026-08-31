const fmt = require("./fmt");
const { is_centered_band } = require("../compute/summary_facts");
const {
  SEVERITY_ORDER,
  by_severity,
  attention_sort,
  is_attention,
  is_urgent,
  is_data_issue,
  is_limited,
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
// The legend used to be pinned to the bottom of page 1 and cost this budget
// 12 rows; it now closes the document instead (see LEGEND_ROWS and the
// .legend.pin note in fleet_page.js), so the cover got those rows back.
// check_fleet.js measures the real geometry, so a mismatch fails loudly
// instead of clipping rows.
// 25 measured at 100% of the cover's usable height with ONE pixel to spare on
// the live fleet document — passing, but a single-pixel margin on a page whose
// masthead content varies week to week is not a margin. 24 keeps a row's worth.
//
// 23 since 2026-08-14: the cover RESERVES room for a two-line lead sentence.
// At 24 the budget silently assumed the lead fit on one line, and the first
// 6-month fleet document ("155 systems analyzed — 106 need attention, 3
// urgent, 1 limited coverage.") wrapped and pushed its last attention row
// 8px past the footer, where overflow:hidden ate it. Reserving the line
// unconditionally — rather than predicting each document's lead width —
// keeps the row budget a CONSTANT: no font metric, no calibration, and no
// way for a future edit to the sentence's wording to reintroduce the clip.
// The reservation is sound because the lead cannot exceed two lines: even
// with every optional clause at four digits it measures ~1007px against a
// 1440px two-line budget, an invariant check_fleet.js asserts. It costs one
// attention row on covers whose lead does fit; that row is the price of the
// document never clipping one.
const ATTENTION_FIRST_PAGE = 23;
const ATTENTION_PER_PAGE = 24;
const FAILURES_PER_PAGE = 20;

// The legend is pinned above the footer of the LAST page, so the last page
// cannot also carry a full table. This is the MOST ROWS the legend page may
// still carry (reserve_tail re-splits whichever group ends the document so
// its final chunk never exceeds it), measured in Chromium against the
// rendered legend box — not estimated.
// The categorical legend (three captioned columns, term-over-description,
// 2026-08-14) measures 396.6px — 118.7px / 4.4 rows taller than the packed
// column-flow legend (277.9px) that fit beside 12 rows — so the budget
// drops by 5: 7 rows beside the taller box, the extra fraction kept as
// slack. check_fleet's geometry pass measures the real clearance.
const LEGEND_ROWS = 7;

// Re-split a page group's final chunk so it leaves room for the pinned
// legend. One split always suffices: the final chunk is at most a full page,
// so the head is itself under a page.
//
// The split is balanced rather than "shove exactly `tail` onto a new page":
// a 14-row final chunk against a 12-row budget would otherwise become 2 + 12
// and strand a two-row page, so it takes the larger of an even halving and
// the budget — whichever still fits. Capped at `tail`, which is the actual
// constraint.
const reserve_tail = (pages, tail) => {
  if (!pages.length) return pages;
  const out = pages.slice();
  const last = out[out.length - 1];
  if (last.length <= tail) return out;
  const take = Math.min(tail, Math.ceil(last.length / 2));
  out[out.length - 1] = last.slice(0, last.length - take);
  out.push(last.slice(last.length - take));
  return out;
};

// Section order and per-variant column sets. Each variant lists only the
// channels it actually has — Philips has no coldhead, GE has no cabinet,
// only Siemens 10K (non-TIM) has cabinet temperature — so no section carries a column
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
    title: "Siemens (4K)",
    columns: ["system", "site", "condition", "primary", "line", "helium", "coldhead", "compressor"]
  },
  {
    vendor_key: "SIEMENS_NON_TIM",
    title: "Siemens (10K)",
    columns: ["system", "site", "condition", "primary", "line", "helium", "cabinet", "compressor"]
  }
];

// The EDU section's column set, beside SECTIONS so every consumer of "the
// column lists" (fleet_page's widths, dev/solve_widths' derivation, the
// check fixtures) reads ONE source. The section itself is built inline in
// build_fleet_model because its membership is cross-vendor.
const EDU_COLUMNS = ["system", "site", "edu_room", "edu_humidity", "edu_probe_0", "edu_probe_1"];

// The LIMITED-COVERAGE section's column set: identity, the manufacturer,
// and the four stated EDU channels. Deliberately NO condition, limit, or
// judgment column — a limited system is stated, never judged.
const LIMITED_COLUMNS = ["system", "site", "manufacturer", "edu_room", "edu_humidity", "edu_probe_0", "edu_probe_1"];

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
  // The limited-coverage brief refusal (index.js run_one): a per-system
  // brief was requested for a system that has none by design.
  if (/limited coverage/i.test(m))
    return "limited coverage — no per-system report exists; included in summary documents only";
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

// An EDU channel is CURRENT when its last plausible reading falls within a
// day of the period end — the same 24h staleness line the brief's tiles use
// for their "as of <day>" prefix (compute/staleness, the one shared
// constant). Anything older renders dimmed with its date and never drives
// the hottest-room sort.
const { STALE_MS } = require("../compute/staleness");
const edu_channel_fresh = (r, ch) =>
  !!ch && r.window_end - ch.last_t <= STALE_MS;

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
  const all_rows = [...(records || [])];
  // LIMITED-COVERAGE partition (assessment_status): limited rows carry
  // identity + EDU statements only — no archetype, no judgments — and
  // belong to exactly one place, the LIMITED section at the document's
  // tail. Everything below this split (attention, urgency, rollups,
  // vendor sections, the EDU section and its members) is the ASSESSED
  // universe, so a limited row can never leak into a judged surface.
  const limited_rows = all_rows
    .filter((r) => is_limited(r))
    .sort(
      (a, b) =>
        String(a.manufacturer).localeCompare(String(b.manufacturer)) ||
        String(a.system_id).localeCompare(String(b.system_id))
    );
  const rows = all_rows.filter((r) => !is_limited(r));
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

  // PARTITION assertion (never-silent): every analyzed row must land in
  // exactly one section over the section list, because `total` below counts
  // ALL rows — a record whose vendor_key matches no section would be
  // counted in the headline yet appear in no vendor table, silently. The
  // include-filters above make double-membership impossible, so the sum
  // check plus naming the strays is the whole partition. Throwing here
  // soft-fails the summary document (build_fleet_summary isolates it),
  // which is the correct failure: loud and visible, never a shrunk table.
  {
    const sectioned = sections.reduce((n, s) => n + s.count, 0);
    if (sectioned !== rows.length) {
      const known = new Set(SECTIONS.map((s) => s.vendor_key));
      const strays = rows
        .filter((r) => !known.has(r.vendor_key))
        .map((r) => `${r.system_id} ("${r.vendor_key}")`);
      throw new Error(
        `fleet partition violated: ${rows.length} analyzed rows, ${sectioned} sectioned — unsectioned: ${strays.join(", ") || "(none identified — duplicate membership?)"}`
      );
    }
  }

  // Environmental (EDU) section: every analyzed system whose EDU hardware
  // reported this period, regardless of vendor — the channels are the same
  // (°F / %RH) across all EDU generations, so one table serves them all.
  // Hottest CURRENT room first: environmental data is read to find the room
  // that needs the HVAC call, and a sensor that last reported early in the
  // period must not top that list on an old hot reading — stale channels
  // (last plausible reading >24h before the period end, the brief tiles'
  // staleness convention) sort with the unknowns, and render dimmed with an
  // "as of" date. No thresholds are configured for these channels, so the
  // section states readings and judges nothing.
  const edu_members = rows
    .filter((r) => r.edu)
    .sort((a, b) => {
      const ta = edu_channel_fresh(a, a.edu.room_temp)
        ? a.edu.room_temp.last
        : -Infinity;
      const tb = edu_channel_fresh(b, b.edu.room_temp)
        ? b.edu.room_temp.last
        : -Infinity;
      if (ta !== tb) return tb - ta;
      return String(a.system_id).localeCompare(String(b.system_id));
    });
  const edu_section = edu_members.length
    ? {
        vendor_key: "EDU",
        title: "Environmental (EDU)",
        columns: EDU_COLUMNS,
        count: edu_members.length,
        pages: chunk_rows(edu_members, ROWS_FIRST_PAGE, ROWS_PER_PAGE)
      }
    : null;

  // LIMITED-COVERAGE section: identified systems we carry no magnet data
  // adapter for (classify_manufacturer allowlist). Stated, never judged —
  // identity, manufacturer, and EDU environmental readings only; no
  // condition, limit, or judgment column exists in this table. Its EDU
  // readings live HERE, not in the EDU section: the EDU reserve ladder
  // rests on "EDU members are a subset of the vendor-sectioned rows", and
  // limited rows are in no vendor section. Sorted by manufacturer then
  // system id (no judgments exist to rank by).
  {
    const stray = limited_rows.filter((r) => r.vendor_key !== "LIMITED");
    if (stray.length)
      throw new Error(
        `limited-coverage rows must carry vendor_key LIMITED: ${stray.map((r) => `${r.system_id} ("${r.vendor_key}")`).join(", ")}`
      );
  }
  const limited_section = limited_rows.length
    ? {
        vendor_key: "LIMITED",
        title: "Limited coverage — other manufacturers",
        columns: LIMITED_COLUMNS,
        count: limited_rows.length,
        pages: chunk_rows(limited_rows, ROWS_FIRST_PAGE, ROWS_PER_PAGE)
      }
    : null;

  const vendor_rollup = sections.map((s) => ({ title: s.title, count: s.count }));

  // The overview paginates too. The attention list is the actionable part of
  // this document, so it is shown in full rather than truncated with a
  // "+N more" that sends the reader hunting through the vendor sections.
  // ATTENTION_FIRST_PAGE already reserves the cover's second lead line, so
  // this is a plain constant — the budget does not depend on what any
  // particular document's lead sentence measures.
  const attention_pages = chunk_rows(attention, ATTENTION_FIRST_PAGE, ATTENTION_PER_PAGE);
  let data_issue_pages = chunk_rows(data_issues, FAILURES_PER_PAGE, FAILURES_PER_PAGE);
  let failure_pages = chunk_rows(
    expand_failures(group_failures(failed, { customer_facing: !!scope })),
    FAILURES_PER_PAGE,
    FAILURES_PER_PAGE
  );
  let overview_pages = attention_pages.length ? attention_pages : [[]];

  // The exclusion statement rides the last failures page only when vendor
  // sections FOLLOW it — the legend then closes the document pages away.
  // With no sections, that same page would also carry the pinned legend,
  // and a tail-reserved failures page plus the exclusion block measured
  // within pixels of the legend box — so it takes its own page instead.
  // Own pages must be counted HERE or every footer reads "page N of N−1".
  // The block itself is bounded by the loader (≤100 ids, note ≤240 chars),
  // which is what makes "one page, clear of the legend" a fact.
  // fleet_page.js mirrors this placement condition — keep the two in sync.
  const excluded_meta =
    meta.excluded && meta.excluded.ids && meta.excluded.ids.length
      ? meta.excluded
      : null;
  const exclusion_pages =
    excluded_meta && (!failure_pages.length || !sections.length) ? 1 : 0;

  // Reserve the legend's room on whichever group ENDS the document. Page
  // order in fleet_page.js is overview → data issues → failures → exclusions
  // → vendor sections → EDU section → LIMITED section, so the limited
  // section claims the tail whenever it exists, then EDU (whose members are
  // a subset of the vendor-sectioned rows, so it can only exist when vendor
  // sections do), then the last vendor section. The exclusion statement,
  // when it takes its own page, is a heading plus a loader-bounded block
  // (≤100 ids, note ≤240 chars — measured against the pinned legend in
  // check_fleet), so it ends the document without needing the reservation.
  if (limited_section) {
    limited_section.pages = reserve_tail(limited_section.pages, LEGEND_ROWS);
  } else if (edu_section) {
    edu_section.pages = reserve_tail(edu_section.pages, LEGEND_ROWS);
  } else if (sections.length) {
    const last = sections[sections.length - 1];
    last.pages = reserve_tail(last.pages, LEGEND_ROWS);
  } else if (exclusion_pages) {
    // nothing to reserve — the exclusion page ends the document
  } else if (failure_pages.length) failure_pages = reserve_tail(failure_pages, LEGEND_ROWS);
  else if (data_issue_pages.length)
    data_issue_pages = reserve_tail(data_issue_pages, LEGEND_ROWS);
  else overview_pages = reserve_tail(overview_pages, LEGEND_ROWS);

  const page_count =
    overview_pages.length +
    data_issue_pages.length +
    failure_pages.length +
    exclusion_pages +
    sections.reduce((n, s) => n + s.pages.length, 0) +
    (edu_section ? edu_section.pages.length : 0) +
    (limited_section ? limited_section.pages.length : 0);

  // The document's period comes from EVERY successful record — limited
  // rows included (round-4 F2): a limited-only summary carries a real
  // analysis window and possibly EDU readings, and "no data this period"
  // on its cover and footers would be false.
  const window_start = all_rows.length
    ? Math.min(...all_rows.map((r) => r.window_start))
    : null;
  const window_end = all_rows.length
    ? Math.max(...all_rows.map((r) => r.window_end))
    : null;

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
    edu_section,
    limited_section,
    limited_count: limited_rows.length,
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
  edu_channel_fresh,
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
  reserve_tail,
  SECTIONS,
  EDU_COLUMNS,
  LIMITED_COLUMNS,
  ROWS_PER_PAGE,
  ROWS_FIRST_PAGE,
  ATTENTION_FIRST_PAGE,
  ATTENTION_PER_PAGE,
  FAILURES_PER_PAGE,
  LEGEND_ROWS
};
