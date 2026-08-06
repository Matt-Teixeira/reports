SELECT helium_level_units AS helium_units, monitor_magnet_pressure_units AS pressure_units
FROM mag.philips_mri_monitoring_data_units
WHERE system_id::text = $1
