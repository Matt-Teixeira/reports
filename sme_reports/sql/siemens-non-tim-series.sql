SELECT
    capture_datetime,
    host_datetime,
    shield_temp_value,
    he_level_1_value,
    cca_cab_temp_value,
    cca_cab_temp_warn_value,
    cca_cab_temp_alarm_value
FROM mag.siemens_non_tim
WHERE system_id::text = $1
    AND capture_datetime BETWEEN $2 AND $3
ORDER BY capture_datetime ASC
