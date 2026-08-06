SELECT
    capture_datetime,
    host_datetime,
    he_pressure_value,
    he_level_value,
    coldhead_ruo_value,
    shield_si410_value,
    water_flow_value,
    water_temp_value,
    cdc1_value,
    hdc_value
FROM mag.ge_mm3
WHERE system_id::text = $1
    AND capture_datetime BETWEEN $2 AND $3
ORDER BY capture_datetime ASC
