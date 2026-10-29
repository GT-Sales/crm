CREATE TABLE "app"."properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object" text NOT NULL,
	"key" text NOT NULL,
	"origin" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"staff_only" boolean DEFAULT false NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"lead_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "properties_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "properties_workspace_object_key_unique" UNIQUE("workspace_id","object","key"),
	CONSTRAINT "properties_object_check" CHECK ("app"."properties"."object" in ('lead', 'plan')),
	CONSTRAINT "properties_key_check" CHECK ("app"."properties"."key" ~ '^[a-z][A-Za-z0-9_]{0,63}$'),
	CONSTRAINT "properties_origin_check" CHECK ("app"."properties"."origin" in ('builtin', 'custom')),
	CONSTRAINT "properties_label_check" CHECK (length("app"."properties"."label") between 1 and 80),
	CONSTRAINT "properties_kind_check" CHECK ("app"."properties"."kind" in ('text', 'longText', 'number', 'money', 'date', 'dateTime', 'count', 'yesNo', 'choice', 'email', 'phone', 'url')),
	CONSTRAINT "properties_options_check" CHECK (jsonb_typeof("app"."properties"."options") = 'array')
);
--> statement-breakpoint
ALTER TABLE "app"."properties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."property_layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object" text NOT NULL,
	"lead_type" text DEFAULT '' NOT NULL,
	"layout" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "property_layouts_workspace_object_lead_type_unique" UNIQUE("workspace_id","object","lead_type"),
	CONSTRAINT "property_layouts_object_check" CHECK ("app"."property_layouts"."object" in ('lead', 'plan')),
	CONSTRAINT "property_layouts_lead_type_check" CHECK ("app"."property_layouts"."lead_type" ~ '^[a-z0-9_]{0,64}$'),
	CONSTRAINT "property_layouts_layout_check" CHECK (jsonb_typeof("app"."property_layouts"."layout") = 'object')
);
--> statement-breakpoint
ALTER TABLE "app"."property_layouts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"object" text NOT NULL,
	"name" text NOT NULL,
	"state" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "saved_views_object_check" CHECK ("app"."saved_views"."object" in ('lead')),
	CONSTRAINT "saved_views_name_check" CHECK (length(btrim("app"."saved_views"."name")) between 1 and 60),
	CONSTRAINT "saved_views_state_check" CHECK (jsonb_typeof("app"."saved_views"."state") = 'object')
);
--> statement-breakpoint
ALTER TABLE "app"."saved_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."properties" ADD CONSTRAINT "properties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."property_layouts" ADD CONSTRAINT "property_layouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."saved_views" ADD CONSTRAINT "saved_views_workspace_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "app"."memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_owner_name_unique" ON "app"."saved_views" USING btree ("workspace_id","actor_id","object",lower("name"));--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_custom_values_check" CHECK (jsonb_typeof("app"."leads"."custom_values") = 'object');--> statement-breakpoint
CREATE POLICY "properties_tenant_policy" ON "app"."properties" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."properties"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."properties"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "properties_backup_reader_read" ON "app"."properties" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
CREATE POLICY "property_layouts_tenant_policy" ON "app"."property_layouts" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."property_layouts"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."property_layouts"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "property_layouts_backup_reader_read" ON "app"."property_layouts" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
CREATE POLICY "saved_views_owner_policy" ON "app"."saved_views" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."saved_views"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."saved_views"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid) WITH CHECK ("app"."saved_views"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."saved_views"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid);--> statement-breakpoint
CREATE POLICY "saved_views_backup_reader_read" ON "app"."saved_views" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);