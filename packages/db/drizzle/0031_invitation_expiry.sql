-- Staff invitations expire (security audit L-16).
--
-- app.accept_staff_invitations (0001) claimed any pending invitation whose
-- invited_email equalled the verified email, however old. Now only invitations
-- sent in the last 14 days are claimable; an older pending row is simply never
-- matched (it stays visible as pending until staff revoke it, and a new
-- invitation to the same address supersedes it: DatabaseStaffStore.inviteStaff
-- revokes an expired pending one before inserting). The only change from the
-- 0001 body is the created_at filter marked below; the signature, owner,
-- SECURITY DEFINER, empty search_path and the grants are as before.
--
-- Before applying: any invitation still pending after 14 days stops working.
-- List them with
--   select workspace_id, invited_email, created_at from app.memberships
--   where membership_type = 'staff' and status = 'pending'
--     and created_at <= now() - interval '14 days';
-- and re-invite whoever still needs to join.
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
      -- An invitation is claimable for 14 days from when it was sent (audit L-16):
      -- the check on the verified email is only as strong as the sign-in
      -- provider's email confirmation, so a forgotten invitation must not stay
      -- claimable for ever. Re-invite to send a fresh one.
      AND created_at > pg_catalog.clock_timestamp() - interval '14 days'
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
