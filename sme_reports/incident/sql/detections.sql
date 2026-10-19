-- Every detection the alert engine logged for the system's default models
-- in the window. inserted_at is when the run happened; capture_datetime is
-- the slot it evaluated — except for offline models, where it is the
-- monitor's last check-in and can predate the window, hence the OR.
SELECT d.alert_model_id, d.field_name, d.resolved_field_content,
       d.resolved_field_units, d.operator, d.threshold,
       d.resolved_threshold_content, d.threshold_units,
       d.inserted_at, d.capture_datetime
FROM alert.detections d
WHERE d.alert_model_id IN (
        SELECT id FROM alert.models WHERE system_id = $1 AND user_id = 'default')
  AND ((d.capture_datetime >= $2 AND d.capture_datetime < $3)
       OR (d.inserted_at >= $2 AND d.inserted_at < $3))
ORDER BY d.inserted_at
