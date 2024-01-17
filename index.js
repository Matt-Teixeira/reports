("use strict");
require("dotenv").config();

//127.0.0.1

// JOBS
const { helium_level_report, helium_psi_report } = require("./jobs");

// TOOLS
const { formatted_dt, captureDatetime } = require("./tools");

// UTILS
const db = require("./utils/db/pg-pool");
const {
  alert_notify: {
    get_user_report_schemas,
    get_he_level_report_data,
    get_he_psi_rport_data
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

  console.log(users_model_rpp_data);

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

  const report_queries = {
    get_user_report_schemas,
    he_level_value: get_he_level_report_data,
    he_pressure_value: get_he_psi_rport_data
  };

  const dt = formatted_dt();
  const dt_2 = "wed-09:00";

  let note = { dt };

  const run_log = await makeAppRunLog();
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  try {
    const user_report_schemas = await db.any(
      report_queries.get_user_report_schemas,
      [dt_2, report_type]
    );

    let note = { dt, user_report_schemas };
    await addLogEvent(I, run_log, "on_boot", det, note, null);

    const users_model_rpp_data = [];

    for await (let users_report of user_report_schemas) {
      const rpp_data = await db.any(report_queries[report_type], [
        dt_2,
        users_report.author
      ]);

      const object_map = new Map(
        rpp_data.map((obj) => [obj.alert_model_id, obj])
      );

      const matched_model_data = [];

      users_report.alert_models.forEach((alert_model_id) => {
        if (object_map.has(alert_model_id)) {
          matched_model_data.push(object_map.get(alert_model_id));
        }
      });

      users_model_rpp_data.push({
        author: users_report.author,
        report_name: users_report.report_name,
        field_name: users_report.field_name,
        operator: users_report.operator,
        custom_threshold: users_report.threshold,
        threshold_data_type: users_report.threshold_data_type,
        cc_list: users_report.cc_list,
        matched_model_data
      });
    }

    return [users_model_rpp_data, run_log];
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "on_boot", cat, note, error);
    await writeLogEvents(run_log);
  }
}

run_job();

/*

matched_model_data = [
  {
    author: "matt.teixeira@avantehs.com",
    rpp_data: 
  }
]

*/

/* 

['6fd60576-cf17-4bbe-b127-2577ff5b7eb6', '0228dfc7-d3e9-4a9c-9f1e-3d20ec88cf19', '6cf7596f-7dd2-4fb5-83e3-dbbc8c10f5f5', '6b3fccdc-75d9-4583-9bde-47ac90549e6d', '0cf80263-ebdd-4156-83f3-f843832e91cf', '1d11540b-ac87-416c-9fb2-213a0102edc6', '530ee9f2-4f18-461a-98c3-a8dc0cb73cbb', '365195f5-e31c-4d0c-9d16-4f97246c9fd9', '02e20539-b8d0-4ac9-be37-ae4ce919257e', '60323814-5eff-4b41-a58b-e51cea5f5fb4', 'b162edc1-6064-4d42-bee4-50e6df73eaaa', 'ecca8ea6-ec93-4c74-bde3-5d1d64f8c1e7', '034ee513-0bba-4704-9382-58bfd7647ae3', '03cb4cf0-ba6e-4c56-9b4c-94fe54994e47', '6762c960-2b95-43e2-808e-fa34e32b32c5', 'eb0f2a37-c05e-4999-9557-fa605a1d2e90', '042afdbd-ec4e-4a14-909c-975fd24042c3', '070fe67d-2a88-47c7-b2d7-839969bde2f2', '09323879-8ac8-435c-b790-d694b909feee', '0a5792f8-b5a8-4290-a05d-d386acb89b16', '0aae507a-e5dd-407b-a254-977169e2d9d1']

'6b3fccdc-75d9-4583-9bde-47ac90549e6d', '0cf80263-ebdd-4156-83f3-f843832e91cf', '1d11540b-ac87-416c-9fb2-213a0102edc6', '530ee9f2-4f18-461a-98c3-a8dc0cb73cbb', '365195f5-e31c-4d0c-9d16-4f97246c9fd9', '02e20539-b8d0-4ac9-be37-ae4ce919257e', '60323814-5eff-4b41-a58b-e51cea5f5fb4', 'b162edc1-6064-4d42-bee4-50e6df73eaaa', 'ecca8ea6-ec93-4c74-bde3-5d1d64f8c1e7', '034ee513-0bba-4704-9382-58bfd7647ae3', '03cb4cf0-ba6e-4c56-9b4c-94fe54994e47', '6762c960-2b95-43e2-808e-fa34e32b32c5', 'eb0f2a37-c05e-4999-9557-fa605a1d2e90', '042afdbd-ec4e-4a14-909c-975fd24042c3', '070fe67d-2a88-47c7-b2d7-839969bde2f2', '09323879-8ac8-435c-b790-d694b909feee', '0a5792f8-b5a8-4290-a05d-d386acb89b16', '0aae507a-e5dd-407b-a254-977169e2d9d1'

 */
