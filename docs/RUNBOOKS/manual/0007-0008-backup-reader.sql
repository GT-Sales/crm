-- Migrations 0007 and 0008 by hand, for when the Supabase tool's confirm
-- prompt cannot be answered (0007 has DO blocks, GRANT and ALTER DEFAULT
-- PRIVILEGES). Run the pre-paste check in docs/RUNBOOKS/backup.md step 5
-- first. Then paste everything from BEGIN to COMMIT into Supabase → SQL
-- Editor → Run, once. It is one transaction: either all of it lands, all
-- four tracker rows included, or none of it. A WARNING that the auth schema
-- was not granted, or PostgreSQL's own "no privileges were granted" WARNING,
-- is not a failure; the verification selects at the end show what
-- backup_reader can read (docs/RUNBOOKS/database.md, 0007 + 0008).
--
-- The SQL editor shows only the last result set of a run, so run the
-- password line and then each verification select on its own, one at a time.
BEGIN;

-- ---------------------------------------------------------------------------
-- 0007_backup_reader
-- ---------------------------------------------------------------------------
-- The backup job's read-only login, backup_reader (merge design spec §10,
-- docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md; procedure
-- in docs/RUNBOOKS/backup.md). It dumps the database with
-- `pg_dump --enable-row-security`, so it must read every row of every table
-- without being able to change any of them.
--
-- BYPASSRLS and the pg_read_all_data role would do that in one line, but both
-- need a superuser to grant, and Supabase's `postgres` is not one. So the role
-- gets explicit SELECT grants here, and a PERMISSIVE FOR SELECT ... USING (true)
-- policy on every RLS table: the `app` tables get theirs from schema.ts in the
-- generated 0008 (so every future table declares one too), and the `public`
-- tables the migration role owns get theirs from the loop below, since they
-- are not in schema.ts.
--
-- No password here: the owner sets it outside migrations
-- (docs/RUNBOOKS/manual/0007-0008-backup-reader.sql), and until then the role
-- cannot log in. Its attributes are not re-asserted with ALTER ROLE, for the
-- same reason as app_runtime's in 0000.

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
		CREATE ROLE backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
	END IF;
END
$$;
GRANT USAGE ON SCHEMA "app", "public", "drizzle" TO backup_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA "app", "public", "drizzle" TO backup_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA "app", "public", "drizzle" TO backup_reader;
-- Tables and sequences later migrations create in `app` are readable without
-- a grant of their own (their read policy still comes from schema.ts).
ALTER DEFAULT PRIVILEGES IN SCHEMA "app" GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA "app" GRANT SELECT ON SEQUENCES TO backup_reader;
-- The same in `public`: Get Canada Sim's legacy tables live there and are all
-- owned by the migration role, so a table it adds later is readable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON SEQUENCES TO backup_reader;
-- The website's own tables in `public` (Get Canada Sim, the CanadaWide legacy
-- tables): a read policy on each RLS table the migration role owns. A table
-- added there later needs one by hand before the backup can see its rows.
DO $$
DECLARE
	t record;
BEGIN
	FOR t IN
		SELECT tablename FROM pg_tables
		WHERE schemaname = 'public' AND rowsecurity AND tableowner = current_user
	LOOP
		IF NOT EXISTS (
			SELECT 1 FROM pg_policies
			WHERE schemaname = 'public'
				AND tablename = t.tablename
				AND policyname = t.tablename || '_backup_reader_read'
		) THEN
			EXECUTE format(
				'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR SELECT TO backup_reader USING (true)',
				t.tablename || '_backup_reader_read',
				'public',
				t.tablename
			);
		END IF;
	END LOOP;
