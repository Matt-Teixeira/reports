// Read-only database connection for the GE CT Insights viewer
// (hhm_rpp_ge PLAN-CT-INSIGHTS.md §16.2 item 3).
//
// Its own pg-promise instance, not utils/db/pg-pool: same credentials
// (PG_* from the repo-root .env), but every session starts with
// default_transaction_read_only=on, so the builder cannot write. open()
// checks that setting before returning and refuses otherwise.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });
const pgp = require("pg-promise")({ noWarnings: true });

const SESSION = [
  "-c default_transaction_read_only=on",
  "-c statement_timeout=120000",
  "-c lock_timeout=5000",
  "-c idle_in_transaction_session_timeout=300000"
].join(" ");

const open = async ({ application_name = "ct_viewer" } = {}) => {
  for (const k of ["PG_HOST", "PG_DB", "PG_USER", "PG_SSL_PATH"]) if (!process.env[k]) throw new Error(`ct/db: ${k} is not set (.env)`);
  const db = pgp({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT || 5432,
    database: process.env.PG_DB,
    user: process.env.PG_USER,
    password: process.env.PG_PW,
    ssl: { require: true, cert: fs.readFileSync(path.resolve(ROOT, process.env.PG_SSL_PATH)), rejectUnauthorized: true },
    application_name,
    max: 1,
    options: SESSION
  });
  const s = await db.one("SELECT current_setting('default_transaction_read_only') AS ro");
  if (s.ro !== "on") {
    pgp.end();
    throw new Error("ct/db: session is not read-only; refusing");
  }
  return db;
};

const close = () => pgp.end();

module.exports = { open, close, pgp };
