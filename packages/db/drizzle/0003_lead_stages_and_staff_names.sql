ALTER TABLE "app"."leads" ADD COLUMN "stage" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD COLUMN "display_name" text;--> statement-breakpoint
CREATE INDEX "email_messages_workspace_lead_idx" ON "app"."email_messages" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE INDEX "follow_up_schedules_workspace_lead_idx" ON "app"."follow_up_schedules" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE INDEX "lead_tasks_workspace_assignee_status_due_idx" ON "app"."lead_tasks" USING btree ("workspace_id","assigned_actor_id","status","due_at");--> statement-breakpoint
CREATE INDEX "leads_workspace_type_stage_idx" ON "app"."leads" USING btree ("workspace_id","lead_type","stage","updated_at");--> statement-breakpoint
CREATE INDEX "leads_contact_id_idx" ON "app"."leads" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "marketing_consents_workspace_lead_idx" ON "app"."marketing_consents" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE INDEX "outbox_job_alerts_workspace_job_idx" ON "app"."outbox_job_alerts" USING btree ("workspace_id","job_id");--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_stage_check" CHECK ("app"."leads"."stage" ~ '^[a-z0-9_]{1,64}$');--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_display_name_check" CHECK ("app"."memberships"."display_name" is null or (char_length("app"."memberships"."display_name") between 1 and 80 and "app"."memberships"."display_name" = btrim("app"."memberships"."display_name")));