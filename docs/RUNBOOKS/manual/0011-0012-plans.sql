-- Migrations 0011 and 0012 by hand, for when the Supabase tool's confirm
-- prompt cannot be answered (0011 has ALTER TABLE on app.leads and
-- app.properties, 0012 has ALTER, GRANT and an UPDATE of every sim_order
-- lead). Paste everything from BEGIN to COMMIT into Supabase -> SQL Editor
-- -> Run, once, as postgres. It is one transaction: either all of it lands,
-- all four tracker rows included, or none of it.
--
-- Order of work (docs/RUNBOOKS/database.md, 0011 + 0012):
--   1. the pre-check (A) and the reconciliation (B) below, one at a time;
--      write down B's rows: they are the "before" counts;
--   2. BEGIN ... COMMIT;
--   3. the verification selects at the end, one at a time (the SQL editor
--      shows only the last result set of a run), then B again: the "after"
--      counts.
-- Apply this before deploying a backend that reads plans or order_details,
-- and before the next Get Canada Sim import run (the updated script writes
-- order_details).
--
-- Additive except for the sim_order data migration in 0012: one new table,
-- two new columns with constant defaults, six seeded plans, and every
-- sim_order lead given its order_details, `paid` -> `pending`, `invoiced` ->
-- `completed`, one timeline entry per moved lead. Drizzle hashes (sha256 of
-- each file) and journal `when` values:
--   0011_plans          ce21f737d78ea05f0c3ccd46dbe86d76aff29a01bee10b1a997095770e524ca0  1793326396341
--   0012_plans_runtime  e243ef2f8914f732d0357f88f2b3e97661354b6b3d803d4cba66f9e24e1c36ff  1793326400817

-- A. Pre-check. Expect one row: plans_table null, order_details_column
-- false, website_visible_column false, tracker_rows 0, getcanadasim true.
SELECT to_regclass('app.plans') AS plans_table,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'leads' AND column_name = 'order_details'
       ) AS order_details_column,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'app' AND table_name = 'properties' AND column_name = 'website_visible'
       ) AS website_visible_column,
       (SELECT count(*) FROM drizzle.__drizzle_migrations
        WHERE created_at IN (1793326396341, 1793326400817)) AS tracker_rows,
       EXISTS (SELECT 1 FROM app.workspaces WHERE slug = 'getcanadasim') AS getcanadasim;

-- B. Reconciliation, run before and after: sim_order leads per site, stage
-- and payment status, archived and restricted included (payment_status is
-- null before, since order_details does not exist yet; to_jsonb keeps the
-- same query valid on both sides). Production on 2026-10-30, before:
-- incomplete 23 (11 archived), pending 59 (25 archived), verified 1,
-- delivered 1, activated 8, completed 13, cancelled 14 (8 archived), paid 20;
-- 139 in all. Expected after: incomplete/pending 23, pending/pending 59,
-- pending/paid 20, verified/paid 1, delivered/paid 1, activated/paid 8,
-- completed/paid 13, cancelled/not_needed 14; no `paid` or `invoiced` stage,
-- no null payment_status, the same 139 and the same archived counts.
SELECT w.slug,
       l.stage,
       to_jsonb(l) -> 'order_details' ->> 'paymentStatus' AS payment_status,
       count(*) AS leads,
       count(*) FILTER (WHERE l.deleted_at IS NOT NULL) AS archived,
       count(*) FILTER (WHERE l.customer_data_restricted_at IS NOT NULL) AS restricted
FROM app.leads l
JOIN app.workspaces w ON w.id = l.workspace_id
WHERE l.lead_type = 'sim_order'
GROUP BY w.slug, l.stage, payment_status
ORDER BY w.slug, l.stage, payment_status;

BEGIN;

-- ---------------------------------------------------------------------------
-- 0011_plans (generated from packages/db/src/schema.ts)
-- ---------------------------------------------------------------------------
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
ALTER TABLE "app"."plans" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app"."leads" ADD COLUMN "order_details" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "app"."properties" ADD COLUMN "website_visible" boolean DEFAULT false NOT NULL;
ALTER TABLE "app"."plans" ADD CONSTRAINT "plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "plans_workspace_type_name_unique" ON "app"."plans" USING btree ("workspace_id","lead_type",lower("name"));
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_order_details_check" CHECK (jsonb_typeof("app"."leads"."order_details") = 'object');
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
    )::uuid is not null);
CREATE POLICY "plans_backup_reader_read" ON "app"."plans" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);

