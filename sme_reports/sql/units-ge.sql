SELECT
    COALESCE(mm4.he_level_units, mm3.he_level_units) AS helium_units,
    COALESCE(mm4.he_pressure_units, mm3.he_pressure_units) AS pressure_units
FROM (SELECT 1) one
LEFT JOIN mag.ge_mm4_units mm4 ON mm4.system_id::text = $1
LEFT JOIN mag.ge_mm3_units mm3 ON mm3.system_id::text = $1
