-- Issue #109: a draft restricted by an older version of the retention job
-- keeps attribution extras a draft restricted today loses (`utmTerm`,
-- `utmContent`, `landingPath`: free text that can carry an identifier), and
-- nothing could remove them afterwards, because `app.guard_restricted_lead`
-- (0001) refuses every attribution change on a restricted lead except
-- emptying it.
--
-- The guard is relaxed by exactly one case: the new attribution is the old
-- one without those three keys. Every other key must be unchanged, so no
-- attribution can be written, rewritten or added on a restricted lead, and
-- nothing else about the guard moves. This is narrower than extending the
-- SECURITY DEFINER erasure (0030): the guard is a row trigger and fires for
-- that function's updates too, so it would have to be relaxed either way,
-- and the runtime role already holds UPDATE on the column.
--
-- The keys live in one function so the guard and the backend cannot drift;
-- its presence is also how the backend knows this migration is applied
-- (retention/abandoned-leads.ts), as it does for 0030 and 0039.
CREATE OR REPLACE FUNCTION app.restricted_lead_erased_attribution_keys() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = '' AS $f$
  SELECT ARRAY['utmTerm', 'utmContent', 'landingPath']::text[];
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.restricted_lead_erased_attribution_keys() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.restricted_lead_erased_attribution_keys() TO app_runtime;
--> statement-breakpoint

-- 0001's guard, with the one added case on the attribution line.
CREATE OR REPLACE FUNCTION app.guard_restricted_lead() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $f$
BEGIN
 IF OLD.customer_data_restricted_at IS NOT NULL THEN
   IF NEW.customer_data_restricted_at IS DISTINCT FROM OLD.customer_data_restricted_at
     OR (NEW.full_name IS DISTINCT FROM OLD.full_name AND NEW.full_name IS NOT NULL)
     OR (NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS NOT NULL)
     OR (NEW.phone IS DISTINCT FROM OLD.phone AND NEW.phone IS NOT NULL)
     OR (NEW.country_code IS DISTINCT FROM OLD.country_code AND NEW.country_code IS NOT NULL)
     OR (NEW.payload IS DISTINCT FROM OLD.payload AND NEW.payload IS NOT NULL)
     OR (NEW.attribution IS DISTINCT FROM OLD.attribution
       AND NEW.attribution IS DISTINCT FROM '{}'::jsonb
       AND NEW.attribution IS DISTINCT FROM (OLD.attribution - app.restricted_lead_erased_attribution_keys()))
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
     OR (NEW.external_ref IS DISTINCT FROM OLD.external_ref AND NEW.external_ref IS NOT NULL) THEN
     RAISE EXCEPTION 'customer_data_restricted' USING ERRCODE = 'check_violation';
   END IF;
 END IF;
 RETURN NEW;
END;
$f$;
