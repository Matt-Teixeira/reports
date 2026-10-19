-- Every user whose system-list filter names the given customer. The app
-- has no users.customer_id: users.system_list_config is the JSON filter
-- it applies to decide which systems a user sees — an array of
-- {"customers__id": "C0151", "and": {"sites__id": [...], ...}} elements —
-- so "this customer's users" are the ones whose filter has an element for
-- it. customer_count says how many customers the filter names in all: the
-- fleet document lists the users whose access is this customer alone and
-- only counts the rest. Avante's own accounts (any address naming the
-- company) are dropped by fleet_model, not here, so the same rule covers
-- the site-group query too. Ordering is decorative — fleet_model sorts
-- (status, name).
SELECT
    u.email_address,
    u.first_name,
    u.last_name,
    u.status,
    u.notify_email,
    u.last_logged_in,
    (SELECT count(DISTINCT e->>'customers__id')
       FROM jsonb_array_elements(u.system_list_config::jsonb) e)::int AS customer_count
FROM users u
WHERE jsonb_typeof(u.system_list_config::jsonb) = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(u.system_list_config::jsonb) e
    WHERE e->>'customers__id' = $1
  )
ORDER BY u.last_name, u.first_name, u.email_address
