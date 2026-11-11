-- Migration 0030 by hand (audit M-2), for when the Supabase tool's confirm
-- prompt cannot be answered. Paste the whole file into Supabase → SQL Editor →
-- Run, once. One transaction: the function and both tracker rows land
-- together or not at all. Needs 0001 and 0005 (they are applied).
-- The last query should show one row: t, t, f.
BEGIN;

-- Audit M-2: restricting an abandoned draft (retention/abandoned-leads.ts)
-- erased the lead row's answers but left what the runtime role may not remove
-- itself: the lead's identities (a sealed SIN and its date of birth, a
-- licence file link) and their transitional plain-text copy in CanadaWide's
-- legacy table, the bodies of staff notes on the timeline, and the global
-- contact row (email, name, phone) once no lead points at it any more. The
-- backend tombstones the lead's files, deletes their objects, removes its
-- tasks and clears its attribution extras, order details and contact link
-- with its own grants; this function does the rest, in the same transaction.
--
-- It acts only on leads of the transaction's own site that are already
-- restricted, so it can never erase a live lead, and a contact only when no
-- lead on any site still references it.
CREATE OR REPLACE FUNCTION app.erase_restricted_lead_data(
	p_workspace_id uuid,
	p_lead_ids uuid[],
	p_contact_ids uuid[]
)
RETURNS TABLE(identities integer, notes integer, contacts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	v_leads uuid[];
	v_identity_ids uuid[];
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF pg_catalog.cardinality(p_lead_ids) > 1000 OR pg_catalog.cardinality(p_contact_ids) > 1000 THEN
		RAISE EXCEPTION 'too_many_ids' USING ERRCODE = 'invalid_parameter_value';
	END IF;

	SELECT coalesce(pg_catalog.array_agg(l.id), '{}') INTO v_leads
	FROM app.leads l
	WHERE l.workspace_id = p_workspace_id
		AND l.id = ANY (p_lead_ids)
		AND l.customer_data_restricted_at IS NOT NULL;

	-- Identities: the CRM's sealed rows and the legacy mirror's plain-text copy
	-- under the same id (0005); a no-op on the mirror without the legacy table.
	SELECT coalesce(pg_catalog.array_agg(i.id), '{}') INTO v_identity_ids
	FROM app.lead_identities i
	WHERE i.workspace_id = p_workspace_id AND i.lead_id = ANY (v_leads);
	IF pg_catalog.to_regclass('public.mobility_id_uploads') IS NOT NULL
		AND pg_catalog.cardinality(v_identity_ids) > 0 THEN
		EXECUTE 'DELETE FROM public.mobility_id_uploads WHERE id = ANY ($1)' USING v_identity_ids;
	END IF;
	DELETE FROM app.lead_identities i WHERE i.workspace_id = p_workspace_id AND i.id = ANY (v_identity_ids);
	identities := pg_catalog.cardinality(v_identity_ids);

	-- Notes keep their place on the (append-only) timeline, without the text.
	UPDATE app.lead_activities a SET body = NULL
	WHERE a.workspace_id = p_workspace_id AND a.lead_id = ANY (v_leads) AND a.body IS NOT NULL;
	GET DIAGNOSTICS notes = ROW_COUNT;

	-- A contact is global (merged by email across sites); delete one only when
	-- no lead anywhere references it.
	DELETE FROM app.contacts c
	WHERE c.id = ANY (p_contact_ids)
		AND NOT EXISTS (SELECT 1 FROM app.leads l WHERE l.contact_id = c.id);
	GET DIAGNOSTICS contacts = ROW_COUNT;

	RETURN NEXT;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.erase_restricted_lead_data(uuid, uuid[], uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.erase_restricted_lead_data(uuid, uuid[], uuid[]) TO app_runtime;

INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT 'd9f606b7fb11c80c9953650a1e1824cbba4e0dc4a39c7725aa30ae2f89069a31', 1794348226604
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1794348226604);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0030_restricted_lead_erasure',
       ARRAY['-- applied by hand from packages/db/drizzle/0030_restricted_lead_erasure.sql; see docs/RUNBOOKS/manual/0030-restricted-lead-erasure.sql']
WHERE NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0030_restricted_lead_erasure'
);

COMMIT;

SELECT
  (SELECT prosecdef FROM pg_proc WHERE proname = 'erase_restricted_lead_data') AS security_definer,
  has_function_privilege('app_runtime', 'app.erase_restricted_lead_data(uuid,uuid[],uuid[])', 'execute') AS runtime_execute,
  has_function_privilege('anon', 'app.erase_restricted_lead_data(uuid,uuid[],uuid[])', 'execute') AS anon_execute;
