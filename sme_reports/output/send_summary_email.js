const build_transporter = require("../../email/build-transporter");
const send_with_retry = require("./send_with_retry");
const {
  COLORS,
  FONT,
  logo_attachment,
  wrap_email,
  themed_table
} = require("./email_theme");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// One attachment-free email summarizing every system in a batch run: detected
// condition per system (most severe first) plus any systems that failed to
// produce a report. Body is themed, email-client-safe HTML (table layout,
// inline styles) matching the brief PDFs — see email_theme.js.

const SEVERITY_ORDER = [
  "compressor_stop_ongoing",
  "threshold_exceeded",
  "compressor_stop_recovered",
  "pressure_rising",
  "stable_healthy"
];

const CONDITION_LABELS = {
  compressor_stop_ongoing: "COMPRESSOR STOP — ONGOING",
  threshold_exceeded: "THRESHOLD EXCEEDED",
  compressor_stop_recovered: "compressor stop, recovered",
  pressure_rising: "pressure rising",
  stable_healthy: "stable / healthy"
};

const ATTENTION = new Set([
  "compressor_stop_ongoing",
  "threshold_exceeded",
  "pressure_rising"
]);

const condition_cell = (archetype) => {
  const label = CONDITION_LABELS[archetype] || archetype;
  if (ATTENTION.has(archetype))
    return `<b style="color:${COLORS.red};">${label}</b>`;
  if (archetype === "compressor_stop_recovered")
    return `<span style="color:${COLORS.amber};">${label}</span>`;
  return `<span style="color:${COLORS.teal};">${label}</span>`;
};

const send_summary_email = async (run_log, job_id, batch_email, results, failures) => {
  const date = new Date().toISOString().slice(0, 10);
  const subject = `Magnet Health Summary — ${results.length} systems — ${date}`;

  const sorted = [...results].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.archetype) - SEVERITY_ORDER.indexOf(b.archetype)
  );
  const attention = sorted.filter((r) => ATTENTION.has(r.archetype));

  const headline = attention.length
    ? `<b>${results.length}</b> Magnet Health Briefs generated — <b style="color:${COLORS.red};">${attention.length} need${attention.length === 1 ? "s" : ""} attention</b>.`
    : `<b>${results.length}</b> Magnet Health Briefs generated — no systems need attention.`;

  const columns = [
    { label: "SYSTEM", width: "90" },
    { label: "SITE" },
    { label: "CONDITION", width: "210" }
  ];
  const rows = sorted.map((r) => [
    `<b>${r.system_id}</b>`,
    `${r.site_name}<br><span style="font-size:11px;color:${COLORS.grey};">${r.manufacturer} ${r.modality || ""}</span>`,
    condition_cell(r.archetype)
  ]);

  let body_html =
    `<p style="${FONT}font-size:14px;color:${COLORS.navy};margin:0 0 14px 0;">${headline}</p>` +
    themed_table(columns, rows);

  if (failures && failures.length) {
    body_html +=
      `<p style="${FONT}font-size:13px;color:${COLORS.navy};margin:18px 0 8px 0;"><b>${failures.length} system${failures.length === 1 ? "" : "s"} did not produce a report</b></p>` +
      themed_table(
        [{ label: "SYSTEM", width: "90" }, { label: "REASON" }],
        failures.map((f) => [
          `<b>${f.system_id}</b>`,
          `<span style="color:${COLORS.grey};">${f.message}</span>`
        ])
      );
  }

  const message = {
    from: process.env.OUTLOOK_USER,
    to: batch_email.recipients.join(","),
    subject,
    html: wrap_email({ title: "Magnet Health Summary", date, body_html }),
    attachments: [logo_attachment()]
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
