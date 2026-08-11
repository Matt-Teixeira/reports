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
  reportable_issue_report,
  unsuccessful_acqu_hhm_report,
  new_online_systems,
  inspect_board,
  get_board_info,
  create_row
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
    get_issue_tracker_report,
    get_unsuccessful_acqu_hhm,
    get_new_online_systems
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
    case "hhm_issue_newer_30":
      await mmb_hhm_all_issue_tracker(run_log, job_id, users_report_rpp_data);
      break;
    case "missed_stack_run_mmb":
      await missed_stack_run_mmb(run_log, job_id, users_report_rpp_data);
      break;
    case "reportable_issue":
      await reportable_issue_report(run_log, job_id, users_report_rpp_data);
      break;
    case "unsuccessful_acqu_hhm":
      await unsuccessful_acqu_hhm_report(
        run_log,
        job_id,
        users_report_rpp_data
      );
      break;
    case "new_online_systems":
      await new_online_systems(run_log, job_id, users_report_rpp_data);
      break;
    case "monday":
      // await inspect_board();
      await get_board_info();
      // await create_row();
      break;
    default:
      break;
  }
}

async function on_boot() {
  // GET PROCESS ARG TO DETERMIN REPORT TYPE FOR QUERY
  const report_type = process.argv[2];

  // SINGLE-SME MAGNET HEALTH BRIEF (new paradigm) — dispatches to its own
  // engine under sme_reports/ and skips the alert.reports schema flow entirely.
  // Usage: npm start sme_report -- ./requests/<name>.json
  if (report_type === "sme_report") {
    const run_log = await makeAppRunLog();
    try {
      // Strict parse FIRST (review F2): a typo'd --config must abort, never
      // fall through to the live slot batch.
      const { parse_sme_args } = require("./sme_reports/cli_args");
      const opts = parse_sme_args(process.argv.slice(3));
      if (opts.request_path) {
        // File mode — unchanged: npm start sme_report -- ./requests/x.json
        const run_sme_report = require("./sme_reports");
        await run_sme_report(run_log, opts.request_path);
      } else {
        // Scheduled (DB-config) mode — no file argument: match the current
        // slot against alert.sme_reports and fan out. Operator overrides:
        //   --slot mon-08:00   run a specific slot without waiting for cron
        //   --config 3         run one config row by id (dry-run if disabled)
        //   --dry-run          force the no-send path regardless of the row
        const run_scheduled = require("./sme_reports/run_scheduled");
        await run_scheduled(run_log, opts);
      }
    } catch (error) {
      // Fatal run error (bad arguments, bad request file, failed fleet
      // render in summary-only mode, failed send, failed config rows). The
      // log record is still written, but cron must see a nonzero exit — a
      // swallowed error here reported success with nothing delivered.
      // Argument errors reach only this catch, so they print here.
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      await writeLogEvents(run_log);
    }
    return;
  }

  if (report_type === "monday") {
    let users_report_rpp_data = {
      field_name: "monday"
    };
    await run_job(users_report_rpp_data, null);
  }

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
    reportable_issue: get_issue_tracker_report,
    unsuccessful_acqu_hhm: get_unsuccessful_acqu_hhm,
    new_online_systems: get_new_online_systems
  };

  let note = { dt };

  const run_log = await makeAppRunLog();
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  try {
    const user_report_schemas = await db.any(
      report_queries.get_user_report_schemas,
      [dt, report_type]
    );

    let note = { dt, user_report_schemas };
    await addLogEvent(I, run_log, "on_boot", det, note, null);

    const users_system_rpp_data = [];

    for await (let users_report of user_report_schemas) {
      let rpp_data = await db.any(report_queries[report_type], [
        dt,
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
        report_type === "new_online_systems" ||
        report_type === "conn_offline" ||
        report_type === "default_alerts" ||
        report_type === "missed_stack_run_mmb" ||
        report_type === "unsuccessful_acqu_hhm" ||
        contains_issue
      ) {
        if (report_type === "reportable_issue") {
          let dup_list = [];
          for (let rpp of rpp_data) {
            let concat_key = `${rpp.system_id}-${rpp.report_name}`;
            if (
              rpp.system_id === users_report.issue_system_id &&
              !dup_list.includes(concat_key)
            ) {
              matched_systems_list.push(rpp);
              dup_list.push(concat_key);
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
