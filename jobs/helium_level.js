const { build_email_text } = require("../tools");

// 1) Filter on user’s operator and custom_threshold criteria
// 2) Get filtered data into HTML
// 3) Send email report
const helium_level_reports = async (user_reports) => {
  //console.log(user_reports);
  const {
    author,
    field_name,
    operator,
    custom_threshold,
    threshold_data_type,
    cc_list
  } = user_reports;

  const report_meta_data = {
    author,
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

  console.log("\nReport This Data!");
  console.log(reportable_reports);

  console.log("\n Build Email");

  build_email_text(report_meta_data, reportable_reports);
};

module.exports = helium_level_reports;
