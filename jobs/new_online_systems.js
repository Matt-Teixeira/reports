const {
  build_email_text,
  build_new_systems_text,
  build_full_email,
  sort_by_manufacturer
} = require("../tools");
const build_transporter = require("../email/build-transporter");
const send_email = require("../email/send_email");

const [addLogEvent] = require("../utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("../utils/logger/enums");

const new_online_systems = async (run_log, job_id, user_reports) => {
  let note = { job_id, user_report: user_reports };
  await addLogEvent(
    I,
    run_log,
    "new_online_systems",
    cal,
    note,
    null
  );

  const {
    author,
    report_name,
    field_name,
    operator,
    custom_threshold,
    threshold_data_type,
    cc_list
  } = user_reports;

  const report_meta_data = {
    author,
    report_name,
    field_name,
    operator,
    custom_threshold,
    threshold_data_type,
    cc_list
  };

  try {
    //const sorted_data = sort_by_manufacturer(user_reports.matched_systems_list);
    const systems_list = user_reports.matched_systems_list;

    let note = { job_id, report_meta_data, systems_list };

    // Discontinue email process if no reportable data found.
    if (systems_list.length === 0) {
      let note = {
        job_id,
        report_meta_data,
        systems_list,
        message: "User has no reportable data"
      };
      await addLogEvent(
        W,
        run_log,
        "new_online_systems",
        det,
        note,
        null
      );
      return;
    }
    await addLogEvent(
      I,
      run_log,
      "new_online_systems",
      det,
      note,
      null
    );

    // 2) Build row text
    const email_text = await build_new_systems_text(
      run_log,
      job_id,
      report_meta_data,
      systems_list
    );

    // 2) Build/Nest row text into full email
    const full_email = await build_full_email(
      run_log,
      job_id,
      email_text,
      report_meta_data.report_name,
      6
    );

    // console.log("\nfull_email\n");
    // console.log(full_email);

    // return;

    // 3) Send Email
    const transporter = await build_transporter();

    await send_email(
      run_log,
      job_id,
      transporter,
      report_meta_data.author,
      full_email,
      report_name
    ); // report_meta_data.author - matt.teixeira@avantehs.com
  } catch (error) {
    console.log(error);
    await addLogEvent(
      E,
      run_log,
      "new_online_systems",
      cat,
      note,
      error
    );
  }
};

module.exports = new_online_systems;

/* 
  {
    system_id: 'SME18580',
    show_on_website_on: 2025-08-29T18:40:13.006Z,
    process_log_on: 2025-08-29T18:40:13.007Z,
    process_mag_on: 2025-08-29T18:40:13.007Z,
    process_edu_on: 2025-08-29T18:40:13.007Z,
    customer_name: 'Tallahassee Memorial HealthCare',
    manufacturer: 'Philips',
    modality: 'CV/IR',
    site_name: 'Tallahassee Memorial HealthCare'
  }
*/
