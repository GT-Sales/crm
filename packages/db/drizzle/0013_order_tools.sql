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
--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."automations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."email_template_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."email_templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."idempotency_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
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
--> statement-breakpoint
ALTER TABLE "app"."workspace_email_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."email_messages" ADD COLUMN "template_version" integer;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automation_runs" ADD CONSTRAINT "automation_runs_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."automations" ADD CONSTRAINT "automations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_template_versions" ADD CONSTRAINT "email_template_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_templates" ADD CONSTRAINT "email_templates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workspace_email_settings" ADD CONSTRAINT "workspace_email_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automation_runs_workspace_key_created_idx" ON "app"."automation_runs" USING btree ("workspace_id","automation_key","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idempotency_keys_workspace_created_idx" ON "app"."idempotency_keys" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "app"."email_messages" ADD CONSTRAINT "email_messages_template_version_check" CHECK ("app"."email_messages"."template_version" is null or "app"."email_messages"."template_version" >= 0);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "automation_runs_backup_reader_read" ON "app"."automation_runs" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "automations_backup_reader_read" ON "app"."automations" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "email_template_versions_backup_reader_read" ON "app"."email_template_versions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "email_templates_backup_reader_read" ON "app"."email_templates" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "idempotency_keys_backup_reader_read" ON "app"."idempotency_keys" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "workspace_email_settings_backup_reader_read" ON "app"."workspace_email_settings" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);