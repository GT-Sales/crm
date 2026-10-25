-- Remaining statements of packages/db/drizzle/0001_runtime_functions.sql for
-- the hosted project, 2026-10-25. The Supabase MCP tool applied the grants,
-- the DELETE-free functions and the four triggers, but holds every statement
-- that contains REVOKE, ALTER or DELETE for a confirmation prompt that never
-- reached the owner. Paste this whole file into the Supabase SQL editor once.
-- Everything here is idempotent except the two tracker inserts at the end,
-- which are guarded.
--
-- After it runs, verify:
--   select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'app' order by 1;                 -- 10 functions
--   select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'app' and c.relkind = 'r' and c.relforcerowsecurity;  -- 24

-- 1. Revokes (PUBLIC has no USAGE on the schema, so these are defence in depth)
REVOKE ALL ON SCHEMA "app" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."list_staff_workspaces"() FROM PUBLIC;
REVOKE ALL ON FUNCTION "app"."resolve_website_credential"(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.lead_restricted(uuid, uuid) FROM PUBLIC;

-- 2. FORCE ROW LEVEL SECURITY (binds table owners too)
ALTER TABLE "app"."memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."membership_roles" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."permissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."membership_permissions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."contacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."leads" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."lead_activities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."lead_tasks" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."draft_grants" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."outbox_jobs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."outbox_job_alerts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."service_credentials" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."rate_limit_buckets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."audit_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."files" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."file_revisions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."file_review_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."email_messages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."deleted_email_messages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."email_suppressions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."marketing_consents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."follow_up_schedules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "app"."email_provider_events" FORCE ROW LEVEL SECURITY;

-- 3. The three bootstrap functions whose bodies contain DELETE
CREATE OR REPLACE FUNCTION app.accept_staff_invitations(p_verified_email text, p_request_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := nullif(pg_catalog.current_setting('app.actor_id', true), '')::uuid;
  v_invite record;
  v_existing record;
  v_target uuid;
  v_count integer := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'verified actor context is required' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR nullif(pg_catalog.btrim(p_verified_email), '') IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_actor::text, 0));
  FOR v_invite IN
    SELECT id, workspace_id FROM app.memberships
    WHERE membership_type = 'staff' AND status = 'pending'
      AND pg_catalog.lower(invited_email) = pg_catalog.lower(pg_catalog.btrim(p_verified_email))
    ORDER BY workspace_id FOR UPDATE
  LOOP
    SELECT id, status, membership_type INTO v_existing FROM app.memberships
    WHERE workspace_id = v_invite.workspace_id AND user_id = v_actor FOR UPDATE;
    IF FOUND THEN
      IF v_existing.status = 'revoked' AND v_existing.membership_type = 'staff' THEN
        DELETE FROM app.membership_roles WHERE workspace_id = v_invite.workspace_id AND membership_id = v_existing.id;
        DELETE FROM app.membership_permissions WHERE workspace_id = v_invite.workspace_id AND membership_id = v_existing.id;
        INSERT INTO app.membership_roles(workspace_id, membership_id, role_id)
          SELECT workspace_id, v_existing.id, role_id FROM app.membership_roles
          WHERE workspace_id = v_invite.workspace_id AND membership_id = v_invite.id;
        UPDATE app.memberships SET status = 'active', revoked_at = NULL,
          accepted_at = pg_catalog.clock_timestamp() WHERE id = v_existing.id;
        v_target := v_existing.id;
      ELSE
        v_target := NULL;
      END IF;
      UPDATE app.memberships SET status = 'revoked', revoked_at = pg_catalog.clock_timestamp()
        WHERE id = v_invite.id;
      INSERT INTO app.audit_events(workspace_id, actor_id, actor_label, action, entity, entity_id, request_id, after)
        VALUES (v_invite.workspace_id, v_actor, 'staff actor', 'membership.invitation_consumed',
          'membership', v_invite.id, p_request_id,
          pg_catalog.jsonb_build_object('membershipId', v_existing.id, 'reactivated', v_target IS NOT NULL));
    ELSE
      UPDATE app.memberships SET user_id = v_actor, invited_email = NULL, status = 'active',
        accepted_at = pg_catalog.clock_timestamp() WHERE id = v_invite.id;
      v_target := v_invite.id;
    END IF;
    IF v_target IS NOT NULL THEN
      INSERT INTO app.audit_events(workspace_id, actor_id, actor_label, action, entity, entity_id, request_id, after)
        VALUES (v_invite.workspace_id, v_actor, 'staff actor', 'membership.accepted', 'membership',
          v_target, p_request_id, pg_catalog.jsonb_build_object('status', 'active', 'invitationId', v_invite.id));
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RETURN v_count;
END;
$function$;
REVOKE ALL ON FUNCTION "app"."accept_staff_invitations"(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app"."accept_staff_invitations"(text, uuid) TO app_runtime;

CREATE OR REPLACE FUNCTION "app"."rate_limit_hit"(
  p_bucket_key text,
  p_window_seconds integer,
  p_max_count integer
)
RETURNS TABLE (
  allowed boolean,
  retry_after_seconds integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_count integer;
BEGIN
  IF p_window_seconds <= 0
     OR p_max_count <= 0
     OR nullif(pg_catalog.btrim(p_bucket_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid rate limit parameters' USING ERRCODE = '22023';
  END IF;
  SET LOCAL lock_timeout = '75ms';
  v_window_start := pg_catalog.to_timestamp(
    pg_catalog.floor(
      pg_catalog.date_part('epoch', v_now) / p_window_seconds
    ) * p_window_seconds
  );
  v_window_end := v_window_start + pg_catalog.make_interval(secs => p_window_seconds);
  DELETE FROM app.rate_limit_buckets AS bucket
  WHERE bucket.ctid IN (
    SELECT expired.ctid
    FROM app.rate_limit_buckets AS expired
    WHERE expired.expires_at < v_now
    LIMIT 50
  );
  INSERT INTO app.rate_limit_buckets AS bucket (
    bucket_key, window_start, request_count, expires_at
  )
  VALUES (p_bucket_key, v_window_start, 1, v_window_end)
  ON CONFLICT (bucket_key, window_start)
  DO UPDATE SET request_count = bucket.request_count + 1
  RETURNING bucket.request_count INTO v_count;
  RETURN QUERY
  SELECT
    v_count <= p_max_count,
    CASE
      WHEN v_count <= p_max_count THEN 0
      ELSE GREATEST(
        1,
        pg_catalog.ceil(pg_catalog.date_part('epoch', v_window_end - v_now))::integer
      )
    END;
END;
$function$;
REVOKE ALL ON FUNCTION "app"."rate_limit_hit"(text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION "app"."rate_limit_hit"(text, integer, integer) TO app_runtime;

CREATE OR REPLACE FUNCTION app.prune_operational_rows(p_workspace_id uuid, p_now timestamptz)
RETURNS TABLE(table_name text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	n integer;
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;
	DELETE FROM app.outbox_jobs j WHERE j.ctid IN (
		SELECT x.ctid FROM app.outbox_jobs x
		WHERE x.workspace_id = p_workspace_id AND x.status = 'completed'
			AND coalesce(x.completed_at, x.updated_at) < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_jobs'; deleted := n; RETURN NEXT;
	DELETE FROM app.outbox_job_alerts a WHERE a.ctid IN (
		SELECT x.ctid FROM app.outbox_job_alerts x
		WHERE x.workspace_id = p_workspace_id AND x.resolved_at < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_job_alerts'; deleted := n; RETURN NEXT;
	DELETE FROM app.email_provider_events p WHERE p.ctid IN (
		SELECT x.ctid FROM app.email_provider_events x
		WHERE x.workspace_id = p_workspace_id AND x.applied_at < p_now - interval '180 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'email_provider_events'; deleted := n; RETURN NEXT;
END;
$function$;
REVOKE ALL ON FUNCTION app.prune_operational_rows(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prune_operational_rows(uuid, timestamptz) TO app_runtime;

-- 4. Record 0001 in both migration trackers (docs/RUNBOOKS/database.md)
INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
SELECT '01b2bf4ae77864b0d7f495f97faa438a2825e545e035e33bbeed6ede49f5e394', 1792904896632
WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = 1792904896632);
INSERT INTO supabase_migrations.schema_migrations (version, name, statements)
SELECT to_char(now() at time zone 'utc', 'YYYYMMDDHH24MISS'), '0001_runtime_functions',
       ARRAY['-- applied by hand from packages/db/drizzle/0001_runtime_functions.sql; see docs/RUNBOOKS/manual/0001-remaining.sql']
WHERE NOT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE name = '0001_runtime_functions');
