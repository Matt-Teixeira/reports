const path = require("path");
const build_transporter = require("../../email/build-transporter");
const send_with_retry = require("./send_with_retry");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// Sends the Magnet Health Brief as a PDF attachment with a short HTML body.
// Deliberately separate from email/send_email.js, which is hard-wired to the
// alert.reports flow (html-only body + alert.notifications status updates).

const send_report_email = async (run_log, job_id, request, identity, pdf_path) => {
  const subject = `Magnet Health Brief — ${identity.system_id} — ${identity.site_name}`;
  const body_html =
    `<p>Attached is the one-page Magnet Health Brief for ` +
    `<b>${identity.system_id}</b> (${identity.site_name} — ${identity.manufacturer} ${identity.modality || ""}).</p>` +
    `<p>Data window: ${request.window.start.toFormat("yyyy-MM-dd")} to ${request.window.end.toFormat("yyyy-MM-dd")}.</p>` +
    `<p>Avante · Remote Solutions</p>`;

  const message = {
    from: process.env.OUTLOOK_USER,
    to: request.recipients.join(","),
    subject,
    html: body_html,
    attachments: [{ filename: path.basename(pdf_path), path: pdf_path }]
  };
  if (request.cc_list.length) message.cc = request.cc_list.join(",");

  const transporter = await build_transporter();
  try {
    const info = await send_with_retry(transporter, message);
    const note = {
      job_id,
      system_id: identity.system_id,
      to: message.to,
      cc: message.cc || null,
      status: "SENT",
      response: info && info.response
    };
    await addLogEvent(I, run_log, "send_report_email", det, note, null);
    return info;
  } catch (error) {
    const note = { job_id, system_id: identity.system_id, to: message.to, status: "ERROR" };
    await addLogEvent(E, run_log, "send_report_email", cat, note, error);
    throw error;
  }
};

module.exports = send_report_email;