-- ---------------------------------------------------------------------------
-- 0012_plans_runtime
-- ---------------------------------------------------------------------------
-- Hand-written companion to 0011_plans (AGENTS.md rule 3): FORCE RLS and the
-- runtime grants on app.plans, Get Canada Sim's six SIM plans, and the
-- sim_order stage clean-up (phase 3: `paid` and `invoiced` are no longer
-- stages; what they said moves to the order's payment status and carrier
-- commission). backup_reader needs no grant here: 0007's default privileges
-- make every new app table readable, and plans' read policy comes from
-- schema.ts in 0011. Every statement is safe to run twice.

ALTER TABLE "app"."plans" FORCE ROW LEVEL SECURITY;

-- No DELETE: a plan that is no longer sold is made inactive, and the orders
-- that name it keep their own frozen copy.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."plans" TO app_runtime;

-- Get Canada Sim's plans as its website sells them today (contracts
-- SIM_PLANS: the labels are the names, the price is the label's dollars in
-- cents, monthly, paid before activation), for the getcanadasim site when it
-- exists. A plan of the same name (any case) is left as it is.
INSERT INTO "app"."plans" (
  "workspace_id", "lead_type", "name", "price_minor", "billing_period",
  "payment_required", "active", "position"
)
SELECT w."id", 'sim_order', p."name", p."price_minor", 'month', true, true, p."position"
FROM "app"."workspaces" AS w
CROSS JOIN (
  VALUES
    ('Unlimited Data · $50, Rogers', 5000, 0),
    ('Unlimited Data · $40, Rogers', 4000, 1),
    ('75GB · $35, Fido', 3500, 2),
    ('90GB · $40, Chatr', 4000, 3),
    ('50GB · $35, Chatr', 3500, 4),
    ('75GB · $75, Chatr', 7500, 5)
) AS p("name", "price_minor", "position")
WHERE w."slug" = 'getcanadasim'
ON CONFLICT ("workspace_id", "lead_type", lower("name")) DO NOTHING;

-- Every sim_order lead (archived and restricted ones included) gets its
-- order: no plan link yet, quantity 1, the payment status its stage implies
-- and the carrier commission the old admin recorded (`commissionStatus` in
-- the form; `invoiced` for an invoiced order). Then `paid` becomes `pending`
-- and `invoiced` becomes `completed`, and each lead so moved gets one system
-- entry on its timeline saying so. A lead that already has an order is
-- skipped, so a second run changes nothing. `updated_at` is kept: this is
-- not anyone working the lead. The entry is by the legacy-import actor
-- (contracts LEGACY_IMPORT_ACTOR_ID, shown as "Old admin"): the timeline
-- needs an actor, and the Get Canada Sim import does not count that actor's
-- entries as work done in the CRM, so later import runs still update these
-- leads. Every other lead type keeps order_details '{}'.
WITH "mapped" AS (
  UPDATE "app"."leads" AS l
  SET
    "order_details" = jsonb_build_object(
      'planId', null,
      'plan', null,
      'quantity', 1,
      'paymentStatus', CASE
        WHEN previous."stage" IN ('paid', 'verified', 'delivered', 'activated', 'completed', 'invoiced')
          THEN 'paid'
        WHEN previous."stage" IN ('cancelled', 'on_hold') THEN 'not_needed'
        ELSE 'pending'
      END,
      'carrierCommission', CASE
        WHEN previous."stage" = 'invoiced' THEN 'invoiced'
        ELSE CASE previous."payload" -> 'payload' ->> 'commissionStatus'
          WHEN 'invoiced' THEN 'invoiced'
          WHEN 'commission_received' THEN 'received'
          WHEN 'claw_back' THEN 'clawback'
          ELSE 'not_yet'
        END
      END
    ),
    "stage" = CASE previous."stage"
      WHEN 'paid' THEN 'pending'
      WHEN 'invoiced' THEN 'completed'
      ELSE previous."stage"
    END
  FROM "app"."leads" AS previous
  WHERE previous."workspace_id" = l."workspace_id"
    AND previous."id" = l."id"
    AND l."lead_type" = 'sim_order'
    AND l."order_details" = '{}'::jsonb
  RETURNING l."workspace_id", l."id", previous."stage" AS "previous_stage"
)
INSERT INTO "app"."lead_activities" ("workspace_id", "lead_id", "actor_id", "kind", "body", "data")
SELECT
  m."workspace_id",
  m."id",
  '00000000-0000-4000-8000-00000000a001'::uuid,
  'system',
  CASE m."previous_stage"
    WHEN 'paid' THEN 'Stage Paid became Pending; payment status set to Paid (phase 3 migration)'
    ELSE 'Stage Invoiced became Completed; carrier commission set to Invoiced (phase 3 migration)'
  END,
  '{"migration":"0012"}'::jsonb
