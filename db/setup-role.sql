-- db/setup-role.sql
-- One-time setup of the least-privilege role the reports app connects as.
-- Run as a superuser against the database the app targets (PGDATABASE=staging):
--   docker exec -i pg_db psql -U postgres -d staging -v pw='choose-a-strong-password' \
--     -f - < db/setup-role.sql
--
-- Pattern copied from /opt/apps/incident-engine/db/setup-owner-role.sql and
-- /opt/apps/ops-dashboard/db/setup-readonly-role.sql: strip everything the role
-- may have accumulated, grant only the intended surface, then FAIL-CLOSED
-- audits RAISE if any other effective privilege remains. Idempotent — re-run
-- (as superuser) after a DB reset, or BEFORE deploying code that needs a new
-- grant. NOTE: "GRANT SELECT ON ALL TABLES IN SCHEMA x" covers existing tables
-- only; a table added later needs this script re-run.
--
-- PREREQUISITE (2026-08-31): run sql/sme_reports_config.sql FIRST. The grants
-- below name alert.sme_report_sends and its sequence directly, and this script
-- is non-transactional (DB-03) — against a database without those objects it
-- stops midway, having applied everything above the failure.
--
-- Grant surface (verified against the code 2026-08-31, post-PROD-merge):
--   READS   alert.* , mag.* , config.* , edu.*  (report queries join broadly here)
--           util.ip_sec                          (VPN IP lookups)
--           public.customers / sites / systems   (entity joins)
--           public.users — FOUR COLUMNS ONLY, column-level (see below)
--   WRITES  alert.models              UPDATE  (sql/schedule_matrix.sql)
--           alert.notifications       UPDATE  (email/sms status updates)
--           alert.sme_report_sends    INSERT  (sme_reports/sql/insert-send.sql)
--           util.app_run_logs         INSERT  (logger self-log, utils/logger/log.js)
--   ONE sequence privilege: USAGE on alert.sme_report_sends_id_seq. The id is
--   BIGSERIAL and nextval() in a column DEFAULT executes as the INSERTING role,
--   not the owner — without this the INSERT above fails. (The pre-merge claim
--   "no sequence privileges anywhere / none of the write targets have serial
--   columns" was true until the sme_reports merge; it no longer is.)
--   No DELETE/TRUNCATE anywhere. Temp tables come from the PUBLIC
--   TEMP grant on the database (used by alert-tests SQL).
--   NOTHING in archive_* — see the archived-partition sweep below.
--
-- Deviation from the incident-engine pattern, on purpose (pilot scope): the
-- self-log INSERT is granted on util.app_run_logs directly instead of through
-- a per-app WITH CHECK OPTION view. Standardizing per-app self-log views is a
-- fleet-rollout item.

\set ON_ERROR_STOP on

-- Require the password variable (must be set with -v pw=...).
\if :{?pw}
\else
  \echo 'ERROR: set pw first, e.g.  psql -v pw=secret -f db/setup-role.sql'
  \quit
\endif

SELECT format('CREATE ROLE reports_rw LOGIN PASSWORD %L', :'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reports_rw')
\gexec

ALTER ROLE reports_rw LOGIN PASSWORD :'pw'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;

GRANT CONNECT ON DATABASE staging TO reports_rw;

-- ---------------------------------------------------------------------------
-- Strip-and-regrant, schema by schema.
-- ---------------------------------------------------------------------------

-- alert: SELECT everywhere, UPDATE on exactly models + notifications.
REVOKE ALL ON ALL TABLES    IN SCHEMA alert FROM reports_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA alert FROM reports_rw;
REVOKE ALL ON SCHEMA alert                  FROM reports_rw;
GRANT USAGE  ON SCHEMA alert                TO reports_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA alert  TO reports_rw;
GRANT UPDATE ON alert.models, alert.notifications TO reports_rw;
-- Send-status tracking for the scheduled sme_reports runner: one row per
-- envelope recipient per delivery attempt. The sequence grant is NOT optional
-- (BIGSERIAL default → nextval runs as the inserting role); it is deliberately
-- placed after the REVOKE ALL ON ALL SEQUENCES above.
GRANT INSERT ON alert.sme_report_sends              TO reports_rw;
GRANT USAGE  ON SEQUENCE alert.sme_report_sends_id_seq TO reports_rw;

-- mag / config / edu: read-only.
REVOKE ALL ON ALL TABLES    IN SCHEMA mag    FROM reports_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA mag    FROM reports_rw;
REVOKE ALL ON SCHEMA mag                     FROM reports_rw;
GRANT USAGE  ON SCHEMA mag                   TO reports_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA mag     TO reports_rw;

REVOKE ALL ON ALL TABLES    IN SCHEMA config FROM reports_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA config FROM reports_rw;
REVOKE ALL ON SCHEMA config                  FROM reports_rw;
GRANT USAGE  ON SCHEMA config                TO reports_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA config  TO reports_rw;

REVOKE ALL ON ALL TABLES    IN SCHEMA edu    FROM reports_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA edu    FROM reports_rw;
REVOKE ALL ON SCHEMA edu                     FROM reports_rw;
GRANT USAGE  ON SCHEMA edu                   TO reports_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA edu     TO reports_rw;

-- util: SELECT on ip_sec, INSERT on app_run_logs (partitioned parent covers
-- current and future partitions). Nothing else.
REVOKE ALL ON ALL TABLES    IN SCHEMA util   FROM reports_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA util   FROM reports_rw;
REVOKE ALL ON SCHEMA util                    FROM reports_rw;
GRANT USAGE  ON SCHEMA util                  TO reports_rw;
GRANT SELECT ON util.ip_sec                  TO reports_rw;
GRANT INSERT ON util.app_run_logs            TO reports_rw;

-- public: exactly the three entity tables. hhm_credentials, users, etc. stay
-- unreachable (verified by the audit below).
REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM reports_rw;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM reports_rw;
GRANT SELECT ON public.customers, public.sites, public.systems TO reports_rw;
-- public.users, COLUMN-LEVEL ON PURPOSE. The sme_reports derived-recipient
-- path reads exactly these four columns (sme_reports/sql/audience-users.sql
-- and user-caches.sql). A full-table grant would also expose roles, phone
-- numbers and anything added to this table later; the column list keeps the
-- original "nothing else in public" posture as tight as the feature allows.
-- public.hhm_credentials and every other public table remain unreachable
-- (verified by the audit below).
GRANT SELECT (email_address, status, notify_email, system_list_cache)
  ON public.users TO reports_rw;

-- ---------------------------------------------------------------------------
-- ARCHIVED-PARTITION SWEEP (added 2026-08-31).
--
-- Moving a table to another schema PRESERVES its ACL. odd-jobs' partition
-- archiver detaches month partitions from alert/edu/mag and moves them into
-- archive_*, so every partition that was live the last time the sweeps above
-- ran carries this role's SELECT out with it. The role has no USAGE on the
-- archive_* schemas, so the privilege is unusable — but it is HELD, and the
-- fail-closed audit below (correctly) refuses to certify it.
--
-- Found the hard way: this script had become un-re-runnable, aborting on 13
-- stale grants (archive_alert/edu/mag, the 2026_02 partitions) that had
-- nothing to do with the change being deployed. Allowlisting archive_* would
-- have been the wrong fix — it would widen the surface to hide the drift.
-- Instead, revoke on every archive schema that exists, every run.
--
-- Loop rather than a literal REVOKE list: the archive_* schemas do not exist
-- on a fresh server, and this script is non-transactional (DB-03) — a REVOKE
-- naming a missing schema would abort the run partway through.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'archive%' ORDER BY 1
  LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES    IN SCHEMA %I FROM reports_rw', s.nspname);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM reports_rw', s.nspname);
    EXECUTE format('REVOKE ALL ON SCHEMA %I                  FROM reports_rw', s.nspname);
  END LOOP;
