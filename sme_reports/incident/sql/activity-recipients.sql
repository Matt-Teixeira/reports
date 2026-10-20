-- recipients.sql for activity pages: who the notified addresses are, which
-- customers their access names (users.system_list_config), and their app
-- roles — the scrub drops staff-role users (incident/scrub.js). Unlike
-- recipients.sql, a user whose config or roles is not a JSON array is still
-- returned (empty list), so the scrub sees every notified user's row.
SELECT u.email_address, u.first_name, u.last_name, u.status,
       CASE WHEN jsonb_typeof(u.system_list_config::jsonb) = 'array'
            THEN ARRAY(SELECT DISTINCT e->>'customers__id'
                       FROM jsonb_array_elements(u.system_list_config::jsonb) e)
            ELSE '{}'::text[] END AS customer_ids,
       CASE WHEN jsonb_typeof(u.roles->'roles') = 'array'
            THEN ARRAY(SELECT jsonb_array_elements_text(u.roles->'roles'))
            ELSE '{}'::text[] END AS roles
FROM users u
WHERE lower(u.email_address) = ANY($1)