FROM "mapped" AS m
WHERE m."previous_stage" IN ('paid', 'invoiced');

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'ce21f737d78ea05f0c3ccd46dbe86d76aff29a01bee10b1a997095770e524ca0', 1793326396341
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793326396341);
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'e243ef2f8914f732d0357f88f2b3e97661354b6b3d803d4cba66f9e24e1c36ff', 1793326400817
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793326400817);
-- now() is fixed for the whole transaction, so the second version is one
-- second later: the two rows need distinct versions.
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0011_plans',
       ARRAY['-- applied by hand from packages/db/drizzle/0011_plans.sql; see docs/RUNBOOKS/manual/0011-0012-plans.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0011_plans'
);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char((now() + interval '1 second') at time zone 'utc', 'YYYYMMDDHH24MISS'), '0012_plans_runtime',
       ARRAY['-- applied by hand from packages/db/drizzle/0012_plans_runtime.sql; see docs/RUNBOOKS/manual/0011-0012-plans.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0012_plans_runtime'
);

COMMIT;

-- Verification, one select at a time; then B again (the "after" counts).

-- 1. Expect one row: plans, true, true (row security on and forced).
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c
WHERE c.relnamespace = 'app'::regnamespace AND c.relname = 'plans';

-- 2. Expect two rows: plans_backup_reader_read, plans_tenant_policy.
SELECT policyname FROM pg_policies
WHERE schemaname = 'app' AND tablename = 'plans'
ORDER BY policyname;

-- 3. Expect 29: one backup_reader read policy per RLS table in app (every
-- app table but workspaces).
SELECT count(*) FROM pg_policies
WHERE schemaname = 'app' AND policyname LIKE '%\_backup\_reader\_read' AND 'backup_reader' = ANY (roles);

-- 4. Expect one row: t t t f t (app_runtime select, insert, update, no
-- delete; backup_reader select).
SELECT has_table_privilege('app_runtime', 'app.plans', 'SELECT') AS runtime_select,
       has_table_privilege('app_runtime', 'app.plans', 'INSERT') AS runtime_insert,
       has_table_privilege('app_runtime', 'app.plans', 'UPDATE') AS runtime_update,
       has_table_privilege('app_runtime', 'app.plans', 'DELETE') AS runtime_delete,
       has_table_privilege('backup_reader', 'app.plans', 'SELECT') AS backup_select;

-- 5. Expect two rows: leads.order_details '{}'::jsonb NO with its check
-- (true), properties.website_visible false NO (no check: false).
SELECT table_name, column_name, column_default, is_nullable,
       EXISTS (
         SELECT 1 FROM pg_constraint
         WHERE conrelid = 'app.leads'::regclass AND conname = 'leads_order_details_check'
       ) AND column_name = 'order_details' AS has_check
FROM information_schema.columns
WHERE table_schema = 'app'
  AND (table_name, column_name) IN (('leads', 'order_details'), ('properties', 'website_visible'))
ORDER BY table_name;

-- 6. Expect six rows for getcanadasim, positions 0-5: Unlimited Data · $50,
-- Rogers 5000; Unlimited Data · $40, Rogers 4000; 75GB · $35, Fido 3500;
-- 90GB · $40, Chatr 4000; 50GB · $35, Chatr 3500; 75GB · $75, Chatr 7500;
-- all sim_order, CAD, month, payment required, active.
SELECT w.slug, p.position, p.name, p.price_minor, p.lead_type, p.currency, p.billing_period,
       p.payment_required, p.active
FROM app.plans p JOIN app.workspaces w ON w.id = p.workspace_id
ORDER BY w.slug, p.position;

-- 7. Expect one row: moved 20 (the timeline entries: 20 "Stage Paid became
-- Pending", 0 Invoiced), sim_order_without_payment_status 0,
-- old_stages_left 0, other_leads_with_order_details 0.
SELECT
  (SELECT count(*) FROM app.lead_activities
   WHERE kind = 'system' AND data ->> 'migration' = '0012') AS moved,
  (SELECT count(*) FROM app.lead_activities
   WHERE kind = 'system' AND data ->> 'migration' = '0012'
     AND body LIKE 'Stage Invoiced%') AS moved_from_invoiced,
  (SELECT count(*) FROM app.leads
   WHERE lead_type = 'sim_order' AND NOT order_details ? 'paymentStatus') AS sim_order_without_payment_status,
  (SELECT count(*) FROM app.leads
   WHERE lead_type = 'sim_order' AND stage IN ('paid', 'invoiced')) AS old_stages_left,
  (SELECT count(*) FROM app.leads
   WHERE lead_type <> 'sim_order' AND order_details <> '{}'::jsonb) AS other_leads_with_order_details;
