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
	CONSTRAINT "change_requests_resolved_check" CHECK (("app"."change_requests"."status" = 'pending') = ("app"."change_requests"."resolved_at" is null and "app"."change_requests"."resolved_by" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."tracking_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."email_template_versions" DROP CONSTRAINT "email_template_versions_key_check";--> statement-breakpoint
ALTER TABLE "app"."email_templates" DROP CONSTRAINT "email_templates_key_check";--> statement-breakpoint
ALTER TABLE "app"."site_counters" DROP CONSTRAINT "site_counters_counter_check";--> statement-breakpoint
ALTER TABLE "app"."files" ADD COLUMN "held_for_change_request" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."change_requests" ADD CONSTRAINT "change_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."change_requests" ADD CONSTRAINT "change_requests_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."tracking_challenges" ADD CONSTRAINT "tracking_challenges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "change_requests_one_pending" ON "app"."change_requests" USING btree ("workspace_id","lead_id") WHERE "app"."change_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "change_requests_workspace_lead_created_idx" ON "app"."change_requests" USING btree ("workspace_id","lead_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "tracking_challenges_workspace_email_idx" ON "app"."tracking_challenges" USING btree ("workspace_id","email_hash","status","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "app"."email_template_versions" ADD CONSTRAINT "email_template_versions_key_check" CHECK ("app"."email_template_versions"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected'));--> statement-breakpoint
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_key_check" CHECK ("app"."email_templates"."key" in ('tracking_code', 'order_received', 'information_needed', 'dispatched', 'activated', 'cancelled', 'sim_number_ready', 'change_approved', 'change_rejected'));--> statement-breakpoint
ALTER TABLE "app"."site_counters" ADD CONSTRAINT "site_counters_counter_check" CHECK ("app"."site_counters"."counter" in ('sim_order_ref', 'change_request_no'));--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "change_requests_backup_reader_read" ON "app"."change_requests" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "tracking_challenges_backup_reader_read" ON "app"."tracking_challenges" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);