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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_step_runs_step_id_check" CHECK ("app"."automation_step_runs"."step_id" ~ '^[a-z0-9_]{1,40}$'),
	CONSTRAINT "automation_step_runs_step_kind_check" CHECK ("app"."automation_step_runs"."step_kind" in ('send_email', 'create_task', 'assign_lead', 'update_lead', 'notify_staff', 'if_else', 'wait')),
	CONSTRAINT "automation_step_runs_outcome_check" CHECK ("app"."automation_step_runs"."outcome" in ('done', 'skipped', 'failed', 'waiting', 'cancelled')),
	CONSTRAINT "automation_step_runs_branch_check" CHECK ("app"."automation_step_runs"."branch" is null or "app"."automation_step_runs"."branch" in ('yes', 'no')),
	CONSTRAINT "automation_step_runs_reason_check" CHECK ("app"."automation_step_runs"."reason" is null or "app"."automation_step_runs"."reason" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "automation_step_runs_detail_check" CHECK ("app"."automation_step_runs"."detail" is null or char_length("app"."automation_step_runs"."detail") <= 200)
);
--> statement-breakpoint
ALTER TABLE "app"."automation_step_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."automation_timers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."automation_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."automation_waits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_automation_key_check";--> statement-breakpoint
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_outcome_check";--> statement-breakpoint
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_reason_check";--> statement-breakpoint
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_skipped_reason_check";--> statement-breakpoint
ALTER TABLE "app"."automation_runs" DROP CONSTRAINT "automation_runs_queued_job_check";--> statement-breakpoint
ALTER TABLE "app"."automations" DROP CONSTRAINT "automations_key_check";--> statement-breakpoint
ALTER TABLE "app"."email_template_versions" DROP CONSTRAINT "email_template_versions_key_check";--> statement-breakpoint
ALTER TABLE "app"."email_templates" DROP CONSTRAINT "email_templates_key_check";--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ALTER COLUMN "outcome" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "status" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "occurrence" text;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "trigger_kind" text;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "origin" text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "active_version_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."email_templates" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "app"."email_templates" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD COLUMN "notification_email" text;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_workspace_id_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "app"."automation_step_runs" ADD CONSTRAINT "automation_step_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_step_runs" ADD CONSTRAINT "automation_step_runs_workspace_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."automation_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_timers" ADD CONSTRAINT "automation_timers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_timers" ADD CONSTRAINT "automation_timers_workspace_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "app"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_timers" ADD CONSTRAINT "automation_timers_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_versions" ADD CONSTRAINT "automation_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_versions" ADD CONSTRAINT "automation_versions_workspace_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "app"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_waits" ADD CONSTRAINT "automation_waits_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_waits" ADD CONSTRAINT "automation_waits_workspace_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "app"."automation_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_step_runs_workspace_run_created_idx" ON "app"."automation_step_runs" USING btree ("workspace_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "automation_timers_workspace_status_due_idx" ON "app"."automation_timers" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_one_draft" ON "app"."automation_versions" USING btree ("workspace_id","automation_id") WHERE "app"."automation_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "automation_versions_one_active" ON "app"."automation_versions" USING btree ("workspace_id","automation_id") WHERE "app"."automation_versions"."status" = 'active';--> statement-breakpoint
CREATE INDEX "automation_waits_workspace_status_resume_idx" ON "app"."automation_waits" USING btree ("workspace_id","status","resume_at");--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_automation_fk" FOREIGN KEY ("workspace_id","automation_id") REFERENCES "app"."automations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_version_fk" FOREIGN KEY ("workspace_id","version_id") REFERENCES "app"."automation_versions"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "automation_runs_occurrence_unique" ON "app"."automation_runs" USING btree ("workspace_id","automation_key","lead_id","occurrence") WHERE "app"."automation_runs"."occurrence" is not null;--> statement-breakpoint
CREATE INDEX "automation_runs_workspace_automation_created_idx" ON "app"."automation_runs" USING btree ("workspace_id","automation_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_status_check" CHECK ("app"."automation_runs"."status" in ('waiting', 'completed', 'skipped', 'failed', 'cancelled'));--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_waiting_check" CHECK ("app"."automation_runs"."status" <> 'waiting' or "app"."automation_runs"."finished_at" is null);--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_depth_check" CHECK ("app"."automation_runs"."depth" between 0 and 3);--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_trigger_kind_check" CHECK ("app"."automation_runs"."trigger_kind" is null or "app"."automation_runs"."trigger_kind" in ('lead_submitted', 'stage_entered', 'time_in_stage', 'task_overdue', 'after_submitted'));--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_occurrence_check" CHECK ("app"."automation_runs"."occurrence" is null or char_length("app"."automation_runs"."occurrence") <= 200);--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_detail_check" CHECK ("app"."automation_runs"."detail" is null or char_length("app"."automation_runs"."detail") <= 200);--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_automation_key_check" CHECK ("app"."automation_runs"."automation_key" ~ '^[a-z][a-z0-9_]{2,63}$');--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_outcome_check" CHECK ("app"."automation_runs"."outcome" is null or "app"."automation_runs"."outcome" in ('queued', 'skipped'));--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_reason_check" CHECK ("app"."automation_runs"."reason" is null or "app"."automation_runs"."reason" ~ '^[a-z][a-z0-9_]{0,63}$');--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_skipped_reason_check" CHECK ("app"."automation_runs"."outcome" is distinct from 'skipped' or "app"."automation_runs"."reason" is not null);--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_queued_job_check" CHECK ("app"."automation_runs"."outcome" is distinct from 'queued' or "app"."automation_runs"."job_id" is not null);--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_origin_check" CHECK ("app"."automations"."origin" in ('builtin', 'custom'));--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_archived_check" CHECK ("app"."automations"."archived_at" is null or ("app"."automations"."origin" = 'custom' and not "app"."automations"."enabled"));--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_name_check" CHECK (("app"."automations"."name" is null and "app"."automations"."origin" = 'builtin') or ("app"."automations"."name" is not null and char_length(btrim("app"."automations"."name")) between 1 and 80));--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_description_check" CHECK ("app"."automations"."description" is null or char_length("app"."automations"."description") <= 500);--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_revision_check" CHECK ("app"."automations"."revision" >= 0);--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_key_check" CHECK (("app"."automations"."origin" = 'builtin' and "app"."automations"."key" in ('order_received', 'sim_order_information_needed', 'sim_order_dispatched', 'sim_order_activated', 'sim_order_cancelled', 'mobility_activated')) or ("app"."automations"."origin" = 'custom' and "app"."automations"."key" ~ '^flow_[a-z0-9]{16}$'));--> statement-breakpoint
ALTER TABLE "app"."email_template_versions" ADD CONSTRAINT "email_template_versions_key_check" CHECK ("app"."email_template_versions"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected') or "app"."email_template_versions"."key" ~ '^tpl_[a-z0-9]{16}$');--> statement-breakpoint
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_name_check" CHECK (("app"."email_templates"."key" ~ '^tpl_') = ("app"."email_templates"."name" is not null) and ("app"."email_templates"."name" is null or (char_length("app"."email_templates"."name") between 1 and 80 and "app"."email_templates"."name" = btrim("app"."email_templates"."name"))));--> statement-breakpoint
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_archived_check" CHECK ("app"."email_templates"."archived_at" is null or "app"."email_templates"."key" ~ '^tpl_');--> statement-breakpoint
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_key_check" CHECK ("app"."email_templates"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected') or "app"."email_templates"."key" ~ '^tpl_[a-z0-9]{16}$');--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_notification_email_check" CHECK ("app"."memberships"."notification_email" is null or (char_length("app"."memberships"."notification_email") <= 254 and "app"."memberships"."notification_email" ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'));--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "automation_step_runs_backup_reader_read" ON "app"."automation_step_runs" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "automation_timers_backup_reader_read" ON "app"."automation_timers" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "automation_versions_backup_reader_read" ON "app"."automation_versions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "automation_waits_backup_reader_read" ON "app"."automation_waits" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);