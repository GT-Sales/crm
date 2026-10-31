-- Migrations 0019 and 0020 by hand, for when the Supabase tool's confirm
-- prompt cannot be answered (0019 has CREATE TABLE, ALTER TABLE ... DROP/ADD
-- CONSTRAINT, ADD COLUMN, ALTER COLUMN ... DROP NOT NULL and ENABLE ROW LEVEL
-- SECURITY; 0020 has ALTER, GRANT, REVOKE, a DO block, CREATE OR REPLACE
-- FUNCTION and TRIGGER, and UPDATE/INSERT backfills). Paste everything from
-- BEGIN to COMMIT into Supabase -> SQL Editor -> Run, once, as postgres. It
-- is one transaction: either all of it lands, all four tracker rows
-- included, or none of it.
--
-- Why: merge phase 8 step A (automation flows, spec
-- docs/superpowers/specs/2026-10-31-phase-8-automation-flows-design.md §4,
-- §6, §7). Every automation becomes a flow with versions, runs record each
-- step, waits and time triggers are stored, the six built-in rules become
-- seeded flows (same keys, still off), site-made email templates and a
-- member's notification address get their columns.
--
-- Order of work (docs/RUNBOOKS/database.md, 0019 + 0020):
--   1. the pre-check (A) below;
--   2. BEGIN ... COMMIT;
--   3. the verification selects at the end, one at a time (the SQL editor
--      shows only the last result set of a run).
-- Apply this before deploying a backend that reads app.automation_versions,
-- app.automation_step_runs, app.automation_waits, app.automation_timers or
-- the new columns (merge phase 8, step A).
--
-- The deploy window: do not switch automation rules between applying this
-- and the new backend going live (the old backend can still switch a rule
-- on, creating a row with no version that the new firing ignores until the
-- Automations list repairs it; production has none on). The old admin's
-- Automations page may show its load error until the admin deploys.
--
-- If the plain statements go through the Supabase tool instead, the
-- `CREATE OR REPLACE FUNCTION app.prune_operational_rows` statement (marked
-- OWNER PASTE below, and repeated after the verification selects) is the one
-- the owner pastes by hand, as in phases 4 and 5.
--
-- Additive, with a data conversion that is a no-op on production (0 rows in
-- app.automations and app.automation_runs on 2026-10-31): four new tables
-- (all empty); new columns on app.automations, app.automation_runs,
-- app.email_templates and app.memberships, each nullable or with a constant
-- (or now()) default, so no table rewrite; automation_runs.outcome made
-- nullable; the key, reason and outcome checks of automations,
-- automation_runs, email_templates and email_template_versions dropped and
-- re-added as shapes (each re-added check scans its table once); the
-- (workspace_id, id) unique constraints on automations and automation_runs;
-- FORCE RLS and grants on the four tables (no DELETE), UPDATE of five
-- columns of automation_runs; the FK from a flow to its live version; the
-- trigger that keeps an activated version fixed (its definition, its
-- activation and every status move but active -> retired); the functions
-- app.builtin_flow_definition, app.builtin_flow_name and
-- app.record_staff_notification_email; the
-- conversion of existing rule rows and runs; and prune_operational_rows()
-- replaced with 0018's body except that runs go 90 days after they finish
-- (never while waiting) and fired or void timers 90 days after they ended.
-- The two files are below verbatim but for drizzle's
-- `--> statement-breakpoint` markers and the OWNER PASTE note. Drizzle hashes
-- (sha256 of each file) and journal `when` values:
--   0019_automation_flows          c91f1c89269e3e1fa63110fc594d1f250b72d884889000ad5e7af4a19aadcd1b  1793450665432
--   0020_automation_flows_runtime  d0358cece7c5ae47cd3b4072ff12426999752400fb64597e0d216dd45c753cd8  1793450690795

-- A. Pre-check. Expect one row: automation_versions, automation_step_runs,
-- automation_waits and automation_timers null, origin_column false,
-- tracker_rows 0.
SELECT to_regclass('app.automation_versions') AS automation_versions,
       to_regclass('app.automation_step_runs') AS automation_step_runs,
       to_regclass('app.automation_waits') AS automation_waits,
       to_regclass('app.automation_timers') AS automation_timers,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'automations' AND column_name = 'origin'
       ) AS origin_column,
       (SELECT count(*) FROM drizzle.__drizzle_migrations
        WHERE created_at IN (1793450665432, 1793450690795)) AS tracker_rows;

BEGIN;

