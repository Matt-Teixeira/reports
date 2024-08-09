const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_default_alert_report,
  col_1_default_alert_report,
  col_2_default_alert_report,
  col_3_default_alert_report,
  col_4_default_alert_report
} = require("../email/templates/rows");
const avante_link = require("./link_builder");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const build_disabled_alert_text = async (
  run_log,
  job_id,
  report_meta_data,
  reportable_data
) => {
  let note = {
    job_id
  };

  try {
    await addLogEvent(I, run_log, "build_disabled_alert_text", cal, note, null);

    let processed_row = "";

    // Loop though each index and conver to email template
    for await (const rpp_data of reportable_data) {

      const dt_iso_last_update = rpp_data.last_update.toISOString();

      const dt_ny_last_update = DateTime.fromISO(dt_iso_last_update, {
        zone: "America/New_York"
      });

     /*  const dt_ny_last_update = DateTime.fromISO(dt_iso_last_update, {
        zone: "America/New_York"
      }); */
      
      const link = avante_link(rpp_data.system_id, rpp_data.field_name);

      // MAP DATA AND PROCESS TEMPLATE
      const col_0_data = {
        view_link: link,
        system_id: rpp_data.system_id,
        manufacturer: rpp_data.manufacturer,
        modality: rpp_data.modality,
        alert_model_id: rpp_data.alert_model_id
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
        field_name: rpp_data.field_name,
        operator: rpp_data.operator,
        threshold: rpp_data.threshold
      };

      processed_row += await process_template(
        col_2_default_alert_report,
        col_2_data
      );

      const col_3_data = {
        time: dt_ny_last_update.toFormat("t ZZZZ"), // 9:07 AM EST,
        date: dt_ny_last_update.toFormat("DD"),
        last_updated_by: rpp_data.last_updated_by
      };

      processed_row += await process_template(
        col_3_default_alert_report,
        col_3_data
      );

      /* const col_4_data = {
        enabled: rpp_data.enabled
      };

      processed_row += await process_template(
        col_4_default_alert_report,
        col_4_data
      ); */

    }

    return processed_row;
  } catch (error) {
    console.log(error);
    await addLogEvent(
      E,
      run_log,
      "build_disabled_alert_text",
      cat,
      note,
      error
    );
  }
};

module.exports = build_disabled_alert_text;
