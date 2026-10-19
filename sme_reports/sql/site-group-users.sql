-- Every user assigned to the given site groups (public.user_site_groups),
-- with each group's own identity. LEFT-joined from the group side so a
-- group with nobody assigned still returns ONE row (email_address NULL):
-- the fleet document states "no users assigned" rather than dropping the
-- group. Ordering is decorative — fleet_model sorts (status, then name).
SELECT
    g.id            AS site_group_id,
    g.name          AS site_group_name,
    g.customer_id,
    c.name          AS customer_name,
    u.email_address,
    u.first_name,
    u.last_name,
    u.status,
    u.notify_email,
    u.last_logged_in
FROM site_groups g
JOIN customers c ON c.id = g.customer_id
LEFT JOIN user_site_groups usg ON usg.site_group_id = g.id
LEFT JOIN users u ON u.email_address = usg.user_email
WHERE g.id = ANY($1::int[])
ORDER BY g.name, g.id, u.last_name, u.first_name, u.email_address
