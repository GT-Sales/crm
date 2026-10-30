CREATE TABLE "app"."plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_type" text NOT NULL,
	"name" text NOT NULL,
	"price_minor" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'CAD' NOT NULL,
	"billing_period" text DEFAULT 'month' NOT NULL,
	"payment_required" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"required_documents" text[] DEFAULT '{}'::text[] NOT NULL,
	"custom_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "plans_lead_type_check" CHECK ("app"."plans"."lead_type" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "plans_name_check" CHECK (length(btrim("app"."plans"."name")) between 1 and 120),
	CONSTRAINT "plans_price_minor_check" CHECK ("app"."plans"."price_minor" >= 0),
	CONSTRAINT "plans_currency_check" CHECK ("app"."plans"."currency" = 'CAD'),
	CONSTRAINT "plans_billing_period_check" CHECK ("app"."plans"."billing_period" in ('one_time', 'month', '30_days', '90_days', 'year')),
	CONSTRAINT "plans_custom_values_check" CHECK (jsonb_typeof("app"."plans"."custom_values") = 'object')
);
--> statement-breakpoint
ALTER TABLE "app"."plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."leads" ADD COLUMN "order_details" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."properties" ADD COLUMN "website_visible" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."plans" ADD CONSTRAINT "plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plans_workspace_type_name_unique" ON "app"."plans" USING btree ("workspace_id","lead_type",lower("name"));--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_order_details_check" CHECK (jsonb_typeof("app"."leads"."order_details") = 'object');--> statement-breakpoint
CREATE POLICY "plans_tenant_policy" ON "app"."plans" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."plans"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."plans"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "plans_backup_reader_read" ON "app"."plans" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);