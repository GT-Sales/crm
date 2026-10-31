-- Migrations 0017 and 0018 by hand, for when the Supabase tool's confirm
-- prompt cannot be answered (0017 has ALTER TABLE ... DROP/ADD CONSTRAINT,
-- ADD COLUMN and ENABLE ROW LEVEL SECURITY; 0018 has ALTER, GRANT, REVOKE and
-- a CREATE OR REPLACE FUNCTION). Paste everything from BEGIN to COMMIT into
-- Supabase -> SQL Editor -> Run, once, as postgres. It is one transaction:
-- either all of it lands, all four tracker rows included, or none of it.
--
-- Order of work (docs/RUNBOOKS/database.md, 0017 + 0018):
--   1. the pre-check (A) below;
--   2. BEGIN ... COMMIT;
--   3. the eight verification selects at the end, one at a time (the SQL
--      editor shows only the last result set of a run).
-- Apply this before deploying a backend that reads app.tracking_challenges,
-- app.change_requests or files.held_for_change_request (merge phase 5,
-- step B).
--
-- If the plain statements go through the Supabase tool instead, the
-- `CREATE OR REPLACE FUNCTION app.prune_operational_rows` statement (marked
-- OWNER PASTE below) is the one the owner pastes by hand, as in phase 4.
--
-- Additive only, no data migration: two new tables (app.tracking_challenges,
-- app.change_requests, both empty), one new column with a constant default
-- (app.files.held_for_change_request boolean not null default false: no
-- rewrite), one new expression index on app.leads (workspace_id,
-- lower(btrim(email))) for the tracking lookups (a plain CREATE INDEX: it
-- holds writes to app.leads for the few seconds it takes), the two template
-- key checks and the site counter check widened
-- (each re-added check scans its table once), FORCE RLS and grants on the
-- two tables (no DELETE), and prune_operational_rows() replaced with 0014's
-- body plus tracking challenges 24 hours after they expire. The two files are
-- below verbatim but for drizzle's `--> statement-breakpoint` markers and the
-- OWNER PASTE note. Drizzle hashes (sha256 of each file) and journal `when`
-- values:
--   0017_customer_tracking          7b4e5292e29ac1fdc8ab891e604d82dbbe9e3997e5756d73f6d2f120c817ad94  1793385700370
--   0018_customer_tracking_runtime  900a964eac69947a733e022e05e1664a2c03f312cced36c510383e9faa99ffc2  1793385701352

-- A. Pre-check. Expect one row: tracking_challenges null, change_requests
-- null, held_column false, tracker_rows 0.
SELECT to_regclass('app.tracking_challenges') AS tracking_challenges,
       to_regclass('app.change_requests') AS change_requests,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'files' AND column_name = 'held_for_change_request'
       ) AS held_column,
       (SELECT count(*) FROM drizzle.__drizzle_migrations
        WHERE created_at IN (1793385700370, 1793385701352)) AS tracker_rows;

BEGIN;

