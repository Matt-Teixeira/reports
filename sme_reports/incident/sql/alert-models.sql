-- The system's default alert models: these define what can trigger and
-- for whom the thresholds were set.
SELECT id, field_name_alias, operator, threshold, threshold_units,
       threshold_offset, severity, enabled, customized, notify_frequency,
       last_update, last_updated_by
FROM alert.models
WHERE system_id = $1
  AND user_id = 'default'
ORDER BY field_name_alias, threshold
