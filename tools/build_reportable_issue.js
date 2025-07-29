const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_default_alert_report,
  col_1_default_alert_report,
  col_2_reportable_issue
} = require("../email/templates/rows");
const avante_link = require("./link_builder");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const build_reportable_issue = async (
  run_log,
  job_id,
  reportable_data
) => {
  let note = {
    job_id
  };

  try {
    await addLogEvent(I, run_log, "build_reportable_issue", cal, note, null);

    let processed_row = "";

    // Loop though each index and convert to email template
    for await (const rpp_data of reportable_data) {

      const link = avante_link(rpp_data.system_id, rpp_data.field_name);

      // MAP DATA AND PROCESS TEMPLATE
      const col_0_data = {
        view_link: link,
        system_id: rpp_data.system_id,
        manufacturer: rpp_data.manufacturer,
        modality: rpp_data.modality
      };

      processed_row += await process_template(
        col_0_default_alert_report,
        col_0_data
      );

      const col_1_data = {
        name: rpp_data.name,
        city: rpp_data.city,
        state: rpp_data.state
      };

      processed_row += await process_template(
        col_1_default_alert_report,
        col_1_data
      );

     const col_2_data = {
        note: rpp_data.issue_note
      };

      processed_row += await process_template(
        col_2_reportable_issue,
        col_2_data
      );
    }

    return processed_row;
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "build_reportable_issue", cat, note, error);
  }
};

module.exports = build_reportable_issue;
