const {
  build_email_text,
  build_conn_offline_text,
  build_full_email,
  sort_by_manufacturer
} = require("../tools");
const build_transporter = require("../email/build-transporter");
const send_email = require("../email/send_email");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const disabled_default_alerts = async (run_log, job_id, user_reports) => {};

module.exports = disabled_default_alerts;