-- ---------------------------------------------------------------------------
-- 0019_automation_flows (generated from packages/db/src/schema.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE "app"."automation_step_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"step_kind" text NOT NULL,
	"outcome" text NOT NULL,
	"branch" text,
	"reason" text,
	"detail" text,
	"job_id" uuid,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "automation_step_runs_step_id_check" CHECK ("app"."automation_step_runs"."step_id" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "automation_step_runs_step_kind_check" CHECK ("app"."automation_step_runs"."step_kind" in ('send_email', 'create_task', 'assign_lead', 'update_lead', 'notify_staff', 'if_else', 'wait')),
	CONSTRAINT "automation_step_runs_outcome_check" CHECK ("app"."automation_step_runs"."outcome" in ('done', 'skipped', 'failed', 'waiting', 'cancelled')),
	CONSTRAINT "automation_step_runs_branch_check" CHECK ("app"."automation_step_runs"."branch" is null or "app"."automation_step_runs"."branch" in ('yes', 'no')),
	CONSTRAINT "automation_step_runs_reason_check" CHECK ("app"."automation_step_runs"."reason" is null or "app"."automation_step_runs"."reason" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "automation_step_runs_detail_check" CHECK ("app"."automation_step_runs"."detail" is null or char_length("app"."automation_step_runs"."detail") <= 200)
);

ALTER TABLE "app"."automation_step_runs" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."automation_timers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"trigger_kind" text NOT NULL,
	"occurrence" text NOT NULL,
	"subject_id" uuid,
	"stage" text,
	"event_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_timers_occurrence_unique" UNIQUE("workspace_id","automation_id","lead_id","occurrence"),
	CONSTRAINT "automation_timers_trigger_kind_check" CHECK ("app"."automation_timers"."trigger_kind" in ('time_in_stage', 'task_overdue', 'after_submitted')),
	CONSTRAINT "automation_timers_status_check" CHECK ("app"."automation_timers"."status" in ('pending', 'fired', 'void')),
	CONSTRAINT "automation_timers_occurrence_check" CHECK (char_length("app"."automation_timers"."occurrence") between 1 and 200),
	CONSTRAINT "automation_timers_subject_check" CHECK (("app"."automation_timers"."trigger_kind" = 'task_overdue') = ("app"."automation_timers"."subject_id" is not null)),
	CONSTRAINT "automation_timers_stage_check" CHECK (("app"."automation_timers"."trigger_kind" = 'time_in_stage') = ("app"."automation_timers"."stage" is not null))
);

ALTER TABLE "app"."automation_timers" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."automation_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_by" uuid,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "automation_versions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "automation_versions_workspace_automation_version_unique" UNIQUE("workspace_id","automation_id","version"),
	CONSTRAINT "automation_versions_status_check" CHECK ("app"."automation_versions"."status" in ('draft', 'active', 'retired', 'discarded')),
	CONSTRAINT "automation_versions_version_check" CHECK ("app"."automation_versions"."version" > 0),
	CONSTRAINT "automation_versions_schema_version_check" CHECK ("app"."automation_versions"."schema_version" = 1),
	CONSTRAINT "automation_versions_definition_check" CHECK (jsonb_typeof("app"."automation_versions"."definition") = 'object' and octet_length("app"."automation_versions"."definition"::text) <= 65536),
	CONSTRAINT "automation_versions_activated_check" CHECK (("app"."automation_versions"."status" in ('active', 'retired')) = ("app"."automation_versions"."activated_at" is not null)),
	CONSTRAINT "automation_versions_retired_check" CHECK (("app"."automation_versions"."status" = 'retired') = ("app"."automation_versions"."retired_at" is not null))
);

ALTER TABLE "app"."automation_versions" ENABLE ROW LEVEL SECURITY;
CREATE TABLE "app"."automation_waits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"resume_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_waits_run_id_unique" UNIQUE("run_id"),
	CONSTRAINT "automation_waits_step_id_check" CHECK ("app"."automation_waits"."step_id" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "automation_waits_status_check" CHECK ("app"."automation_waits"."status" in ('pending', 'resumed', 'cancelled')),
	CONSTRAINT "automation_waits_attempts_check" CHECK ("app"."automation_waits"."attempts" between 0 and 5)
);

