-- notifications.sql narrowed to the system's DEFAULT alert models. The
-- per-user model copies are never referenced by a notification (verified
-- 2026-10-19: zero rows over six months on three systems referencing only
-- non-default models), and overlapping against them made this query
-- compare every row with ~1,000 ids: 23 s per system over six months,
-- 0.4 s narrowed. One row per recipient per notification run.
SELECT n.last_update, n.user_id, n.customer_id, n.email_status, n.sms_status,
       n.detected_alert_models, n.run_id
FROM alert.notifications n
WHERE n.detected_alert_models && ARRAY(
        SELECT id::text FROM alert.models WHERE system_id = $1 AND user_id = 'default')
  AND n.last_update >= $2
  AND n.last_update < $3
ORDER BY n.last_update
