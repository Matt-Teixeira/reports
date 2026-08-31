-- edu.v1 names its probes 1/2; aliased to the 0/1 convention of v2/v3.
SELECT
    capture_datetime,
    room_temp_value,
    room_humidity_value,
    temp_probe_1_value AS temp_probe_0_value,
    temp_probe_2_value AS temp_probe_1_value,
    NULL AS comp_vib_status
FROM edu.v1
WHERE system_id::text = $1
    AND capture_datetime BETWEEN $2 AND $3
ORDER BY capture_datetime ASC
