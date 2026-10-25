-- Hand-written companion to 0000_app_foundation: everything drizzle-kit does
-- not generate. Keep in step with packages/db/src/schema.ts.
--
--   1. Grants for the restricted runtime role (least privilege per table).
--   2. FORCE ROW LEVEL SECURITY so policies bind table owners too.
--   3. SECURITY DEFINER functions the backend calls before tenant context
--      exists (credential lookup, rate limiting, staff bootstrap) or that must
--      not be reproducible with the runtime role's own grants (pruning).
--   4. Triggers protecting audit history and restricted customer data.

-- ---------------------------------------------------------------------------
-- 1. Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON SCHEMA "app" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "app" FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "app" TO app_runtime;
--> statement-breakpoint
-- No grant on app.workspaces: staff discover sites through list_staff_workspaces()
-- and websites through their credential, so the runtime cannot enumerate sites.
-- No grant on app.rate_limit_buckets: reached only through rate_limit_hit().
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
	"app"."memberships",
	"app"."roles",
	"app"."membership_roles",
	"app"."permissions",
	"app"."membership_permissions",
	"app"."service_credentials"
TO app_runtime;
--> statement-breakpoint
-- Audit history is append-only; the one permitted update is privacy redaction
-- of the recorded values to SQL null (see audit_events_redaction_only below).
GRANT SELECT, INSERT ON TABLE "app"."audit_events" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE ("before", "after") ON TABLE "app"."audit_events" TO app_runtime;
--> statement-breakpoint
-- Contacts are found-or-created by intake and refreshed from later submissions;
-- removing one is a phase-2 deletion flow with its own migration.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."contacts" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
	"app"."leads",
	"app"."draft_grants",
	"app"."lead_tasks"
TO app_runtime;
--> statement-breakpoint
-- The timeline is append-only.
GRANT SELECT, INSERT ON TABLE "app"."lead_activities" TO app_runtime;
--> statement-breakpoint
-- Outbox rows are claimed and resolved in place; age-based removal is only
-- through prune_operational_rows().
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."outbox_jobs", "app"."outbox_job_alerts" TO app_runtime;
--> statement-breakpoint
-- `files` is mutated in place (status lifecycle, attach, tombstone) and expired
-- uploads are swept; revisions and review decisions are append-only.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "app"."files" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "app"."file_revisions", "app"."file_review_events" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE
	"app"."email_messages",
	"app"."email_provider_events",
	"app"."follow_up_schedules"
TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "app"."email_suppressions", "app"."marketing_consents" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "app"."deleted_email_messages" TO app_runtime;
--> statement-breakpoint
GRANT UPDATE (provider_id) ON TABLE "app"."deleted_email_messages" TO app_runtime;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. FORCE ROW LEVEL SECURITY (drizzle emits ENABLE only)
-- ---------------------------------------------------------------------------
ALTER TABLE "app"."memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."membership_roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."permissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."membership_permissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."contacts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."leads" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."lead_activities" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."lead_tasks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."draft_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."outbox_jobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."outbox_job_alerts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."service_credentials" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."rate_limit_buckets" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."files" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."file_revisions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."file_review_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."email_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."deleted_email_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."email_suppressions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."marketing_consents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."follow_up_schedules" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."email_provider_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. Pre-tenant bootstrap functions (SECURITY DEFINER, empty search_path)
-- ---------------------------------------------------------------------------

