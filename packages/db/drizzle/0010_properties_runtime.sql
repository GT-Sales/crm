-- Hand-written companion to 0009_properties: FORCE RLS, the runtime grants
-- and the guard on property identity (AGENTS.md rule 3). backup_reader needs
-- no grant here: 0007's default privileges make every new app table readable,
-- and each table's read policy comes from schema.ts in 0009.

ALTER TABLE "app"."properties" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."property_layouts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."saved_views" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- No DELETE on properties: a custom property is tombstoned with deleted_at
-- and its key stays reserved by the unique (workspace_id, object, key).
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."properties" TO app_runtime;
--> statement-breakpoint
-- A layout is replaced in place, never removed.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."property_layouts" TO app_runtime;
--> statement-breakpoint
-- A person's own views; the owner policy limits every statement to them.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."saved_views" TO app_runtime;
--> statement-breakpoint

-- A property's identity is fixed once created: its site, object, key, kind
-- and origin never change (stored values are read by key and kind), a
-- tombstone is permanent, and a built-in override can be hidden but never
-- tombstoned (the built-in itself lives in code).
CREATE OR REPLACE FUNCTION "app"."guard_property_identity"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.object IS DISTINCT FROM OLD.object
     OR NEW.key IS DISTINCT FROM OLD.key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'property_identity_locked' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at THEN
    RAISE EXCEPTION 'property_tombstone_permanent' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.origin = 'builtin' AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'builtin_property_not_deletable' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "properties_identity_guard"
BEFORE UPDATE ON "app"."properties"
FOR EACH ROW EXECUTE FUNCTION "app"."guard_property_identity"();
