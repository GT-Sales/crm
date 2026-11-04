CREATE TABLE "app"."ai_automation_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"digest" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_automation_proposals_size_check" CHECK (octet_length("app"."ai_automation_proposals"."payload"::text) <= 100000)
);
--> statement-breakpoint
ALTER TABLE "app"."ai_automation_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_automation_proposals" ADD CONSTRAINT "ai_automation_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_automation_proposals_expiry_idx" ON "app"."ai_automation_proposals" USING btree ("expires_at");--> statement-breakpoint
CREATE POLICY "ai_automation_proposals_owner_policy" ON "app"."ai_automation_proposals" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."ai_automation_proposals"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_automation_proposals"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid) WITH CHECK ("app"."ai_automation_proposals"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_automation_proposals"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid);--> statement-breakpoint
CREATE POLICY "ai_automation_proposals_backup_reader_read" ON "app"."ai_automation_proposals" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);