-- Staff bootstrap: the sites the verified actor (app.actor_id) actively
-- belongs to, with role names. The runtime role has no grant on workspaces,
-- so this is the only way it learns a site exists.
CREATE OR REPLACE FUNCTION "app"."list_staff_workspaces"()
RETURNS TABLE (
  workspace_id uuid,
  workspace_slug text,
  workspace_name text,
  membership_id uuid,
  role_names text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    workspace.id,
    workspace.slug,
    workspace.name,
    membership.id,
    ARRAY(
      SELECT role.name::text
      FROM app.membership_roles AS membership_role
      JOIN app.roles AS role
        ON role.workspace_id = membership_role.workspace_id
       AND role.id = membership_role.role_id
      WHERE membership_role.workspace_id = membership.workspace_id
        AND membership_role.membership_id = membership.id
      ORDER BY role.name::text
    )
  FROM app.memberships AS membership
  JOIN app.workspaces AS workspace ON workspace.id = membership.workspace_id
  WHERE membership.membership_type = 'staff'
    AND membership.status = 'active'
    AND membership.user_id =
      nullif(pg_catalog.current_setting('app.actor_id', true), '')::uuid
  ORDER BY workspace.name, workspace.slug;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."list_staff_workspaces"() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."list_staff_workspaces"() TO app_runtime;
--> statement-breakpoint

-- First verified login: claim every pending invitation addressed to the
-- verified email. Preserves membership identity/history on re-invitation of a
-- revoked member, but never carries old grants over; refuses to change an
-- already active identity's roles.
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
  -- Serialize overlapping bootstrap requests for this verified actor.
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
      -- An invitation cannot silently change an active identity's roles/type.
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."accept_staff_invitations"(text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."accept_staff_invitations"(text, uuid) TO app_runtime;
--> statement-breakpoint

-- Website bootstrap: a credential secret hash resolves to exactly one site
-- before any tenant context exists. The credential's own id doubles as the
-- actor id for the website's tenant writes (there is no human actor), which is
-- what satisfies every policy's fail-closed actor predicate.
CREATE OR REPLACE FUNCTION "app"."resolve_website_credential"(
  p_secret_hash text
)
RETURNS TABLE (
  id uuid,
  workspace_id uuid,
  scopes text[],
  revoked boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    credential.id,
    credential.workspace_id,
    credential.scopes,
    credential.revoked_at IS NOT NULL
  FROM app.service_credentials AS credential
  WHERE credential.secret_hash = p_secret_hash
  LIMIT 1;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."resolve_website_credential"(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."resolve_website_credential"(text) TO app_runtime;
--> statement-breakpoint

-- Bounded per-key rate limiting for public requests. Rows are keyed per
-- credential/IP and fixed window; the runtime role never touches the table.
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

  -- Fail fast on a contended single-key row rather than holding a pooled
  -- connection open; different keys touch different rows, so there is no
  -- global hot counter to serialize on.
  SET LOCAL lock_timeout = '75ms';

  v_window_start := pg_catalog.to_timestamp(
    pg_catalog.floor(
      pg_catalog.date_part('epoch', v_now) / p_window_seconds
    ) * p_window_seconds
  );
  v_window_end := v_window_start + pg_catalog.make_interval(secs => p_window_seconds);

  -- Opportunistic, bounded expiry cleanup; never a full-table sweep.
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."rate_limit_hit"(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."rate_limit_hit"(text, integer, integer) TO app_runtime;
--> statement-breakpoint

-- Bounded pruning of operational rows for the caller's own tenant only. The
-- runtime role gets EXECUTE here and no DELETE grant on these tables. Leads,
-- contacts, activities, files and audit events are never touched. Each table
-- loses at most 1000 rows per call.
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

	-- Completed jobs after 30 days (their alerts go with them by cascade).
	DELETE FROM app.outbox_jobs j WHERE j.ctid IN (
		SELECT x.ctid FROM app.outbox_jobs x
		WHERE x.workspace_id = p_workspace_id AND x.status = 'completed'
			AND coalesce(x.completed_at, x.updated_at) < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_jobs'; deleted := n; RETURN NEXT;

	-- Resolved alerts after 30 days.
	DELETE FROM app.outbox_job_alerts a WHERE a.ctid IN (
		SELECT x.ctid FROM app.outbox_job_alerts x
		WHERE x.workspace_id = p_workspace_id AND x.resolved_at < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_job_alerts'; deleted := n; RETURN NEXT;

	-- Applied email provider events after 180 days.
	DELETE FROM app.email_provider_events p WHERE p.ctid IN (
		SELECT x.ctid FROM app.email_provider_events x
		WHERE x.workspace_id = p_workspace_id AND x.applied_at < p_now - interval '180 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'email_provider_events'; deleted := n; RETURN NEXT;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.prune_operational_rows(uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.prune_operational_rows(uuid, timestamptz) TO app_runtime;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Triggers
-- ---------------------------------------------------------------------------

-- The runtime's column grant permits privacy redaction, never replacement of
-- recorded evidence. Keep unchanged values valid when only one side is erased.
CREATE OR REPLACE FUNCTION "app"."restrict_audit_redaction"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, app
AS $function$
BEGIN
  IF (NEW."before" IS DISTINCT FROM OLD."before" AND NEW."before" IS NOT NULL)
     OR (NEW."after" IS DISTINCT FROM OLD."after" AND NEW."after" IS NOT NULL) THEN
    RAISE EXCEPTION 'audit values may only be redacted to SQL null'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_redaction_only"
BEFORE UPDATE OF "before", "after" ON "app"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "app"."restrict_audit_redaction"();
--> statement-breakpoint

-- True when the lead's personal data has been restricted (retention or an
-- erasure request). Shared by the guards below.
CREATE OR REPLACE FUNCTION app.lead_restricted(w uuid, l uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, app AS $f$
  SELECT EXISTS (
    SELECT 1 FROM app.leads
    WHERE workspace_id = w AND id = l AND customer_data_restricted_at IS NOT NULL
  );
$f$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.lead_restricted(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.lead_restricted(uuid, uuid) TO app_runtime;
--> statement-breakpoint

-- Once a lead's personal data is restricted, nothing may write it back: the
-- row stays as an anonymous count (type, status, source) and the restriction
-- itself cannot be lifted from the application.
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
     OR (NEW.attribution IS DISTINCT FROM OLD.attribution AND NEW.attribution IS DISTINCT FROM '{}'::jsonb)
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL)
     OR (NEW.external_ref IS DISTINCT FROM OLD.external_ref AND NEW.external_ref IS NOT NULL) THEN
     RAISE EXCEPTION 'customer_data_restricted' USING ERRCODE = 'check_violation';
   END IF;
 END IF;
 RETURN NEW;
END;
$f$;
--> statement-breakpoint
CREATE TRIGGER leads_customer_restriction
BEFORE UPDATE ON app.leads
FOR EACH ROW EXECUTE FUNCTION app.guard_restricted_lead();
--> statement-breakpoint

-- A file's owning record never changes, and no document may be attached to or
-- re-keyed under a restricted lead; the only permitted write there is the
-- tombstone (status 'deleted').
CREATE OR REPLACE FUNCTION app.guard_restricted_file() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $f$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.record_type IS DISTINCT FROM OLD.record_type
     OR NEW.record_id IS DISTINCT FROM OLD.record_id) THEN
   RAISE EXCEPTION 'file_identity_immutable' USING ERRCODE = 'check_violation';
 END IF;
 IF NEW.record_type = 'lead' THEN
   IF TG_OP = 'INSERT' THEN
     -- Hold the parent so a concurrent restriction cannot race the attach.
     PERFORM id FROM app.leads WHERE workspace_id = NEW.workspace_id AND id = NEW.record_id FOR SHARE;
   END IF;
   IF app.lead_restricted(NEW.workspace_id, NEW.record_id) THEN
     IF TG_OP = 'INSERT' OR NEW.status <> 'deleted' THEN
       RAISE EXCEPTION 'customer_data_restricted' USING ERRCODE = 'check_violation';
     END IF;
     IF NEW.staging_key IS DISTINCT FROM OLD.staging_key
        OR NEW.candidate_key IS DISTINCT FROM OLD.candidate_key
        OR NEW.object_key IS DISTINCT FROM OLD.object_key
        OR NEW.bucket IS DISTINCT FROM OLD.bucket THEN
       RAISE EXCEPTION 'customer_data_restricted' USING ERRCODE = 'check_violation';
     END IF;
   END IF;
 END IF;
 RETURN NEW;
END;
$f$;
--> statement-breakpoint
CREATE TRIGGER files_customer_restriction
BEFORE INSERT OR UPDATE ON app.files
FOR EACH ROW EXECUTE FUNCTION app.guard_restricted_file();
--> statement-breakpoint

-- No new job may be queued for a restricted lead (an email, a follow-up), so
-- a restriction is not undone by a message already on its way.
CREATE OR REPLACE FUNCTION app.guard_restricted_job() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app AS $f$
DECLARE l uuid;
BEGIN
 IF NEW.payload->>'leadId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
   l := (NEW.payload->>'leadId')::uuid;
   PERFORM id FROM app.leads WHERE workspace_id = NEW.workspace_id AND id = l FOR SHARE;
   IF app.lead_restricted(NEW.workspace_id, l) THEN
     RAISE EXCEPTION 'customer_data_restricted' USING ERRCODE = 'check_violation';
   END IF;
 END IF;
 RETURN NEW;
END;
$f$;
--> statement-breakpoint
CREATE TRIGGER jobs_customer_restriction
BEFORE INSERT ON app.outbox_jobs
FOR EACH ROW EXECUTE FUNCTION app.guard_restricted_job();
