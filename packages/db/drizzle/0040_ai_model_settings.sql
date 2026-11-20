CREATE TABLE "app"."ai_model_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"allowed_models" jsonb NOT NULL,
	"default_model" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_settings_allowed_models_check" CHECK (jsonb_typeof("app"."ai_model_settings"."allowed_models") = 'array' and jsonb_array_length("app"."ai_model_settings"."allowed_models") between 1 and 8 and octet_length("app"."ai_model_settings"."allowed_models"::text) <= 4096),
	CONSTRAINT "ai_model_settings_default_model_check" CHECK (length("app"."ai_model_settings"."default_model") between 1 and 120 and "app"."ai_model_settings"."allowed_models" @> jsonb_build_array(jsonb_build_object('id', "app"."ai_model_settings"."default_model")))
);
--> statement-breakpoint
ALTER TABLE "app"."ai_model_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_model_settings" ADD CONSTRAINT "ai_model_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "ai_model_settings_tenant_policy" ON "app"."ai_model_settings" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."ai_model_settings"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."ai_model_settings"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "ai_model_settings_backup_reader_read" ON "app"."ai_model_settings" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
-- Hand-written part (AGENTS.md rule 3): FORCE RLS and the runtime grants for
-- the per-site Ask AI model settings, in the same file as the generated table,
-- as 0039 keeps its functions with its column. The tenant policy and the
-- backup read policy come from schema.ts above, and backup_reader needs no
-- grant here: 0007's default privileges make every new app table readable.
--
-- The owner's save is an upsert (INSERT … ON CONFLICT DO UPDATE), so the
-- runtime role needs SELECT, INSERT and UPDATE. There is no DELETE: a site's
-- row goes only with the site, by the foreign key's cascade. Nothing here
-- changes app.prune_operational_rows: the row is configuration, not a record.
ALTER TABLE "app"."ai_model_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."ai_model_settings" TO app_runtime;
