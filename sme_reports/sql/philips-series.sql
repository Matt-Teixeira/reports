SELECT
    capture_datetime,
    host_datetime,
    monitor_magnet_pressure_value,
    he_psi_avg_value,
    helium_level_value,
    cryo_comp_malf_value,
    cryo_comp_temp_alarm_state,
    cryo_comp_press_alarm_state,
    quenched_state,
    tech_room_temp_value
FROM mag.philips_mri_monitoring_data_agg
WHERE system_id::text = $1
    AND capture_datetime BETWEEN $2 AND $3
ORDER BY capture_datetime ASC
