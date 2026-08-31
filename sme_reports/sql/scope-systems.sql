-- Resolve a request scope to concrete magnet systems, via the canonical
-- hierarchy: customers -> sites (customer_id) -> systems (site_id). The same
-- three tables get-system-identity.sql reads, so the scope join and the
-- names the reports display can never disagree. Only mag-processed systems
-- qualify — this pipeline reports on magnets.
-- Exactly one of the three parameters is non-null (scope.js validates).
SELECT
    systems.id      AS system_id,
    sites.id        AS site_id,
    sites.name      AS site_name,
    c.id            AS customer_id,
    c.name          AS customer_name
FROM systems
JOIN sites ON systems.site_id = sites.id
JOIN customers c ON c.id = sites.customer_id
WHERE systems.process_mag = true
  AND ($1::text   IS NULL OR c.id = $1)
  AND ($2::text[] IS NULL OR sites.id = ANY($2))
  AND ($3::text[] IS NULL OR systems.id = ANY($3))
ORDER BY systems.id
