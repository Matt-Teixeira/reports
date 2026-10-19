-- Who the notified addresses are, and which customers their access names
-- (users.system_list_config is the app's per-user system filter).
SELECT u.email_address, u.first_name, u.last_name, u.status,
       ARRAY(SELECT DISTINCT e->>'customers__id'
             FROM jsonb_array_elements(u.system_list_config::jsonb) e) AS customer_ids
FROM users u
WHERE lower(u.email_address) = ANY($1)
  AND jsonb_typeof(u.system_list_config::jsonb) = 'array'
