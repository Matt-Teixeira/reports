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
const pgp = require("pg-promise")();
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

// FAIL-LOUDLY EXIT-CODE CONTRACT (see DESIGN.md):
//   0 = success or skipped, 1 = failed (fatal error reached on_boot),
//   2 = partial (tolerated per-report errors) or self-log persistence failure,
//   3 = usage error (unknown report name -> operator must fix the invocation).
const EXIT = { SUCCESS: 0, FAILED: 1, PARTIAL: 2, USAGE: 3 };

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

// DERIVE THE FINAL RUN OUTCOME FROM THE EVENTS THE RUN ACTUALLY RECORDED.
// report JOBS MOSTLY LET ERRORS PROPAGATE TO on_boot'S CATCH (fatal); ANY
// ERROR EVENTS LOGGED BY DEEPER LAYERS WITHOUT RETHROW COUNT AS TOLERATED
// (partial). SEE DESIGN.md ("run_outcome/v1").
const deriveOutcome = (run_log, fatal_error) => {
  const events = run_log.log_events || [];
  const error_events = events.filter((e) => e.type === "ERROR").length;
  const warn_events = events.filter((e) => e.type === "WARN").length;
  const failed_systems = [
    ...new Set(
      events
        .filter((e) => e.type === "ERROR" && e.note)
        .map((e) => e.note.sme || e.note.system_id)
        .filter(Boolean)
    ),
  ];

  let outcome;
  let exit_code;
  if (fatal_error) {
    outcome = "failed";
    exit_code =
      fatal_error.code === "E_UNKNOWN_RUN_GROUP" ? EXIT.USAGE : EXIT.FAILED;
  } else if (error_events > 0) {
    outcome = "partial";
    exit_code = EXIT.PARTIAL;
  } else if (run_log.outcome === "skipped") {
    // OPT-IN: run_log.outcome = "skipped" WHEN THE INVOCATION WAS VALID BUT
    // THERE WAS NO WORK (NO SUBSCRIBED REPORT SCHEMAS AT THIS dt).
    outcome = "skipped";
    exit_code = EXIT.SUCCESS;
  } else {
    outcome = "success";
    exit_code = EXIT.SUCCESS;
  }

  return {
    outcome: outcome,
    exit_code: exit_code,
    error_events: error_events,
    warn_events: warn_events,
    systems: {
      failed_count: failed_systems.length,
      failed: failed_systems.slice(0, 50),
    },
    fatal: fatal_error
      ? {
          code: fatal_error.code || null,
          message: String(fatal_error.message || fatal_error),
        }
      : null,
    contract: "run_outcome/v1",
  };
};

// MODULE-LEVEL REFS FOR THE SIGNAL HANDLERS + A ONCE-GUARD SO THE
// FINALIZE/PERSIST PATH CAN NEVER RUN TWICE (A SIGNAL DURING finally WOULD
// OTHERWISE DOUBLE-INSERT INTO util.app_run_logs).
let active_run_log = null;
let finalize_started = false;