ALTER TABLE "app"."automation_waits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_automation_key_check";
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_outcome_check";
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_reason_check";
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_skipped_reason_check";
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_queued_job_check";
ALTER TABLE "app"."automations" DROP CONSTRAINT "automations_key_check";
ALTER TABLE "app"."email_template_versions" DROP CONSTRAINT "email_template_versions_key_check";
ALTER TABLE "app"."email_templates" DROP CONSTRAINT "email_templates_key_check";
ALTER TABLE "app"."automation_runs" ALTER COLUMN "outcome" DROP NOT NULL;
ALTER TABLE "app"."automation_runs" ADD COLUMN "automation_id" uuid;
ALTER TABLE "app"."automation_runs" ADD COLUMN "version_id" uuid;
ALTER TABLE "app"."automation_runs" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;
ALTER TABLE "app"."automation_runs" ADD COLUMN "detail" text;
ALTER TABLE "app"."automation_runs" ADD COLUMN "occurrence" text;
ALTER TABLE "app"."automation_runs" ADD COLUMN "trigger_kind" text;
ALTER TABLE "app"."automation_runs" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;
ALTER TABLE "app"."automation_runs" ADD COLUMN "parent_run_id" uuid;
ALTER TABLE "app"."automation_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "app"."automation_runs" ADD COLUMN "finished_at" timestamp with time zone;
ALTER TABLE "app"."automations" ADD COLUMN "origin" text DEFAULT 'builtin' NOT NULL;
ALTER TABLE "app"."automations" ADD COLUMN "name" text;
ALTER TABLE "app"."automations" ADD COLUMN "description" text;
ALTER TABLE "app"."automations" ADD COLUMN "active_version_id" uuid;
ALTER TABLE "app"."automations" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;
ALTER TABLE "app"."automations" ADD COLUMN "created_by" uuid;
ALTER TABLE "app"."automations" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;
ALTER TABLE "app"."automations" ADD COLUMN "archived_at" timestamp with time zone;
ALTER TABLE "app"."email_templates" ADD COLUMN "name" text;
ALTER TABLE "app"."email_templates" ADD COLUMN "archived_at" timestamp with time zone;
ALTER TABLE "app"."memberships" ADD COLUMN "notification_email" text;
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_id_unique" UNIQUE("workspace_id","id");
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_workspace_id_id_unique" UNIQUE("workspace_id","id");
ALTER TABLE "app"."automation_step_runs" ADD CONSTRAINT "automation_step_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_step_runs" ADD CONSTRAINT "automation_step_runs_workspace_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."automation_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_timers" ADD CONSTRAINT "automation_timers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_timers" ADD CONSTRAINT "automation_timers_workspace_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "app"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_timers" ADD CONSTRAINT "automation_timers_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_versions" ADD CONSTRAINT "automation_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_versions" ADD CONSTRAINT "automation_versions_workspace_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "app"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_waits" ADD CONSTRAINT "automation_waits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_waits" ADD CONSTRAINT "automation_waits_workspace_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."automation_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "automation_step_runs_workspace_run_created_idx" ON "app"."automation_step_runs" USING btree ("workspace_id","run_id","created_at");
CREATE INDEX "automation_timers_workspace_status_due_idx" ON "app"."automation_timers" USING btree ("workspace_id","status","due_at");
CREATE UNIQUE INDEX "automation_versions_one_draft" ON "app"."automation_versions" USING btree ("workspace_id","automation_id") WHERE "app"."automation_versions"."status" = 'draft';
CREATE UNIQUE INDEX "automation_versions_one_active" ON "app"."automation_versions" USING btree ("workspace_id","automation_id") WHERE "app"."automation_versions"."status" = 'active';
CREATE INDEX "automation_waits_workspace_status_resume_idx" ON "app"."automation_waits" USING btree ("workspace_id","status","resume_at");
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "app"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "app"."automation_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;
CREATE UNIQUE INDEX "automation_runs_occurrence_unique" ON "app"."automation_runs" USING btree ("workspace_id","automation_key","lead_id","occurrence") WHERE "app"."automation_runs"."occurrence" is not null;
CREATE INDEX "automation_runs_workspace_automation_created_idx" ON "app"."automation_runs" USING btree ("workspace_id","automation_id","created_at" DESC NULLS LAST);
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_status_check" CHECK ("app"."automation_runs"."status" in ('waiting', 'completed', 'skipped', 'failed', 'cancelled'));
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_waiting_check" CHECK ("app"."automation_runs"."status" <> 'waiting' or "app"."automation_runs"."finished_at" is null);
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_depth_check" CHECK ("app"."automation_runs"."depth" between 0 and 3);
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_trigger_kind_check" CHECK ("app"."automation_runs"."trigger_kind" is null or "app"."automation_runs"."trigger_kind" in ('lead_submitted', 'stage_entered', 'time_in_stage', 'task_overdue', 'after_submitted'));
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_occurrence_check" CHECK ("app"."automation_runs"."occurrence" is null or char_length("app"."automation_runs"."occurrence") <= 200);
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_detail_check" CHECK ("app"."automation_runs"."detail" is null or char_length("app"."automation_runs"."detail") <= 200);
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_automation_key_check" CHECK ("app"."automation_runs"."automation_key" ~ '^[a-z][a-z0-9_]{2,63}$');
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_outcome_check" CHECK ("app"."automation_runs"."outcome" is null or "app"."automation_runs"."outcome" in ('queued', 'skipped'));
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_reason_check" CHECK ("app"."automation_runs"."reason" is null or "app"."automation_runs"."reason" ~ '^[a-z][a-z0-9_]{0,63}$');
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_skipped_reason_check" CHECK ("app"."automation_runs"."outcome" is distinct from 'skipped' or "app"."automation_runs"."reason" is not null);
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_queued_job_check" CHECK ("app"."automation_runs"."outcome" is distinct from 'queued' or "app"."automation_runs"."job_id" is not null);
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_origin_check" CHECK ("app"."automations"."origin" in ('builtin', 'custom'));
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_archived_check" CHECK ("app"."automations"."archived_at" is null or ("app"."automations"."origin" = 'custom' and not "app"."automations"."enabled"));
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_name_check" CHECK (("app"."automations"."name" is null and "app"."automations"."origin" = 'builtin') or ("app"."automations"."name" is not null and char_length(btrim("app"."automations"."name")) between 1 and 80));
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_description_check" CHECK ("app"."automations"."description" is null or char_length("app"."automations"."description") <= 500);
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_revision_check" CHECK ("app"."automations"."revision" >= 0);
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_key_check" CHECK (("app"."automations"."origin" = 'builtin' and "app"."automations"."key" in ('order_received', 'sim_order_information_needed', 'sim_order_dispatched', 'sim_order_activated', 'sim_order_cancelled', 'mobility_activated')) or ("app"."automations"."origin" = 'custom' and "app"."automations"."key" ~ '^flow_[a-z0-9]{16}$'));
ALTER TABLE "app"."email_template_versions" ADD CONSTRAINT "email_template_versions_key_check" CHECK ("app"."email_template_versions"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected') or "app"."email_template_versions"."key" ~ '^tpl_[a-z0-9]{16}$');
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_name_check" CHECK (("app"."email_templates"."key" ~ '^tpl_') = ("app"."email_templates"."name" is not null) and ("app"."email_templates"."name" is null or (char_length("app"."email_templates"."name") between 1 and 80 and "app"."email_templates"."name" = btrim("app"."email_templates"."name"))));
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_archived_check" CHECK ("app"."email_templates"."archived_at" is null or "app"."email_templates"."key" ~ '^tpl_');
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_key_check" CHECK ("app"."email_templates"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected') or "app"."email_templates"."key" ~ '^tpl_[a-z0-9]{16}$');
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_notification_email_check" CHECK ("app"."memberships"."notification_email" is null or (char_length("app"."memberships"."notification_email") <= 254 and "app"."memberships"."notification_email" ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'));
CREATE POLICY "automation_step_runs_tenant_policy" ON "app"."automation_step_runs" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."automation_step_runs"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."automation_step_runs"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "automation_step_runs_backup_reader_read" ON "app"."automation_step_runs" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "automation_timers_tenant_policy" ON "app"."automation_timers" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."automation_timers"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."automation_timers"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "automation_timers_backup_reader_read" ON "app"."automation_timers" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "automation_versions_tenant_policy" ON "app"."automation_versions" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."automation_versions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."automation_versions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "automation_versions_backup_reader_read" ON "app"."automation_versions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
CREATE POLICY "automation_waits_tenant_policy" ON "app"."automation_waits" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."automation_waits"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."automation_waits"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);
CREATE POLICY "automation_waits_backup_reader_read" ON "app"."automation_waits" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);

