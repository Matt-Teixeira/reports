const {
  build_conn_offline_text,
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

// 1) Filter on user’s operator and custom_threshold criteria
// 2) Get filtered data into HTML
// 3) Send email report
const connection_offline = async (run_log, job_id, user_reports) => {
  let note = { job_id, user_report: user_reports };
  await addLogEvent(I, run_log, "connection_offline", cal, note, null);

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
    field_name: "Connection Offline",
    operator,
    custom_threshold,
    threshold_data_type,
    cc_list
  };

  try {
    const sorted_data = sort_by_manufacturer(user_reports.matched_systems_list);

    let note = { job_id, report_meta_data, sorted_data };

    // Discontinue email process if no reportable data found.
    if (sorted_data.length === 0) {
      let note = {
        job_id,
        report_meta_data,
        sorted_data,
        message: "User has no reportable data"
      };
      await addLogEvent(W, run_log, "connection_offline", det, note, null);
      return;
    }
    await addLogEvent(I, run_log, "connection_offline", det, note, null);

    // 2) Build row text
    const email_text = await build_conn_offline_text(
      run_log,
      job_id,
      report_meta_data,
      sorted_data
    );

    // 2) Build/Nest row text into full email
    const full_email = await build_full_email(
      run_log,
      job_id,
      email_text,
      report_meta_data.report_name,
      6
    );

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
    await addLogEvent(E, run_log, "connection_offline", cat, note, error);
  }
};

module.exports = connection_offline;

/* 
{
  author: 'matt.teixeira@avantehs.com',
  report_name: 'Connection Offline',
  field_name: 'conn_offline',
  operator: null,
  custom_threshold: null,
  threshold_data_type: null,
  cc_list: null,
  matched_systems_list: [
    {
      system_id: 'SME00888',
      manufacturer: 'Philips',
      modality: 'CV/IR',
      name: 'Piedmont Athens Regional Medical Center',
      type: 'OFFLINE',
      notes: 'Machine does not ping locally',
      diagnoses: 'CV does not ping locally maybe not in use changed ip or not used often',
      resolved: null,
      ticket_created_at: 2024-01-04T15:09:19.132Z,
      ticket_updated_at: 2024-01-04T15:10:38.165Z,
      hhm_last_connected: null,
      hhm_last_db_update: 2024-04-30T12:45:11.996Z,
      intervention_detected: null,
      mmb_last_connected: null,
      mmb_last_db_update: null
    },
    {
      system_id: 'SME17374',
      manufacturer: 'Philips',
      modality: 'CT',
      name: 'Thomas Hospital',
      type: 'OFFLINE',
      notes: 'Phil CT port 22 closed again',
      diagnoses: null,
      resolved: null,
      ticket_created_at: 2024-01-30T15:46:00.786Z,
      ticket_updated_at: 2024-01-30T15:46:58.397Z,
      hhm_last_connected: 2024-01-25T17:00:06.807Z,
      hhm_last_db_update: 2024-05-16T12:15:07.150Z,
      intervention_detected: false,
      mmb_last_connected: null,
      mmb_last_db_update: null
    },
  }
*/
