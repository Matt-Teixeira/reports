("use strict");
require("dotenv").config();

// JOBS
const {
  helium_level_report,
  helium_psi_report,
  all_he_level_report,
  all_he_psi_report,
  he_pressure_72_hr
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
    get_72_hr_pressure_report
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

async function run_job() {
  const app_run_datetime = captureDatetime();
  const job_id = uuidv4();
  const [users_model_rpp_data, run_log] = await on_boot();

  // console.log(users_model_rpp_data[0]);

  // 1) Loop through each user's specific report model
  // 2) Filter on user’s operator and custom_threshold criteria
  // 3) Get filtered data into HTML
  // 4) Send email report
  for await (let users_rpp_data of users_model_rpp_data) {
    switch (users_rpp_data.field_name) {
      case "he_level_value":
        await helium_level_report(run_log, job_id, users_rpp_data);
        break;
      case "he_pressure_value":
        await helium_psi_report(run_log, job_id, users_rpp_data);
        break;
      case "all_he_level":
        await all_he_level_report(run_log, job_id, users_rpp_data);
        break;
      case "all_he_psi":
        await all_he_psi_report(run_log, job_id, users_rpp_data);
        break;
      case "he_pressure_72_hr":
        await he_pressure_72_hr(run_log, job_id, users_rpp_data);
        break;
      default:
        break;
    }

    // REMOVE: Just loop though one user report
    // break;
  }
  await writeLogEvents(run_log);
}

async function on_boot() {
  // GET PROCESS ARG TO DETERMIN REPORT TYPE FOR QUERY
  // he_level_value
  // he_pressure_value
  const report_type = process.argv[2];

  console.log(report_type);

  const report_queries = {
    get_user_report_schemas,
    he_level_value: get_he_level_report_data,
    he_pressure_value: get_he_psi_rport_data,
    all_he_level: get_he_level_all_report,
    all_he_psi: get_he_psi_all_report,
    he_pressure_72_hr: get_72_hr_pressure_report
  };

  const dt = formatted_dt();
  const dt_2 = "wed-15:00";

  let note = { dt_2 };

  const run_log = await makeAppRunLog();
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  try {
    const user_report_schemas = await db.any(
      report_queries.get_user_report_schemas,
      [dt_2, report_type]
    );

    // console.log("\nuser_report_schemas");
    // console.log(user_report_schemas);

    let note = { dt_2, user_report_schemas };
    await addLogEvent(I, run_log, "on_boot", det, note, null);

    const users_system_rpp_data = [];

    for await (let users_report of user_report_schemas) {
      const rpp_data = await db.any(report_queries[report_type], [
        dt_2,
        users_report.author
      ]);

      //console.log("Args to query");
      // console.log(rpp_data);

      const object_map = new Map(rpp_data.map((obj) => [obj.system_id, obj]));

      const matched_systems_list = [];

      users_report.systems_list.forEach((sme) => {
        if (object_map.has(sme)) {
          matched_systems_list.push(object_map.get(sme));
        }
      });

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

    return [users_system_rpp_data, run_log];
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "on_boot", cat, note, error);
    await writeLogEvents(run_log);
  }
}

run_job();
