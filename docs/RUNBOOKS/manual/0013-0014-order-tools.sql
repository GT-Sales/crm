-- Migrations 0013 and 0014 by hand, for when the Supabase tool's confirm
-- prompt cannot be answered (0013 has ALTER TABLE on app.email_messages,
-- 0014 has ALTER, GRANT and a CREATE OR REPLACE FUNCTION). Paste everything
-- from BEGIN to COMMIT into Supabase -> SQL Editor -> Run, once, as
-- postgres. It is one transaction: either all of it lands, all four tracker
-- rows included, or none of it.
--
-- Order of work (docs/RUNBOOKS/database.md, 0013 + 0014):
--   1. the pre-check (A) below;
--   2. BEGIN ... COMMIT;
--   3. the verification selects at the end, one at a time (the SQL editor
--      shows only the last result set of a run).
-- Apply this before deploying a backend that reads the six new tables or
-- email_messages.template_version.
--
-- Additive only, no data migration: six new tables, one new nullable column
-- with no default (no rewrite; its check scans email_messages once), FORCE
-- RLS and grants on the six, and prune_operational_rows() replaced with
-- 0001's body plus idempotency keys (7 days) and automation runs (90 days).
-- Drizzle hashes (sha256 of each file) and journal `when` values:
--   0013_order_tools          dc79cd6b92a16064141144d74734b4f9d1a0ca70ef28c7c1f90221e28ea47962  1793349931483
--   0014_order_tools_runtime  c84d2ebed00c0fb61f26e79e68887636a2db1e30701d406ef4c7d6acd2c0ea60  1793349941965

-- A. Pre-check. Expect one row: the six tables null,
-- template_version_column false, tracker_rows 0.
SELECT to_regclass('app.idempotency_keys') AS idempotency_keys,
       to_regclass('app.workspace_email_settings') AS workspace_email_settings,
       to_regclass('app.email_templates') AS email_templates,
       to_regclass('app.email_template_versions') AS email_template_versions,
       to_regclass('app.automations') AS automations,
       to_regclass('app.automation_runs') AS automation_runs,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'email_messages' AND column_name = 'template_version'
       ) AS template_version_column,
       (SELECT count(*) FROM drizzle.__drizzle_migrations
        WHERE created_at IN (1793349931483, 1793349941965)) AS tracker_rows;

BEGIN;

-- ---------------------------------------------------------------------------
-- 0013_order_tools (generated from packages/db/src/schema.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE "app"."automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"automation_key" text NOT NULL,
	"lead_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_runs_automation_key_check" CHECK ("app"."automation_runs"."automation_key" in ('order_received', 'sim_order_information_needed', 'sim_order_dispatched', 'sim_order_activated', 'sim_order_cancelled', 'mobility_activated')),
	CONSTRAINT "automation_runs_outcome_check" CHECK ("app"."automation_runs"."outcome" in ('queued', 'skipped')),
	CONSTRAINT "automation_runs_reason_check" CHECK ("app"."automation_runs"."reason" is null or "app"."automation_runs"."reason" in ('no_sender', 'no_customer_email', 'missing_fill_in')),
	CONSTRAINT "automation_runs_skipped_reason_check" CHECK (("app"."automation_runs"."outcome" = 'skipped') = ("app"."automation_runs"."reason" is not null)),
	CONSTRAINT "automation_runs_queued_job_check" CHECK (("app"."automation_runs"."outcome" = 'queued') = ("app"."automation_runs"."job_id" is not null))
);

ALTER TABLE "app"."automation_runs" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_workspace_key_unique" UNIQUE("workspace_id","key"),
	CONSTRAINT "automations_key_check" CHECK ("app"."automations"."key" in ('order_received', 'sim_order_information_needed', 'sim_order_dispatched', 'sim_order_activated', 'sim_order_cancelled', 'mobility_activated')),
	CONSTRAINT "automations_run_count_check" CHECK ("app"."automations"."run_count" >= 0)
);

