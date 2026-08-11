// Thin DB layer for scheduled (DB-config) runs — PLAN-SCOPED-WEEKLY.md B2.
// Every decision lives in fanout.js (pure, dev-checked); this module only
// reads rows and writes send records. The pg pool loads lazily so DB-free
// dev checks can import modules that import this one.

const q = require("./sql/sql");

const db = () => require("../utils/db/pg-pool");

// The current schedule slot, via the SAME function the legacy alert.reports
// cron flow uses (tools/schedule_dt.js: America/New_York, "ccc-HH:mm",
// lowercased) — shared, not copied, so the two schedulers can never drift
// on slot naming.
const current_slot = () => require("../tools/schedule_dt")();

const load_slot_configs = (slot) => db().any(q.config_slot, [slot]);

const load_config = (id) => db().oneOrNone(q.config_by_id, [id]);

const load_audience_pool = async () => {
  const [users, mag] = await Promise.all([
    db().any(q.audience_users),
    db().any(q.mag_system_ids)
  ]);
  return { users, mag_ids: mag.map((r) => r.id) };
};

// Refetched immediately before sending — the re-check must see CURRENT
// access, not the access that existed at render time.
const load_user_caches = async (emails) => {
  const rows = await db().any(q.user_caches, [emails]);
  return new Map(rows.map((r) => [r.email_address, r]));
};

const record_send = ({ config_id, slot, recipient, scope_hash, document, status, error }) =>
  db().none(q.insert_send, [
    config_id,
    slot || null,
    recipient,
    scope_hash || null,
    document || null,
    status,
    error || null
  ]);

module.exports = {
  current_slot,
  load_slot_configs,
  load_config,
  load_audience_pool,
  load_user_caches,
  record_send
};