// EVERYTHING THAT MUST HAPPEN EXACTLY ONCE AT END-OF-RUN, WHETHER THE RUN
// COMPLETED, THREW, OR WAS KILLED. RETURNS false IF ANOTHER CALLER (finally
// vs signal handler) ALREADY STARTED IT.
const finalizeRun = async (run_log, fatal_error) => {
  if (finalize_started) return false;
  finalize_started = true;

  // 1) DECIDE THE OUTCOME AND SET THE (HONEST) EXIT CODE. NEVER process.exit():
  //    process.exitCode LETS PENDING I/O FLUSH AND THE LOOP DRAIN NATURALLY.
  const outcome = deriveOutcome(run_log, fatal_error);
  process.exitCode = outcome.exit_code;

  // 2) APPEND TERMINAL run_outcome EVENT (type INFO ON PURPOSE: IT MUST
  //    NEVER LAND IN warn_error_logs -- ops-dashboard DERIVES STATUS AND
  //    incident-engine MATERIALIZES INCIDENTS FROM THAT COLUMN). THIS
  //    APP'S VENDORED LOGGER (VARIANT B) HAS NO addRunSummary; THE
  //    OUTCOME EVENT IS STILL LAST AND CARRIES A VALID dt FOR ended_at.
  await addLogEvent(I, run_log, "run_outcome", det, outcome, null);

  // 3) PERSIST THE SELF-LOG, DB FIRST THEN DISK (DISK CAPTURES ANY DB-INSERT
  //    ERROR EVENT). THE DB INSERT IS NEW FOR THIS APP: IT IMPORTED
  //    dbInsertLogEvents BUT NEVER CALLED IT, SO EVERY PRIOR RUN --
  //    INCLUDING FAILED ONES -- WAS INVISIBLE TO ops-dashboard AND
  //    incident-engine.
  const db_insert_ok = await dbInsertLogEvents(pgp, run_log);
  const disk_write_ok = await writeLogEvents(run_log);
  if (!db_insert_ok || !disk_write_ok) {
    // MONITORING IS BLIND FOR THIS RUN -- NEVER REPORT A CLEAN SUCCESS.
    if (process.exitCode === EXIT.SUCCESS) process.exitCode = EXIT.PARTIAL;
    console.error(
      `[run_outcome] self-log persistence failed (db=${db_insert_ok} disk=${disk_write_ok})`
    );
  }

  console.log(
    `[run_outcome] ${outcome.outcome} exit=${process.exitCode}` +
      ` errors=${outcome.error_events} warns=${outcome.warn_events}` +
      ` failed_systems=${outcome.systems.failed_count}`
  );

  // 4) RELEASE THE SHARED POOL SO THE EVENT LOOP CAN DRAIN. THIS APP HAS
  //    EXACTLY ONE LIVE POOL: utils/db/pg-pool (THE LOGGER'S ../db/pg-pool
  //    RESOLVES TO THE SAME MODULE INSTANCE).
  try {
    await db.$pool.end();
  } catch (e) {
    console.error(`[run_outcome] utils/db/pg-pool close: ${e.message}`);
  }
  pgp.end();

  // 5) FAILSAFE: IF A LEAKED HANDLE (SMTP/HTTP SOCKET) KEEPS THE LOOP
  //    ALIVE, FORCE-EXIT WITH THE SAME HONEST CODE INSTEAD OF HANGING.
  //    unref() SO THE TIMER ITSELF NEVER HOLDS THE LOOP OPEN.
  //    (SET ONLY HERE, AFTER PERSISTENCE -- SO IT CAN NEVER PREEMPT A FLUSH.)
  const failsafe = setTimeout(() => {
    console.error(
      "[run_outcome] event loop did not drain within 30s; forcing exit"
    );
    process.exit(process.exitCode);
  }, 30_000);
  failsafe.unref();

  return true;
};

