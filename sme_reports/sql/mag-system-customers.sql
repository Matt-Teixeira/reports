-- Every mag-processed system with its owning customer — the per-customer
-- document plan partitions each user's scope by this mapping.
SELECT systems.id AS system_id, c.id AS customer_id, c.name AS customer_name
FROM systems
JOIN sites ON systems.site_id = sites.id
JOIN customers c ON c.id = sites.customer_id
WHERE systems.process_mag = true
ORDER BY systems.id
