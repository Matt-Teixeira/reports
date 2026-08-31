SELECT he_level_units AS helium_units, shield_temp_units AS pressure_units
FROM mag.siemens_non_tim_units
WHERE system_id::text = $1
