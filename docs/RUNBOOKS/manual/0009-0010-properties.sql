-- Migrations 0009 and 0010 by hand, for when the Supabase tool's confirm
-- prompt cannot be answered (0009 has ALTER TABLE on app.leads, 0010 has
-- ALTER, GRANT and a CREATE FUNCTION). Paste everything from BEGIN to COMMIT
-- into Supabase → SQL Editor → Run, once, as postgres. It is one
-- transaction: either all of it lands, all four tracker rows included, or
-- none of it. Then run the verification selects at the end, one at a time
-- (the SQL editor shows only the last result set of a run;
-- docs/RUNBOOKS/database.md, 0009 + 0010).
--
-- Additive only: three new tables and one new column with a default, so it
-- can go in before the code that reads them. Drizzle hashes (sha256 of each
-- file) and journal `when` values:
--   0009_properties          fc29a234e9726f0af4aa523a011d67f148203fed528de8794e8a81a4c7c18aaf  1793296569722
--   0010_properties_runtime  2ae0e451305f7110cb3262f086535e09f484fb844da2b020c9d090321544815f  1793296580888
BEGIN;

-- ---------------------------------------------------------------------------
-- 0009_properties (generated from packages/db/src/schema.ts)
-- ---------------------------------------------------------------------------
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
ALTER TABLE "app"."properties" ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE "app"."property_layouts" ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE "app"."saved_views" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."leads" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "app"."properties" ADD CONSTRAINT "properties_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."property_layouts" ADD CONSTRAINT "property_layouts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."saved_views" ADD CONSTRAINT "saved_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "app"."saved_views" ADD CONSTRAINT "saved_views_workspace_actor_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "app"."memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "saved_views_owner_name_unique" ON "app"."saved_views" USING btree ("workspace_id","actor_id","object",lower("name"));
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_custom_values_check" CHECK (jsonb_typeof("app"."leads"."custom_values") = 'object');
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
    )::uuid is not null);
CREATE POLICY "properties_backup_reader_read" ON "app"."properties" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
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
    )::uuid is not null);
CREATE POLICY "property_layouts_backup_reader_read" ON "app"."property_layouts" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);
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
    )::uuid);
CREATE POLICY "saved_views_backup_reader_read" ON "app"."saved_views" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);

-- ---------------------------------------------------------------------------
-- 0010_properties_runtime
-- ---------------------------------------------------------------------------
-- Hand-written companion to 0009_properties: FORCE RLS, the runtime grants
-- and the guard on property identity (AGENTS.md rule 3). backup_reader needs
-- no grant here: 0007's default privileges make every new app table readable,
-- and each table's read policy comes from schema.ts in 0009.

ALTER TABLE "app"."properties" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."property_layouts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."saved_views" FORCE ROW LEVEL SECURITY;

-- No DELETE on properties: a custom property is tombstoned with deleted_at
-- and its key stays reserved by the unique (workspace_id, object, key).
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."properties" TO app_runtime;
-- A layout is replaced in place, never removed.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."property_layouts" TO app_runtime;
-- A person's own views; the owner policy limits every statement to them.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."saved_views" TO app_runtime;

-- A property's identity is fixed once created: its site, object, key, kind
-- and origin never change (stored values are read by key and kind), a
-- tombstone is permanent, and a built-in override can be hidden but never
-- tombstoned (the built-in itself lives in code).
CREATE OR REPLACE FUNCTION "app"."guard_property_identity"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.object IS DISTINCT FROM OLD.object
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'property_identity_locked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'property_tombstone_permanent' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.origin = 'builtin' AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'builtin_property_not_deletable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "properties_identity_guard"
BEFORE UPDATE ON "app"."properties"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_property_identity"();

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'fc29a234e9726f0af4aa523a011d67f148203fed528de8794e8a81a4c7c18aaf', 1793296569722
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793296569722);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '2ae0e451305f7110cb3262f086535e09f484fb844da2b020c9d090321544815f', 1793296580888
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793296580888);
-- now() is fixed for the whole transaction, so the second version is one
-- second later: the two rows need distinct versions.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0009_properties',
       ARRAY['-- applied by hand from packages/db/drizzle/0009_properties.sql; see docs/RUNBOOKS/manual/0009-0010-properties.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0009_properties'
);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char((now() + interval '1 second') at time zone 'utc', 'YYYYMMDDHH24MISS'), '0010_properties_runtime',
       ARRAY['-- applied by hand from packages/db/drizzle/0010_properties_runtime.sql; see docs/RUNBOOKS/manual/0009-0010-properties.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0010_properties_runtime'
);

COMMIT;

-- Verification, one select at a time.

-- 1. Expect three rows, each with row security on and forced (true, true).
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.relnamespace = 'app'::regnamespace
  AND c.relname IN ('properties', 'property_layouts', 'saved_views')
ORDER BY c.relname;

-- 2. Expect six rows: properties_backup_reader_read, properties_tenant_policy,
-- property_layouts_backup_reader_read, property_layouts_tenant_policy,
-- saved_views_backup_reader_read, saved_views_owner_policy.
SELECT tablename, policyname FROM pg_policies
WHERE schemaname = 'app' AND tablename IN ('properties', 'property_layouts', 'saved_views')
ORDER BY tablename, policyname;

-- 3. Expect 28: one backup_reader read policy per RLS table in app (every
-- app table but workspaces).
SELECT count(*) FROM pg_policies
WHERE schemaname = 'app' AND policyname LIKE '%\_backup\_reader\_read' AND 'backup_reader' = ANY (roles);

-- 4. Expect app_runtime: properties t t t f, property_layouts t t t f,
-- saved_views t t t t (select, insert, update, delete); and backup_reader
-- can read all three (the last column true).
SELECT t.name,
       has_table_privilege('app_runtime', format('app.%I', t.name), 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', format('app.%I', t.name), 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', format('app.%I', t.name), 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', format('app.%I', t.name), 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', format('app.%I', t.name), 'SELECT') AS backup_select
FROM unnest(ARRAY['properties', 'property_layouts', 'saved_views']) AS t(name)
ORDER BY t.name;

-- 5. Expect one row: properties_identity_guard, enabled ('O').
SELECT tgname, tgenabled FROM pg_trigger
WHERE tgrelid = 'app.properties'::regclass AND NOT tgisinternal;

-- 6. Expect one row: '{}'::jsonb, NO, and the check leads_custom_values_check
-- present (true).
SELECT column_default, is_nullable,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'app.leads'::regclass AND conname = 'leads_custom_values_check'
       ) AS has_check
FROM information_schema.columns
WHERE table_schema = 'app' AND table_name = 'leads' AND column_name = 'custom_values';
