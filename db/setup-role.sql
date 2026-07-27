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
-- Grant surface (verified against the code 2026-07-27):
--   READS   alert.* , mag.* , config.* , edu.*  (report queries join broadly here)
--           util.ip_sec                          (VPN IP lookups)
--           public.customers / sites / systems   (entity joins; NOTHING else in
--           public — it also holds hhm_credentials/users, which this app must
--           never read)
--   WRITES  alert.models         UPDATE  (sql/schedule_matrix.sql)
--           alert.notifications  UPDATE  (email/sms status updates)
--           util.app_run_logs    INSERT  (logger self-log, utils/logger/log.js)
--   No sequence privileges anywhere (none of the write targets have serial
--   columns). No DELETE/TRUNCATE anywhere. Temp tables come from the PUBLIC
--   TEMP grant on the database (used by alert-tests SQL).
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
    OR (e.nspname, e.relname, e.priv) = ('util', 'ip_sec', 'SELECT')
    OR (e.nspname, e.relname, e.priv) = ('util', 'app_run_logs', 'INSERT')
    OR (e.nspname = 'public' AND e.relname IN ('customers','sites','systems')
        AND e.priv = 'SELECT')
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
