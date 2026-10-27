-- Migration 0006 by hand, for when the Supabase tool's confirm prompt cannot
-- be answered. Paste the whole file into Supabase → SQL Editor → Run, once.
-- It is one transaction: either all of it lands, both trackers included, or
-- none of it. The last query should show two rows, both returning boolean.
BEGIN;

DROP FUNCTION app.mirror_canadawide_legacy_identity(uuid, uuid, text, text, text, date, timestamptz);

-- True when an identity on this lead belongs in the old admin too: the legacy
-- tables exist, the lead is a CanadaWide mobility lead of the caller's site,
-- and its legacy row (written by the 0002 trigger) is there to link to.
CREATE FUNCTION app.canadawide_legacy_identity_applies(p_lead_id uuid) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $f$
BEGIN
  IF pg_catalog.to_regclass('public.mobility_id_uploads') IS NULL
    OR pg_catalog.to_regclass('public.mobility_leads') IS NULL THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM app.leads AS lead
    JOIN app.workspaces AS site ON site.id = lead.workspace_id
    WHERE lead.id = p_lead_id
      AND lead.lead_type = 'mobility'
      AND site.slug = 'canadawide'
      AND lead.workspace_id =
        nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid
  ) AND EXISTS (SELECT 1 FROM public.mobility_leads AS legacy WHERE legacy.id = p_lead_id);
END;
$f$;
REVOKE ALL ON FUNCTION app.canadawide_legacy_identity_applies(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.canadawide_legacy_identity_applies(uuid) TO app_runtime;

-- Writes the identity into public.mobility_id_uploads under the same id (the
-- SIN in plain text, as the old Mobility Leads page always had it; the CRM
-- itself only stores it sealed). A licence needs the copied photo's path; one
-- without it is skipped rather than refused, so the CRM's own copy of the
-- identity never fails on the old admin's account.
CREATE FUNCTION app.mirror_canadawide_legacy_identity(
  p_id uuid,
  p_lead_id uuid,
  p_id_type text,
  p_file_path text,
  p_sin text,
  p_date_of_birth date,
  p_consented_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $f$
BEGIN
  IF p_id_type = 'drivers_licence' AND p_file_path IS NULL THEN
    RETURN false;
  END IF;
  IF NOT app.canadawide_legacy_identity_applies(p_lead_id) THEN
    RETURN false;
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
  RETURN true;
END;
$f$;
REVOKE ALL ON FUNCTION app.mirror_canadawide_legacy_identity(uuid, uuid, text, text, text, date, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.mirror_canadawide_legacy_identity(uuid, uuid, text, text, text, date, timestamptz) TO app_runtime;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '063cfe0eff5e3a986f093c1cca8b1c1c3255e5e90763beb1b206ddae3d1877ac', 1793082645098
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1793082645098);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0006_legacy_identity_mirror_result',
       ARRAY['-- applied by hand from packages/db/drizzle/0006_legacy_identity_mirror_result.sql; see docs/RUNBOOKS/manual/0006-legacy-identity-mirror.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0006_legacy_identity_mirror_result'
);

COMMIT;

SELECT p.proname, pg_get_function_result(p.oid) AS returns
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app' AND p.proname LIKE '%legacy_identity%'
ORDER BY 1;
