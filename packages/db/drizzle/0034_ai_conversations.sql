CREATE TABLE "app"."ai_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"kind" text NOT NULL,
	"media_type" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text,
	"bucket" text NOT NULL,
	"object_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"extracted_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_attachments_kind_check" CHECK (("app"."ai_attachments"."kind" = 'image' and "app"."ai_attachments"."media_type" in ('image/png', 'image/jpeg', 'image/webp')) or ("app"."ai_attachments"."kind" = 'pdf' and "app"."ai_attachments"."media_type" = 'application/pdf') or ("app"."ai_attachments"."kind" = 'text' and "app"."ai_attachments"."media_type" in ('text/plain', 'text/csv', 'text/markdown'))),
	CONSTRAINT "ai_attachments_file_name_check" CHECK (length(btrim("app"."ai_attachments"."file_name")) between 1 and 200 and length("app"."ai_attachments"."file_name") <= 200 and "app"."ai_attachments"."file_name" !~ '[[:cntrl:]/\\]'),
	CONSTRAINT "ai_attachments_byte_size_check" CHECK ("app"."ai_attachments"."byte_size" > 0 and "app"."ai_attachments"."byte_size" <= case "app"."ai_attachments"."kind" when 'image' then 5242880 when 'pdf' then 10485760 else 524288 end),
	CONSTRAINT "ai_attachments_sha256_check" CHECK ("app"."ai_attachments"."sha256" is null or "app"."ai_attachments"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ai_attachments_storage_check" CHECK (length("app"."ai_attachments"."bucket") between 1 and 100 and length("app"."ai_attachments"."object_key") between 1 and 300),
	CONSTRAINT "ai_attachments_status_check" CHECK ("app"."ai_attachments"."status" in ('pending', 'ready')),
	CONSTRAINT "ai_attachments_ready_check" CHECK ("app"."ai_attachments"."status" = 'pending' or "app"."ai_attachments"."sha256" is not null),
	CONSTRAINT "ai_attachments_extracted_text_check" CHECK ("app"."ai_attachments"."extracted_text" is null or ("app"."ai_attachments"."kind" = 'text' and "app"."ai_attachments"."status" = 'ready' and length("app"."ai_attachments"."extracted_text") <= 20000)),
	CONSTRAINT "ai_attachments_link_check" CHECK (("app"."ai_attachments"."conversation_id" is null) = ("app"."ai_attachments"."message_id" is null) and ("app"."ai_attachments"."message_id" is null or "app"."ai_attachments"."status" = 'ready'))
);
--> statement-breakpoint
ALTER TABLE "app"."ai_attachments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."ai_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_workspace_actor_id_unique" UNIQUE("workspace_id","actor_id","id"),
	CONSTRAINT "ai_conversations_title_check" CHECK (length(btrim("app"."ai_conversations"."title")) between 1 and 120 and length("app"."ai_conversations"."title") <= 120 and "app"."ai_conversations"."title" !~ '[[:cntrl:]]')
);
--> statement-breakpoint
ALTER TABLE "app"."ai_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"role" text NOT NULL,
	"text" text NOT NULL,
	"outcome" text NOT NULL,
	"error_code" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follow_up" jsonb,
	"expired_drafts" integer DEFAULT 0 NOT NULL,
	"request_id" uuid,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "ai_messages_workspace_conversation_id_unique" UNIQUE("workspace_id","conversation_id","id"),
	CONSTRAINT "ai_messages_role_check" CHECK ("app"."ai_messages"."role" in ('user', 'assistant')),
	CONSTRAINT "ai_messages_text_check" CHECK (length("app"."ai_messages"."text") <= 20000),
	CONSTRAINT "ai_messages_outcome_check" CHECK (("app"."ai_messages"."role" = 'user' and "app"."ai_messages"."outcome" = 'completed') or ("app"."ai_messages"."role" = 'assistant' and "app"."ai_messages"."outcome" in ('completed', 'failed', 'cancelled', 'access_lost'))),
	CONSTRAINT "ai_messages_error_code_check" CHECK ("app"."ai_messages"."error_code" is null or ("app"."ai_messages"."role" = 'assistant' and "app"."ai_messages"."error_code" ~ '^[a-z][a-z0-9_]{0,59}$')),
	CONSTRAINT "ai_messages_sources_check" CHECK (jsonb_typeof("app"."ai_messages"."sources") = 'array' and octet_length("app"."ai_messages"."sources"::text) <= 131072),
	CONSTRAINT "ai_messages_follow_up_check" CHECK ("app"."ai_messages"."follow_up" is null or (jsonb_typeof("app"."ai_messages"."follow_up") = 'object' and octet_length("app"."ai_messages"."follow_up"::text) <= 16384)),
	CONSTRAINT "ai_messages_expired_drafts_check" CHECK ("app"."ai_messages"."expired_drafts" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "app"."ai_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_turns" DROP CONSTRAINT "ai_turns_counts_check";--> statement-breakpoint
ALTER TABLE "app"."ai_turns" ADD COLUMN "input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_attachments" ADD CONSTRAINT "ai_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_attachments" ADD CONSTRAINT "ai_attachments_conversation_fk" FOREIGN KEY ("workspace_id","actor_id","conversation_id") REFERENCES "app"."ai_conversations"("workspace_id","actor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_attachments" ADD CONSTRAINT "ai_attachments_message_fk" FOREIGN KEY ("workspace_id","conversation_id","message_id") REFERENCES "app"."ai_messages"("workspace_id","conversation_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_conversations" ADD CONSTRAINT "ai_conversations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_messages" ADD CONSTRAINT "ai_messages_conversation_fk" FOREIGN KEY ("workspace_id","actor_id","conversation_id") REFERENCES "app"."ai_conversations"("workspace_id","actor_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_attachments_owner_created_idx" ON "app"."ai_attachments" USING btree ("workspace_id","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_attachments_message_idx" ON "app"."ai_attachments" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "ai_conversations_owner_recent_idx" ON "app"."ai_conversations" USING btree ("workspace_id","actor_id","last_message_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_messages_request_unique" ON "app"."ai_messages" USING btree ("workspace_id","conversation_id","request_id","role") WHERE "app"."ai_messages"."request_id" is not null;--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_created_idx" ON "app"."ai_messages" USING btree ("workspace_id","conversation_id","created_at","id");--> statement-breakpoint
ALTER TABLE "app"."ai_turns" ADD CONSTRAINT "ai_turns_counts_check" CHECK ("app"."ai_turns"."duration_ms" >= 0 and "app"."ai_turns"."input_tokens" >= 0 and "app"."ai_turns"."output_tokens" >= 0 and "app"."ai_turns"."tool_calls" >= 0 and "app"."ai_turns"."records" >= 0 and "app"."ai_turns"."data_bytes" >= 0);--> statement-breakpoint
CREATE POLICY "ai_attachments_owner_policy" ON "app"."ai_attachments" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."ai_attachments"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_attachments"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid) WITH CHECK ("app"."ai_attachments"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_attachments"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid);--> statement-breakpoint
CREATE POLICY "ai_attachments_backup_reader_read" ON "app"."ai_attachments" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
CREATE POLICY "ai_conversations_owner_policy" ON "app"."ai_conversations" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."ai_conversations"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_conversations"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid) WITH CHECK ("app"."ai_conversations"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_conversations"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid);--> statement-breakpoint
CREATE POLICY "ai_conversations_backup_reader_read" ON "app"."ai_conversations" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);--> statement-breakpoint
CREATE POLICY "ai_messages_owner_policy" ON "app"."ai_messages" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."ai_messages"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_messages"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid) WITH CHECK ("app"."ai_messages"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and "app"."ai_messages"."actor_id" = nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid);--> statement-breakpoint
CREATE POLICY "ai_messages_backup_reader_read" ON "app"."ai_messages" AS PERMISSIVE FOR SELECT TO "backup_reader" USING (true);