ALTER TABLE "app"."ai_messages" ADD COLUMN "effort" text;--> statement-breakpoint
ALTER TABLE "app"."ai_turns" ADD COLUMN "effort" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_messages" ADD CONSTRAINT "ai_messages_effort_check" CHECK ("app"."ai_messages"."effort" is null or "app"."ai_messages"."effort" in ('normal', 'high'));--> statement-breakpoint
ALTER TABLE "app"."ai_turns" ADD CONSTRAINT "ai_turns_effort_check" CHECK ("app"."ai_turns"."effort" in ('normal', 'high'));