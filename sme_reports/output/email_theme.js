const logo_base64 = require("../render/assets/logo");

// Shared theming for the SME report emails, matching the brief PDFs' design
// language (header, gradient band, palette, footer bar).
//
// EMAIL HTML RULES (this is email, not web): table-based layout only, all
// styles inline, no flexbox/grid/position, bgcolor + style doubled up, no
// external assets. The logo ships as a CID inline attachment because most
// clients (Outlook, Gmail) block data: URIs in <img>. border-radius degrades
// gracefully where unsupported.

const COLORS = {
  navy: "#002B43",
  blue: "#004E79",
  light: "#97C6E9",
  fill: "#EBF0F5",
  red: "#E50B14",
  amber: "#C25E00",
  teal: "#00695C",
  grey: "#57585A"
};

const FONT =
  "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;";

const LOGO_CID = "avante-logo";

// Inline attachment for the header logo; include in message.attachments.
const logo_attachment = () => ({
  filename: "avante-logo.png",
  content: Buffer.from(logo_base64, "base64"),
  cid: LOGO_CID,
  contentDisposition: "inline"
});

// Wraps body content in the branded shell: logo header, gradient band,
// content area, navy footer bar.
//
// FLUID-HYBRID width (no media queries — Gmail and Outlook drop or mangle
// them): the shell is a div capped at SHELL_PX and otherwise as wide as the
// screen, so a phone gets a full-width email instead of an 800px page it
// must scroll sideways or zoom out of. A `width="800"` table with
// `max-width:100%` did NOT shrink — Chromium-family and Apple clients honor
// the attribute over the style once the content's minimum width is wide.
// Classic Outlook for Windows (Word renderer) ignores max-width, so a
// conditional ("ghost") table gives it the fixed 800px it always had.
const SHELL_PX = 800;
const GUTTER_PX = 24;
// Width the body content lays out in on a full-width screen — the fluid
// columns in email_status.js split this.
const CONTENT_PX = SHELL_PX - 2 * GUTTER_PX;

const wrap_email = ({ title, date, body_html }) => `
<div style="${FONT}background-color:#f4f6f8;padding:16px 8px;">
<!--[if mso]><table role="presentation" width="${SHELL_PX}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<div style="max-width:${SHELL_PX}px;margin:0 auto;background-color:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#ffffff;" bgcolor="#ffffff">
  <tr>
    <td style="padding:20px ${GUTTER_PX}px 12px ${GUTTER_PX}px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" valign="middle"><img src="cid:${LOGO_CID}" alt="Avante" height="38" style="height:38px;border:0;display:block;"></td>
        <td align="right" valign="middle" style="${FONT}font-size:13px;color:${COLORS.grey};line-height:1.4;">${title}<br><b style="color:${COLORS.navy};">${date}</b></td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding:0 ${GUTTER_PX}px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="30%" height="6" bgcolor="${COLORS.navy}" style="background-color:${COLORS.navy};font-size:1px;line-height:6px;">&nbsp;</td>
        <td width="32%" height="6" bgcolor="${COLORS.blue}" style="background-color:${COLORS.blue};font-size:1px;line-height:6px;">&nbsp;</td>
        <td width="38%" height="6" bgcolor="${COLORS.light}" style="background-color:${COLORS.light};font-size:1px;line-height:6px;">&nbsp;</td>
      </tr></table>
    </td>
  </tr>
  <tr><td style="padding:16px ${GUTTER_PX}px 20px ${GUTTER_PX}px;">${body_html}</td></tr>
  <tr>
    <td bgcolor="${COLORS.navy}" style="background-color:${COLORS.navy};padding:12px ${GUTTER_PX}px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" style="${FONT}font-size:12px;color:#ffffff;">Avante · Moving Healthcare Forward</td>
        <td align="right" style="${FONT}font-size:12px;color:${COLORS.light};">Remote Solutions</td>
      </tr></table>
    </td>
  </tr>
</table>
</div>
<!--[if mso]></td></tr></table><![endif]-->
</div>`;

// Themed data table: header row in navy, zebra-striped body rows.
// columns: [{label, align?, width?}], rows: array of arrays of cell HTML.
const themed_table = (columns, rows) => {
  const head = columns
    .map(
      (c) =>
        `<th align="${c.align || "left"}"${c.width ? ` width="${c.width}"` : ""} style="${FONT}font-size:11px;letter-spacing:1px;color:#ffffff;padding:8px 10px;text-align:${c.align || "left"};">${c.label}</th>`
    )
    .join("");
  const body = rows
    .map(
      (cells, i) =>
        `<tr${i % 2 ? "" : ` bgcolor="${COLORS.fill}" style="background-color:${COLORS.fill};"`}>` +
        cells
          .map(
            (cell, j) =>
              `<td align="${columns[j].align || "left"}" style="${FONT}font-size:13px;color:${COLORS.navy};padding:7px 10px;line-height:1.4;">${cell}</td>`
          )
          .join("") +
        `</tr>`
    )
    .join("");
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
    `<tr bgcolor="${COLORS.navy}" style="background-color:${COLORS.navy};">${head}</tr>${body}</table>`
  );
};

// HTML-escape for every DATABASE- or error-derived string interpolated into
// email bodies (site names, manufacturers, failure messages). "Smith & Sons
// <West>" must arrive as text, not as markup the client swallows.
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

// The statement the summary email carries when the run's fleet document was
// requested but failed to build (review round-2 F1): an absent attachment
// alone reads as "nothing was supposed to be here", which hides the failure
// from the one audience that expected the document. Lives here rather than
// send_summary_email.js so the DB-free check suite can pin both variants
// (requiring the sender pulls in the logger's pg pool). Customer-facing
// (scoped) wording carries no raw error — the same whitelist stance as
// customer_failure_reason; the raw message stays in the run log and the
// internal variant.
const fleet_failure_note = (scope_label, fleet_error) =>
  `<p style="${FONT}font-size:13px;color:${COLORS.red};margin:0 0 12px 0;">` +
  `<b>The ${scope_label ? "Magnet Health Summary document" : "fleet summary document"} for this run could not be generated and is not attached.</b> ` +
  `The condition list below is complete and unaffected.` +
  (scope_label ? "" : ` Error: ${esc(fleet_error)}. The run is recorded as failed.`) +
  `</p>`;

module.exports = {
  COLORS,
  FONT,
  logo_attachment,
  wrap_email,
  CONTENT_PX,
  themed_table,
  esc,
  fleet_failure_note
};
