-- Hand-written companion to 0011_plans (AGENTS.md rule 3): FORCE RLS and the
-- runtime grants on app.plans, Get Canada Sim's six SIM plans, and the
-- sim_order stage clean-up (phase 3: `paid` and `invoiced` are no longer
-- stages; what they said moves to the order's payment status and carrier
-- commission). backup_reader needs no grant here: 0007's default privileges
-- make every new app table readable, and plans' read policy comes from
-- schema.ts in 0011. Every statement is safe to run twice.

ALTER TABLE "app"."plans" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- No DELETE: a plan that is no longer sold is made inactive, and the orders
-- that name it keep their own frozen copy.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."plans" TO app_runtime;
--> statement-breakpoint

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
--> statement-breakpoint

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
