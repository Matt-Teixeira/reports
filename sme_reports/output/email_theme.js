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
// content area, navy footer bar. 640px centered, fluid below that.
const wrap_email = ({ title, date, body_html }) => `
<div style="${FONT}background-color:#f4f6f8;padding:16px 8px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:640px;max-width:100%;background-color:#ffffff;" bgcolor="#ffffff">
  <tr>
    <td style="padding:20px 24px 12px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" valign="middle"><img src="cid:${LOGO_CID}" alt="Avante" height="38" style="height:38px;border:0;display:block;"></td>
        <td align="right" valign="middle" style="${FONT}font-size:13px;color:${COLORS.grey};line-height:1.4;">${title}<br><b style="color:${COLORS.navy};">${date}</b></td>
      </tr></table>
    </td>
  </tr>
  <tr>
    <td style="padding:0 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="30%" height="6" bgcolor="${COLORS.navy}" style="background-color:${COLORS.navy};font-size:1px;line-height:6px;">&nbsp;</td>
        <td width="32%" height="6" bgcolor="${COLORS.blue}" style="background-color:${COLORS.blue};font-size:1px;line-height:6px;">&nbsp;</td>
        <td width="38%" height="6" bgcolor="${COLORS.light}" style="background-color:${COLORS.light};font-size:1px;line-height:6px;">&nbsp;</td>
      </tr></table>
    </td>
  </tr>
  <tr><td style="padding:16px 24px 20px 24px;">${body_html}</td></tr>
  <tr>
    <td bgcolor="${COLORS.navy}" style="background-color:${COLORS.navy};padding:12px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="left" style="${FONT}font-size:12px;color:#ffffff;">Avante · Moving Healthcare Forward</td>
        <td align="right" style="${FONT}font-size:12px;color:${COLORS.light};">Remote Solutions</td>
      </tr></table>
    </td>
  </tr>
</table>
</td></tr></table>
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
  themed_table,
  esc,
  fleet_failure_note
};
