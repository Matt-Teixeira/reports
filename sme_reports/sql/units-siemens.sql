SELECT he_level_units AS helium_units, mag_psia_units AS pressure_units
FROM mag.siemens_units
WHERE system_id::text = $1
