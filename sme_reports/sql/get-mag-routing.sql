SELECT pg_tables
FROM config.mag
WHERE system_id = $1
