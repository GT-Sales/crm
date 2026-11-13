-- Hand-written companion to 0032_workspaces_rls (security audit I-2): FORCE
-- row security on the site registry, the one app table that had none.
--
-- The table has no policy for app_runtime and no grant to it, so nothing reads
-- it through the API roles today (sites are found through
-- app.list_staff_workspaces() and a website's credential). RLS on with no
-- policy, forced, makes that structural: a grant added by mistake, or an
-- exposure of the `app` schema, returns no rows instead of every site.
--
-- Who still reads it, and why nothing changes for them:
--   * the SECURITY DEFINER functions (list_staff_workspaces, the legacy mirror
--     trigger and the others) are owned by the migration role `postgres`, which
--     has BYPASSRLS on Supabase, so FORCE does not reach them;
--   * backup_reader reads it through 0032's workspaces_backup_reader_read.
-- Apply the same way as any migration (docs/RUNBOOKS/database.md): prepared,
-- not applied by the deploy.

ALTER TABLE "app"."workspaces" FORCE ROW LEVEL SECURITY;
