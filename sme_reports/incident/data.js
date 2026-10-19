const { QueryFile } = require("pg-promise");
const { join } = require("path");
const sql_queries = require("../sql/sql");

// Loads everything an incident report reads for one system over one fixed
// window. Read-only. The readings queries are GE MM3 + EDU v3 — the only
// pairing this report has been built against so far (see README.md).

const sql = (file) => new QueryFile(join(__dirname, "sql", file), { minify: true });
const Q = {
  models: sql("alert-models.sql"),
  detections: sql("detections.sql"),
  notifications: sql("notifications.sql"),
  recipients: sql("recipients.sql"),
  mag: sql("ge-mm3-readings.sql"),
  edu: sql("edu-v3-readings.sql"),
  meta: sql("system-meta.sql")
};

const load_incident_data = async (db, { system_id, from, to }) => {
  const args = [system_id, from.toISOString(), to.toISOString()];
  const [identity] = await db.any(sql_queries.get_system_identity, [system_id]);
  if (!identity) throw new Error(`no system ${system_id}`);
  const [models, detections, notifications, mag, edu, [meta]] = await Promise.all([
    db.any(Q.models, [system_id]),
    db.any(Q.detections, args),
    db.any(Q.notifications, args),
    db.any(Q.mag, args),
    db.any(Q.edu, args),
    db.any(Q.meta, [system_id])
  ]);
  const addresses = [...new Set(notifications.map((n) => n.user_id.toLowerCase()))];
  const recipients = addresses.length ? await db.any(Q.recipients, [addresses]) : [];
  return { identity, meta: meta || {}, models, detections, notifications, recipients, mag, edu };
};

module.exports = { load_incident_data };
