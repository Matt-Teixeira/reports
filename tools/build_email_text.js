const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_report,
  col_1,
  col_2_report,
  col_3_end
} = require("../email/templates/rows");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");
const avante_link = require("../tools/link_builder");

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
      let dt_iso;
      if (rpp_data.capture_datetime) {
        dt_iso = rpp_data.capture_datetime.toISOString();
      } else if (rpp_data.host_datetime) {
        dt_iso = rpp_data.host_datetime.toISOString();
      }

      // CREATE LUXON DT OBJECT
      // TODO: MAKE ZONE DYNAMIC AND SYSTEM SPECIFIC
      const dt_ny = DateTime.fromISO(dt_iso, {
        zone: "America/New_York"
      });

      const link = avante_link(rpp_data.system_id, rpp_data.field_name);
      // Was: https://remote2.avantehs.com/machine/" + rpp_data.system_id
      
      console.log(link);
      // MAP DATA AND PROCESS TEMPLATE
      const col_0_1_data = {
        view_link: link,
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

      // Run seperate case for Scan Seconds because rpp_data.field_name is variable e.g. scan_seconds and system_scan_seconds.
      let col_2_data = {};
      if (report_meta_data.field_name === "Scan Seconds") {
        let split_words = rpp_data.field_name
          .split("_")
          .map(
            (word) => (word = word[0] = word[0].toUpperCase() + word.slice(1))
          );
        split_words = split_words.join(" ");

        col_2_data = {
          field_name: split_words,
          resolved_field_content: rpp_data.rpp_value, // Need to change to general name
          threshold_units: rpp_data.rpp_units
        };
      } else {
        col_2_data = {
          field_name: report_meta_data.field_name,
          resolved_field_content: rpp_data.rpp_value, // Need to change to general name
          threshold_units: rpp_data.rpp_units
        };
      }

      processed_row += await process_template(col_2_report, col_2_data);

      const col_3_data = {
        site_name: rpp_data.site_name,
        city: rpp_data.city,
        state: rpp_data.state
      };

      processed_row += await process_template(col_3_end, col_3_data);
    }
    return processed_row;
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "build_email_text", cat, note, error);
  }
};

module.exports = build_email_text;
