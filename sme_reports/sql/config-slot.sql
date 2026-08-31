-- Enabled report configs whose schedule grid marks the fired slot true —
-- the same ->> 'true' convention alert.reports uses.
SELECT * FROM alert.sme_reports
WHERE enabled = true AND email_schedule ->> $1 = 'true'
ORDER BY id
