SELECT field_name, operator, threshold, threshold_units, severity
FROM alert.models
WHERE user_id = 'default'
    AND system_id = $1
    AND enabled IS TRUE
    AND field_name = ANY($2)
    AND operator IN ('greater_than', 'less_than')
