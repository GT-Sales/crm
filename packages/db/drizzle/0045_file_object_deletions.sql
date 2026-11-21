CREATE TABLE "app"."file_object_deletions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"file_id" uuid,
	"reason" text NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_object_deletions_reason_check" CHECK ("app"."file_object_deletions"."reason" in ('staging_after_attach', 'upload_rejected', 'upload_expired', 'file_deleted', 'backfill')),
	CONSTRAINT "file_object_deletions_outcome_check" CHECK (("app"."file_object_deletions"."completed_at" is null and "app"."file_object_deletions"."outcome" is null) or ("app"."file_object_deletions"."completed_at" is not null and "app"."file_object_deletions"."outcome" in ('deleted', 'kept_referenced'))),
	CONSTRAINT "file_object_deletions_attempts_check" CHECK ("app"."file_object_deletions"."attempts" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."file_object_deletions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."file_object_deletions" ADD CONSTRAINT "file_object_deletions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "file_object_deletions_object_unique" ON "app"."file_object_deletions" USING btree ("workspace_id","bucket","object_key");--> statement-breakpoint
CREATE INDEX "file_object_deletions_due_idx" ON "app"."file_object_deletions" USING btree ("workspace_id","not_before") WHERE "app"."file_object_deletions"."completed_at" is null;--> statement-breakpoint
CREATE INDEX "file_revisions_object_key_idx" ON "app"."file_revisions" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "files_candidate_key_idx" ON "app"."files" USING btree ("candidate_key") WHERE "app"."files"."candidate_key" is not null;--> statement-breakpoint
CREATE POLICY "file_object_deletions_tenant_policy" ON "app"."file_object_deletions" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."file_object_deletions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."file_object_deletions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "file_object_deletions_backup_reader_read" ON "app"."file_object_deletions" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
-- Hand-written part (AGENTS.md rule 3), kept with the generated table as 0040
-- does: FORCE RLS and the runtime grants for the pending deletions of
-- document objects (#82, #108). The tenant policy and the backup read policy
-- come from schema.ts above; backup_reader needs no grant here, 0007's
-- default privileges make every new app table readable.
--
-- The runtime role enqueues (INSERT … ON CONFLICT), claims and completes rows
-- (SELECT, UPDATE). There is no DELETE: a completed row stays as the record
-- that its object is gone, so the backfill never enqueues it again, and rows
-- go only with their site, by the foreign key's cascade.
--
-- Live-database impact: a new empty table, plus two plain indexes on
-- app.files (candidate_key, partial) and app.file_revisions (object_key).
-- CREATE INDEX holds a SHARE lock on each table while it builds, blocking
-- writes to it (reads go on); at the current few thousand file rows that is
-- well under a second. No existing row is changed: the leftovers of earlier
-- files are enqueued later, a bounded batch per document_cleanup run.
ALTER TABLE "app"."file_object_deletions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."file_object_deletions" TO app_runtime;