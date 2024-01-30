const { build_email_text, build_full_email } = require("../tools");
const build_transporter = require("../email/build-transporter");
const send_email = require("../email/send_email");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

// 1) Filter on user’s operator and custom_threshold criteria
// 2) Get filtered data into HTML
// 3) Send email report
const all_he_level_report = async (run_log, job_id, user_reports) => {
  let note = { job_id, user_report: user_reports };
  await addLogEvent(I, run_log, "all_he_level_report", cal, note, null);

  const {
    author,
    report_name,
    field_name,
    operator,
    custom_threshold,
    threshold_data_type,
    cc_list
  } = user_reports;

  const report_meta_data = {
    author,
    report_name,
    field_name: "He Level",
    operator,
    custom_threshold,
    threshold_data_type,
    cc_list
  };

  try {
    // 1) Looping though all rpp data that corresponds with user's array of alert_model_ids and filtering out data that fits user’s custom_threshold condition.
    const reportable_data = [];
    for (let rpp_data of user_reports.matched_systems_list) {
      if (rpp_data.rpp_value === null) continue;
      reportable_data.push(rpp_data);
    }

    let note = { job_id, report_meta_data, reportable_data };

    // Discontinue email process if no reportable data found.
    if (reportable_data.length === 0) {
      let note = {
        job_id,
        report_meta_data,
        reportable_data,
        message: "User has no reportable data"
      };
      await addLogEvent(W, run_log, "all_he_level_report", det, note, null);
      return;
    }
    await addLogEvent(I, run_log, "all_he_level_report", det, note, null);

    // 2) Build row text
    const email_text = await build_email_text(
      run_log,
      job_id,
      report_meta_data,
      reportable_data
    );

    // 2) Build/Nest row text into full email
    const full_email = await build_full_email(
      run_log,
      job_id,
      email_text,
      report_meta_data.report_name
    );

    console.log(full_email);

    // 3) Send Email
    const transporter = await build_transporter();

    await send_email(
      run_log,
      job_id,
      transporter,
      report_meta_data.author,
      full_email
    ); // report_meta_data.author - matt.teixeira@avantehs.com
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "all_he_level_report", cat, note, error);
  }
};

module.exports = all_he_level_report;