END
$$;
-- Supabase's own schemas, where they exist (neither does locally or in CI).
-- Neither case below fails this migration. Where the migration role holds a
-- privilege without grant option, PostgreSQL grants nothing for it and
-- prints its own WARNING ("no privileges were granted"). Where it holds no
-- privilege on the object at all, the GRANT fails with insufficient_privilege
-- and the handler turns that into a WARNING. Either way the verification
-- selects in docs/RUNBOOKS/manual/0007-0008-backup-reader.sql show what
-- backup_reader can read.
DO $$
BEGIN
	IF to_regnamespace('supabase_migrations') IS NOT NULL THEN
		BEGIN
			GRANT USAGE ON SCHEMA supabase_migrations TO backup_reader;
			GRANT SELECT ON ALL TABLES IN SCHEMA supabase_migrations TO backup_reader;
		EXCEPTION WHEN insufficient_privilege THEN
			RAISE WARNING 'supabase_migrations schema not granted to backup_reader; see docs/RUNBOOKS/backup.md';
		END;
	END IF;
	-- Only the two auth tables a restore needs: the accounts and their sign-in
	-- identities. The token, session and MFA tables must never be readable by
	-- the backup role; a restore brings back accounts, never sessions, and
	-- every restored user signs in again.
	BEGIN
		IF to_regnamespace('auth') IS NOT NULL THEN
			GRANT USAGE ON SCHEMA auth TO backup_reader;
			GRANT SELECT ON auth.users, auth.identities TO backup_reader;
		END IF;
	EXCEPTION WHEN insufficient_privilege THEN
		RAISE WARNING 'auth schema not granted to backup_reader; see docs/RUNBOOKS/backup.md';
	END;
END
$$;

-- ---------------------------------------------------------------------------
-- 0008_backup_reader_policies (generated from packages/db/src/schema.ts)
-- ---------------------------------------------------------------------------
CREATE POLICY "audit_events_backup_reader_read" ON "app"."audit_events" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "contacts_backup_reader_read" ON "app"."contacts" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "deleted_email_messages_backup_reader_read" ON "app"."deleted_email_messages" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "draft_grants_backup_reader_read" ON "app"."draft_grants" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "email_messages_backup_reader_read" ON "app"."email_messages" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "email_provider_events_backup_reader_read" ON "app"."email_provider_events" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "email_suppressions_backup_reader_read" ON "app"."email_suppressions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "file_review_events_backup_reader_read" ON "app"."file_review_events" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "file_revisions_backup_reader_read" ON "app"."file_revisions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "files_backup_reader_read" ON "app"."files" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "follow_up_schedules_backup_reader_read" ON "app"."follow_up_schedules" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "lead_activities_backup_reader_read" ON "app"."lead_activities" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "lead_identities_backup_reader_read" ON "app"."lead_identities" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "lead_tasks_backup_reader_read" ON "app"."lead_tasks" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "leads_backup_reader_read" ON "app"."leads" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "marketing_consents_backup_reader_read" ON "app"."marketing_consents" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "membership_permissions_backup_reader_read" ON "app"."membership_permissions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "membership_roles_backup_reader_read" ON "app"."membership_roles" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "memberships_backup_reader_read" ON "app"."memberships" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "outbox_job_alerts_backup_reader_read" ON "app"."outbox_job_alerts" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "outbox_jobs_backup_reader_read" ON "app"."outbox_jobs" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "permissions_backup_reader_read" ON "app"."permissions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "rate_limit_buckets_backup_reader_read" ON "app"."rate_limit_buckets" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "roles_backup_reader_read" ON "app"."roles" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "service_credentials_backup_reader_read" ON "app"."service_credentials" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '4518ddd1a136f26ccdd848a39799de7a888b70121a4d4ce390b5a88b7d9d3587', 1793273916007
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793273916007);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '6d87bd3afd04885626c3d7d1b656de93a4267bf59ffe98a00de01ee947effcfd', 1793273993722
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793273993722);
-- now() is fixed for the whole transaction, so the second version is one
-- second later: the two rows need distinct versions.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0007_backup_reader',
       ARRAY['-- applied by hand from packages/db/drizzle/0007_backup_reader.sql; see docs/RUNBOOKS/manual/0007-0008-backup-reader.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0007_backup_reader'
);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char((now() + interval '1 second') at time zone 'utc', 'YYYYMMDDHH24MISS'), '0008_backup_reader_policies',
       ARRAY['-- applied by hand from packages/db/drizzle/0008_backup_reader_policies.sql; see docs/RUNBOOKS/manual/0007-0008-backup-reader.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0008_backup_reader_policies'
);

