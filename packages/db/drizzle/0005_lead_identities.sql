CREATE TABLE "app"."lead_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"id_type" text NOT NULL,
	"file_id" uuid,
	"sin_sealed" text,
	"sin_last3" text,
	"date_of_birth" date,
	"credit_check_consent_at" timestamp with time zone NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_identities_workspace_id_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "lead_identities_id_type_check" CHECK ("app"."lead_identities"."id_type" in ('drivers_licence', 'sin')),
	CONSTRAINT "lead_identities_shape_check" CHECK ((
          "app"."lead_identities"."id_type" = 'drivers_licence'
          and "app"."lead_identities"."file_id" is not null
          and "app"."lead_identities"."sin_sealed" is null
          and "app"."lead_identities"."sin_last3" is null
          and "app"."lead_identities"."date_of_birth" is null
        ) or (
          "app"."lead_identities"."id_type" = 'sin'
          and "app"."lead_identities"."file_id" is null
          and "app"."lead_identities"."sin_sealed" is not null
          and "app"."lead_identities"."sin_last3" ~ '^[0-9]{3}$'
          and "app"."lead_identities"."date_of_birth" is not null
        ))
);
--> statement-breakpoint
ALTER TABLE "app"."lead_identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."files" DROP CONSTRAINT "files_content_type_check";--> statement-breakpoint
ALTER TABLE "app"."lead_identities" ADD CONSTRAINT "lead_identities_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "app"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_identities" ADD CONSTRAINT "lead_identities_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_id") REFERENCES "app"."leads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."lead_identities" ADD CONSTRAINT "lead_identities_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "app"."files"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lead_identities_workspace_lead_idx" ON "app"."lead_identities" USING btree ("workspace_id","lead_id","created_at");--> statement-breakpoint
CREATE INDEX "lead_identities_workspace_file_idx" ON "app"."lead_identities" USING btree ("workspace_id","file_id");--> statement-breakpoint
ALTER TABLE "app"."files" ADD CONSTRAINT "files_content_type_check" CHECK ("app"."files"."declared_content_type" in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp'));--> statement-breakpoint
CREATE POLICY "lead_identities_tenant_policy" ON "app"."lead_identities" AS PERMISSIVE FOR ALL TO "app_runtime" USING ("app"."lead_identities"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null) WITH CHECK ("app"."lead_identities"."workspace_id" = nullif(
      (select current_setting('app.workspace_id', true)),
      ''
    )::uuid and nullif(
      (select current_setting('app.actor_id', true)),
      ''
    )::uuid is not null);--> statement-breakpoint

-- Runtime access: read and add only. A correction is a new row; nothing the
-- runtime role does can rewrite or remove an identity on file.
ALTER TABLE "app"."lead_identities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "app"."lead_identities" TO app_runtime;
--> statement-breakpoint

-- No identity may be attached to a restricted lead (customer data erased).
CREATE OR REPLACE FUNCTION app.guard_restricted_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $f$
BEGIN
  IF app.lead_restricted(NEW.workspace_id, NEW.lead_id) THEN
    RAISE EXCEPTION 'customer_data_restricted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$f$;
--> statement-breakpoint
CREATE TRIGGER lead_identities_customer_restriction
BEFORE INSERT ON app.lead_identities
FOR EACH ROW EXECUTE FUNCTION app.guard_restricted_identity();
--> statement-breakpoint

-- Transitional, like 0002: until staff leave the old Get Canada Sim admin,
-- CanadaWide's ID step lands in its legacy table too, under the same id, so
-- the old Mobility Leads page keeps showing it (the SIN in plain text, as that
-- page always has; the CRM itself only ever stores it sealed). The backend
-- calls this inside the tenant transaction that writes the identity; it only
-- accepts a CanadaWide mobility lead of that transaction's own site. A no-op
-- without the legacy table (CI, local). Drop it with the 0002 trigger at the
-- staff cutover (docs/HANDOFF.md §5.1 step 5).
CREATE FUNCTION app.mirror_canadawide_legacy_identity(
  p_id uuid,
  p_lead_id uuid,
  p_id_type text,
  p_file_path text,
  p_sin text,
  p_date_of_birth date,
  p_consented_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $f$
BEGIN
  IF pg_catalog.to_regclass('public.mobility_id_uploads') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM app.leads AS lead
    JOIN app.workspaces AS site ON site.id = lead.workspace_id
    WHERE lead.id = p_lead_id
      AND lead.lead_type = 'mobility'
      AND site.slug = 'canadawide'
      AND lead.workspace_id =
        nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ) THEN
    RAISE EXCEPTION 'not a CanadaWide mobility lead of this site' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.mobility_id_uploads (
    id, lead_id, id_type, id_file_path, sin, date_of_birth, credit_check_consent, consented_at
  ) VALUES (
    p_id,
    p_lead_id,
    CASE p_id_type WHEN 'drivers_licence' THEN 'drivers-licence' ELSE p_id_type END,
    p_file_path,
    p_sin,
    p_date_of_birth,
    true,
    p_consented_at
  )
  ON CONFLICT (id) DO NOTHING;
END;
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.mirror_canadawide_legacy_identity(uuid, uuid, text, text, text, date, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.mirror_canadawide_legacy_identity(uuid, uuid, text, text, text, date, timestamptz) TO app_runtime;
