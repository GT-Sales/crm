-- Issue #81: one current file per record and document type. A file is
-- current when it is attached (`available`), not replaced
-- (`superseded_by_file_id` null) and not held for a customer's change
-- request. Two attaches of one slot that overlapped could both stay current,
-- and the documents check (any current file approved) and tracking (the
-- newest) then read different files. The backend now supersedes under a
-- per-slot lock before a file becomes current; this migration reconciles the
-- duplicates already stored and makes the database refuse new ones.
--
-- Owner decision, 21 Nov 2026: the NEWEST UPLOAD WINS (created_at, then
-- revision, then id, newest first). Each older current file of the slot is
-- marked superseded by it. An approval is never carried over: if the newest
-- has no approving review, the documents check holds the order until staff
-- review it, and it is in the review queue meanwhile. Superseded files keep
-- their objects, as every superseded file does today.
--
-- A file of a restricted lead cannot be changed except to a tombstone
-- (app.guard_restricted_file, 0001), so an older duplicate there is
-- tombstoned instead; the data_retention task would tombstone it anyway, and
-- 0045's cleanup backfill deletes its objects.
--
-- Idempotent: once no slot holds two current files the updates match no row,
-- and the index is created only if it is missing.
--
-- Live-database impact: the two UPDATEs read the current files once (a few
-- thousand rows) and write only the duplicates; then CREATE UNIQUE INDEX holds
-- a SHARE lock on app.files while it builds, so uploads, reviews and
-- deletions wait for it (reads go on): well under a second at today's size.
-- Apply it AFTER deploying the backend that supersedes before attaching: an
-- older backend makes a file current first and would then be refused by the
-- index (a finalize or an import answering 500) instead of storing a
-- duplicate.
WITH ranked AS (
  SELECT f.workspace_id, f.id,
    first_value(f.id) OVER slot AS winner,
    row_number() OVER slot AS place
  FROM app.files f
  WHERE f.status = 'available' AND f.superseded_by_file_id IS NULL
    AND NOT f.held_for_change_request
  WINDOW slot AS (
    PARTITION BY f.workspace_id, f.record_type, f.record_id, f.document_type
    ORDER BY f.created_at DESC, f.revision DESC, f.id DESC
  )
)
UPDATE app.files AS f
SET superseded_by_file_id = r.winner, updated_at = now()
FROM ranked AS r
WHERE f.workspace_id = r.workspace_id AND f.id = r.id AND r.place > 1
  AND NOT (f.record_type = 'lead' AND app.lead_restricted(f.workspace_id, f.record_id));
--> statement-breakpoint
WITH ranked AS (
  SELECT f.workspace_id, f.id,
    row_number() OVER slot AS place
  FROM app.files f
  WHERE f.status = 'available' AND f.superseded_by_file_id IS NULL
    AND NOT f.held_for_change_request
  WINDOW slot AS (
    PARTITION BY f.workspace_id, f.record_type, f.record_id, f.document_type
    ORDER BY f.created_at DESC, f.revision DESC, f.id DESC
  )
)
UPDATE app.files AS f
SET status = 'deleted', deleted_at = now(), updated_at = now()
FROM ranked AS r
WHERE f.workspace_id = r.workspace_id AND f.id = r.id AND r.place > 1
  AND f.record_type = 'lead' AND app.lead_restricted(f.workspace_id, f.record_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "files_one_current_per_slot" ON "app"."files" USING btree ("workspace_id","record_type","record_id","document_type") WHERE "app"."files"."status" = 'available' and "app"."files"."superseded_by_file_id" is null and not "app"."files"."held_for_change_request";
