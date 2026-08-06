const fs = require("fs");
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

// Sends the generated briefs by email. Small batches attach the PDFs
// individually; batches larger than AUTO_ZIP_THRESHOLD are bundled into a
// zip (batch_email.zip = true forces zipping for any size). Batches whose
// PDFs exceed CHUNK_PDF_BYTES are split across multiple "part n/N" emails so
// each stays under the O365 message-size limit (~25 MB after base64 growth).

const AUTO_ZIP_THRESHOLD = 4;
const CHUNK_PDF_BYTES = 12 * 1024 * 1024;
const SEND_THROTTLE_MS = 1500;

const chunk_by_size = (results) => {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const r of results) {
    const size = fs.statSync(r.pdf_path).size;
    if (current.length && bytes + size > CHUNK_PDF_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(r);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
};

const send_one = async (run_log, job_id, batch_email, chunk, out_dir, part, total_parts, total_systems) => {
  const date = new Date().toISOString().slice(0, 10);
  const part_tag = total_parts > 1 ? ` — part ${part}/${total_parts}` : "";
  const subject = `Magnet Health Briefs — ${total_systems} systems${part_tag} — ${date}`;
  const use_zip = batch_email.zip || chunk.length > AUTO_ZIP_THRESHOLD;

  const rows = chunk
    .map(
      (r) =>
        `<li><b>${r.system_id}</b> — ${r.site_name} (${r.manufacturer} ${r.modality || ""}) · ${r.archetype.replace(/_/g, " ")}</li>`
    )
    .join("");
  const body_html =
    `<p>Attached are the one-page Magnet Health Briefs for ${chunk.length} of ${total_systems} systems${use_zip ? " (bundled as a zip)" : ""}${part_tag}:</p>` +
    `<ul>${rows}</ul><p>Avante · Remote Solutions</p>`;

  let attachments;
  if (use_zip) {
    const zip_name =
      total_parts > 1
        ? `Magnet-Health-Briefs-${date}-part${part}.zip`
        : `Magnet-Health-Briefs-${date}.zip`;
    const zip_path = path.join(out_dir, zip_name);
    await exec_file("zip", ["-j", "-o", zip_path, ...chunk.map((r) => r.pdf_path)]);
    attachments = [{ filename: zip_name, path: zip_path }];
  } else {
    attachments = chunk.map((r) => ({
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
      part: `${part}/${total_parts}`,
      systems: chunk.map((r) => r.system_id),
      zipped: use_zip,
      status: "SENT",
      response: info && info.response
    };
    await addLogEvent(I, run_log, "send_batch_email", det, note, null);
    return info;
  } catch (error) {
    const note = { job_id, to: message.to, part: `${part}/${total_parts}`, status: "ERROR" };
    await addLogEvent(E, run_log, "send_batch_email", cat, note, error);
    throw error;
  }
};

const send_batch_email = async (run_log, job_id, batch_email, results, out_dir) => {
  const chunks = chunk_by_size(results);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
    await send_one(
      run_log,
      job_id,
      batch_email,
      chunks[i],
      out_dir,
      i + 1,
      chunks.length,
      results.length
    );
  }
  return { parts: chunks.length };
};

module.exports = send_batch_email;
