const { build_email_text, build_full_email } = require("../tools");

const send_it = require("../email/send");

// 1) Filter on user’s operator and custom_threshold criteria
// 2) Get filtered data into HTML
// 3) Send email report
const helium_level_reports = async (run_log, job_id, user_reports) => {
  //console.log(user_reports);
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
    field_name,
    operator,
    custom_threshold,
    threshold_data_type,
    cc_list
  };

  console.log(report_meta_data);

  const reportable_reports = [];
  for (let report of user_reports.matched_model_data) {
    if (report.helium_value === null) continue;
    switch (user_reports.operator) {
      case "less_than":
        if (report.helium_value < user_reports.custom_threshold)
          reportable_reports.push(report);
        break;
      case "greater_than":
        if (report.helium_value > user_reports.custom_threshold)
          reportable_reports.push(report);
        break;

      default:
        break;
    }
  }

  // Build row text
  const email_text = await build_email_text(
    report_meta_data,
    reportable_reports
  );
  // Build/Nest row text into full email
  const full_email = await build_full_email(email_text, report_meta_data.report_name);

  console.log(full_email);

  await send_it(run_log, job_id, report_meta_data.author, full_email); // report_meta_data.author
};

module.exports = helium_level_reports;