ALTER TABLE "app"."automations" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."email_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"version" integer NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_template_versions_workspace_key_version_unique" UNIQUE("workspace_id","key","version"),
	CONSTRAINT "email_template_versions_key_check" CHECK ("app"."email_template_versions"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready')),
	CONSTRAINT "email_template_versions_subject_check" CHECK (char_length("app"."email_template_versions"."subject") between 1 and 150),
	CONSTRAINT "email_template_versions_body_check" CHECK (char_length("app"."email_template_versions"."body") between 1 and 5000),
	CONSTRAINT "email_template_versions_version_check" CHECK ("app"."email_template_versions"."version" > 0)
);

ALTER TABLE "app"."email_template_versions" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"version" integer NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_templates_workspace_key_unique" UNIQUE("workspace_id","key"),
	CONSTRAINT "email_templates_key_check" CHECK ("app"."email_templates"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready')),
	CONSTRAINT "email_templates_subject_check" CHECK (char_length("app"."email_templates"."subject") between 1 and 150),
	CONSTRAINT "email_templates_body_check" CHECK (char_length("app"."email_templates"."body") between 1 and 5000),
	CONSTRAINT "email_templates_version_check" CHECK ("app"."email_templates"."version" > 0)
);

ALTER TABLE "app"."email_templates" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"key_hash" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"lead_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_unique" UNIQUE("workspace_id","scope","key_hash"),
	CONSTRAINT "idempotency_keys_scope_check" CHECK ("app"."idempotency_keys"."scope" in ('lead_submission')),
	CONSTRAINT "idempotency_keys_key_hash_check" CHECK ("app"."idempotency_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_request_fingerprint_check" CHECK ("app"."idempotency_keys"."request_fingerprint" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "idempotency_keys_status_check" CHECK ("app"."idempotency_keys"."status" in ('pending', 'completed')),
	CONSTRAINT "idempotency_keys_completed_check" CHECK (("app"."idempotency_keys"."status" = 'completed') = ("app"."idempotency_keys"."completed_at" is not null and "app"."idempotency_keys"."lead_id" is not null))
);

ALTER TABLE "app"."idempotency_keys" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."workspace_email_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"from_name" text NOT NULL,
	"from_address" text NOT NULL,
	"reply_to" text,
	"logo_url" text,
	"brand_color" text DEFAULT '#d72638' NOT NULL,
	"footer_text" text DEFAULT '' NOT NULL,
	"site_url" text,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_email_settings_from_name_check" CHECK (char_length(btrim("app"."workspace_email_settings"."from_name")) between 1 and 80),
	CONSTRAINT "workspace_email_settings_from_address_check" CHECK (char_length("app"."workspace_email_settings"."from_address") <= 254 and "app"."workspace_email_settings"."from_address" ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
	CONSTRAINT "workspace_email_settings_reply_to_check" CHECK ("app"."workspace_email_settings"."reply_to" is null or (char_length("app"."workspace_email_settings"."reply_to") <= 254 and "app"."workspace_email_settings"."reply_to" ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
	CONSTRAINT "workspace_email_settings_logo_url_check" CHECK ("app"."workspace_email_settings"."logo_url" is null or (char_length("app"."workspace_email_settings"."logo_url") <= 2048 and "app"."workspace_email_settings"."logo_url" ~ '^https://')),
	CONSTRAINT "workspace_email_settings_brand_color_check" CHECK ("app"."workspace_email_settings"."brand_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "workspace_email_settings_footer_text_check" CHECK (char_length("app"."workspace_email_settings"."footer_text") <= 500),
	CONSTRAINT "workspace_email_settings_site_url_check" CHECK ("app"."workspace_email_settings"."site_url" is null or (char_length("app"."workspace_email_settings"."site_url") <= 2048 and "app"."workspace_email_settings"."site_url" ~ '^https://'))
);

ALTER TABLE "app"."workspace_email_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."email_messages" ADD COLUMN "template_version" integer;
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."email_template_versions" ADD CONSTRAINT "email_template_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."workspace_email_settings" ADD CONSTRAINT "workspace_email_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "automation_runs_workspace_key_created_idx" ON "app"."automation_runs" USING btree ("workspace_id","automation_key","created_at" DESC NULLS LAST);
CREATE INDEX "idempotency_keys_workspace_created_idx" ON "app"."idempotency_keys" USING btree ("workspace_id","created_at");
ALTER TABLE "app"."email_messages" ADD CONSTRAINT "email_messages_template_version_check" CHECK ("app"."email_messages"."template_version" is null or "app"."email_messages"."template_version" >= 0);
CREATE POLICY "automation_runs_tenant_policy" ON "app"."automation_runs" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."automation_runs"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."automation_runs"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "automation_runs_backup_reader_read" ON "app"."automation_runs" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "automations_tenant_policy" ON "app"."automations" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."automations"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."automations"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "automations_backup_reader_read" ON "app"."automations" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "email_template_versions_tenant_policy" ON "app"."email_template_versions" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."email_template_versions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."email_template_versions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "email_template_versions_backup_reader_read" ON "app"."email_template_versions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "email_templates_tenant_policy" ON "app"."email_templates" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."email_templates"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."email_templates"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "email_templates_backup_reader_read" ON "app"."email_templates" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "idempotency_keys_tenant_policy" ON "app"."idempotency_keys" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."idempotency_keys"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."idempotency_keys"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "idempotency_keys_backup_reader_read" ON "app"."idempotency_keys" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "workspace_email_settings_tenant_policy" ON "app"."workspace_email_settings" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."workspace_email_settings"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."workspace_email_settings"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "workspace_email_settings_backup_reader_read" ON "app"."workspace_email_settings" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);

-- ---------------------------------------------------------------------------
-- 0014_order_tools_runtime
-- ---------------------------------------------------------------------------
-- Hand-written companion to 0013_order_tools (AGENTS.md rule 3): FORCE RLS
-- and the runtime grants on the six new tables, and the retention of the two
-- that grow with traffic. backup_reader needs no grant here: 0007's default
-- privileges make every new app table readable, and each table's read policy
-- comes from schema.ts in 0013. No data migration. Every statement is safe to
-- run twice.

ALTER TABLE "app"."idempotency_keys" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."workspace_email_settings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."email_templates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."email_template_versions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."automations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."automation_runs" FORCE ROW LEVEL SECURITY;

-- No DELETE anywhere: old idempotency keys and runs go through
-- prune_operational_rows() below, the rest go with their site.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."idempotency_keys" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."workspace_email_settings" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."email_templates" TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automations" TO app_runtime;

-- Append-only: a template's saved versions and an automation's run log are
-- never rewritten from the application.
GRANT SELECT, INSERT ON TABLE "app"."email_template_versions" TO app_runtime;
GRANT SELECT, INSERT ON TABLE "app"."automation_runs" TO app_runtime;

-- 0001's bounded pruning, plus idempotency keys after 7 days (a website
-- retries a submission within minutes, not days) and automation runs after
-- 90 days. Still the caller's own tenant only, at most 1000 rows per table
-- per call.
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
END;
$function$;
REVOKE ALL ON FUNCTION app.prune_operational_rows(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prune_operational_rows(uuid, timestamptz) TO app_runtime;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'dc79cd6b92a16064141144d74734b4f9d1a0ca70ef28c7c1f90221e28ea47962', 1793349931483
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793349931483);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'c84d2ebed00c0fb61f26e79e68887636a2db1e30701d406ef4c7d6acd2c0ea60', 1793349941965
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793349941965);
-- now() is fixed for the whole transaction, so the second version is one
-- second later: the two rows need distinct versions.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0013_order_tools',
       ARRAY['-- applied by hand from packages/db/drizzle/0013_order_tools.sql; see docs/RUNBOOKS/manual/0013-0014-order-tools.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0013_order_tools'
);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char((now() + interval '1 second') at time zone 'utc', 'YYYYMMDDHH24MISS'), '0014_order_tools_runtime',
       ARRAY['-- applied by hand from packages/db/drizzle/0014_order_tools_runtime.sql; see docs/RUNBOOKS/manual/0013-0014-order-tools.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0014_order_tools_runtime'
);

COMMIT;

-- Verification, one select at a time.

-- 1. Expect six rows, each true, true (row security on and forced):
-- automation_runs, automations, email_template_versions, email_templates,
-- idempotency_keys, workspace_email_settings.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.relnamespace = 'app'::regnamespace
  AND c.relname IN ('automation_runs', 'automations', 'email_template_versions', 'email_templates', 'idempotency_keys', 'workspace_email_settings')
ORDER BY c.relname;

-- 2. Expect twelve rows: <table>_backup_reader_read and <table>_tenant_policy
-- for each of the six.
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'app'
  AND tablename IN ('automation_runs', 'automations', 'email_template_versions', 'email_templates', 'idempotency_keys', 'workspace_email_settings')
ORDER BY tablename, policyname;

-- 3. Expect 35: one backup_reader read policy per RLS table in app (every
-- app table but workspaces).
SELECT count(*) FROM pg_policies
WHERE schemaname = 'app' AND policyname LIKE '%\_backup\_reader\_read' AND 'backup_reader' = ANY (roles);

-- 4. Expect six rows. app_runtime select and insert true everywhere, delete
-- false everywhere; update true for automations, email_templates,
-- idempotency_keys and workspace_email_settings, false for automation_runs
-- and email_template_versions (append-only); backup_reader select true
-- everywhere.
SELECT 'idempotency_keys' AS table_name,
       has_table_privilege('app_runtime', 'app.idempotency_keys', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.idempotency_keys', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.idempotency_keys', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.idempotency_keys', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.idempotency_keys', 'SELECT') AS backup_select
UNION ALL
SELECT 'workspace_email_settings' AS table_name,
       has_table_privilege('app_runtime', 'app.workspace_email_settings', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.workspace_email_settings', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.workspace_email_settings', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.workspace_email_settings', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.workspace_email_settings', 'SELECT') AS backup_select
UNION ALL
SELECT 'email_templates' AS table_name,
       has_table_privilege('app_runtime', 'app.email_templates', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.email_templates', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.email_templates', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.email_templates', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.email_templates', 'SELECT') AS backup_select
UNION ALL
SELECT 'email_template_versions' AS table_name,
       has_table_privilege('app_runtime', 'app.email_template_versions', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.email_template_versions', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.email_template_versions', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.email_template_versions', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.email_template_versions', 'SELECT') AS backup_select
UNION ALL
SELECT 'automations' AS table_name,
       has_table_privilege('app_runtime', 'app.automations', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.automations', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.automations', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.automations', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.automations', 'SELECT') AS backup_select
UNION ALL
SELECT 'automation_runs' AS table_name,
       has_table_privilege('app_runtime', 'app.automation_runs', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.automation_runs', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.automation_runs', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.automation_runs', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.automation_runs', 'SELECT') AS backup_select
ORDER BY table_name;

-- 5. Expect one row: template_version, integer, YES (nullable), no default,
-- has_check true.
SELECT column_name, data_type, is_nullable, column_default,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'app.email_messages'::regclass
           AND conname = 'email_messages_template_version_check'
       ) AS has_check
FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'email_messages' AND column_name = 'template_version';

-- 6. Expect one row: true, true, true (the prune function names both new
-- tables and is still SECURITY DEFINER).
SELECT p.prosrc LIKE '%app.idempotency_keys%' AS prunes_idempotency_keys,
       p.prosrc LIKE '%app.automation_runs%' AS prunes_automation_runs,
       p.prosecdef AS security_definer
FROM pg_proc p
WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'prune_operational_rows';

-- 7. Expect two rows: the hashes and `when` values in the header.
SELECT hash, created_at FROM drizzle.__drizzle_migrations
WHERE created_at IN (1793349931483, 1793349941965)
ORDER BY created_at;
