const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const exec_file = promisify(execFile);

const build_transporter = require("../../email/build-transporter");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// Sends one email carrying every generated brief. Attaches the PDFs
// individually by default; batch_email.zip = true bundles them into a single
// zip archive (uses the system `zip` binary, -j strips directory paths).

const send_batch_email = async (run_log, job_id, batch_email, results, out_dir) => {
  const date = new Date().toISOString().slice(0, 10);
  const subject = `Magnet Health Briefs — ${results.length} systems — ${date}`;

  const rows = results
    .map(
      (r) =>
        `<li><b>${r.system_id}</b> — ${r.site_name} (${r.manufacturer} ${r.modality || ""}) · ${r.archetype.replace(/_/g, " ")}</li>`
    )
    .join("");
  const body_html =
    `<p>Attached are the one-page Magnet Health Briefs for ${results.length} systems:</p>` +
    `<ul>${rows}</ul><p>Avante · Remote Solutions</p>`;

  let attachments;
  if (batch_email.zip) {
    const zip_path = path.join(out_dir, `Magnet-Health-Briefs-${date}.zip`);
    await exec_file("zip", ["-j", "-o", zip_path, ...results.map((r) => r.pdf_path)]);
    attachments = [{ filename: path.basename(zip_path), path: zip_path }];
  } else {
    attachments = results.map((r) => ({
      filename: path.basename(r.pdf_path),
      path: r.pdf_path
    }));
  }

  const message = {
    from: process.env.OUTLOOK_USER,
    to: batch_email.recipients.join(","),
    subject,
    html: body_html,
    attachments
  };
  if (batch_email.cc_list.length) message.cc = batch_email.cc_list.join(",");

  const transporter = await build_transporter();
  try {
    const info = await transporter.sendMail(message);
    const note = {
      job_id,
      to: message.to,
      systems: results.map((r) => r.system_id),
      zipped: batch_email.zip,
      status: "SENT",
      response: info && info.response
    };
    await addLogEvent(I, run_log, "send_batch_email", det, note, null);
    return info;
  } catch (error) {
    const note = { job_id, to: message.to, status: "ERROR" };
    await addLogEvent(E, run_log, "send_batch_email", cat, note, error);
    throw error;
  }
};

module.exports = send_batch_email;
