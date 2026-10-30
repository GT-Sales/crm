CREATE TABLE "app"."site_counters" (
	"workspace_id" uuid NOT NULL,
	"counter" text NOT NULL,
	"last_value" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_counters_workspace_id_counter_pk" PRIMARY KEY("workspace_id","counter"),
	CONSTRAINT "site_counters_counter_check" CHECK ("app"."site_counters"."counter" in ('sim_order_ref')),
	CONSTRAINT "site_counters_last_value_check" CHECK ("app"."site_counters"."last_value" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."site_counters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."site_counters" ADD CONSTRAINT "site_counters_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "site_counters_backup_reader_read" ON "app"."site_counters" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);