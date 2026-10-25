-- The backend's restricted runtime role. Created here, before any policy names
-- it, with no password: the owner sets one out of band (never in a migration),
-- so the role cannot log in until then. NOBYPASSRLS and non-ownership of every
-- table are what make the row-level policies below binding.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
		CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
	END IF;
END
$$;
--> statement-breakpoint
ALTER ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
--> statement-breakpoint
CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TYPE "app"."membership_type" AS ENUM('staff');--> statement-breakpoint
CREATE TYPE "app"."permission_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "app"."permission_name" AS ENUM('document_download', 'financial_data', 'bulk_export', 'deletion', 'invoice_approval', 'integration_management');--> statement-breakpoint
CREATE TYPE "app"."role_name" AS ENUM('owner', 'leads', 'orders', 'partners', 'finance', 'content', 'viewer');--> statement-breakpoint
CREATE TABLE "app"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"request_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"phone" text,
	"country_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_email_unique" UNIQUE("email"),
	CONSTRAINT "contacts_email_normalized_check" CHECK ("app"."contacts"."email" = lower(btrim("app"."contacts"."email")) and position('@' in "app"."contacts"."email") > 1)
);
--> statement-breakpoint
ALTER TABLE "app"."contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."deleted_email_messages" (
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"provider" text,
	"provider_account" text,
	"provider_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_email_messages_workspace_message_unique" UNIQUE("workspace_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "app"."deleted_email_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."draft_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_grants_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."draft_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."email_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"template" text NOT NULL,
	"message_class" text NOT NULL,
	"lead_id" uuid,
	"contact_hash" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"provider_id" text,
	"provider" text,
	"provider_account" text,
	"last_error_code" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_messages_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "email_messages_workspace_message_id_unique" UNIQUE("workspace_id","message_id"),
	CONSTRAINT "email_messages_provider_id_unique" UNIQUE("workspace_id","provider","provider_account","provider_id"),
	CONSTRAINT "email_messages_class_check" CHECK ("app"."email_messages"."message_class" in ('transactional', 'marketing')),
	CONSTRAINT "email_messages_status_check" CHECK ("app"."email_messages"."status" in ('queued', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'uncertain')),
	CONSTRAINT "email_messages_provider_pair_check" CHECK (("app"."email_messages"."provider" is null) = ("app"."email_messages"."provider_account" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."email_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."email_provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider_event_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account" text NOT NULL,
	"event_type" text NOT NULL,
	"message_id" uuid,
	"contact_hash" text,
	"received_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_provider_events_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "email_provider_events_workspace_provider_event_unique" UNIQUE("workspace_id","provider","provider_account","provider_event_id"),
	CONSTRAINT "email_provider_events_type_check" CHECK ("app"."email_provider_events"."event_type" in ('delivered', 'bounce', 'complaint', 'reject'))
);
--> statement-breakpoint
ALTER TABLE "app"."email_provider_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."email_suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"contact_hash" text NOT NULL,
	"reason" text NOT NULL,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "email_suppressions_workspace_contact_reason_unique" UNIQUE("workspace_id","contact_hash","reason"),
	CONSTRAINT "email_suppressions_reason_check" CHECK ("app"."email_suppressions"."reason" in ('hard_bounce', 'complaint', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "app"."email_suppressions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."file_review_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_review_events_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "file_review_events_decision_check" CHECK ("app"."file_review_events"."decision" in ('approved', 'rejected')),
	CONSTRAINT "file_review_events_note_check" CHECK ("app"."file_review_events"."note" is null or char_length("app"."file_review_events"."note") between 1 and 2000)
);
--> statement-breakpoint
ALTER TABLE "app"."file_review_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."file_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"object_key" text NOT NULL,
	"detected_mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"checksum_sha256" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_revisions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "file_revisions_workspace_file_revision_unique" UNIQUE("workspace_id","file_id","revision"),
	CONSTRAINT "file_revisions_revision_positive_check" CHECK ("app"."file_revisions"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."file_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"record_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"bucket" text NOT NULL,
	"staging_key" text NOT NULL,
	"candidate_key" text,
	"object_key" text,
	"declared_content_type" text NOT NULL,
	"detected_mime" text,
	"declared_size_bytes" integer NOT NULL,
	"size_bytes" integer,
	"checksum_sha256" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"reject_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"superseded_by_file_id" uuid,
	"uploaded_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finalized_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "files_status_check" CHECK ("app"."files"."status" in ('uploading', 'verifying', 'available', 'rejected', 'deleted')),
	CONSTRAINT "files_record_type_check" CHECK ("app"."files"."record_type" in ('lead', 'order')),
	CONSTRAINT "files_content_type_check" CHECK ("app"."files"."declared_content_type" in ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "files_declared_size_check" CHECK ("app"."files"."declared_size_bytes" > 0),
	CONSTRAINT "files_size_check" CHECK ("app"."files"."size_bytes" is null or "app"."files"."size_bytes" >= 0),
	CONSTRAINT "files_revision_positive_check" CHECK ("app"."files"."revision" > 0),
	CONSTRAINT "files_available_provenance_check" CHECK ((
          "app"."files"."status" = 'available'
          and "app"."files"."object_key" is not null
          and "app"."files"."detected_mime" is not null
          and "app"."files"."checksum_sha256" is not null
          and "app"."files"."size_bytes" is not null
        ) or (
          "app"."files"."status" <> 'available'
        ))
);
--> statement-breakpoint
ALTER TABLE "app"."files" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."follow_up_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"template" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"cancelled_reason" text,
	"cancelled_by_actor_id" uuid,
	"sent_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_up_schedules_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "follow_up_schedules_status_check" CHECK ("app"."follow_up_schedules"."status" in ('scheduled', 'sent', 'cancelled', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "app"."follow_up_schedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."lead_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_activities_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "lead_activities_kind_check" CHECK ("app"."lead_activities"."kind" in ('note', 'status_change', 'assignment', 'email', 'call', 'edit', 'document', 'merge', 'system')),
	CONSTRAINT "lead_activities_body_check" CHECK ("app"."lead_activities"."body" is null or char_length("app"."lead_activities"."body") between 1 and 4000)
);
--> statement-breakpoint
ALTER TABLE "app"."lead_activities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."lead_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"title" text NOT NULL,
	"due_at" timestamp with time zone,
	"assigned_actor_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_tasks_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "lead_tasks_title_check" CHECK (char_length("app"."lead_tasks"."title") between 1 and 200),
	CONSTRAINT "lead_tasks_status_check" CHECK ("app"."lead_tasks"."status" in ('open', 'done', 'cancelled')),
	CONSTRAINT "lead_tasks_completion_check" CHECK (("app"."lead_tasks"."status" = 'done') = ("app"."lead_tasks"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "app"."lead_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_type" text NOT NULL,
	"status" text NOT NULL,
	"full_name" text,
	"email" text,
	"phone" text,
	"country_code" text,
	"contact_id" uuid,
	"assigned_actor_id" uuid,
	"external_ref" text,
	"payload" jsonb,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consent_version" text NOT NULL,
	"customer_data_restricted_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "leads_status_check" CHECK ("app"."leads"."status" in ('incomplete', 'submitted')),
	CONSTRAINT "leads_lead_type_check" CHECK ("app"."leads"."lead_type" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "leads_external_ref_check" CHECK ("app"."leads"."external_ref" is null or char_length("app"."leads"."external_ref") between 1 and 128)
);
--> statement-breakpoint
ALTER TABLE "app"."leads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."marketing_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid,
	"contact_hash" text NOT NULL,
	"marketing_opt_in" boolean NOT NULL,
	"version" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "marketing_consents_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "marketing_consents_reference_check" CHECK ("app"."marketing_consents"."lead_id" is not null or ("app"."marketing_consents"."marketing_opt_in" = false and "app"."marketing_consents"."version" = 'retained-opt-out'))
);
--> statement-breakpoint
ALTER TABLE "app"."marketing_consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."membership_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"permission_id" uuid NOT NULL,
	"effect" "app"."permission_effect" DEFAULT 'allow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_permissions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "membership_permissions_workspace_membership_permission_unique" UNIQUE("workspace_id","membership_id","permission_id")
);
--> statement-breakpoint
ALTER TABLE "app"."membership_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."membership_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_roles_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "membership_roles_workspace_membership_role_unique" UNIQUE("workspace_id","membership_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "app"."membership_roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid,
	"invited_email" text,
	"membership_type" "app"."membership_type" NOT NULL,
	"status" text NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "memberships_workspace_id_user_id_unique" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "memberships_status_check" CHECK ("app"."memberships"."status" in ('pending', 'active', 'revoked')),
	CONSTRAINT "memberships_identity_state_check" CHECK ((
          "app"."memberships"."status" = 'pending'
          and "app"."memberships"."user_id" is null
          and "app"."memberships"."invited_email" is not null
        ) or (
          "app"."memberships"."status" = 'active'
          and "app"."memberships"."user_id" is not null
          and "app"."memberships"."invited_email" is null
        ) or "app"."memberships"."status" = 'revoked')
);
--> statement-breakpoint
ALTER TABLE "app"."memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."outbox_job_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"alert_code" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_job_alerts_workspace_id_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "app"."outbox_job_alerts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."outbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_type" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"message_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"lease_owner_id" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_attempt_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"uncertain_at" timestamp with time zone,
	"last_error_code" text,
	"provider_id" text,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_jobs_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "outbox_jobs_workspace_type_dedupe_unique" UNIQUE("workspace_id","job_type","dedupe_key"),
	CONSTRAINT "outbox_jobs_status_check" CHECK ("app"."outbox_jobs"."status" in ('pending', 'processing', 'completed', 'failed', 'uncertain')),
	CONSTRAINT "outbox_jobs_attempts_check" CHECK ("app"."outbox_jobs"."attempts" >= 0),
	CONSTRAINT "outbox_jobs_payload_version_check" CHECK ("app"."outbox_jobs"."payload_version" > 0),
	CONSTRAINT "outbox_jobs_lease_check" CHECK (("app"."outbox_jobs"."status" = 'processing' and "app"."outbox_jobs"."lease_owner_id" is not null and "app"."outbox_jobs"."lease_expires_at" is not null and "app"."outbox_jobs"."locked_at" is not null) or ("app"."outbox_jobs"."status" <> 'processing' and "app"."outbox_jobs"."lease_owner_id" is null and "app"."outbox_jobs"."lease_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "app"."outbox_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" "app"."permission_name" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permissions_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "permissions_workspace_id_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "app"."permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."rate_limit_buckets" (
	"bucket_key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_bucket_key_window_start_pk" PRIMARY KEY("bucket_key","window_start")
);
--> statement-breakpoint
ALTER TABLE "app"."rate_limit_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" "app"."role_name" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "roles_workspace_id_name_unique" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "app"."roles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."service_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" text[] DEFAULT array[]::text[] NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_credentials_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "service_credentials_secret_hash_unique" UNIQUE("secret_hash")
);
--> statement-breakpoint
ALTER TABLE "app"."service_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug"),
	CONSTRAINT "workspaces_slug_check" CHECK ("app"."workspaces"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "workspaces_status_check" CHECK ("app"."workspaces"."status" in ('active', 'paused'))
);
--> statement-breakpoint
ALTER TABLE "app"."audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."deleted_email_messages" ADD CONSTRAINT "deleted_email_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."draft_grants" ADD CONSTRAINT "draft_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."draft_grants" ADD CONSTRAINT "draft_grants_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_messages" ADD CONSTRAINT "email_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_messages" ADD CONSTRAINT "email_messages_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_provider_events" ADD CONSTRAINT "email_provider_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_suppressions" ADD CONSTRAINT "email_suppressions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."file_review_events" ADD CONSTRAINT "file_review_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."file_review_events" ADD CONSTRAINT "file_review_events_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "app"."files"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."file_revisions" ADD CONSTRAINT "file_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."file_revisions" ADD CONSTRAINT "file_revisions_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "app"."files"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."follow_up_schedules" ADD CONSTRAINT "follow_up_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."follow_up_schedules" ADD CONSTRAINT "follow_up_schedules_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_activities" ADD CONSTRAINT "lead_activities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_activities" ADD CONSTRAINT "lead_activities_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_tasks" ADD CONSTRAINT "lead_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_tasks" ADD CONSTRAINT "lead_tasks_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."leads" ADD CONSTRAINT "leads_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "app"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."marketing_consents" ADD CONSTRAINT "marketing_consents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."marketing_consents" ADD CONSTRAINT "marketing_consents_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_permissions" ADD CONSTRAINT "membership_permissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_permissions" ADD CONSTRAINT "membership_permissions_workspace_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "app"."memberships"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_permissions" ADD CONSTRAINT "membership_permissions_workspace_permission_fk" FOREIGN KEY ("workspace_id","permission_id") REFERENCES "app"."permissions"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_roles" ADD CONSTRAINT "membership_roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_roles" ADD CONSTRAINT "membership_roles_workspace_membership_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "app"."memberships"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_roles" ADD CONSTRAINT "membership_roles_workspace_role_fk" FOREIGN KEY ("workspace_id","role_id") REFERENCES "app"."roles"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox_job_alerts" ADD CONSTRAINT "outbox_job_alerts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox_job_alerts" ADD CONSTRAINT "outbox_job_alerts_workspace_job_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "app"."outbox_jobs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."outbox_jobs" ADD CONSTRAINT "outbox_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."permissions" ADD CONSTRAINT "permissions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."roles" ADD CONSTRAINT "roles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."service_credentials" ADD CONSTRAINT "service_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_workspace_id_created_at_idx" ON "app"."audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_id_entity_idx" ON "app"."audit_events" USING btree ("workspace_id","entity","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_id_request_id_idx" ON "app"."audit_events" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE INDEX "deleted_email_messages_provider_idx" ON "app"."deleted_email_messages" USING btree ("workspace_id","provider","provider_account","provider_id");--> statement-breakpoint
CREATE INDEX "draft_grants_workspace_id_lead_id_idx" ON "app"."draft_grants" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE INDEX "email_messages_workspace_status_idx" ON "app"."email_messages" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "email_messages_workspace_contact_hash_idx" ON "app"."email_messages" USING btree ("workspace_id","contact_hash");--> statement-breakpoint
CREATE INDEX "email_provider_events_workspace_message_idx" ON "app"."email_provider_events" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "email_suppressions_workspace_contact_hash_idx" ON "app"."email_suppressions" USING btree ("workspace_id","contact_hash");--> statement-breakpoint
CREATE INDEX "file_review_events_workspace_file_created_idx" ON "app"."file_review_events" USING btree ("workspace_id","file_id","created_at");--> statement-breakpoint
CREATE INDEX "file_revisions_workspace_file_idx" ON "app"."file_revisions" USING btree ("workspace_id","file_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "files_staging_key_unique" ON "app"."files" USING btree ("staging_key");--> statement-breakpoint
CREATE UNIQUE INDEX "files_object_key_unique" ON "app"."files" USING btree ("object_key") WHERE "app"."files"."object_key" is not null;--> statement-breakpoint
CREATE INDEX "files_workspace_record_idx" ON "app"."files" USING btree ("workspace_id","record_type","record_id","status");--> statement-breakpoint
CREATE INDEX "files_workspace_status_expires_idx" ON "app"."files" USING btree ("workspace_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "follow_up_schedules_workspace_due_idx" ON "app"."follow_up_schedules" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "lead_activities_workspace_lead_created_idx" ON "app"."lead_activities" USING btree ("workspace_id","lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_tasks_workspace_status_due_idx" ON "app"."lead_tasks" USING btree ("workspace_id","status","due_at");--> statement-breakpoint
CREATE INDEX "lead_tasks_workspace_lead_idx" ON "app"."lead_tasks" USING btree ("workspace_id","lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_workspace_type_external_ref_unique" ON "app"."leads" USING btree ("workspace_id","lead_type","external_ref") WHERE "app"."leads"."external_ref" is not null;--> statement-breakpoint
CREATE INDEX "leads_workspace_id_status_idx" ON "app"."leads" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "leads_workspace_id_updated_at_idx" ON "app"."leads" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "leads_workspace_id_lead_type_idx" ON "app"."leads" USING btree ("workspace_id","lead_type","updated_at");--> statement-breakpoint
CREATE INDEX "leads_workspace_id_contact_id_idx" ON "app"."leads" USING btree ("workspace_id","contact_id");--> statement-breakpoint
CREATE INDEX "leads_workspace_id_assigned_actor_idx" ON "app"."leads" USING btree ("workspace_id","assigned_actor_id");--> statement-breakpoint
CREATE INDEX "marketing_consents_workspace_contact_hash_idx" ON "app"."marketing_consents" USING btree ("workspace_id","contact_hash","captured_at");--> statement-breakpoint
CREATE INDEX "membership_permissions_workspace_id_permission_id_idx" ON "app"."membership_permissions" USING btree ("workspace_id","permission_id");--> statement-breakpoint
CREATE INDEX "membership_roles_workspace_id_role_id_idx" ON "app"."membership_roles" USING btree ("workspace_id","role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_workspace_pending_email_unique" ON "app"."memberships" USING btree ("workspace_id",lower("invited_email")) WHERE "app"."memberships"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "memberships_workspace_id_status_idx" ON "app"."memberships" USING btree ("workspace_id","status","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_id_status_workspace_id_idx" ON "app"."memberships" USING btree ("user_id","status","workspace_id");--> statement-breakpoint
CREATE INDEX "outbox_job_alerts_workspace_unresolved_idx" ON "app"."outbox_job_alerts" USING btree ("workspace_id","resolved_at","created_at");--> statement-breakpoint
CREATE INDEX "outbox_jobs_workspace_status_available_idx" ON "app"."outbox_jobs" USING btree ("workspace_id","status","available_at");--> statement-breakpoint
CREATE INDEX "rate_limit_buckets_expires_at_idx" ON "app"."rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "service_credentials_workspace_id_revoked_at_idx" ON "app"."service_credentials" USING btree ("workspace_id","revoked_at");--> statement-breakpoint
CREATE POLICY "audit_events_tenant_policy" ON "app"."audit_events" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."audit_events"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."audit_events"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "contacts_actor_policy" ON "app"."contacts" AS PERMISSIVE FOR ALL TO "app_runtime" USING (nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK (nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "deleted_email_messages_tenant_policy" ON "app"."deleted_email_messages" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."deleted_email_messages"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."deleted_email_messages"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "draft_grants_tenant_policy" ON "app"."draft_grants" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."draft_grants"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."draft_grants"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "email_messages_tenant_policy" ON "app"."email_messages" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."email_messages"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."email_messages"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "email_provider_events_tenant_policy" ON "app"."email_provider_events" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."email_provider_events"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."email_provider_events"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "email_suppressions_tenant_policy" ON "app"."email_suppressions" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."email_suppressions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."email_suppressions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "file_review_events_tenant_policy" ON "app"."file_review_events" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."file_review_events"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."file_review_events"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "file_revisions_tenant_policy" ON "app"."file_revisions" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."file_revisions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."file_revisions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "files_tenant_policy" ON "app"."files" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."files"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."files"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "follow_up_schedules_tenant_policy" ON "app"."follow_up_schedules" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."follow_up_schedules"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."follow_up_schedules"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "lead_activities_tenant_policy" ON "app"."lead_activities" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."lead_activities"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."lead_activities"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "lead_tasks_tenant_policy" ON "app"."lead_tasks" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."lead_tasks"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."lead_tasks"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "leads_tenant_policy" ON "app"."leads" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."leads"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."leads"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "marketing_consents_tenant_policy" ON "app"."marketing_consents" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."marketing_consents"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."marketing_consents"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "membership_permissions_tenant_policy" ON "app"."membership_permissions" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."membership_permissions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."membership_permissions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "membership_roles_tenant_policy" ON "app"."membership_roles" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."membership_roles"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."membership_roles"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "memberships_tenant_policy" ON "app"."memberships" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."memberships"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."memberships"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "outbox_job_alerts_tenant_policy" ON "app"."outbox_job_alerts" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."outbox_job_alerts"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."outbox_job_alerts"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "outbox_jobs_tenant_policy" ON "app"."outbox_jobs" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."outbox_jobs"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."outbox_jobs"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "permissions_tenant_policy" ON "app"."permissions" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."permissions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."permissions"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "roles_tenant_policy" ON "app"."roles" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."roles"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."roles"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint
CREATE POLICY "service_credentials_tenant_policy" ON "app"."service_credentials" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."service_credentials"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."service_credentials"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);