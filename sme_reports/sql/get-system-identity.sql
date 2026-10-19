-- One system's display identity, through the canonical hierarchy
-- (systems -> sites -> customers). The site GROUP rides along as a LEFT
-- join: site_group_sites.site_id is UNIQUE, so a site belongs to at most
-- one group and this stays a single row — systems whose site is in no
-- group return NULLs, which the records carry as "no site group".
SELECT
    systems.id AS system_id,
    systems.manufacturer,
    systems.modality,
    systems.model,
    systems.cus_sys_id,
    systems.site_id,
    sites.name AS site_name,
    sites.city,
    sites.state,
    c.id AS customer_id,
    c.name AS customer_name,
    sg.id AS site_group_id,
    sg.name AS site_group_name
FROM systems
JOIN sites ON systems.site_id = sites.id
JOIN customers c ON c.id = sites.customer_id
LEFT JOIN site_group_sites sgs ON sgs.site_id = sites.id
LEFT JOIN site_groups sg ON sg.id = sgs.site_group_id
WHERE systems.id = $1
