SELECT capture_datetime, comp_vib_status
FROM edu.v3
WHERE system_id = $1
  AND capture_datetime >= $2
  AND capture_datetime < $3
ORDER BY capture_datetime
