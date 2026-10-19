-- Descriptive extras for the header tiles that the shared identity query
-- (sql/get-system-identity.sql) does not carry: serial number, which data
-- feeds the system has, and the site's street address.
SELECT s.serial_number, s.process_mag, s.process_edu, s.process_log,
       si.street_address, si.zip
FROM systems s
JOIN sites si ON si.id = s.site_id
WHERE s.id = $1
