const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_alert,
  col_0_report,
  col_0_72_hr_report,
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
  col_3_end,
  col_4_report,
  col_3,
  col_5_report,
  col_6_report,
  col_7_report
} = require("../email/templates/rows");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const build_72_hr_text = async (
  run_log,
  job_id,
  report_meta_data,
  reportable_data
) => {
  let note = {
    job_id
  };
  console.log(report_meta_data);

  try {
    await addLogEvent(I, run_log, "build_72_hr_text", cal, note, null);

    let processed_row = "";

    // Loop though each index and conver to email template
    for await (const rpp_data of reportable_data) {
      // MAP DATA AND PROCESS TEMPLATE
      const col_0_1_data = {
        view_link: "https://remote2.avantehs.com/machine/" + rpp_data.system_id,
        system_id: rpp_data.system_id,
        manufacturer: rpp_data.manufacturer,
        modality: rpp_data.modality,
        model: rpp_data.model
      };

      processed_row += await process_template(col_0_72_hr_report, col_0_1_data);

      // Adds model info to report
      if (report_meta_data.field_name === "he_pressure_72_hr") {
        /* const col_4_data = {
          model: rpp_data.model
        };

        processed_row += await process_template(col_4_report, col_4_data); */

        const col_5_data = {
          datapoint_count: rpp_data.datapoint_count
        };

        processed_row += await process_template(col_5_report, col_5_data);

        const col_6_data = {
          min_value: rpp_data.min_value,
          unit: rpp_data.unit
        };

        processed_row += await process_template(col_6_report, col_6_data);

        const col_7_data = {
          max_value: rpp_data.max_value,
          unit: rpp_data.unit
        };

        processed_row += await process_template(col_7_report, col_7_data);
      }

      /* const col_3_data = {
        site_name: rpp_data.site_name,
        city: rpp_data.city,
        state: rpp_data.state
      };

      processed_row += await process_template(col_3_end, col_3_data); */
    }
    return processed_row;
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "build_72_hr_text", cat, note, error);
  }
};

module.exports = build_72_hr_text;
