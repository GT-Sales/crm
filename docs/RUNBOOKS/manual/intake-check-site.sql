-- The intake check's test site (merge phase 6). Run in Supabase -> SQL Editor
-- as postgres, one section at a time, and each verification select on its own
-- (the editor shows only the last result set of a run). Runbook:
-- docs/RUNBOOKS/intake-check.md.
--
-- The test site is one row in app.workspaces: slug intake-check, name
-- "Intake check", status active, with no members, no site keys, no saved
-- email settings and no automation rows. No member means no staff list shows
-- it; no sender and no rules mean no run ever queues a mail. No roles or
-- permissions rows are needed: the site has no members. Its id goes into the
-- backend's INTAKE_CHECK_WORKSPACE_ID (Railway, service crm).
--
-- Sections:
--   A  pre-check: is there a test site already?
--   B  create it (idempotent on the slug), copy its id, then the four
--      verification selects;
--   C  controlled failure: remove the site row (the next run fails at create);
--   D  recovery: put it back with the same id (the next run passes).
-- C and D only with the owner's agreement, as part of the live check
-- (docs/RUNBOOKS/intake-check.md, "The controlled failure").

-- A. PRE-CHECK BEGIN
-- Expect no row before the first set-up; one row (status active) afterwards.
select id, slug, status from app.workspaces where slug = 'intake-check';
-- A. PRE-CHECK END

-- B. CREATE BEGIN
-- Safe to run twice: a second run inserts nothing.
insert into app.workspaces (slug, name, status)
values ('intake-check', 'Intake check', 'active')
on conflict (slug) do nothing;

-- The id to copy into INTAKE_CHECK_WORKSPACE_ID.
select id from app.workspaces where slug = 'intake-check';
-- B. CREATE END

-- B. VERIFY BEGIN (one select at a time; each expects 0)
select count(*) as memberships from app.memberships
where workspace_id = (select id from app.workspaces where slug = 'intake-check');

select count(*) as service_credentials from app.service_credentials
where workspace_id = (select id from app.workspaces where slug = 'intake-check');

select count(*) as email_settings from app.workspace_email_settings
where workspace_id = (select id from app.workspaces where slug = 'intake-check');

select count(*) as automations from app.automations
where workspace_id = (select id from app.workspaces where slug = 'intake-check');
-- B. VERIFY END

-- C. CONTROLLED FAILURE BEGIN
-- Replace <id> with the id from section B (the value of
-- INTAKE_CHECK_WORKSPACE_ID). Leave the variable as it is: changing a
-- variable restarts the backend and empties the alert state, so the
-- all-clear would never be seen (ruling R7). Deleting the row cascades the
-- site's own rows (a leftover lead, its audit rows); no other site is
-- touched. Expect "DELETE 1". The next run fails at create with
-- sqlstate_23503 and the owner gets the "intake check failed" alert within
-- 15 minutes.
delete from app.workspaces where slug = 'intake-check' and id = '<id>';
-- C. CONTROLLED FAILURE END

-- D. RECOVERY BEGIN
-- The same <id> as in section C, so the variable still matches. Expect
-- "INSERT 0 1", then section A shows the row again. The next run passes and
-- the owner gets the "intake check passing again" alert.
insert into app.workspaces (id, slug, name, status)
values ('<id>', 'intake-check', 'Intake check', 'active');
-- D. RECOVERY END
