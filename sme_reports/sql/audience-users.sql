-- The raw audience pool for derived recipients: filtering (status,
-- notify_email, magnet intersection) is pure logic in fanout.js so the
-- dev checks can exercise it; this query stays a plain read.
SELECT email_address, status, notify_email, system_list_cache
FROM public.users
