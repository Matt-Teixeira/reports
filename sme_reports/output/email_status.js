const { COLORS, FONT, CONTENT_PX, esc } = require("./email_theme");
const {
  attention_sort,
  is_attention,
  is_data_issue,
  is_limited,
  condition_status
} = require("../conditions");

// The per-system status block shared by the summary and batch emails,
// grouped by what the reader has to do about each system:
//
//   FLAGGED          one card per system — the condition, then the system,
//                    site and make, then WHY (the summary document's reason).
//                    Needs attention, urgent, data issues, unclassified, and
//                    systems that produced no report (summary email only).
//   STABLE / HEALTHY a compact list in flowing columns — identity only; the
//                    heading is the verdict
//   LIMITED COVERAGE the same list — stated, never judged (conditions.js)
//
// Layout is FLUID, not fixed: email clients give no reliable media queries,
// so nothing here depends on one.
//   - A flagged card is a single full-width cell. It has no columns to
//     squeeze, so it reads the same at 800px and on a phone. (It replaced a
//     four-column table whose columns could only shrink or overflow.)
//   - The lists split into two halves, each an inline-block column capped
//     at half the content width: side by side when the screen is wide,
//     stacked when it is not. The split is by HALVES, so reading down the
//     left column then the right — or down the single stacked column on a
//     phone — is always the sorted order. Classic Outlook (Word renderer)
//     ignores inline-block widths, so a conditional "ghost" table gives it
//     the same two columns.

const facts_of = (r) => ({ ...(r.summary || {}), archetype: r.archetype });

const make_of = (r) => `${esc(r.manufacturer)} ${esc(r.modality || "")}`.trim();

const section = (label, n) =>
  `<p style="${FONT}font-size:11px;letter-spacing:1px;font-weight:700;color:${COLORS.blue};margin:20px 0 8px 0;">` +
  `${label} <span style="color:${COLORS.grey};font-weight:400;letter-spacing:0;">· ${n}</span></p>`;

const CARD_FILL = "#F5F8FA";

// The shared condition vocabulary is lowercase ("compressor stop,
// recovered") because it sits mid-sentence and in table cells. As a card's
// heading it starts a line, so only its first letter is raised; urgent
// labels are already upper case.
const heading_case = (label) => label.charAt(0).toUpperCase() + label.slice(1);

// One flagged system. accent: the condition's color, carried by the bar on
// the left so a reader scanning the edge sees red / amber / grey first.
const card = ({ accent, label, strong, mark, ident, why }) =>
  `<tr><td bgcolor="${CARD_FILL}" style="background-color:${CARD_FILL};border-left:4px solid ${accent};padding:9px 14px 10px 12px;">` +
  `<div style="${FONT}font-size:14px;line-height:1.35;color:${accent};font-weight:${strong ? 700 : 600};">${heading_case(label)}${mark ? "<sup>c</sup>" : ""}</div>` +
  `<div style="${FONT}font-size:13px;line-height:1.45;color:${COLORS.navy};margin-top:2px;">${ident}</div>` +
  (why ? `<div style="${FONT}font-size:12px;line-height:1.45;color:${COLORS.grey};margin-top:1px;">${why}</div>` : "") +
  `</td></tr>` +
  `<tr><td height="6" style="font-size:0;line-height:6px;">&nbsp;</td></tr>`;

const cards = (items) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">${items.join("")}</table>`;

const ident_of = (r) =>
  `<b>${esc(r.system_id)}</b>&nbsp;&nbsp;${esc(r.site_name)}` +
  ` <span style="font-size:12px;color:${COLORS.grey};white-space:nowrap;">· ${make_of(r)}</span>`;

// The reason the summary document gives in its WHY column, so the email
// and the attached document explain a system the same way.
//
// Supplementary, so it may be absent but may never sink the email: the
// summary email is what STATES a failed summary document (fleet_failure_
// note), and a record malformed enough to break the document's reason
// wording must not take the email down with it. The card still states the
// condition, which is the verdict; only the elaboration is dropped.
const why_of = (facts) => {
  const { attention_reason, data_issue_reason } = require("../render/fleet_model");
  try {
    const text = is_data_issue(facts) ? data_issue_reason(facts) : attention_reason(facts);
    return text ? esc(text) : "";
  } catch (error) {
    return "";
  }
};

// A compact list in two flowing columns (see header). Each item is the
// system id, its make, and its site.
const COL_PX = Math.floor(CONTENT_PX / 2);

// Each item sets its own font size: the column wrapper's font-size:0 (which
// closes the gap between the columns) would otherwise shrink the space
// between the system id and its make to nothing, and zero the line height.
const list_item = (r) =>
  `<div style="${FONT}font-size:13px;padding:0 12px 9px 0;line-height:1.35;">` +
  `<b style="font-size:13px;color:${COLORS.navy};">${esc(r.system_id)}</b>` +
  ` <span style="font-size:11px;color:${COLORS.grey};">${make_of(r)}</span><br>` +
  `<span style="font-size:12px;color:${COLORS.navy};">${esc(r.site_name)}</span></div>`;

const column = (records) =>
  `<div class="col" style="display:inline-block;width:100%;max-width:${COL_PX}px;vertical-align:top;">${records.map(list_item).join("")}</div>`;

const flowing_list = (records) => {
  const half = Math.ceil(records.length / 2);
  const left = records.slice(0, half);
  const right = records.slice(half);
  if (!right.length) return `<div style="font-size:0;line-height:0;">${column(left)}</div>`;
  return (
    // font-size:0 removes the whitespace gap inline-blocks would otherwise
    // leave between the columns (it would push the right one to the next
    // line at full width). Items set their own font sizes.
    `<div style="font-size:0;line-height:0;">` +
    `<!--[if mso]><table role="presentation" width="${CONTENT_PX}" cellpadding="0" cellspacing="0" border="0"><tr><td width="${COL_PX}" valign="top"><![endif]-->` +
    column(left) +
    `<!--[if mso]></td><td width="${COL_PX}" valign="top"><![endif]-->` +
    column(right) +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</div>`
  );
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
      cards([
        ...flagged.map((r) => {
          const f = facts_of(r);
          const s = condition_status(f);
          return card({ accent: s.color, label: s.label, strong: s.strong, mark: s.mark, ident: ident_of(r), why: why_of(f) });
        }),
        ...unclassified.map((r) =>
          card({ accent: COLORS.grey, label: "not classified", strong: false, mark: false, ident: ident_of(r), why: "" })
        ),
        ...failures.map((f) =>
          card({
            accent: COLORS.grey,
            label: "no report",
            strong: true,
            mark: false,
            ident: `<b>${esc(f.system_id)}</b>`,
            why: esc(reason_of(f.message))
          })
        )
      ]);
  // Every item here would repeat the same label, so the heading states it.
  if (stable.length) html += section("STABLE / HEALTHY", stable.length) + flowing_list(stable);
  if (limited.length) html += section("LIMITED COVERAGE", limited.length) + flowing_list(limited);
  return html;
};

module.exports = { status_html };
