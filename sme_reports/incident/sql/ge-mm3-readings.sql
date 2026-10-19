SELECT capture_datetime, he_level_value, he_pressure_value
FROM mag.ge_mm3
WHERE system_id = $1
  AND capture_datetime >= $2
  AND capture_datetime < $3
ORDER BY capture_datetime
