const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_unsucc_acqu_hhm_report,
  col_1_unsucc_acqu_hhm_report,
  col_2_unsucc_acqu_hhm_report,
  col_3_unsucc_acqu_hhm_report,
  col_4_unsucc_acqu_hhm_report,
  col_5_issue_tracker_report
} = require("../email/templates/rows");
const avante_link = require("./link_builder");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const build_unsucc_acqu_hhm_text = async (
  run_log,
  job_id,
  report_meta_data,
  reportable_data
) => {
  let note = {
    job_id
  };

  try {
    await addLogEvent(
      I,
      run_log,
      "build_unsucc_acqu_hhm_text",
      cal,
      note,
      null
    );

    let processed_row = "";

    // Loop though each index and conver to email template
    for await (const rpp_data of reportable_data) {
      // CONVERT TO STRING
      const dt_iso_last_file_pulled_at = rpp_data.last_file_pulled_at
        ? { datetime: rpp_data.last_file_pulled_at.toISOString(), msg: null }
        : { datetime: null, msg: "No Datetime" };

      const dt_iso_latest_data_datetime = rpp_data.latest_data_datetime
        ? { datetime: rpp_data.latest_data_datetime.toISOString(), msg: null }
        : { datetime: null, msg: "No Datetime" };

      // CREATE LUXON DT OBJECT
      // TODO: MAKE ZONE DYNAMIC AND SYSTEM SPECIFIC
      const dt_ny_last_conn = dt_iso_last_file_pulled_at
        ? DateTime.fromISO(dt_iso_last_file_pulled_at.datetime, {
            zone: "America/New_York"
          })
        : dt_iso_last_file_pulled_at.msg;

      const dt_ny_last_file_data_dt = dt_iso_latest_data_datetime
        ? DateTime.fromISO(dt_iso_latest_data_datetime.datetime, {
            zone: "America/New_York"
          })
        : dt_iso_latest_data_datetime.msg;

      const link = avante_link(rpp_data.system_id, rpp_data.field_name);

      // MAP DATA AND PROCESS TEMPLATE
      const col_0_data = {
        view_link: link,
        system_id: rpp_data.system_id,
        manufacturer: rpp_data.manufacturer,
        modality: rpp_data.modality,
        name: rpp_data.cust_name
      };

      processed_row += await process_template(
        col_0_unsucc_acqu_hhm_report,
        col_0_data
      );

      const col_1_data = {
        time: dt_ny_last_conn.toFormat("t ZZZZ"), // 9:07 AM EST,
        date: dt_ny_last_conn.toFormat("DD") // Aug 6, 2014,
      };

      processed_row += await process_template(
        col_1_unsucc_acqu_hhm_report,
        col_1_data
      );

      const col_2_data = {
        time: dt_ny_last_file_data_dt.toFormat("t ZZZZ"), // 9:07 AM EST,
        date: dt_ny_last_file_data_dt.toFormat("DD") // Aug 6, 2014,
      };

      processed_row += await process_template(
        col_2_unsucc_acqu_hhm_report,
        col_2_data
      );

      const col_3_data = {};
      if (!rpp_data.connection_error) {
        col_3_data.connection_error = "N/A";
      } else {
        col_3_data.connection_error =
          rpp_data.connection_error.slice(0, 50) + "...";
      }

      processed_row += await process_template(
        col_3_unsucc_acqu_hhm_report,
        col_3_data
      );

      const col_4_data = {
        host_intervention: rpp_data.host_intervention
      };

      processed_row += await process_template(
        col_4_unsucc_acqu_hhm_report,
        col_4_data
      );
    }

    return processed_row;
  } catch (error) {
    console.log(error);
    await addLogEvent(
      E,
      run_log,
      "build_unsucc_acqu_hhm_text",
      cat,
      note,
      error
    );
  }
};

module.exports = build_unsucc_acqu_hhm_text;