-- ---------------------------------------------------------------------------
-- 0017_customer_tracking (generated from packages/db/src/schema.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE "app"."change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"request_no" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"staged_file_ids" uuid[] DEFAULT array[]::uuid[] NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_requests_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "change_requests_workspace_request_no_unique" UNIQUE("workspace_id","request_no"),
	CONSTRAINT "change_requests_request_no_check" CHECK ("app"."change_requests"."request_no" > 0),
	CONSTRAINT "change_requests_status_check" CHECK ("app"."change_requests"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "change_requests_version_check" CHECK ("app"."change_requests"."version" > 0),
	CONSTRAINT "change_requests_resolved_check" CHECK (("app"."change_requests"."status" = 'pending') = ("app"."change_requests"."resolved_at" is null) and ("app"."change_requests"."resolved_at" is null) = ("app"."change_requests"."resolved_by" is null))
);

ALTER TABLE "app"."change_requests" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."tracking_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_challenges_email_hash_check" CHECK ("app"."tracking_challenges"."email_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tracking_challenges_code_hash_check" CHECK ("app"."tracking_challenges"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tracking_challenges_attempts_check" CHECK ("app"."tracking_challenges"."attempts" >= 0),
	CONSTRAINT "tracking_challenges_status_check" CHECK ("app"."tracking_challenges"."status" in ('pending', 'consumed')),
	CONSTRAINT "tracking_challenges_consumed_check" CHECK (("app"."tracking_challenges"."status" = 'consumed') = ("app"."tracking_challenges"."consumed_at" is not null))
);

ALTER TABLE "app"."tracking_challenges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."email_template_versions" DROP CONSTRAINT "email_template_versions_key_check";
ALTER TABLE "app"."email_templates" DROP CONSTRAINT "email_templates_key_check";
ALTER TABLE "app"."site_counters" DROP CONSTRAINT "site_counters_counter_check";
ALTER TABLE "app"."files" ADD COLUMN "held_for_change_request" boolean DEFAULT false NOT NULL;
ALTER TABLE "app"."change_requests" ADD CONSTRAINT "change_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."change_requests" ADD CONSTRAINT "change_requests_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."tracking_challenges" ADD CONSTRAINT "tracking_challenges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "change_requests_one_pending" ON "app"."change_requests" USING btree ("workspace_id","lead_id") WHERE "app"."change_requests"."status" = 'pending';
CREATE INDEX "change_requests_workspace_lead_created_idx" ON "app"."change_requests" USING btree ("workspace_id","lead_id","created_at" DESC NULLS LAST);
CREATE INDEX "tracking_challenges_workspace_email_idx" ON "app"."tracking_challenges" USING btree ("workspace_id","email_hash","status","created_at" DESC NULLS LAST);
CREATE INDEX "leads_workspace_email_idx" ON "app"."leads" USING btree ("workspace_id",lower(btrim("email")));
ALTER TABLE "app"."email_template_versions" ADD CONSTRAINT "email_template_versions_key_check" CHECK ("app"."email_template_versions"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected'));
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_key_check" CHECK ("app"."email_templates"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected'));
ALTER TABLE "app"."site_counters" ADD CONSTRAINT "site_counters_counter_check" CHECK ("app"."site_counters"."counter" in ('sim_order_ref', 'change_request_no'));
CREATE POLICY "change_requests_tenant_policy" ON "app"."change_requests" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."change_requests"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."change_requests"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "change_requests_backup_reader_read" ON "app"."change_requests" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "tracking_challenges_tenant_policy" ON "app"."tracking_challenges" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."tracking_challenges"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."tracking_challenges"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "tracking_challenges_backup_reader_read" ON "app"."tracking_challenges" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
-- ---------------------------------------------------------------------------
-- 0018_customer_tracking_runtime
-- ---------------------------------------------------------------------------
-- Hand-written companion to 0017_customer_tracking (AGENTS.md rule 3): FORCE
-- RLS and the runtime grants on app.tracking_challenges and
-- app.change_requests, and the retention of challenges. backup_reader needs no
-- grant here: 0007's default privileges make every new app table readable,
-- and each table's read policy comes from schema.ts in 0017. No data
-- migration. Every statement is safe to run twice.

ALTER TABLE "app"."tracking_challenges" FORCE ROW LEVEL SECURITY;

ALTER TABLE "app"."change_requests" FORCE ROW LEVEL SECURITY;

-- No DELETE: old challenges go through prune_operational_rows() below, change
-- requests are kept, and both go with their site (and a request with its lead).
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."tracking_challenges" TO app_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE "app"."change_requests" TO app_runtime;

-- 0014's pruning, plus tracking challenges 24 hours after they expire (a code
-- lives 10 minutes; the day keeps a guessing burst visible for a while).
-- Change requests are never pruned. Still the caller's own tenant only, at
-- most 1000 rows per table per call. This replacement is the statement the
-- owner pastes by hand (docs/RUNBOOKS/database.md).
-- >>> OWNER PASTE: this CREATE OR REPLACE FUNCTION statement (down to
-- $function$;) is the one the owner pastes by hand in the SQL editor when
-- the rest goes through the Supabase tool, which asks for a confirmation on
-- a function body with DELETEs (docs/RUNBOOKS/database.md, 0018).
CREATE OR REPLACE FUNCTION app.prune_operational_rows(p_workspace_id uuid, p_now timestamptz)
RETURNS TABLE(table_name text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	n integer;
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;

	-- Completed jobs after 30 days (their alerts go with them by cascade).
	DELETE FROM app.outbox_jobs j WHERE j.ctid IN (
		SELECT x.ctid FROM app.outbox_jobs x
		WHERE x.workspace_id = p_workspace_id AND x.status = 'completed'
			AND coalesce(x.completed_at, x.updated_at) < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_jobs'; deleted := n; RETURN NEXT;

	-- Resolved alerts after 30 days.
	DELETE FROM app.outbox_job_alerts a WHERE a.ctid IN (
		SELECT x.ctid FROM app.outbox_job_alerts x
		WHERE x.workspace_id = p_workspace_id AND x.resolved_at < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_job_alerts'; deleted := n; RETURN NEXT;

	-- Applied email provider events after 180 days.
	DELETE FROM app.email_provider_events p WHERE p.ctid IN (
		SELECT x.ctid FROM app.email_provider_events x
		WHERE x.workspace_id = p_workspace_id AND x.applied_at < p_now - interval '180 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'email_provider_events'; deleted := n; RETURN NEXT;

	-- Idempotency keys after 7 days, pending or completed.
	DELETE FROM app.idempotency_keys k WHERE k.ctid IN (
		SELECT x.ctid FROM app.idempotency_keys x
		WHERE x.workspace_id = p_workspace_id AND x.created_at < p_now - interval '7 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'idempotency_keys'; deleted := n; RETURN NEXT;

	-- Automation runs after 90 days.
	DELETE FROM app.automation_runs r WHERE r.ctid IN (
		SELECT x.ctid FROM app.automation_runs x
		WHERE x.workspace_id = p_workspace_id AND x.created_at < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_runs'; deleted := n; RETURN NEXT;

	-- Tracking challenges 24 hours after they expire, consumed or not.
	DELETE FROM app.tracking_challenges c WHERE c.ctid IN (
		SELECT x.ctid FROM app.tracking_challenges x
		WHERE x.workspace_id = p_workspace_id AND x.expires_at < p_now - interval '1 day'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'tracking_challenges'; deleted := n; RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION app.prune_operational_rows(uuid, timestamptz) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.prune_operational_rows(uuid, timestamptz) TO app_runtime;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '7b4e5292e29ac1fdc8ab891e604d82dbbe9e3997e5756d73f6d2f120c817ad94', 1793385700370
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793385700370);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '900a964eac69947a733e022e05e1664a2c03f312cced36c510383e9faa99ffc2', 1793385701352
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793385701352);
-- now() is fixed for the whole transaction, so the second version is one
-- second later: the two rows need distinct versions.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0017_customer_tracking',
       ARRAY['-- applied by hand from packages/db/drizzle/0017_customer_tracking.sql; see docs/RUNBOOKS/manual/0017-0018-customer-tracking.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0017_customer_tracking'
);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char((now() + interval '1 second') at time zone 'utc', 'YYYYMMDDHH24MISS'), '0018_customer_tracking_runtime',
       ARRAY['-- applied by hand from packages/db/drizzle/0018_customer_tracking_runtime.sql; see docs/RUNBOOKS/manual/0017-0018-customer-tracking.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0018_customer_tracking_runtime'
);

COMMIT;

-- Verification, one select at a time.

-- 1. Expect two rows, each true, true (row security on and forced):
-- change_requests, tracking_challenges.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.relnamespace = 'app'::regnamespace
  AND c.relname IN ('change_requests', 'tracking_challenges')
ORDER BY c.relname;

-- 2. Expect four rows: <table>_backup_reader_read (SELECT, backup_reader) and
-- <table>_tenant_policy (ALL, app_runtime) for each of the two.
SELECT tablename, policyname, cmd, roles FROM pg_policies
WHERE schemaname = 'app' AND tablename IN ('change_requests', 'tracking_challenges')
ORDER BY tablename, policyname;

-- 3. Expect 38: one backup_reader read policy per RLS table in app (every
-- app table but workspaces).
SELECT count(*) FROM pg_policies
WHERE schemaname = 'app' AND policyname LIKE '%\_backup\_reader\_read' AND 'backup_reader' = ANY (roles);

-- 4. Expect two rows, each: runtime_select, runtime_insert, runtime_update
-- true, runtime_delete false, backup_select true.
SELECT 'change_requests' AS table_name,
       has_table_privilege('app_runtime', 'app.change_requests', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.change_requests', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.change_requests', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.change_requests', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.change_requests', 'SELECT') AS backup_select
UNION ALL
SELECT 'tracking_challenges' AS table_name,
       has_table_privilege('app_runtime', 'app.tracking_challenges', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.tracking_challenges', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.tracking_challenges', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.tracking_challenges', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.tracking_challenges', 'SELECT') AS backup_select
ORDER BY table_name;

-- 5. Expect one row: held_for_change_request, boolean, NO (not null), false,
-- and email_index true (leads_workspace_email_idx on lower(btrim(email))).
SELECT column_name, data_type, is_nullable, column_default,
       EXISTS (
         SELECT 1 FROM pg_indexes
         WHERE schemaname = 'app' AND tablename = 'leads' AND indexname = 'leads_workspace_email_idx'
           AND indexdef LIKE '%lower(btrim(email))%'
       ) AS email_index
FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'files' AND column_name = 'held_for_change_request';

-- 6. Expect four rows: change_requests_resolved_check (pending exactly when
-- resolved_at is null, and resolved_at null exactly when resolved_by is),
-- email_template_versions_key_check and
-- email_templates_key_check each naming 'change_approved' and
-- 'change_rejected', and site_counters_counter_check naming 'sim_order_ref'
-- and 'change_request_no'.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace = 'app'::regnamespace
  AND conname IN ('change_requests_resolved_check', 'email_template_versions_key_check', 'email_templates_key_check', 'site_counters_counter_check')
ORDER BY conname;

-- 7. Expect one row: true, true, true (the prune function names
-- tracking_challenges, still names automation_runs and is still SECURITY
-- DEFINER).
SELECT p.prosrc LIKE '%app.tracking_challenges%' AS prunes_tracking_challenges,
       p.prosrc LIKE '%app.automation_runs%' AS prunes_automation_runs,
       p.prosecdef AS security_definer
FROM pg_proc p
WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'prune_operational_rows';

-- 8. Expect two rows: the hashes and `when` values in the header.
SELECT hash, created_at FROM drizzle.__drizzle_migrations
WHERE created_at IN (1793385700370, 1793385701352)
ORDER BY created_at;
