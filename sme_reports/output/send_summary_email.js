const build_transporter = require("../../email/build-transporter");
const send_with_retry = require("./send_with_retry");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// One attachment-free email summarizing every system in a batch run: detected
// condition per system (most severe first) plus any systems that failed to
// produce a report. Standard option for large batches where the PDFs are too
// heavy to email.

const SEVERITY_ORDER = [
  "compressor_stop_ongoing",
  "threshold_exceeded",
  "compressor_stop_recovered",
  "pressure_rising",
  "stable_healthy"
];

const CONDITION_LABELS = {
  compressor_stop_ongoing: "COMPRESSOR STOP — ONGOING",
  threshold_exceeded: "threshold exceeded",
  compressor_stop_recovered: "compressor stop, recovered",
  pressure_rising: "pressure rising",
  stable_healthy: "stable / healthy"
};

const ATTENTION = new Set([
  "compressor_stop_ongoing",
  "threshold_exceeded",
  "pressure_rising"
]);

const send_summary_email = async (run_log, job_id, batch_email, results, failures) => {
  const date = new Date().toISOString().slice(0, 10);
  const subject = `Magnet Health Summary — ${results.length} systems — ${date}`;

  const sorted = [...results].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.archetype) - SEVERITY_ORDER.indexOf(b.archetype)
  );
  const attention = sorted.filter((r) => ATTENTION.has(r.archetype));

  const row = (r) => {
    const label = CONDITION_LABELS[r.archetype] || r.archetype;
    const styled = ATTENTION.has(r.archetype)
      ? `<b style="color:#E50B14">${label}</b>`
      : label;
    return `<li><b>${r.system_id}</b> — ${r.site_name} (${r.manufacturer} ${r.modality || ""}) · ${styled}</li>`;
  };

  let body_html =
    `<p><b>${results.length}</b> Magnet Health Briefs generated` +
    (attention.length
      ? ` — <b style="color:#E50B14">${attention.length} need${attention.length === 1 ? "s" : ""} attention</b>.`
      : ` — no systems need attention.`) +
    `</p><ul>${sorted.map(row).join("")}</ul>`;

  if (failures && failures.length) {
    body_html +=
      `<p><b>${failures.length} system${failures.length === 1 ? "" : "s"} did not produce a report:</b></p>` +
      `<ul>${failures.map((f) => `<li><b>${f.system_id}</b> — ${f.message}</li>`).join("")}</ul>`;
  }
  body_html += `<p>Avante · Remote Solutions</p>`;

  const message = {
    from: process.env.OUTLOOK_USER,
    to: batch_email.recipients.join(","),
    subject,
    html: body_html
  };
  if (batch_email.cc_list.length) message.cc = batch_email.cc_list.join(",");

  const transporter = await build_transporter();
  try {
    const info = await send_with_retry(transporter, message);
    const note = {
      job_id,
      to: message.to,
      systems: results.length,
      attention: attention.map((r) => r.system_id),
      failures: (failures || []).length,
      status: "SENT",
      response: info && info.response
    };
    await addLogEvent(I, run_log, "send_summary_email", det, note, null);
    return info;
  } catch (error) {
    const note = { job_id, to: message.to, status: "ERROR" };
    await addLogEvent(E, run_log, "send_summary_email", cat, note, error);
    throw error;
  }
};

module.exports = send_summary_email;
