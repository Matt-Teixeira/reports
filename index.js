("use strict");
require("dotenv").config();
const db = require("./utils/db/pg-pool");
const { formatted_dt, captureDatetime } = require("./tools");
const {
  alert_notify: { get_user_report_schema, get_user_report }
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
  await on_boot();
}

async function on_boot() {
  const capture_datetime = captureDatetime();
  const dt = formatted_dt();
  let note = { dt };

  const run_log = await makeAppRunLog();
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  try {
    const user_report_schemas = await db.any(get_user_report_schema, [dt]);

    let note = { dt, user_report_schemas };
    await addLogEvent(I, run_log, "on_boot", det, note, null);

    for await (let report of user_report_schemas) {
      const data = await db.any(get_user_report, [dt, report.author]);
      note.data = data;

      await addLogEvent(I, run_log, "on_boot", det, note, null);
    }

    await writeLogEvents(run_log);
  } catch (error) {
    console.log(error);
    await addLogEvent(E, run_log, "on_boot", cat, note, error);
    await writeLogEvents(run_log);
  }
}

run_job();
