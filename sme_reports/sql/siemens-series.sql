SELECT
    capture_datetime,
    host_datetime,
    mag_psia_value,
    he_level_1_value,
    he_level_2_value,
    compressor_status,
    cold_head_sensor_1_value,
    he_status
FROM mag.siemens
WHERE system_id::text = $1
    AND capture_datetime BETWEEN $2 AND $3
ORDER BY capture_datetime ASC
