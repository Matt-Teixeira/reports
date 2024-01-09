("use strict");
require("dotenv").config();
const db = require("./utils/db/pg-pool");
const {
  alert_notify: { get_user_report }
} = require("./utils/db/sql/sql");

const { v4: uuidv4 } = require("uuid");

async function run_job() {
  await on_boot();
}

async function on_boot() {
  const query = "SELECT * FROM system WHERE system.id = $1";
  const value = ["SME16076"];

  try {
    const systems = await db.any(get_user_report, ['matt.teixeira@avantehs.com']);
    console.log(systems);
  } catch (error) {
    console.log(error);
  }
}

run_job();
