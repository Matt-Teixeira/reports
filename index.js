("use strict");
require("dotenv").config();

// JOBS
const {
  helium_level_report,
  helium_psi_report,
  all_he_level_report,
  all_he_psi_report,
  he_pressure_72_hr,
  scan_seconds,
  shield_temp,
  connection_offline,
  disabled_default_alerts,
  issue_tracker_report,
  mmb_hhm_all_issue_tracker,
  missed_stack_run_mmb,
  reportable_issue_report
} = require("./jobs");

// TOOLS
const { formatted_dt, captureDatetime } = require("./tools");

// UTILS
const db = require("./utils/db/pg-pool");
const {
  alert_notify: {
    get_user_report_schemas,
    get_he_level_report_data,
    get_he_psi_rport_data,
    get_he_level_all_report,
    get_he_psi_all_report,
    get_72_hr_pressure_report,
    get_scan_seconds,
    get_shield_temp,
    get_conn_offline,
    get_default_alert_report
  },
  reports: {
    get_issue_tracker_systems,
    get_issue_mmb_all,
    get_issue_hhm_all,
    get_issue_mmb_older_than_30,
    get_issue_hhm_older_than_30,
    get_issue_mmb_newer_than_30,
    get_issue_hhm_newer_than_30,
    get_disabled_alerts,
    get_missed_stack_run_mmb,
    get_issue_tracker_report
  }
} = require("./utils/db/sql/sql");
const { v4: uuidv4 } = require("uuid");
const [
  addLogEvent,
  writeLogEvents,
  dbInsertLogEvents,
  makeAppRunLog
] = require("./utils/logger/log");
const {
  type: { I, W, E },
  tag: { cal, det, cat, seq, qaf }
} = require("./utils/logger/enums");

async function run_job(users_report_rpp_data, run_log) {
  // const app_run_datetime = captureDatetime();
  const job_id = uuidv4();

  // 1) Loop through each user's specific report model
  // 2) Filter on user’s operator and custom_threshold criteria
  // 3) Get filtered data into HTML
  // 4) Send email report
  switch (users_report_rpp_data.field_name) {
    case "he_level_value":
      await helium_level_report(run_log, job_id, users_report_rpp_data);
      break;
    case "he_pressure_value":
      await helium_psi_report(run_log, job_id, users_report_rpp_data);
      break;
    case "all_he_level":
      await all_he_level_report(run_log, job_id, users_report_rpp_data);
      break;
    case "all_he_psi":
      await all_he_psi_report(run_log, job_id, users_report_rpp_data);
      break;
    case "he_pressure_72_hr":
      await he_pressure_72_hr(run_log, job_id, users_report_rpp_data);
      break;
    case "scan_seconds":
      await scan_seconds(run_log, job_id, users_report_rpp_data);
      break;
    case "shield_temp":
      await shield_temp(run_log, job_id, users_report_rpp_data);
      break;
    case "conn_offline":
      await connection_offline(run_log, job_id, users_report_rpp_data);
      break;
    case "default_alerts":
      await disabled_default_alerts(run_log, job_id, users_report_rpp_data);
      break;
    case "disabled_alerts":
      await disabled_default_alerts(run_log, job_id, users_report_rpp_data);
      break;
    case "issue_tracker":
      await issue_tracker_report(run_log, job_id, users_report_rpp_data);
      break;
    case "mmb_all_issue_tracker":
      await mmb_hhm_all_issue_tracker(run_log, job_id, users_report_rpp_data);
      break;
    case "hhm_all_issue_tracker":
      await mmb_hhm_all_issue_tracker(run_log, job_id, users_report_rpp_data);
      break;
    case "mmb_issue_older_30":
      await mmb_hhm_all_issue_tracker(run_log, job_id, users_report_rpp_data);
      break;
    case "hhm_issue_older_30":
      await mmb_hhm_all_issue_tracker(run_log, job_id, users_report_rpp_data);
      break;
    case "mmb_issue_newer_30":
      await mmb_hhm_all_issue_tracker(run_log, job_id, users_report_rpp_data);
      break;
    case "missed_stack_run_mmb":
      await missed_stack_run_mmb(run_log, job_id, users_report_rpp_data);
      break;
    case "reportable_issue":
      await reportable_issue_report(run_log, job_id, users_report_rpp_data);
      break;
    default:
      break;
  }
}

