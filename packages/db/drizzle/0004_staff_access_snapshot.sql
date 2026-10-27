-- Staff authorization snapshot in one call (docs/RUNBOOKS/database.md).
--
-- Every staff request loads the actor's membership in the site it names,
-- with role names and permission overrides, before its data transaction.
-- That load ran in a tenant transaction of its own (begin, tenant context,
-- the read, commit): four round trips to the remote pooler on every request.
-- As a SECURITY DEFINER function it needs no tenant context, so the backend
-- calls it as one autocommit statement.
--
-- It returns only the one membership the backend names: the verified actor
-- (the Auth user id) in the site from the request path. The runtime role
-- could read that membership anyway by setting the tenant context, so the
-- function adds no reach; it adds no write at all.

CREATE OR REPLACE FUNCTION "app"."staff_access_snapshot"(p_workspace_id uuid, p_actor_id uuid)
RETURNS TABLE (
  membership_id uuid,
  status text,
  role_names text[],
  permission_rows jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    membership.id,
    membership.status,
    ARRAY(
      SELECT role.name::text
      FROM app.membership_roles AS membership_role
      JOIN app.roles AS role
        ON role.workspace_id = membership_role.workspace_id
       AND role.id = membership_role.role_id
      WHERE membership_role.workspace_id = membership.workspace_id
        AND membership_role.membership_id = membership.id
      ORDER BY role.name::text
    ),
    coalesce((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'name', permission.name::text,
          'effect', membership_permission.effect::text
        )
        ORDER BY permission.name::text
      )
      FROM app.membership_permissions AS membership_permission
      JOIN app.permissions AS permission
        ON permission.workspace_id = membership_permission.workspace_id
       AND permission.id = membership_permission.permission_id
      WHERE membership_permission.workspace_id = membership.workspace_id
        AND membership_permission.membership_id = membership.id
    ), '[]'::jsonb)
  FROM app.memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.user_id = p_actor_id
    AND membership.membership_type = 'staff'
  LIMIT 1;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."staff_access_snapshot"(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."staff_access_snapshot"(uuid, uuid) TO app_runtime;
