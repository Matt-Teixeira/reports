const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const exec_file = promisify(execFile);

const build_transporter = require("../../email/build-transporter");
const send_with_retry = require("./send_with_retry");
const {
  COLORS,
  FONT,
  logo_attachment,
  wrap_email,
  themed_table,
  esc
} = require("./email_theme");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// One digest email per USER carrying their per-customer Magnet Health
// Summary documents (the decided packaging: minimize email count, compress
// when possible). A single document attaches directly; multiple documents
// zip into one archive; only when the PDFs outgrow the message-size budget
// does the digest split into "part n/N" emails — same constants and zip
// tooling as send_batch_email.
//
// Returns [{ unit_keys, info }] — one entry per part, each with the raw
// nodemailer info, so the caller can grade every unit's delivery from
// SMTP's accepted list rather than from a resolved promise.

const CHUNK_PDF_BYTES = 12 * 1024 * 1024;
const SEND_THROTTLE_MS = 1500;

const chunk_units = (units) => {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const u of units) {
    const size = fs.statSync(u.pdf_path).size;
    if (current.length && bytes + size > CHUNK_PDF_BYTES) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(u);
    bytes += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
};

const send_part = async (run_log, job_id, recipient, cc_list, chunk, part, total_parts, opts) => {
  const date = new Date().toISOString().slice(0, 10);
  const period = opts.lookback_days && opts.lookback_days !== 30 ? ` — ${opts.lookback_days}-day` : "";
  const part_tag = total_parts > 1 ? ` — part ${part}/${total_parts}` : "";
  const subject = `Magnet Health Summaries — ${opts.total_customers} customer${opts.total_customers === 1 ? "" : "s"}${period}${part_tag} — ${date}`;

  const rows = chunk.map((u) => [
    `<b>${esc(u.customer_name)}</b>`,
    `${u.counts.systems} system${u.counts.systems === 1 ? "" : "s"}`,
    u.counts.attention
      ? `<b style="color:${COLORS.amber};">${u.counts.attention} need${u.counts.attention === 1 ? "s" : ""} attention</b>${u.counts.urgent ? `, <b style="color:${COLORS.red};">${u.counts.urgent} urgent</b>` : ""}`
      : `<span style="color:${COLORS.teal};">no systems need attention</span>`
  ]);
  const use_zip = chunk.length > 1;
  const body_html =
    `<p style="${FONT}font-size:14px;color:${COLORS.navy};margin:0 0 14px 0;">Attached ${use_zip ? "(bundled as a zip) " : ""}are your Magnet Health Summaries for <b>${chunk.length}</b> of ${opts.total_customers} customer${opts.total_customers === 1 ? "" : "s"}${part_tag}.</p>` +
    themed_table(
      [
        { label: "CUSTOMER" },
        { label: "SYSTEMS", width: "90" },
        { label: "STATUS", width: "220" }
      ],
      rows
    );

  let attachments;
  if (use_zip) {
    const zip_name =
      total_parts > 1
        ? `Magnet-Health-Summaries-${date}-part${part}.zip`
        : `Magnet-Health-Summaries-${date}.zip`;
    const zip_path = path.join(opts.out_dir, zip_name);
    await exec_file("zip", ["-j", "-o", zip_path, ...chunk.map((u) => u.pdf_path)]);
    attachments = [{ filename: zip_name, path: zip_path }];
  } else {
    attachments = chunk.map((u) => ({
      filename: path.basename(u.pdf_path),
      path: u.pdf_path
    }));
  }

  const message = {
    from: process.env.OUTLOOK_USER,
    to: recipient,
    subject,
    html: wrap_email({ title: `Magnet Health Summaries${part_tag}`, date, body_html }),
    attachments: [logo_attachment(), ...attachments]
  };
  if (cc_list && cc_list.length) message.cc = cc_list.join(",");

  const transporter = await build_transporter();
  try {
    const info = await send_with_retry(transporter, message);
    const accepted = (info && info.accepted) || [];
    const rejected = (info && info.rejected) || [];
    const status = rejected.length ? (accepted.length ? "PARTIAL" : "ERROR") : "SENT";
    const note = {
      job_id,
      to: recipient,
      part: `${part}/${total_parts}`,
      customers: chunk.map((u) => u.customer_name),
      zipped: use_zip,
      status,
      accepted,
      rejected,
      response: info && info.response
    };
    await addLogEvent(status === "SENT" ? I : E, run_log, "send_digest_email", det, note, null);
    return info;
  } catch (error) {
    const note = { job_id, to: recipient, part: `${part}/${total_parts}`, status: "ERROR" };
    await addLogEvent(E, run_log, "send_digest_email", cat, note, error);
    throw error;
  }
};

// units: [{ key, customer_name, pdf_path, counts: {systems, attention, urgent} }]
const send_digest_email = async (run_log, job_id, recipient, cc_list, units, opts) => {
  const chunks = chunk_units(units);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
    let info = null;
    let error = null;
    try {
      info = await send_part(run_log, job_id, recipient, cc_list, chunks[i], i + 1, chunks.length, {
        ...opts,
        total_customers: units.length
      });
    } catch (e) {
      error = e;
    }
    parts.push({ unit_keys: chunks[i].map((u) => u.key), info, error: error ? error.message : null });
  }
  return parts;
};

module.exports = send_digest_email;
