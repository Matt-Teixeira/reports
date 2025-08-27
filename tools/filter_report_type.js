function admin_reports(users_report, report_type, rpp_data) {
  const contains_issue = report_type.includes("issue");
  if (
    report_type === "conn_offline" ||
    report_type === "default_alerts" ||
    report_type === "missed_stack_run_mmb" ||
    contains_issue
  ) {
    if (report_type === "reportable_issue") {
      let dup_list = [];
      for (let rpp of rpp_data) {
        let concat_key = `${rpp.system_id}-${rpp.report_name}`;
        if (
          rpp.system_id === users_report.issue_system_id &&
          !dup_list.includes(concat_key)
        ) {
          matched_systems_list.push(rpp);
          dup_list.push(concat_key);
        }
      }
    } else {
      matched_systems_list.push(...rpp_data);
    }
  }
}

module.exports = { admin_reports };
