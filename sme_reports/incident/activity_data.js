const { QueryFile } = require("pg-promise");
const { join } = require("path");
const sql_queries = require("../sql/sql");

// The alert-side reads an activity page needs for one system over one
// window: identity, system extras, the default alert models, detections,
// notifications and the notified users. Read-only. The READINGS are not
// read here — they come from the batch's own analysis (run_one's
// result.activity), so the page plots exactly what the summary judged.
//
// Same queries as the Anomaly Report (incident/data.js), minus its GE MM3 /
// EDU v3 readings pair, and with notifications narrowed to the default
// models (sql/activity-notifications.sql — 50x faster, same rows) and
// recipients carrying app roles for the scrub (sql/activity-recipients.sql).

const sql = (file) => new QueryFile(join(__dirname, "sql", file), { minify: true });
const Q = {
  models: sql("alert-models.sql"),
  detections: sql("detections.sql"),
  notifications: sql("activity-notifications.sql"),
  recipients: sql("activity-recipients.sql"),
  meta: sql("system-meta.sql")
};

// from/to: JS Dates bounding the window (half-open).
const load_activity_data = async (db, { system_id, from, to }) => {
  const args = [system_id, from.toISOString(), to.toISOString()];
  const [identity] = await db.any(sql_queries.get_system_identity, [system_id]);
  if (!identity) throw new Error(`no system ${system_id}`);
  const [models, detections, notifications, [meta]] = await Promise.all([
    db.any(Q.models, [system_id]),
    db.any(Q.detections, args),
    db.any(Q.notifications, args),
    db.any(Q.meta, [system_id])
  ]);
  const addresses = [...new Set(notifications.map((n) => String(n.user_id).toLowerCase()))];
  const recipients = addresses.length ? await db.any(Q.recipients, [addresses]) : [];
  return { identity, meta: meta || {}, models, detections, notifications, recipients };
};

module.exports = { load_activity_data };
