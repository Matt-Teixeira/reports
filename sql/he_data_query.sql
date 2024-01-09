SELECT systems.id, rm.capture_datetime AS capture_datetime, zz.id AS alert_model_id, zz.author, zz.alert_models AS alert_models_list, zz.cc_list,
COALESCE(
    (Select he_level_value      FROM mag.ge_mm3 mm3                         WHERE rm.system_id = mm3.system_id::text     and rm.capture_datetime = mm3.capture_datetime),
    (Select he_level_value      FROM mag.ge_mm4 mm4                         WHERE rm.system_id = mm4.system_id::text     and rm.capture_datetime = mm4.capture_datetime),
    (Select he_level_1_value    FROM mag.siemens siemens                    WHERE rm.system_id = siemens.system_id::text and rm.capture_datetime = siemens.capture_datetime),
    (Select he_level_1_value    FROM mag.siemens_non_tim non_tim            WHERE rm.system_id = non_tim.system_id::text and rm.capture_datetime = non_tim.capture_datetime),
    (Select helium_level_value  FROM mag.philips_mri_monitoring_data_agg    WHERE rm.system_id = philips_mri_monitoring_data_agg.system_id::text and helium_level_value IS NOT NULL ORDER BY capture_datetime desc LIMIT 1)
) AS helium_value,
COALESCE(
    (Select he_level_units      FROM mag.ge_mm4_units mm4                       WHERE rm.system_id = mm4.system_id::text),
    (Select he_level_units      FROM mag.ge_mm3_units mm3                       WHERE rm.system_id = mm3.system_id::text),
    (Select he_level_units      FROM mag.siemens_units siemens                  WHERE rm.system_id = siemens.system_id::text),
    (Select he_level_units      FROM mag.siemens_non_tim_units non_tim          WHERE rm.system_id = non_tim.system_id::text),
    (Select helium_level_units  FROM mag.philips_mri_monitoring_data_units phil WHERE rm.system_id = phil.system_id::text and helium_level_units IS NOT NULL)
) AS helium_units
FROM
    recent_files rm FULL
    JOIN systems ON rm.system_id = systems.id
    JOIN (
        SELECT am.id, am.system_id, ar.author, ar.alert_models, ar.email_schedule, ar.cc_list, ar.OPERATOR, ar.threshold, ar.threshold_data_type FROM alert.reports ar
        JOIN alert.models am ON ar.author = am.user_id
        WHERE ar.email_schedule ->> 'tue-10:30' = 'true'
    ) zz ON systems.id = zz.system_id
WHERE
    systems.show_on_website = TRUE
    AND systems.process_mag = TRUE