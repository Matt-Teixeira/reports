const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_issue_tracker_report,
  col_1_issue_tracker_report,
  col_2_issue_tracker_report,
  col_3_issue_tracker_report,
  col_4_issue_mmb_all_report,
  col_5_issue_tracker_report
} = require("../email/templates/rows");
const avante_link = require("../tools/link_builder");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const build_mmb_all_issue_text = async (
  run_log,
  job_id,
  report_meta_data,
  reportable_data
) => {
  let note = {
    job_id
  };

  try {
    await addLogEvent(I, run_log, "build_mmb_all_issue_text", cal, note, null);

    let processed_row = "";

    // Loop though each index and conver to email template
    for await (const rpp_data of reportable_data) {
      // CONVERT TO STRING
      const dt_iso_created_at = rpp_data.created_at.toISOString();
      const dt_iso_updated_at = rpp_data.updated_at
        ? { datetime: rpp_data.updated_at.toISOString(), msg: null }
        : { datetime: null, msg: "No Datetime" };

      // CREATE LUXON DT OBJECT
      // TODO: MAKE ZONE DYNAMIC AND SYSTEM SPECIFIC
      const dt_ny_created_at = DateTime.fromISO(dt_iso_created_at, {
        zone: "America/New_York"
      });

      const dt_ny_updated_at = dt_iso_updated_at
        ? DateTime.fromISO(dt_iso_updated_at.datetime, {
            zone: "America/New_York"
          })
        : dt_iso_updated_at.msg;

      const link = avante_link(rpp_data.system_id, rpp_data.field_name);

      // MAP DATA AND PROCESS TEMPLATE
      const col_0_data = {
        view_link: link,
        system_id: rpp_data.system_id,
        manufacturer: rpp_data.manufacturer,
        modality: rpp_data.modality,
        name: rpp_data.name
      };

      processed_row += await process_template(
        col_0_issue_tracker_report,
        col_0_data
      );

      const col_1_data = {
        time: dt_ny_created_at.toFormat("t ZZZZ"), // 9:07 AM EST,
        date: dt_ny_created_at.toFormat("DD") // Aug 6, 2014,
      };

      processed_row += await process_template(
        col_1_issue_tracker_report,
        col_1_data
      );

      const col_2_data = {
        time: dt_ny_updated_at.toFormat("t ZZZZ"), // 9:07 AM EST,
        date: dt_ny_updated_at.toFormat("DD") // Aug 6, 2014,
      };

      processed_row += await process_template(
        col_2_issue_tracker_report,
        col_2_data
      );

      const col_3_data = {};
      if (!rpp_data.notes) {
        col_3_data.notes = "N/A";
      } else {
        col_3_data.notes = rpp_data.notes.slice(0, 50) + "...";
      }

      processed_row += await process_template(
        col_3_issue_tracker_report,
        col_3_data
      );

      const col_4_data = {};
      if (!rpp_data.assigned) {
        col_4_data.assigned = "N/A";
      } else {
        col_4_data.assigned = rpp_data.assigned;
      }

      processed_row += await process_template(
        col_4_issue_mmb_all_report,
        col_4_data
      );
    }

    return processed_row;
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "build_mmb_all_issue_text", cat, note, error);
  }
};

module.exports = build_mmb_all_issue_text;