async function on_boot() {
  // GET PROCESS ARG TO DETERMIN REPORT TYPE FOR QUERY
  const report_type = process.argv[2];

  const dt = formatted_dt();
  const dt_2 = "mon-08:00";

  const report_queries = {
    get_user_report_schemas,
    he_level_value: get_he_level_report_data,
    he_pressure_value: get_he_psi_rport_data,
    all_he_level: get_he_level_all_report,
    all_he_psi: get_he_psi_all_report,
    he_pressure_72_hr: get_72_hr_pressure_report,
    scan_seconds: get_scan_seconds,
    shield_temp: get_shield_temp,
    conn_offline: get_conn_offline,
    default_alerts: get_default_alert_report,
    issue_tracker: get_issue_tracker_systems,
    mmb_all_issue_tracker: get_issue_mmb_all,
    hhm_all_issue_tracker: get_issue_hhm_all,
    mmb_issue_older_30: get_issue_mmb_older_than_30,
    hhm_issue_older_30: get_issue_hhm_older_than_30,
    mmb_issue_newer_30: get_issue_mmb_newer_than_30,
    hhm_issue_newer_30: get_issue_hhm_newer_than_30,
    disabled_alerts: get_disabled_alerts,
    missed_stack_run_mmb: get_missed_stack_run_mmb,
    reportable_issue: get_issue_tracker_report
  };

  let note = { dt_2 };

  const run_log = await makeAppRunLog();
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  try {
    const user_report_schemas = await db.any(
      report_queries.get_user_report_schemas,
      [dt_2, report_type]
    );

    let note = { dt_2, user_report_schemas };
    await addLogEvent(I, run_log, "on_boot", det, note, null);

    const users_system_rpp_data = [];

    for await (let users_report of user_report_schemas) {
      let rpp_data = await db.any(report_queries[report_type], [
        dt_2,
        users_report.author
      ]);

      if (!rpp_data.length) {
        await addLogEvent(
          W,
          run_log,
          "on_boot",
          det,
          {
            message: "No data for this report",
            report: users_report,
            report_data: rpp_data
          },
          null
        );
        continue;
      }

      // Initialize the map to hold arrays of objects for each system_id
      const object_map = new Map();

      // Populate the map, appending objects to an array under their system_id
      rpp_data.forEach((obj) => {
        if (!object_map.has(obj.system_id)) {
          object_map.set(obj.system_id, [obj]);
        } else {
          object_map.get(obj.system_id).push(obj);
        }
      });

      const matched_systems_list = [];

      // The conn_offline & default_alerts reports will not have a systems list associated with the user report model. Internal reporting
      const contains_issue = report_type.includes("issue");
      if (
        report_type === "conn_offline" ||
        report_type === "default_alerts" ||
        report_type === "missed_stack_run_mmb" ||
        contains_issue
      ) {
        if (report_type === "reportable_issue") {
          for (let rpp of rpp_data) {
            if (rpp.system_id === users_report.issue_system_id) {
              matched_systems_list.push(rpp);
            }
          }
        } else {
          matched_systems_list.push(...rpp_data);
        }
      } else {
        // matched_systems_list will now contain all matched objects, including duplicates based on system_id
        users_report.systems_list.forEach((sme) => {
          if (object_map.has(sme)) {
            // Dump the array of duplicate systems into the matched_systems_list array
            matched_systems_list.push(...object_map.get(sme));
          }
        });
      }

      users_system_rpp_data.push({
        author: users_report.author,
        report_name: users_report.report_name,
        field_name: users_report.field_name,
        operator: users_report.operator,
        custom_threshold: users_report.threshold,
        threshold_data_type: users_report.threshold_data_type,
        cc_list: users_report.cc_list,
        matched_systems_list
      });
    }

    const jobs = [];
    for await (let users_report_rpp_data of users_system_rpp_data) {
      console.log(users_report_rpp_data);
      jobs.push(async () => await run_job(users_report_rpp_data, run_log));
    }

    const execute_jobs = async () => {
      for (const job of jobs) {
        await job();

        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    };

    await execute_jobs();

    await writeLogEvents(run_log);
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "on_boot", cat, note, error);
    await writeLogEvents(run_log);
  }
}

on_boot();
