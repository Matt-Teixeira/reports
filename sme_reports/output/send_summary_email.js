const path = require("path");

const build_transporter = require("../../email/build-transporter");
const send_with_retry = require("./send_with_retry");
const {
  COLORS,
  FONT,
  logo_attachment,
  wrap_email,
  themed_table,
  esc,
  fleet_failure_note
} = require("./email_theme");

const {
  attention_sort,
  is_attention,
  is_urgent,
  is_data_issue,
  condition_cell_record
} = require("../conditions");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// One email summarizing every system in a batch run: detected condition per
// system (most severe first) plus any systems that failed to produce a
// report. Body is themed, email-client-safe HTML (table layout, inline
// styles) matching the brief PDFs — see email_theme.js. When the run built a
// fleet summary document it rides along as the single attachment.

const send_summary_email = async (
  run_log,
  job_id,
  batch_email,
  results,
  failures,
  fleet_pdf_path,
  { scope_label = null, lookback_days = null, fleet_error = null } = {}
) => {
  const date = new Date().toISOString().slice(0, 10);
  // Scoped runs lead with WHO the summary covers; non-default periods say
  // so in the subject — a 7-day and a 30-day summary sent the same day
  // must be tellable apart from the inbox list.
  const period = lookback_days && lookback_days !== 30 ? ` — ${lookback_days}-day` : "";
  const subject = `Magnet Health Summary — ${scope_label ? `${scope_label} — ` : ""}${results.length} systems${period} — ${date}`;

  // Grade the distilled record, not the bare archetype: quench and current
  // breach live there, and the attached fleet PDF grades the same way. When
  // the two disagree the reader has no way to tell which count is right.
  const facts_of = (r) => ({ ...(r.summary || {}), archetype: r.archetype });
  const sorted = [...results].sort((a, b) => attention_sort(facts_of(a), facts_of(b)));
  const attention = sorted.filter((r) => is_attention(facts_of(r)));
  const urgent = attention.filter((r) => is_urgent(facts_of(r)));
  const data_issues = sorted.filter((r) => is_data_issue(facts_of(r)));

  const tiers =
    `<b style="color:${COLORS.amber};">${attention.length} need${attention.length === 1 ? "s" : ""} attention</b>` +
    (urgent.length ? `, <b style="color:${COLORS.red};">${urgent.length} urgent</b>` : "") +
    (data_issues.length ? `, <b style="color:${COLORS.grey};">${data_issues.length} data issue${data_issues.length === 1 ? "" : "s"}</b>` : "");
  const headline =
    attention.length || data_issues.length
      ? `<b>${results.length}</b> systems analyzed — ${tiers}.`
      : `<b>${results.length}</b> systems analyzed — no systems need attention.`;

  const columns = [
    { label: "SYSTEM", width: "90" },
    { label: "SITE" },
    { label: "CONDITION", width: "210" }
  ];
  const rows = sorted.map((r) => [
    `<b>${esc(r.system_id)}</b>`,
    `${esc(r.site_name)}<br><span style="font-size:11px;color:${COLORS.grey};">${esc(r.manufacturer)} ${esc(r.modality || "")}</span>`,
    condition_cell_record(facts_of(r))
  ]);

  let body_html =
    `<p style="${FONT}font-size:14px;color:${COLORS.navy};margin:0 0 14px 0;">${headline}</p>` +
    themed_table(columns, rows);

  if (failures && failures.length) {
    // A scoped run's email is customer-facing: failure wording goes
    // through the same whitelist classifier as the scoped PDF (raw
    // messages stay in the run log), so the two can never disagree.
    const { customer_failure_reason } = require("../render/fleet_model");
    const reason_of = (m) => (scope_label ? customer_failure_reason(m) : m);
    body_html +=
      `<p style="${FONT}font-size:13px;color:${COLORS.navy};margin:18px 0 8px 0;"><b>${failures.length} system${failures.length === 1 ? "" : "s"} did not produce a report</b></p>` +
      themed_table(
        [{ label: "SYSTEM", width: "90" }, { label: "REASON" }],
        failures.map((f) => [
          `<b>${esc(f.system_id)}</b>`,
          `<span style="color:${COLORS.grey};">${esc(reason_of(f.message))}</span>`
        ])
      );
  }

  const attachments = [logo_attachment()];
  if (fleet_pdf_path) {
    attachments.push({
      filename: path.basename(fleet_pdf_path),
      path: fleet_pdf_path
    });
    const doc_name = scope_label
      ? `Magnet Health Summary — ${esc(scope_label)}`
      : "Fleet Magnet Health Summary";
    body_html =
      `<p style="${FONT}font-size:13px;color:${COLORS.navy};margin:0 0 12px 0;">` +
      `The attached <b>${doc_name}</b> carries current helium, primary metric, and compressor state for every system below.</p>` +
      body_html;
  } else if (fleet_error) {
    body_html = fleet_failure_note(scope_label, fleet_error) + body_html;
  }

  const message = {
    from: process.env.OUTLOOK_USER,
    to: batch_email.recipients.join(","),
    subject,
    html: wrap_email({ title: "Magnet Health Summary", date, body_html }),
    attachments
  };
  if (batch_email.cc_list.length) message.cc = batch_email.cc_list.join(",");

  const transporter = await build_transporter();
  try {
    const info = await send_with_retry(transporter, message);
    // Log status graded from what SMTP actually reported (round-3 F2):
    // partial rejection resolves successfully, and a flat "SENT" here
    // contradicted the per-recipient sends records.
    const accepted = (info && info.accepted) || [];
    const rejected = (info && info.rejected) || [];
    const status = rejected.length ? (accepted.length ? "PARTIAL" : "ERROR") : "SENT";
    const note = {
      job_id,
      to: message.to,
      systems: results.length,
      attention: attention.map((r) => r.system_id),
      urgent: urgent.map((r) => r.system_id),
      data_issues: data_issues.map((r) => r.system_id),
      fleet_pdf: fleet_pdf_path || null,
      failures: (failures || []).length,
      status,
      accepted,
      rejected,
      response: info && info.response
    };
    await addLogEvent(status === "SENT" ? I : E, run_log, "send_summary_email", det, note, null);
    return info;
  } catch (error) {
    const note = { job_id, to: message.to, status: "ERROR" };
    await addLogEvent(E, run_log, "send_summary_email", cat, note, error);
    throw error;
  }
};

module.exports = send_summary_email;