-- ---------------------------------------------------------------------------
-- 0020_automation_flows_runtime
-- ---------------------------------------------------------------------------
-- Hand-written companion to 0019_automation_flows (AGENTS.md rule 3): FORCE
-- RLS and the runtime grants on the four new automation tables, UPDATE of
-- five columns of app.automation_runs (a run moves from waiting to its end),
-- the circular FK from a flow to its live version, the guard that keeps an
-- activated version fixed, the six built-in default definitions and names, the
-- notification address function, the conversion of the phase 4 rows into
-- flows (merge phase 8, spec §6) and, last, the retention of runs and timers.
-- backup_reader needs no grant here: 0007's default privileges make every new
-- app table readable, and each table's read policy comes from schema.ts in
-- 0019. Every statement is safe to run twice.

ALTER TABLE "app"."automation_versions" FORCE ROW LEVEL SECURITY;

ALTER TABLE "app"."automation_step_runs" FORCE ROW LEVEL SECURITY;

ALTER TABLE "app"."automation_waits" FORCE ROW LEVEL SECURITY;

ALTER TABLE "app"."automation_timers" FORCE ROW LEVEL SECURITY;

-- No DELETE anywhere: finished runs and old timers go through
-- prune_operational_rows() below, step runs and waits with their run, and
-- everything with its site. Step runs are append-only.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automation_versions" TO app_runtime;

