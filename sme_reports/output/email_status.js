const { COLORS, FONT, themed_table, esc } = require("./email_theme");
const {
  attention_sort,
  is_attention,
  is_data_issue,
  is_limited,
  condition_cell_record
} = require("../conditions");

// The per-system status block shared by the summary and batch emails,
// grouped by what the reader has to do about each system:
//
//   FLAGGED          full table — needs attention, urgent, data issues, and
//                    systems that produced no report (summary email only)
//   STABLE / HEALTHY two-up grid — identity only; the heading is the verdict
//   LIMITED COVERAGE two-up grid — stated, never judged (conditions.js)
//
// One long three-column table put the handful of systems worth reading
// between thirty "stable / healthy" rows, each wrapped to two or three lines
// in a 640px shell. The healthy list carries one fact, so it gets half the
// row height; the flagged rows keep every column.

const facts_of = (r) => ({ ...(r.summary || {}), archetype: r.archetype });

const make_of = (r) => `${esc(r.manufacturer)} ${esc(r.modality || "")}`.trim();

const section = (label, n) =>
  `<p style="${FONT}font-size:11px;letter-spacing:1px;font-weight:700;color:${COLORS.blue};margin:18px 0 6px 0;">` +
  `${label} <span style="color:${COLORS.grey};font-weight:400;letter-spacing:0;">· ${n}</span></p>`;

const RULE = "border-bottom:1px solid #E6EAEE;";

// Two systems per row, read left to right. A trailing odd cell is padded so
// the rule under the last row still spans the table.
const grid = (records) => {
  const cell = (r) =>
    r
      ? `<td width="50%" valign="top" style="${FONT}${RULE}padding:7px 10px;line-height:1.35;">` +
        `<b style="font-size:13px;color:${COLORS.navy};">${esc(r.system_id)}</b> ` +
        `<span style="font-size:11px;color:${COLORS.grey};">${make_of(r)}</span><br>` +
        `<span style="font-size:12px;color:${COLORS.navy};">${esc(r.site_name)}</span></td>`
      : `<td width="50%" style="${RULE}">&nbsp;</td>`;
  let rows = "";
  for (let i = 0; i < records.length; i += 2)
    rows += `<tr>${cell(records[i])}${cell(records[i + 1])}</tr>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">${rows}</table>`;
};

// failures: [{ system_id, message }] — systems that produced no report.
// reason_of maps a raw failure message to the wording this audience sees
// (the customer whitelist on scoped runs; identity on internal ones).
const status_html = (results, { failures = [], reason_of = (m) => m } = {}) => {
  const sorted = [...results].sort((a, b) => attention_sort(facts_of(a), facts_of(b)));
  const flagged = sorted.filter((r) => is_attention(facts_of(r)) || is_data_issue(facts_of(r)));
  const limited = sorted.filter((r) => is_limited(facts_of(r)));
  // STABLE / HEALTHY is a verdict, so it is earned by name: a record with no
  // archetype or one outside the vocabulary is never filed as healthy by
  // falling through the filters above. It is flagged, stated as unclassified.
  const rest = sorted.filter((r) => !flagged.includes(r) && !limited.includes(r));
  const stable = rest.filter((r) => r.archetype === "stable_healthy");
  const unclassified = rest.filter((r) => r.archetype !== "stable_healthy");

  let html = "";
  const flagged_n = flagged.length + unclassified.length + failures.length;
  if (flagged_n)
    html +=
      section("FLAGGED", flagged_n) +
      themed_table(
        [
          { label: "SYSTEM", width: "100" },
          { label: "SITE" },
          { label: "MAKE", width: "100" },
          { label: "CONDITION", width: "210" }
        ],
        [
          ...flagged.map((r) => [
            `<b>${esc(r.system_id)}</b>`,
            esc(r.site_name),
            `<span style="font-size:12px;color:${COLORS.grey};">${make_of(r)}</span>`,
            condition_cell_record(facts_of(r))
          ]),
          ...unclassified.map((r) => [
            `<b>${esc(r.system_id)}</b>`,
            esc(r.site_name),
            `<span style="font-size:12px;color:${COLORS.grey};">${make_of(r)}</span>`,
            `<span style="color:${COLORS.grey};">not classified</span>`
          ]),
          ...failures.map((f) => [
            `<b>${esc(f.system_id)}</b>`,
            `<span style="color:${COLORS.grey};">${esc(reason_of(f.message))}</span>`,
            "",
            `<b style="color:${COLORS.grey};">no report</b>`
          ])
        ]
      );
  // Every cell here would repeat the same label, so the heading states it.
  if (stable.length) html += section("STABLE / HEALTHY", stable.length) + grid(stable);
  if (limited.length) html += section("LIMITED COVERAGE", limited.length) + grid(limited);
  return html;
};

module.exports = { status_html };
