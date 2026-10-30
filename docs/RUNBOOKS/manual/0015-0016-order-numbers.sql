-- Migrations 0015 and 0016 by hand, for when the Supabase tool's confirm
-- prompt cannot be answered (0015 has ALTER TABLE ... ENABLE ROW LEVEL
-- SECURITY and ADD CONSTRAINT, 0016 has ALTER and GRANT). Paste everything
-- from BEGIN to COMMIT into Supabase -> SQL Editor -> Run, once, as
-- postgres. It is one transaction: either all of it lands, all four tracker
-- rows included, or none of it.
--
-- Order of work (docs/RUNBOOKS/database.md, 0015 + 0016):
--   1. the pre-check (A) below;
--   2. BEGIN ... COMMIT;
--   3. the six verification selects at the end, one at a time (the SQL
--      editor shows only the last result set of a run).
-- Apply this before deploying a backend that numbers SIM orders from
-- app.site_counters (merge phase 5, step A).
--
-- Additive only, no data migration: one new table (app.site_counters, one
-- row per site and counter, empty until the first SIM order is created or
-- the switch-day seed runs), its FORCE RLS and its runtime grants (no
-- DELETE). The two files are below verbatim but for drizzle's
-- `--> statement-breakpoint` markers. Drizzle hashes (sha256 of each file)
-- and journal `when` values:
--   0015_order_numbers          e5544ea194961ff67154ff03aae20a077a15283273314edc9675afed77619058  1793380650712
--   0016_order_numbers_runtime  3e6c35c0b2f4c3e8f35adc61a195e8d23027ba9ecf7a39452f0586a4a0015fff  1793380656599

-- A. Pre-check. Expect one row: site_counters null, tracker_rows 0.
SELECT to_regclass('app.site_counters') AS site_counters,
       (SELECT count(*) FROM drizzle.__drizzle_migrations
        WHERE created_at IN (1793380650712, 1793380656599)) AS tracker_rows;

BEGIN;

-- ---------------------------------------------------------------------------
-- 0015_order_numbers (generated from packages/db/src/schema.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE "app"."site_counters" (
	"workspace_id" uuid NOT NULL,
	"counter" text NOT NULL,
	"last_value" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_counters_workspace_id_counter_pk" PRIMARY KEY("workspace_id","counter"),
	CONSTRAINT "site_counters_counter_check" CHECK ("app"."site_counters"."counter" in ('sim_order_ref')),
	CONSTRAINT "site_counters_last_value_check" CHECK ("app"."site_counters"."last_value" >= 0)
);
ALTER TABLE "app"."site_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."site_counters" ADD CONSTRAINT "site_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
CREATE POLICY "site_counters_tenant_policy" ON "app"."site_counters" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."site_counters"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."site_counters"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "site_counters_backup_reader_read" ON "app"."site_counters" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);

-- ---------------------------------------------------------------------------
-- 0016_order_numbers_runtime
-- ---------------------------------------------------------------------------
-- Hand-written companion to 0015_order_numbers (AGENTS.md rule 3): FORCE RLS
-- and the runtime grants on app.site_counters. backup_reader needs no grant
-- here: 0007's default privileges make every new app table readable, and the
-- table's read policy comes from schema.ts in 0015. No data migration and no
-- pruning (one row per site and counter). Every statement is safe to run
-- twice.

ALTER TABLE "app"."site_counters" FORCE ROW LEVEL SECURITY;

-- No DELETE: a counter only ever goes up, and its row goes with its site.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."site_counters" TO app_runtime;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'e5544ea194961ff67154ff03aae20a077a15283273314edc9675afed77619058', 1793380650712
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793380650712);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '3e6c35c0b2f4c3e8f35adc61a195e8d23027ba9ecf7a39452f0586a4a0015fff', 1793380656599
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793380656599);
-- now() is fixed for the whole transaction, so the second version is one
-- second later: the two rows need distinct versions.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0015_order_numbers',
       ARRAY['-- applied by hand from packages/db/drizzle/0015_order_numbers.sql; see docs/RUNBOOKS/manual/0015-0016-order-numbers.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0015_order_numbers'
);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char((now() + interval '1 second') at time zone 'utc', 'YYYYMMDDHH24MISS'), '0016_order_numbers_runtime',
       ARRAY['-- applied by hand from packages/db/drizzle/0016_order_numbers_runtime.sql; see docs/RUNBOOKS/manual/0015-0016-order-numbers.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0016_order_numbers_runtime'
);

COMMIT;

-- Verification, one select at a time.

-- 1. Expect one row: site_counters, true, true (row security on and forced).
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.relnamespace = 'app'::regnamespace AND c.relname = 'site_counters';

-- 2. Expect two rows: site_counters_backup_reader_read (SELECT, backup_reader)
-- and site_counters_tenant_policy (ALL, app_runtime).
SELECT policyname, cmd, roles FROM pg_policies
WHERE schemaname = 'app' AND tablename = 'site_counters'
ORDER BY policyname;

-- 3. Expect 36: one backup_reader read policy per RLS table in app (every
-- app table but workspaces).
SELECT count(*) FROM pg_policies
WHERE schemaname = 'app' AND policyname LIKE '%\_backup\_reader\_read' AND 'backup_reader' = ANY (roles);

-- 4. Expect one row: runtime_select, runtime_insert, runtime_update true,
-- runtime_delete false, backup_select true.
SELECT has_table_privilege('app_runtime', 'app.site_counters', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.site_counters', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.site_counters', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.site_counters', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.site_counters', 'SELECT') AS backup_select;

-- 5. Expect two rows: site_counters_counter_check naming 'sim_order_ref'
-- only, and site_counters_last_value_check (last_value >= 0).
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'app.site_counters'::regclass AND contype = 'c'
ORDER BY conname;

-- 6. Expect two rows: the hashes and `when` values in the header.
SELECT hash, created_at FROM drizzle.__drizzle_migrations
WHERE created_at IN (1793380650712, 1793380656599)
ORDER BY created_at;
