("use strict");
require("dotenv").config();
const db = require("./utils/db/pg-pool");
const { formatted_dt, captureDatetime } = require("./tools");
const {
  alert_notify: { get_user_report_schemas, get_he_level_report_data }
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
  const capture_datetime = captureDatetime();
  const job_id = uuidv4();
  const users_model_rpp_data = await on_boot();
  for (let users_rpp_data of users_model_rpp_data) {
    console.log(users_rpp_data);
  }
}

async function on_boot() {
  const dt = formatted_dt();
  const dt_2 = "wed-09:00";

  let note = { dt };

  const run_log = await makeAppRunLog();
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  try {
    const user_report_schemas = await db.any(get_user_report_schemas, [dt_2]);

    // console.log(user_report_schemas);

    let note = { dt, user_report_schemas };
    await addLogEvent(I, run_log, "on_boot", det, note, null);

    const users_model_rpp_data = [];

    for await (let users_report of user_report_schemas) {
      const rpp_data = await db.any(get_he_level_report_data, [
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
        cc_list: users_report.cc_list,
        matched_model_data
      });
    }

    return users_model_rpp_data;
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