COMMIT;

-- Then, separately, give the role its password (it cannot log in until this
-- runs). Generate it with `openssl rand -hex 16`, run the line below with the
-- value pasted in, and store it only in the backup job's secrets
-- (docs/RUNBOOKS/backup.md); never commit it.
-- ALTER ROLE backup_reader PASSWORD '<paste a 32-character random password>';

-- Verification, one select at a time.

-- 1. Expect: true, false, false, false, false, false, true.
SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication, rolinherit
FROM pg_roles WHERE rolname = 'backup_reader';

-- 2. Expect 25: one per RLS table in app (every app table but workspaces).
SELECT count(*) FROM pg_policies
WHERE schemaname = 'app' AND policyname LIKE '%\_backup\_reader\_read' AND 'backup_reader' = ANY (roles);

-- 3. Expect no rows: a public table backup_reader cannot read in full, by
-- the backup's own guard (jobs/src/backup/sources.ts). A table needs SELECT,
-- and with row security on it needs a PERMISSIVE SELECT/ALL policy naming
-- backup_reader with USING (true) and no RESTRICTIVE SELECT/ALL policy that
-- applies to backup_reader or to public. The backup stops on such a table
-- (backup_source_unreadable) until it is fixed by hand
-- (docs/RUNBOOKS/backup-alert-response.md).
SELECT t.tablename FROM pg_tables t
WHERE t.schemaname = 'public'
  AND (
    NOT has_table_privilege('backup_reader', format('public.%I', t.tablename), 'SELECT')
    OR (
      t.rowsecurity
      AND (
        NOT EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.tablename
            AND p.permissive = 'PERMISSIVE' AND p.cmd IN ('SELECT', 'ALL')
            AND 'backup_reader' = ANY (p.roles) AND p.qual = 'true'
        )
        OR EXISTS (
          SELECT 1 FROM pg_policies p
          WHERE p.schemaname = 'public' AND p.tablename = t.tablename
            AND p.permissive = 'RESTRICTIVE' AND p.cmd IN ('SELECT', 'ALL')
            AND ('backup_reader' = ANY (p.roles) OR 'public' = ANY (p.roles))
        )
      )
    )
  );

-- 4. Expect: true, true, true, 0. backup_reader reads exactly auth.users and
-- auth.identities: a false means the auth grant warned (set
-- BACKUP_AUTH_DATA=skip for the backup job until they are granted,
-- docs/RUNBOOKS/backup.md), and the last column counts the other auth tables
-- (sessions, tokens, MFA) it can read, which must be none.
SELECT has_schema_privilege('backup_reader', 'auth', 'USAGE') AS auth_usage,
       has_table_privilege('backup_reader', 'auth.users', 'SELECT') AS users,
       has_table_privilege('backup_reader', 'auth.identities', 'SELECT') AS identities,
       (SELECT count(*) FROM pg_class c
        WHERE c.relnamespace = 'auth'::regnamespace AND c.relkind IN ('r', 'p')
          AND c.relname NOT IN ('users', 'identities')
          AND has_table_privilege('backup_reader', c.oid, 'SELECT')) AS other_auth_tables;

-- 5. Expect no rows: auth.users or auth.identities with row security on.
-- backup_reader would read it as empty under pg_dump --enable-row-security,
-- and postgres cannot add a policy to a table it does not own; set
-- BACKUP_AUTH_DATA=skip for the backup job until a policy exists.
SELECT c.relname FROM pg_class c
WHERE c.relnamespace = 'auth'::regnamespace AND c.relname IN ('users', 'identities')
  AND c.relkind IN ('r', 'p') AND c.relrowsecurity;
