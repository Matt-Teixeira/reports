const {
  build_email_text,
  build_unsucc_acqu_hhm_text,
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

const unsuccessful_acqu_hhm_report = async (run_log, job_id, user_reports) => {
  let note = { job_id, user_report: user_reports };
  await addLogEvent(
    I,
    run_log,
    "unsuccessful_acqu_hhm_report",
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
        "unsuccessful_acqu_hhm_report",
        det,
        note,
        null
      );
      return;
    }
    await addLogEvent(
      I,
      run_log,
      "unsuccessful_acqu_hhm_report",
      det,
      note,
      null
    );

    // 2) Build row text
    const email_text = await build_unsucc_acqu_hhm_text(
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
      5
    );

    // console.log("\nfull_email");
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
      "unsuccessful_acqu_hhm_report",
      cat,
      note,
      error
    );
  }
};

module.exports = unsuccessful_acqu_hhm_report;

/* 
  {
    id: 'SME00865',
    last_file_pulled_at: 2025-07-24T13:42:01.702Z,
    inserted_at: 2025-08-22T14:15:08.555Z,
    host_intervention: false,
    latest_data_datetime: 2024-08-08T13:07:36.474Z,
    successful_acquisition: false,
    connection_error: 'max-retries exceeded',
    manufacturer: 'GE',
    modality: 'CV/IR',
    cust_name: 'Avante Health Solutions - Demo Customer 1',
    site_name: 'Augusta Medical',
    city: 'Augusta',
    state: 'GA'
  }


    {
    author: 'matt.teixeira@avantehs.com',
    report_name: 'HHM: Unsuccessful Acquisition',
    field_name: 'unsuccessful_acqu_hhm',
    operator: null,
    custom_threshold: null,
    threshold_data_type: null,
    cc_list: null,
    matched_systems_list: [
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object], [Object],
      [Object], [Object], [Object], [Object]
    ]
  }
*/
