-- Hand-written companion to 0034_ai_conversations (AGENTS.md rule 3): FORCE
-- RLS and the runtime grants for Ask AI's saved chat. Each table's owner policy
-- and backup read policy come from schema.ts in 0034, and backup_reader needs
-- no grant here: 0007's default privileges make every new app table readable.
--
-- Nothing here changes app.prune_operational_rows: a conversation, its
-- messages and its sent files are kept until the member deletes them, and an
-- unsent file is swept by the backend together with its stored object (a
-- blind delete here would leave the object behind). ai_turns keeps its 90-day
-- pruning; its new input_tokens column needs no grant (runtime already has
-- SELECT, INSERT on the table).

ALTER TABLE "app"."ai_conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."ai_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."ai_attachments" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- A member's own conversations; the owner policy limits every statement to them.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."ai_conversations" TO app_runtime;
--> statement-breakpoint
-- A message is written once and never edited. It is removed only with its
-- conversation, by the foreign key's cascade, which Postgres runs as the
-- table's owner: the runtime role needs no DELETE for it.
GRANT SELECT, INSERT ON TABLE "app"."ai_messages" TO app_runtime;
--> statement-breakpoint
-- A file is created pending, made ready and linked to its message (UPDATE),
-- and an unsent one may be removed by its member or the daily sweep (DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."ai_attachments" TO app_runtime;
