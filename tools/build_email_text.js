const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_alert,
  col_0_report,
  col_0_warn,
  col_1,
  col_2_less_than,
  col_2_less_than_report,
  col_2_greater_than,
  col_2_equals,
  col_2_delta_neg,
  col_2_offline,
  col_2_contains,
  col_2_composite_equals,
  col_3_end
} = require("../email/templates/rows");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const build_email_text = async (
  run_log,
  job_id,
  report_meta_data,
  reportable_data
) => {
  let note = {
    job_id
  };
  try {
    await addLogEvent(I, run_log, "build_email_text", cal, note, null);

    let processed_row = "";

    // Loop though each index and conver to email template
    for await (const rpp_data of reportable_data) {
      // CONVERT TO STRING
      const dt_iso = rpp_data.capture_datetime.toISOString();

      // CREATE LUXON DT OBJECT
      // TODO: MAKE ZONE DYNAMIC AND SYSTEM SPECIFIC
      const dt_ny = DateTime.fromISO(dt_iso, {
        zone: "America/New_York"
      });

      // MAP DATA AND PROCESS TEMPLATE
      const col_0_1_data = {
        view_link: "https://remote2.avantehs.com/machine/" + rpp_data.system_id,
        system_id: rpp_data.system_id,
        manufacturer: rpp_data.manufacturer,
        modality: rpp_data.modality,
        time: dt_ny.toFormat("t ZZZZ"), // 9:07 AM EST,
        date: dt_ny.toFormat("DD") // Aug 6, 2014,
      };

      processed_row += await process_template(
        col_0_report + col_1,
        col_0_1_data
      );

      const less_than_data = {
        field_name: report_meta_data.field_name,
        resolved_field_content: rpp_data.rpp_value, // Need to change to general name
        threshold_units: rpp_data.rpp_units
      };

      const greater_than_data = {
        field_name: report_meta_data.field_name,
        resolved_field_content: rpp_data.rpp_value, // Need to change to general name
        threshold_units: rpp_data.rpp_units
      };

      processed_row += await process_template(
        col_2_less_than_report,
        less_than_data
      );

      const col_3_data = {
        site_name: rpp_data.site_name,
        city: rpp_data.city,
        state: rpp_data.state
      };

      processed_row += await process_template(col_3_end, col_3_data);
    }
    return processed_row;
  } catch (error) {
    await addLogEvent(E, run_log, "build_email_text", cat, note, error);
  }
};

module.exports = build_email_text;
