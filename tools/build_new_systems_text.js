const { DateTime } = require("luxon");
const process_template = require("../email/process-template");
const {
  col_0_new_system_enroll_report,
  col_1_new_system_enroll_report,
  col_2_new_system_enroll_report,
  col_3_new_system_enroll_report,
  col_4_new_system_enroll_report,
  col_5_new_system_enroll_report
} = require("../email/templates/rows");
const avante_link = require("./link_builder");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const build_new_systems_text = async (
  run_log,
  job_id,
  report_meta_data,
  reportable_data
) => {
  let note = {
    job_id
  };

  try {
    await addLogEvent(I, run_log, "build_new_systems_text", cal, note, null);

    let processed_row = "";

    // Loop though each index and conver to email template
    for await (const rpp_data of reportable_data) {
      const show_on_website_dt = to_ny_luxon(rpp_data.show_on_website_on);
      const process_log_dt = to_ny_luxon(rpp_data.process_log_on);
      const process_mag_dt = to_ny_luxon(rpp_data.process_mag_on);
      const process_edu_dt = to_ny_luxon(rpp_data.process_edu_on);

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
        col_0_new_system_enroll_report,
        col_0_data
      );

      const col_z_data = {
        customer: rpp_data.customer_name,
        name: rpp_data.site_name,
        city: rpp_data.city,
        state: rpp_data.state
      };

      processed_row += await process_template(
        col_1_new_system_enroll_report,
        col_z_data
      );

      const col_2_data = {
        time: show_on_website_dt.dt
          ? show_on_website_dt.dt.toFormat("yyyy-LL-dd HH:mm:ss")
          : show_on_website_dt.msg
      };

      processed_row += await process_template(
        col_2_new_system_enroll_report,
        col_2_data
      );

      const col_3_data = {
        time: process_mag_dt.dt
          ? process_mag_dt.dt.toFormat("yyyy-LL-dd HH:mm:ss")
          : process_mag_dt.msg
      };

      processed_row += await process_template(
        col_3_new_system_enroll_report,
        col_3_data
      );

      const col_4_data = {
        time: process_log_dt.dt
          ? process_log_dt.dt.toFormat("yyyy-LL-dd HH:mm:ss")
          : process_log_dt.msg
      };

      processed_row += await process_template(
        col_4_new_system_enroll_report,
        col_4_data
      );

      const col_5_data = {
        time: process_edu_dt.dt
          ? process_edu_dt.dt.toFormat("yyyy-LL-dd HH:mm:ss")
          : process_edu_dt.msg
      };

      processed_row += await process_template(
        col_5_new_system_enroll_report,
        col_5_data
      );
    }

    return processed_row;
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "build_new_systems_text", cat, note, error);
  }
};

function to_ny_luxon(value) {
  const ny = "America/New_York";
  if (!value) return { dt: null, msg: "Not Set To Process/Show" };

  const dt =
    value instanceof Date
      ? DateTime.fromJSDate(value, { zone: ny })
      : DateTime.fromISO(String(value), { zone: ny });

  return dt.isValid
    ? { dt, msg: null }
    : { dt: null, msg: "Not Set To Process/Show" };
}

module.exports = build_new_systems_text;
