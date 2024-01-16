const db = require("../utils/db/pg-pool");
const {
  alert_notify: { update_notification_email }
} = require("../utils/db/sql/sql");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");
const [addLogEvent] = require("../utils/logger/log");

const send_email = async (
  run_log,
  job_id,
  transporter,
  email_address,
  full_email_text,
  alert_detection_ids
) => {
  let send_note = {
    job_id: job_id,
    user: email_address,
    alert_detection_ids: alert_detection_ids
  };
  try {
    addLogEvent(I, run_log, "send_email", cal, send_note, null);

    const format_email = {
      from: process.env.OUTLOOK_USER,
      to: email_address,
      subject: `Avante Health Solutions Alert Report`,
      html: full_email_text
    };

    const info = await transporter.sendMail(format_email);

    send_note = {
      job_id: job_id,
      user: email_address,
      txt: "EMAIL SENT",
      info: info
    };
    addLogEvent(I, run_log, "send_email", det, send_note, null);

    db.any(update_notification_email, ["SENT", run_log.run_id, job_id]);
  } catch (error) {
    const err_note = {
      job_id: job_id,
      user: email_address
    };
    addLogEvent(E, run_log, "send_email", cat, err_note, error);

    db.any(update_notification_email, ["ERROR", run_log.run_id, job_id]);
  }
};

module.exports = send_email;
