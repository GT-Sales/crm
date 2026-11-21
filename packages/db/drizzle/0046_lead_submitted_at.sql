ALTER TABLE "app"."leads" ADD COLUMN IF NOT EXISTS "submitted_at" timestamp with time zone;
--> statement-breakpoint
-- Hand-written part (issue #94): when each lead already submitted was
-- submitted, for the customer's order tracking. Owner decision, 21 Nov 2026:
-- the recorded `submitted` timeline entry where one exists (the website's
-- submission, or staff rescuing the checkout), otherwise the creation date.
-- An imported legacy order has no such entry and so keeps its original date
-- (the import writes the old order's date as `created_at`). The generated ADD
-- COLUMN above was given IF NOT EXISTS so the file can be run again.
--
-- Idempotent: only rows still without a date are filled, so a second run
-- changes nothing. It touches `submitted_at` alone: `updated_at` (the inbox
-- order) stays as it was, the 0041 mirror fires only on a change of `status`,
-- and app.guard_restricted_lead does not watch this column, so restricted
-- leads take their date too.
--
-- Live-database impact: ADD COLUMN of a nullable column with no default only
-- changes the catalogue (no rewrite). The UPDATE rewrites each submitted lead
-- once and holds those row locks until it commits; at the current few
-- thousand leads, with the earliest entry found through
-- lead_activities_workspace_lead_created_idx, that is well under a second, so
-- it runs as one statement rather than in batches. A website submit or staff
-- edit of one of those leads waits for it.
UPDATE "app"."leads" AS l
SET "submitted_at" = coalesce(
  (
    SELECT min(a."created_at")
    FROM "app"."lead_activities" AS a
    WHERE a."workspace_id" = l."workspace_id"
      AND a."lead_id" = l."id"
      AND a."kind" = 'system'
      AND a."data" ->> 'event' = 'submitted'
  ),
  l."created_at"
)
WHERE l."status" = 'submitted' AND l."submitted_at" IS NULL;
