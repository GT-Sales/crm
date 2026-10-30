-- Hand-written companion to 0015_order_numbers (AGENTS.md rule 3): FORCE RLS
-- and the runtime grants on app.site_counters. backup_reader needs no grant
-- here: 0007's default privileges make every new app table readable, and the
-- table's read policy comes from schema.ts in 0015. No data migration and no
-- pruning (one row per site and counter). Every statement is safe to run
-- twice.

ALTER TABLE "app"."site_counters" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- No DELETE: a counter only ever goes up, and its row goes with its site.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."site_counters" TO app_runtime;
