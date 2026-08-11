-- One row per envelope recipient per delivery attempt (or dry-run/skip),
-- written by the scheduled send loop.
INSERT INTO alert.sme_report_sends
  (config_id, slot, recipient, recipient_role, scope_hash, document, status, error)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
