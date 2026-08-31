-- =========================================================================
-- alert.sme_reports + alert.sme_report_sends  (PLAN-SCOPED-WEEKLY.md, B1)
--
-- Config and send-status tables for the scheduled SME Magnet Health
-- reports: template rows that fan out at run time (one row can drive the
-- whole weekly user-scoped batch), and one row per delivery attempt.
--
-- REPEATABLE: every statement is IF NOT EXISTS / OR REPLACE-safe; running
-- this file twice is a no-op. Runs in one transaction.
--
-- HOW TO RUN (from the repo root, using the same .env the app reads):
--
--   set -a; source .env; set +a
--   PGPASSWORD="$PG_PW" psql \
--     "host=$PG_HOST port=$PG_PORT dbname=$PG_DB user=$PG_USER sslmode=require" \
--     -v ON_ERROR_STOP=1 -f sql/sme_reports_config.sql
--
-- VERIFY afterwards (should list both tables):
--
--   PGPASSWORD="$PG_PW" psql "host=$PG_HOST port=$PG_PORT dbname=$PG_DB \
--     user=$PG_USER sslmode=require" \
--     -c "\d alert.sme_reports" -c "\d alert.sme_report_sends"
--
-- ROLLBACK (destructive — drops config and send history):
--
--   -- DROP TABLE IF EXISTS alert.sme_report_sends;
--   -- DROP TABLE IF EXISTS alert.sme_reports;
--
-- GRANTS: this file creates tables as the running user. If the frontend
-- writes through a different role, grant it separately, e.g.:
--   -- GRANT SELECT, INSERT, UPDATE ON alert.sme_reports TO <frontend_role>;
--   -- GRANT SELECT ON alert.sme_report_sends TO <frontend_role>;
--   -- GRANT USAGE ON SEQUENCE alert.sme_reports_id_seq TO <frontend_role>;
-- =========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS alert.sme_reports (
  id             SERIAL PRIMARY KEY,
  -- users.email_address of whoever created/last edited the row (audit
  -- trail, same convention as alert.reports.author).
  author         TEXT NOT NULL,
  -- New rows never send until BOTH gates open: enabled turns the row on,
  -- dry_run=false allows real SMTP. A freshly inserted row is inert.
  enabled        BOOLEAN NOT NULL DEFAULT false,
  dry_run        BOOLEAN NOT NULL DEFAULT true,
  -- What this row produces:
  --   user_summary     one scoped summary per distinct user scope-set,
  --                    emailed to each user (the weekly flagship)
  --   customer_summary one summary covering a customer's systems
  --   fleet_summary    the internal all-fleet document
  --   briefs           per-system briefs (no summary document)
  report_kind    TEXT NOT NULL
                 CONSTRAINT sme_reports_kind_chk
                 CHECK (report_kind IN
                   ('user_summary', 'customer_summary', 'fleet_summary', 'briefs')),
  -- Which systems / users the row covers. Shapes (see sme_reports/scope.js
  -- and PLAN-SCOPED-WEEKLY.md):
  --   NULL on user_summary       a SUBSCRIPTION: the audience is the row's
  --                              AUTHOR — the frontend "subscribe" contract
  --                              is (author, report_kind, lookback_days,
  --                              email_schedule, enabled), nothing else
  --   {"users": ["a@b.co", …]}   named users (pilots, admin sends)
  --   {"all_users": true}        every active notifiable user (admin tool)
  --   {"customer_id": "C0151"}   one customer's mag systems
  --   {"site_ids": ["..."]}      specific sites
  --   {"system_ids": ["SME..."]} explicit systems
  --   NULL on fleet_summary      the whole fleet
  scope          JSONB,
  -- Analysis period in days; the weekly product uses 7.
  lookback_days  INTEGER NOT NULL DEFAULT 7
                 CONSTRAINT sme_reports_lookback_chk
                 CHECK (lookback_days > 0),
  -- Free-form options consumed by the runner, e.g.
  -- {"include_briefs": true, "exception_only": true}. Unknown keys are
  -- rejected by the runner, not silently ignored.
  options        JSONB NOT NULL DEFAULT '{}',
  -- derived  = recipients resolved at run time from public.users (active,
  --            notify_email, >=1 mag system in scope)
  -- explicit = the recipients[] column below is the whole audience
  recipient_mode TEXT NOT NULL DEFAULT 'derived'
                 CONSTRAINT sme_reports_recipient_mode_chk
                 CHECK (recipient_mode IN ('derived', 'explicit')),
  recipients     TEXT[],
  cc_list        TEXT[],
  -- Slot grid, same convention as alert.reports / alert.models:
  -- {"mon-08:00": true, ...} on the 30-minute day-HH:MM grid. The cron
  -- runner fires, formats the current slot, and selects enabled rows whose
  -- slot is true.
  email_schedule JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Explicit mode without an audience is a config error, caught here so a
  -- frontend write fails loudly instead of producing a silent no-op row.
  CONSTRAINT sme_reports_explicit_has_recipients_chk
  CHECK (recipient_mode <> 'explicit'
         OR (recipients IS NOT NULL AND array_length(recipients, 1) > 0))
);

COMMENT ON TABLE alert.sme_reports IS
  'Template rows driving scheduled SME Magnet Health reports; one row can fan out to many scoped documents/recipients at run time. Contract: sme_reports/PLAN-SCOPED-WEEKLY.md.';

CREATE TABLE IF NOT EXISTS alert.sme_report_sends (
  id          BIGSERIAL PRIMARY KEY,
  config_id   INTEGER REFERENCES alert.sme_reports (id),
  run_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The schedule slot that fired this run ("mon-08:00"), null for manual
  -- --config/--slot operator runs.
  slot        TEXT,
  recipient   TEXT NOT NULL,
  -- Identifies WHICH scoped document this recipient got: the scope-set
  -- hash from scope_artifact_id (8 hex chars).
  scope_hash  TEXT,
  -- Archived artifact basename, so support can answer "what exactly did
  -- customer X receive" from this table alone.
  document    TEXT,
  status      TEXT NOT NULL
              CONSTRAINT sme_report_sends_status_chk
              CHECK (status IN ('sent', 'error', 'skipped_access', 'dry_run')),
  error       TEXT
);

COMMENT ON TABLE alert.sme_report_sends IS
  'One row per SME report delivery attempt (or dry-run/skip), written by the fan-out send loop. skipped_access = recipient''s system access no longer covered the document at send time.';

-- Envelope role (review B round-1 F6): CC recipients receive the
-- attachment too and must be answerable from this table. Values: 'to',
-- 'cc'. Repeatable addendum — safe on tables created before it existed.
ALTER TABLE alert.sme_report_sends
  ADD COLUMN IF NOT EXISTS recipient_role TEXT NOT NULL DEFAULT 'to';

CREATE INDEX IF NOT EXISTS sme_report_sends_config_run_idx
  ON alert.sme_report_sends (config_id, run_at DESC);

CREATE INDEX IF NOT EXISTS sme_report_sends_recipient_idx
  ON alert.sme_report_sends (recipient, run_at DESC);

COMMIT;