// SIGTERM/SIGINT: FLUSH-ONCE, THEN EXIT WITH AN HONEST NON-ZERO CODE.
// entrypoint.sh EXECS gosu WHICH EXECS node, SO node IS PID 1 AND RECEIVES
// THE SIGNAL DIRECTLY -- WITHOUT THESE HANDLERS A `docker stop` OR CTRL-C
// LEAVES NO util.app_run_logs ROW AND NO FILE LOG AT ALL (finally NEVER
// RUNS ON A DEFAULT-DISPOSITION KILL). A SIGNALED RUN IS A FAILED RUN
// (run_outcome/v1) -- NEVER EXIT 0 HERE.
const gracefulShutdown = (signal) => {
  (async () => {
    const err = new Error(`Received ${signal} — run terminated`);
    err.code = "E_SIGNAL";
    if (active_run_log) {
      const ran = await finalizeRun(active_run_log, err);
      // false = finally (OR THE OTHER SIGNAL) IS ALREADY FLUSHING; LET IT
      // FINISH -- ITS OWN FAILSAFE BOUNDS THE WAIT.
      if (!ran) return;
    } else {
      process.exitCode = EXIT.FAILED;
    }
    process.exit(process.exitCode ?? EXIT.FAILED);
  })().catch((e) => {
    console.error(`[run_outcome] shutdown flush failed: ${e.message || e}`);
    process.exit(EXIT.FAILED);
  });
};
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

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
    reportable_issue: get_issue_tracker_report,
    unsuccessful_acqu_hhm: get_unsuccessful_acqu_hhm,
    new_online_systems: get_new_online_systems
  };

  // RELEASE PROVENANCE (fleet paradigm): build-release.sh STAMPS RELEASE_SHA
  // INTO THE DEPLOYED .env; A DEV TREE HAS NO KEY AND RECORDS 'dev-tree'. THE
  // BOOT env_note MAKES EVERY util.app_run_logs ROW IDENTIFY ITS COMMIT
  // (verbose_log->0->note->>'RELEASE_SHA'); THE CONSOLE LINE COVERS ANY
  // CAPTURED OUTPUT (e.g. cron .out FILES, IF A SCHEDULE EVER EXISTS).
  const release_sha = process.env.RELEASE_SHA || "dev-tree";
  console.log(
    `[reports] family=${report_type || "(none)"} release_sha=${release_sha}` +
      ` user_id=${process.env.USER_ID}`
  );
  let note = {
    dt,
    report_family: report_type,
    USER_ID: process.env.USER_ID,
    LOGGER_MODE: process.env.LOGGER_MODE,
    RELEASE_SHA: release_sha
  };

  const run_log = await makeAppRunLog();
  active_run_log = run_log;
  await addLogEvent(I, run_log, "on_boot", cal, note, null);

  let fatal_error = null;
  try {
    if (report_type === "monday") {
      // RUNNER-LEVEL CONTROL-FLOW FIX: THIS BRANCH USED TO RUN *BEFORE* THE
      // try WITH A null run_log, NEVER return, AND FALL THROUGH INTO THE
      // GENERIC QUERY PATH BELOW -- WHICH HAS NO `monday` KEY IN
      // report_queries. IT NOW DISPATCHES ONCE, WITH THE REAL run_log, AND
      // THE return STILL RUNS THE SHARED finally (PERSISTENCE + EXIT CODE).
      let users_report_rpp_data = {
        field_name: "monday"
      };
      await run_job(users_report_rpp_data, run_log);
      return;
    }

    if (
      report_type === "get_user_report_schemas" ||
      !report_queries[report_type]
    ) {
      // FAIL LOUDLY: AN UNKNOWN/TYPO'D REPORT NAME PREVIOUSLY MATCHED ZERO
      // SCHEMA ROWS AND EXITED 0 AS A SILENT NO-OP. (get_user_report_schemas
      // IS A LOOKUP KEY IN THE MAP, NOT A DISPATCHABLE REPORT.)
      const err = new Error(
        `Unknown run group: ${JSON.stringify(report_type)}`
      );
      err.code = "E_UNKNOWN_RUN_GROUP";
      throw err;
    }

    const user_report_schemas = await db.any(
      report_queries.get_user_report_schemas,
      [dt, report_type]
    );

    let note = { dt, user_report_schemas };
    await addLogEvent(I, run_log, "on_boot", det, note, null);

    if (!user_report_schemas.length) {
      // VALID REPORT NAME, NO SUBSCRIBED SCHEMAS AT THIS dt: RECORD skipped
      // (EXIT 0) INSTEAD OF AN INDISTINGUISHABLE "success" THAT SENT NOTHING.
      run_log.outcome = "skipped";
    }

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
  } catch (error) {
    fatal_error = error;
    console.error(error);
    await addLogEvent(E, run_log, "on_boot", cat, note, error);
  } finally {
    // EVERYTHING END-OF-RUN LIVES IN finalizeRun (ONCE-GUARDED: THE SIGNAL
    // HANDLERS SHARE IT, SO A KILL DURING THIS FLUSH CANNOT DOUBLE-INSERT).
    await finalizeRun(run_log, fatal_error);
  }
}

on_boot().catch((error) => {
  // BOOTSTRAP FAILURE (makeAppRunLog / FIRST LOG EVENT): NOTHING WAS RECORDED,
  // SO AT LEAST CRASH HONESTLY.
  console.error(error);
  process.exit(EXIT.FAILED);
});
