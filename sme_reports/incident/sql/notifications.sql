-- One row per recipient per notification run that referenced any of the
-- system's models. A run can bundle other systems' models too, so the
-- per-row model list is narrowed to this system's in analyze.js.
SELECT n.last_update, n.user_id, n.customer_id, n.email_status, n.sms_status,
       n.detected_alert_models, n.run_id
FROM alert.notifications n
WHERE n.detected_alert_models && ARRAY(
        SELECT id::text FROM alert.models WHERE system_id = $1)
  AND n.last_update >= $2
  AND n.last_update < $3
ORDER BY n.last_update