END
$$;

-- ---------------------------------------------------------------------------
-- DATABASE-WIDE ALLOWLIST AUDIT (fail-closed). Every effective table/view/
-- column/sequence privilege the role holds in ANY non-system schema —
-- including via PUBLIC — must be on the allowlist, or the script aborts.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text;
BEGIN
  WITH rels AS (
    SELECT c.oid, n.nspname, c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg\_toast%'
      AND n.nspname NOT LIKE 'pg\_temp%'
  ),
  effective AS (
    SELECT r.nspname, r.relname, priv
    FROM rels r
    CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','REFERENCES']) AS priv
    WHERE r.relkind IN ('r','p','v','m','f')
      AND has_any_column_privilege('reports_rw', r.oid, priv)
    UNION ALL
    SELECT r.nspname, r.relname, priv
    FROM rels r
    CROSS JOIN unnest(ARRAY['DELETE','TRUNCATE','TRIGGER']) AS priv
    WHERE r.relkind IN ('r','p','v','m','f')
      AND has_table_privilege('reports_rw', r.oid, priv)
    UNION ALL
    SELECT r.nspname, r.relname, priv
    FROM rels r
    CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) AS priv
    WHERE r.relkind = 'S'
      AND has_sequence_privilege('reports_rw', r.oid, priv)
  )
  SELECT string_agg(e.nspname || '.' || e.relname || ':' || e.priv, ', '
                    ORDER BY e.nspname, e.relname, e.priv)
    INTO bad
  FROM effective e
  WHERE NOT (
       (e.nspname IN ('alert','mag','config','edu') AND e.priv = 'SELECT')
    OR (e.nspname, e.relname, e.priv) = ('alert', 'models', 'UPDATE')
    OR (e.nspname, e.relname, e.priv) = ('alert', 'notifications', 'UPDATE')
    OR (e.nspname, e.relname, e.priv) = ('alert', 'sme_report_sends', 'INSERT')
    -- the first sequence privilege this role has ever held (BIGSERIAL id on
    -- alert.sme_report_sends); USAGE only, never SELECT/UPDATE.
    OR (e.nspname, e.relname, e.priv) = ('alert', 'sme_report_sends_id_seq', 'USAGE')
    OR (e.nspname, e.relname, e.priv) = ('util', 'ip_sec', 'SELECT')
    OR (e.nspname, e.relname, e.priv) = ('util', 'app_run_logs', 'INSERT')
    OR (e.nspname = 'public' AND e.relname IN ('customers','sites','systems')
        AND e.priv = 'SELECT')
    -- column-level grant: has_any_column_privilege reports SELECT here, which
    -- is why this reads the same as a table grant. The four-column scope is
    -- enforced by the GRANT above, not by this clause.
    OR (e.nspname, e.relname, e.priv) = ('public', 'users', 'SELECT')
    -- extension defaults granted to PUBLIC (read-only; query text masked for
    -- unprivileged roles) — allowlisted explicitly so any OTHER grant trips.
    OR (e.nspname, e.relname, e.priv) = ('public', 'pg_stat_statements', 'SELECT')
    OR (e.nspname, e.relname, e.priv) = ('public', 'pg_stat_statements_info', 'SELECT')
  );
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'reports_rw holds privileges outside the allowlist: %', bad;
  END IF;
END $$;

-- Sanity (manual):
--   SET ROLE reports_rw;
--   SELECT count(*) FROM alert.models;                  -- OK
--   SELECT count(*) FROM mag.ge_mm LIMIT 1;             -- OK
--   SELECT count(*) FROM public.systems;                -- OK
--   SELECT count(*) FROM public.hhm_credentials;        -- expect: permission denied
--   UPDATE alert.models SET model = model WHERE false;  -- OK (no-op)
--   DELETE FROM alert.notifications WHERE false;        -- expect: permission denied
--   INSERT INTO util.app_run_logs(app_name, run_id) VALUES ('reports', gen_random_uuid());  -- OK
