const build_transporter = require("../../email/build-transporter");
const send_with_retry = require("./send_with_retry");
const { COLORS, FONT, logo_attachment, wrap_email, esc } = require("./email_theme");

const [addLogEvent] = require("../../utils/logger/log");
const {
  type: { I, E },
  tag: { det, cat }
} = require("../../utils/logger/enums");

// Parts 2..N of a summary's System Activity zip (incident/system_pages.js).
// Part 1 rides on the summary email itself; these follow it, one zip each,
// to the same recipients, throttled like send_batch_email.

const SEND_THROTTLE_MS = 1500;

const send_activity_parts = async (run_log, job_id, batch_email, zips, { subject_base }) => {
  const date = new Date().toISOString().slice(0, 10);
  for (const z of zips) {
    await new Promise((r) => setTimeout(r, SEND_THROTTLE_MS));
    const part_tag = `part ${z.part}/${z.parts}`;
    const body_html =
      `<p style="${FONT}font-size:14px;color:${COLORS.navy};margin:0 0 10px 0;">` +
      `System Activity pages, ${part_tag}: <b>${z.systems.length}</b> system${z.systems.length === 1 ? "" : "s"} (${z.systems.map(esc).join(", ")}). ` +
      `Open the pages in a web browser.</p>`;
    const message = {
      from: process.env.OUTLOOK_USER,
      to: batch_email.recipients.join(","),
      subject: `${subject_base} — System Activity ${part_tag} — ${date}`,
      html: wrap_email({ title: `System Activity — ${part_tag}`, date, body_html }),
      attachments: [logo_attachment(), { filename: z.filename, path: z.path }]
    };
    if (batch_email.cc_list.length) message.cc = batch_email.cc_list.join(",");
    let info;
    try {
      const transporter = await build_transporter();
      info = await send_with_retry(transporter, message);
    } catch (error) {
      await addLogEvent(E, run_log, "send_activity_parts", cat, { job_id, to: message.to, part: part_tag, status: "ERROR" }, error).catch(() => {});
      throw error;
    }
    try {
      await addLogEvent(I, run_log, "send_activity_parts", det, {
        job_id,
        to: message.to,
        part: part_tag,
        systems: z.systems,
        status: "SENT",
        response: info && info.response
      }, null);
    } catch (log_error) {
      console.error(`activity part send log failed (send outcome unaffected): ${log_error.message}`);
    }
  }
};

module.exports = { send_activity_parts };
