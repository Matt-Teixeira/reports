-- CURRENT system access for the given users, refetched at send time —
-- access revoked between render and send must not leak a wider document.
SELECT email_address, status, notify_email, system_list_cache
FROM public.users
WHERE email_address = ANY($1)
