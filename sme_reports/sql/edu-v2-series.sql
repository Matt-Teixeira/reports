SELECT
    capture_datetime,
    room_temp_value,
    room_humidity_value,
    temp_probe_0_value,
    temp_probe_1_value,
    comp_vib_status
FROM edu.v2
WHERE system_id::text = $1
    AND capture_datetime BETWEEN $2 AND $3
ORDER BY capture_datetime ASC