GRANT SELECT, INSERT ON TABLE "app"."automation_step_runs" TO app_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automation_waits" TO app_runtime;

GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automation_timers" TO app_runtime;

-- Loosens phase 4's append-only run log, column by column: a run moves from
-- waiting to its end (status, reason, detail, updated_at, finished_at); its
-- key, lead, job, outcome, occurrence, version and chain never change. The
-- REVOKE first drops any table-wide UPDATE so only these columns remain.
REVOKE UPDATE ON TABLE "app"."automation_runs" FROM app_runtime;

GRANT UPDATE (status, reason, detail, updated_at, finished_at) ON TABLE "app"."automation_runs" TO app_runtime;

-- A flow's live version. The two tables reference each other, so the FK is
-- added here rather than generated from schema.ts.
DO $do$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_constraint
		WHERE conname = 'automations_active_version_fk'
			AND conrelid = 'app.automations'::regclass
	) THEN
		ALTER TABLE app.automations
			ADD CONSTRAINT automations_active_version_fk
			FOREIGN KEY (workspace_id, active_version_id)
			REFERENCES app.automation_versions (workspace_id, id);
	END IF;
END
$do$;

-- An activated version never changes under a run waiting on it. A version's
-- identity (site, flow, number, schema version, author) never changes. A
-- draft may be rewritten and becomes active or discarded; an active version
-- may only be retired; a retired or discarded one is final. Once activated,
-- who activated it and when stay as they were. Anything else raises
-- automation_version_immutable (SQLSTATE 23514), whatever the code asks.
CREATE OR REPLACE FUNCTION app.guard_automation_version_definition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
	IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
		OR NEW.automation_id IS DISTINCT FROM OLD.automation_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
		OR NEW.created_by IS DISTINCT FROM OLD.created_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'automation_version_immutable' USING ERRCODE = '23514';
	END IF;
	IF OLD.status = 'draft' THEN
		IF NEW.status NOT IN ('draft', 'active', 'discarded') THEN
			RAISE EXCEPTION 'automation_version_immutable' USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.definition IS DISTINCT FROM OLD.definition
		OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
		OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
		OR (NEW.status IS DISTINCT FROM OLD.status
			AND NOT (OLD.status = 'active' AND NEW.status = 'retired'))
		OR (OLD.status IN ('retired', 'discarded')
			AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
		RAISE EXCEPTION 'automation_version_immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$function$;

CREATE OR REPLACE TRIGGER automation_versions_definition_guard
	BEFORE UPDATE ON app.automation_versions
	FOR EACH ROW EXECUTE FUNCTION app.guard_automation_version_definition();

-- The six built-ins' version-1 definitions, a literal copy of contracts'
-- builtInFlowDefinition(key) (tied to it by
-- apps/backend/tests/automation-sql-contracts.integration.test.ts); null for
-- any other key.
CREATE OR REPLACE FUNCTION app.builtin_flow_definition(p_key text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE p_key
    WHEN 'order_received' THEN '{"schemaVersion": 1, "trigger": {"kind": "lead_submitted", "leadTypes": ["sim_order", "internet", "mobility"], "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "order_received"}]}'::jsonb
    WHEN 'sim_order_information_needed' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "on_hold", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "information_needed"}]}'::jsonb
    WHEN 'sim_order_dispatched' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "delivered", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "dispatched"}]}'::jsonb
    WHEN 'sim_order_activated' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "activated", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "activated"}]}'::jsonb
    WHEN 'sim_order_cancelled' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "cancelled", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "cancelled"}]}'::jsonb
    WHEN 'mobility_activated' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "mobility", "stage": "activated", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "activated"}]}'::jsonb
  END;
$function$;

