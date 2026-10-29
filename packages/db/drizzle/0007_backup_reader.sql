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
--> statement-breakpoint
GRANT USAGE ON SCHEMA "app", "public", "drizzle" TO backup_reader;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA "app", "public", "drizzle" TO backup_reader;
--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA "app", "public", "drizzle" TO backup_reader;
--> statement-breakpoint
-- Tables and sequences later migrations create in `app` are readable without
-- a grant of their own (their read policy still comes from schema.ts).
ALTER DEFAULT PRIVILEGES IN SCHEMA "app" GRANT SELECT ON TABLES TO backup_reader;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "app" GRANT SELECT ON SEQUENCES TO backup_reader;
--> statement-breakpoint
-- The same in `public`: Get Canada Sim's legacy tables live there and are all
-- owned by the migration role, so a table it adds later is readable too.
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO backup_reader;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON SEQUENCES TO backup_reader;
--> statement-breakpoint
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
--> statement-breakpoint
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
