const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { v4: uuidv4 } = require("uuid");
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
const { period_label } = require("../periods");

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

const { build_fresh_zip } = require("./fresh_zip");

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
  const digest_label = period_label(opts.lookback_days);
  const period = digest_label ? ` — ${digest_label}` : "";
  const part_tag = total_parts > 1 ? ` — part ${part}/${total_parts}` : "";
  const subject = `Magnet Health Summaries — ${opts.total_customers} customer${opts.total_customers === 1 ? "" : "s"}${period}${part_tag} — ${date}`;

  // Honest status (review F6): a system whose report could not be
  // produced is "status unavailable", never silently folded into a
  // reassuring "no systems need attention".
  const rows = chunk.map((u) => {
    const bits = [];
    if (u.counts.attention)
      bits.push(
        `<b style="color:${COLORS.amber};">${u.counts.attention} need${u.counts.attention === 1 ? "s" : ""} attention</b>${u.counts.urgent ? `, <b style="color:${COLORS.red};">${u.counts.urgent} urgent</b>` : ""}`
      );
    if (u.counts.unavailable)
      bits.push(
        `<b style="color:${COLORS.grey};">${u.counts.unavailable} status unavailable</b>`
      );
    if (!bits.length)
      bits.push(`<span style="color:${COLORS.teal};">no systems need attention</span>`);
    return [
      `<b>${esc(u.customer_name)}</b>`,
      `${u.counts.systems} system${u.counts.systems === 1 ? "" : "s"}`,
      bits.join(", ")
    ];
  });
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
  let zip_path = null;
  if (use_zip) {
    const zip_name =
      total_parts > 1
        ? `Magnet-Health-Summaries-${date}-part${part}.zip`
        : `Magnet-Health-Summaries-${date}.zip`;
    zip_path = await build_fresh_zip(
      path.join(opts.out_dir, `digest-${uuidv4().slice(0, 8)}-${zip_name}`),
      chunk.map((u) => u.pdf_path)
    );
    // filename is what the RECIPIENT sees; path is the private unique file.
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

  // SMTP truth is isolated from telemetry (round-3 F1): only the send
  // itself can produce a delivery failure — a logging error after an
  // accepted send must never convert delivered documents into error rows.
  let info;
  try {
    const transporter = await build_transporter();
    info = await send_with_retry(transporter, message);
  } catch (error) {
    await addLogEvent(E, run_log, "send_digest_email", cat, { job_id, to: recipient, part: `${part}/${total_parts}`, status: "ERROR" }, error).catch(() => {});
    throw error;
  } finally {
    // Best-effort cleanup (round-2 F3): the unique zip is consumed by the
    // awaited send above, but a cleanup failure must NEVER convert an
    // SMTP-accepted delivery into an error outcome — log and move on.
    if (zip_path) {
      try {
        fs.rmSync(zip_path, { force: true });
      } catch (cleanup_error) {
        console.error(`digest zip cleanup failed (send outcome unaffected): ${cleanup_error.message}`);
      }
    }
  }
  // Best-effort success/partial telemetry — cannot change the SMTP result.
  try {
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
  } catch (log_error) {
    console.error(`digest send log failed (send outcome unaffected): ${log_error.message}`);
  }
  return info;
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