REVOKE ALL ON FUNCTION app.builtin_flow_definition(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.builtin_flow_definition(text) TO app_runtime;

-- The six built-ins' default names, a literal copy of contracts'
-- builtInFlowName(key) (their labels; tied to it by the same test); null for
-- any other key.
CREATE OR REPLACE FUNCTION app.builtin_flow_name(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE p_key
    WHEN 'order_received' THEN 'When an order is submitted on the website → send the Order received email'
    WHEN 'sim_order_information_needed' THEN 'When a SIM order moves to On hold → send the Information needed email'
    WHEN 'sim_order_dispatched' THEN 'When a SIM order moves to Delivered → send the Dispatched email'
    WHEN 'sim_order_activated' THEN 'When a SIM order moves to Activated → send the Activated email'
    WHEN 'sim_order_cancelled' THEN 'When a SIM order moves to Cancelled → send the Cancelled email'
    WHEN 'mobility_activated' THEN 'When a mobility order moves to Activated → send the Activated email'
  END;
$function$;

REVOKE ALL ON FUNCTION app.builtin_flow_name(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.builtin_flow_name(text) TO app_runtime;

-- Where a flow's staff notification goes (spec ruling R9): the verified
-- sign-in address, written on every active staff membership of the signed-in
-- actor (app.actor_id) whose address is missing or different. Sign-in runs in
-- an actor-only transaction, where the tenant policy on memberships sees no
-- row, hence SECURITY DEFINER. An address the CHECK would refuse writes
-- nothing. Returns the rows changed.
CREATE OR REPLACE FUNCTION app.record_staff_notification_email(p_verified_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	v_actor uuid := nullif(pg_catalog.current_setting('app.actor_id', true), '')::uuid;
	v_email text := pg_catalog.lower(pg_catalog.btrim(p_verified_email));
	n integer;
BEGIN
	IF v_actor IS NULL THEN
		RAISE EXCEPTION 'verified actor context is required' USING ERRCODE = '42501';
	END IF;
	IF v_email IS NULL OR pg_catalog.char_length(v_email) NOT BETWEEN 1 AND 254
		OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
		RETURN 0;
	END IF;
	UPDATE app.memberships
	SET notification_email = v_email
	WHERE user_id = v_actor
		AND membership_type = 'staff'
		AND status = 'active'
		AND notification_email IS DISTINCT FROM v_email;
	GET DIAGNOSTICS n = ROW_COUNT;
	RETURN n;
END;
$function$;

REVOKE ALL ON FUNCTION app.record_staff_notification_email(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app.record_staff_notification_email(text) TO app_runtime;

-- The conversion (spec §6): each existing rule row becomes a built-in flow
-- with its label as its name and version 1 active, and each phase 4 run is
-- tied to it. Each statement touches only rows it has not converted yet.
UPDATE app.automations
SET name = app.builtin_flow_name(key)
WHERE origin = 'builtin' AND name IS NULL AND app.builtin_flow_name(key) IS NOT NULL;

INSERT INTO app.automation_versions
	(workspace_id, automation_id, version, status, schema_version, definition, created_by,
	 activated_by, activated_at)
SELECT a.workspace_id, a.id, 1, 'active', 1, app.builtin_flow_definition(a.key), a.updated_by,
	NULL, now()
FROM app.automations a
WHERE a.origin = 'builtin'
	AND a.active_version_id IS NULL
	AND app.builtin_flow_definition(a.key) IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM app.automation_versions v
		WHERE v.workspace_id = a.workspace_id AND v.automation_id = a.id
	);

UPDATE app.automations a
SET active_version_id = v.id
FROM app.automation_versions v
WHERE a.active_version_id IS NULL
	AND v.workspace_id = a.workspace_id
	AND v.automation_id = a.id
	AND v.status = 'active';

UPDATE app.automation_runs r
SET automation_id = a.id
FROM app.automations a
WHERE r.automation_id IS NULL
	AND a.workspace_id = r.workspace_id
	AND a.key = r.automation_key;

UPDATE app.automation_runs r
SET status = CASE r.outcome WHEN 'queued' THEN 'completed' ELSE 'skipped' END,
	finished_at = r.created_at
WHERE r.outcome IS NOT NULL AND r.finished_at IS NULL;

UPDATE app.automation_runs r
SET version_id = a.active_version_id
FROM app.automations a
WHERE r.outcome IS NOT NULL
	AND r.version_id IS NULL
	AND a.workspace_id = r.workspace_id
	AND a.id = r.automation_id
	AND a.active_version_id IS NOT NULL;

-- A queued run's occurrence is the third part of its job's dedupe key
-- (<lead>:<key>:<occurrence>), where the job is still there; one run per
-- occurrence at most, as the new unique index requires.
UPDATE app.automation_runs r
SET occurrence = s.occurrence
FROM (
	SELECT DISTINCT ON (x.workspace_id, x.automation_key, x.lead_id, split_part(j.dedupe_key, ':', 3))
		x.id, split_part(j.dedupe_key, ':', 3) AS occurrence
	FROM app.automation_runs x
	JOIN app.outbox_jobs j ON j.workspace_id = x.workspace_id AND j.id = x.job_id
	WHERE x.outcome = 'queued'
		AND x.occurrence IS NULL
		AND split_part(j.dedupe_key, ':', 3) <> ''
		AND char_length(split_part(j.dedupe_key, ':', 3)) <= 200
	ORDER BY x.workspace_id, x.automation_key, x.lead_id, split_part(j.dedupe_key, ':', 3), x.created_at, x.id
) s
WHERE r.id = s.id
	AND NOT EXISTS (
		SELECT 1 FROM app.automation_runs o
		WHERE o.workspace_id = r.workspace_id
			AND o.automation_key = r.automation_key
			AND o.lead_id = r.lead_id
			AND o.occurrence = s.occurrence
	);

-- 0018's pruning, except that automation runs go 90 days after they finish
-- (a waiting run is never pruned) and fired or void timers 90 days after
-- they ended. Still the caller's own tenant only, at most 1000 rows per table
-- per call. This replacement is the statement the owner pastes by hand
-- (docs/RUNBOOKS/database.md), OWNER PASTE.
-- >>> OWNER PASTE: this CREATE OR REPLACE FUNCTION statement (down to
-- $function$;) is the one the owner pastes by hand in the SQL editor when
-- the rest goes through the Supabase tool, which asks for a confirmation on
-- a function body with DELETEs (docs/RUNBOOKS/database.md, 0020).
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

	-- Automation runs 90 days after they finish; a waiting run is never
	-- pruned. Their step runs and their resumed or cancelled waits go with
	-- them by cascade.
	DELETE FROM app.automation_runs r WHERE r.ctid IN (
		SELECT x.ctid FROM app.automation_runs x
		WHERE x.workspace_id = p_workspace_id AND x.status <> 'waiting'
			AND coalesce(x.finished_at, x.created_at) < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_runs'; deleted := n; RETURN NEXT;

	-- Fired and void automation timers 90 days after they ended.
	DELETE FROM app.automation_timers t WHERE t.ctid IN (
		SELECT x.ctid FROM app.automation_timers x
		WHERE x.workspace_id = p_workspace_id AND x.status IN ('fired', 'void')
			AND x.updated_at < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_timers'; deleted := n; RETURN NEXT;

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
SELECT 'c91f1c89269e3e1fa63110fc594d1f250b72d884889000ad5e7af4a19aadcd1b', 1793450665432
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793450665432);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'd0358cece7c5ae47cd3b4072ff12426999752400fb64597e0d216dd45c753cd8', 1793450690795
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793450690795);
-- now() is fixed for the whole transaction, so the second version is one
-- second later: the two rows need distinct versions.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0019_automation_flows',
       ARRAY['-- applied by hand from packages/db/drizzle/0019_automation_flows.sql; see docs/RUNBOOKS/manual/0019-0020-automation-flows.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0019_automation_flows'
);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char((now() + interval '1 second') at time zone 'utc', 'YYYYMMDDHH24MISS'), '0020_automation_flows_runtime',
       ARRAY['-- applied by hand from packages/db/drizzle/0020_automation_flows_runtime.sql; see docs/RUNBOOKS/manual/0019-0020-automation-flows.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0020_automation_flows_runtime'
);

COMMIT;

-- Verification, one select at a time.

-- 1. Expect four rows, each true, true (row security on and forced):
-- automation_step_runs, automation_timers, automation_versions,
-- automation_waits.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.relnamespace = 'app'::regnamespace
  AND c.relname IN ('automation_step_runs', 'automation_timers', 'automation_versions', 'automation_waits')
ORDER BY c.relname;

-- 2. Expect eight rows: <table>_backup_reader_read (SELECT, backup_reader)
-- and <table>_tenant_policy (ALL, app_runtime) for each of the four.
SELECT tablename, policyname, cmd, roles FROM pg_policies
WHERE schemaname = 'app'
  AND tablename IN ('automation_step_runs', 'automation_timers', 'automation_versions', 'automation_waits')
ORDER BY tablename, policyname;

-- 3. Expect 42: one backup_reader read policy per RLS table in app (every
-- app table but workspaces).
SELECT count(*) FROM pg_policies
WHERE schemaname = 'app' AND policyname LIKE '%\_backup\_reader\_read' AND 'backup_reader' = ANY (roles);

-- 4. Expect five rows. runtime_select, runtime_insert and backup_select true
-- and runtime_delete false on every one; runtime_update (table-wide) true on
-- automation_timers, automation_versions and automation_waits, false on
-- automation_runs (column grants, select 4b) and automation_step_runs.
SELECT t.table_name,
       has_table_privilege('app_runtime', 'app.' || t.table_name, 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.' || t.table_name, 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.' || t.table_name, 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.' || t.table_name, 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.' || t.table_name, 'SELECT') AS backup_select
FROM (VALUES ('automation_runs'), ('automation_step_runs'), ('automation_timers'),
             ('automation_versions'), ('automation_waits')) AS t(table_name)
ORDER BY t.table_name;

-- 4b. Expect five rows, the columns of automation_runs app_runtime may
-- update: detail, finished_at, reason, status, updated_at.
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'automation_runs'
  AND has_column_privilege('app_runtime', 'app.automation_runs', column_name, 'UPDATE')
ORDER BY column_name;

-- 5. Expect seven rows: automation_runs_automation_key_check (the shape
-- '^[a-z][a-z0-9_]{2,63}$'), automation_runs_outcome_check (null or queued
-- or skipped), automation_runs_reason_check (null or the shape
-- '^[a-z][a-z0-9_]{0,63}$'), automations_key_check (builtin with the six
-- keys, or custom matching '^flow_[a-z0-9]{16}$'), automations_name_check
-- (null only for a built-in, else 1 to 80 characters), and
-- email_template_versions_key_check and email_templates_key_check (the nine
-- keys, or '^tpl_[a-z0-9]{16}$').
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace = 'app'::regnamespace
  AND conname IN ('automation_runs_automation_key_check', 'automation_runs_outcome_check',
                  'automation_runs_reason_check', 'automations_key_check', 'automations_name_check',
                  'email_template_versions_key_check', 'email_templates_key_check')
ORDER BY conname;

-- 6. Expect one row: automations_active_version_fk, FOREIGN KEY
-- (workspace_id, active_version_id) REFERENCES app.automation_versions(workspace_id, id).
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE connamespace = 'app'::regnamespace AND conname = 'automations_active_version_fk';

-- 7. Expect one row: automation_versions_definition_guard, enabled (O).
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'app.automation_versions'::regclass AND NOT tgisinternal;

-- 8. Expect four rows: builtin_flow_definition false, builtin_flow_name
-- false, guard_automation_version_definition false,
-- record_staff_notification_email true (SECURITY DEFINER).
SELECT p.proname, p.prosecdef FROM pg_proc p
WHERE p.pronamespace = 'app'::regnamespace
  AND p.proname IN ('builtin_flow_definition', 'builtin_flow_name',
                    'guard_automation_version_definition', 'record_staff_notification_email')
ORDER BY p.proname;

-- 9. Expect one row: true, true, true, true (the prune function names
-- automation_timers, keeps waiting runs, still names tracking_challenges and
-- is still SECURITY DEFINER).
SELECT p.prosrc LIKE '%app.automation_timers%' AS prunes_automation_timers,
       p.prosrc LIKE '%status <> ''waiting''%' AS keeps_waiting_runs,
       p.prosrc LIKE '%app.tracking_challenges%' AS prunes_tracking_challenges,
       p.prosecdef AS security_definer
FROM pg_proc p
WHERE p.pronamespace = 'app'::regnamespace AND p.proname = 'prune_operational_rows';

-- 10. Expect one row: 0, 0, 0 (every built-in row has a name and an active
-- version, and every phase 4 run has finished; on production all three
-- tables were empty).
SELECT (SELECT count(*) FROM app.automations WHERE origin = 'builtin' AND name IS NULL) AS unnamed,
       (SELECT count(*) FROM app.automations WHERE active_version_id IS NULL) AS without_version,
       (SELECT count(*) FROM app.automation_runs WHERE outcome IS NOT NULL AND finished_at IS NULL) AS unfinished_legacy_runs;

-- 11. Expect two rows: the hashes and `when` values in the header.
SELECT hash, created_at FROM drizzle.__drizzle_migrations
WHERE created_at IN (1793450665432, 1793450690795)
ORDER BY created_at;

-- ---------------------------------------------------------------------------
-- >>> OWNER PASTE (only when the plain statements above went through the
-- Supabase tool instead of the BEGIN ... COMMIT block): the replacement of
-- app.prune_operational_rows, as in 0020, then select 9 again.
-- ---------------------------------------------------------------------------
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

	-- Automation runs 90 days after they finish; a waiting run is never
	-- pruned. Their step runs and their resumed or cancelled waits go with
	-- them by cascade.
	DELETE FROM app.automation_runs r WHERE r.ctid IN (
		SELECT x.ctid FROM app.automation_runs x
		WHERE x.workspace_id = p_workspace_id AND x.status <> 'waiting'
			AND coalesce(x.finished_at, x.created_at) < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_runs'; deleted := n; RETURN NEXT;

	-- Fired and void automation timers 90 days after they ended.
	DELETE FROM app.automation_timers t WHERE t.ctid IN (
		SELECT x.ctid FROM app.automation_timers x
		WHERE x.workspace_id = p_workspace_id AND x.status IN ('fired', 'void')
			AND x.updated_at < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_timers'; deleted := n; RETURN NEXT;

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
