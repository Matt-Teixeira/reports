SELECT
    systems.id AS system_id,
    systems.manufacturer,
    systems.modality,
    systems.model,
    systems.cus_sys_id,
    sites.name AS site_name,
    sites.city,
    sites.state,
    c.name AS customer_name
FROM systems
JOIN sites ON systems.site_id = sites.id
JOIN customers c ON c.id = sites.customer_id
WHERE systems.id = $1
