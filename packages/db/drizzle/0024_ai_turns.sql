CREATE TABLE "app"."ai_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"model" text,
	"prompt_version" integer NOT NULL,
	"outcome" text NOT NULL,
	"failure_code" text,
	"duration_ms" integer NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"records" integer DEFAULT 0 NOT NULL,
	"data_bytes" integer DEFAULT 0 NOT NULL,
	"recovered_draft" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_turns_outcome_check" CHECK ("app"."ai_turns"."outcome" in ('completed', 'cancelled', 'failed', 'access_lost')),
	CONSTRAINT "ai_turns_counts_check" CHECK ("app"."ai_turns"."duration_ms" >= 0 and "app"."ai_turns"."output_tokens" >= 0 and "app"."ai_turns"."tool_calls" >= 0 and "app"."ai_turns"."records" >= 0 and "app"."ai_turns"."data_bytes" >= 0),
	CONSTRAINT "ai_turns_text_check" CHECK (length("app"."ai_turns"."engine") <= 20 and length(coalesce("app"."ai_turns"."model", '')) <= 200 and length(coalesce("app"."ai_turns"."failure_code", '')) <= 60)
);
--> statement-breakpoint
ALTER TABLE "app"."ai_turns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_turns" ADD CONSTRAINT "ai_turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_turns_workspace_created_idx" ON "app"."ai_turns" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE POLICY "ai_turns_tenant_policy" ON "app"."ai_turns" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."ai_turns"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."ai_turns"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "ai_turns_backup_reader_read" ON "app"."ai_turns" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);