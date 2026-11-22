# Database runbook

Project: Supabase `gtsales-crm` (`xykrphbgpwisqacpyeiv`, Mumbai). The CRM
owns the `app` schema. Get Canada Sim's and CanadaWide's old tables stay in
`public` until the owner retires the old admins; no migration alters them,
and only the two legacy mirrors (0002, 0041) insert rows into them.

## How migrations are applied and tracked

Migrations live in `packages/db/drizzle/` and are **never applied by a
deploy**. Two trackers must agree:

1. **Drizzle**: `drizzle.__drizzle_migrations` (`hash`, `created_at`). The
   migrator (`pnpm --filter @gt-sales/db db:migrate`, with
   `MIGRATION_DATABASE_URL`) applies every entry of
   `packages/db/drizzle/meta/_journal.json` whose `when` is newer than the
   last row, then records `sha256(file)` and `when`.
2. **Supabase**: `supabase_migrations.schema_migrations`, written only when a
   migration goes through the Supabase tool's `apply_migration` or the CLI.

On the hosted project migrations are applied by hand, because no database
password is at hand in a session:

1. Read the migration's notes below (deploy order, what to check first).
2. In the Supabase SQL editor, as `postgres`, in one transaction: the file's
   statements without the `--> statement-breakpoint` lines, then the Drizzle
   tracker row:

   ```sql
   insert into drizzle.__drizzle_migrations (hash, created_at)
   values ('<sha256 of the .sql file>', <journal "when">);
   ```

3. Verify against the schema (`pg_class`, `pg_policies`, `pg_proc`,
   `has_table_privilege`), never against the trackers.
4. Record the date in the table below and in [HANDOFF.md](../HANDOFF.md).

The Supabase tool holds any SQL that contains `REVOKE`, `ALTER`, `DELETE` or
`DROP` for a confirmation that never reaches the owner, so those statements
are pasted by the owner in the SQL editor. A statement the owner must paste
that is not simply a migration file goes into [`manual/`](manual/).

Most backend features that need a newer migration ask the catalogue whether
it is there (`*-schema.ts` probes, re-asked every 5 minutes), so the deploy
and the migration can usually go in either order; the exceptions are named in
the notes below.

## Migrations

48 tracker rows on 2026-11-21: 0000 to 0047 are applied (rows 1 to 38 were
checked against their files' hashes on 2026-11-19). **0048 is not applied**
([below](#0048-not-applied-yet)).

| Migration    | What it adds                                                                                                                                                    | Applied                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 0000, 0001   | The `app` schema and the `app_runtime` role; grants, FORCE RLS, the SECURITY DEFINER functions, the audit and restriction triggers                              | 2026-10-25              |
| 0002         | CanadaWide legacy mirror: trigger `leads_mirror_canadawide_legacy` (temporary, see below)                                                                       | 2026-10-26              |
| 0003         | `leads.stage`, `memberships.display_name`, board and task indexes                                                                                               | 2026-10-26              |
| 0004         | `app.staff_access_snapshot` (one call per staff request)                                                                                                        | 2026-10-27              |
| 0005, 0006   | `lead_identities` (licence photo or sealed SIN) and the CanadaWide identity mirror functions (temporary)                                                        | 2026-10-27              |
| 0007, 0008   | The read-only `backup_reader` login and a `<table>_backup_reader_read` policy on every RLS table ([backup.md](backup.md))                                       | 2026-10-29              |
| 0009, 0010   | Properties: `properties`, `property_layouts`, `saved_views`, `leads.custom_values`, the property identity guard                                                 | 2026-10-29              |
| 0011, 0012   | `plans`, `leads.order_details`, `properties.website_visible`; payment and commission moved out of the stages                                                    | 2026-10-30              |
| 0013, 0014   | `idempotency_keys`, `workspace_email_settings`, `email_templates`, `email_template_versions`, `automations`, `automation_runs`                                  | 2026-10-30              |
| 0015, 0016   | `site_counters` (order numbers)                                                                                                                                 | 2026-10-30              |
| 0017, 0018   | Customer tracking: `tracking_challenges`, `change_requests`, `files.held_for_change_request`                                                                    | 2026-10-31              |
| 0019, 0020   | Automation flows: `automation_versions`, `automation_step_runs`, `automation_waits`, `automation_timers`, site-made templates, `memberships.notification_email` | 2026-10-31              |
| 0021, 0022   | `ai_automation_proposals`                                                                                                                                       | 2026-11-04              |
| 0023         | `lead_activities.created_at` defaults to `clock_timestamp()`                                                                                                    | 2026-11-05              |
| 0024, 0025   | `ai_turns`; `app.automation_overdue_sites`                                                                                                                      | 2026-11-05              |
| 0026         | `automation_runs.chain`                                                                                                                                         | 2026-11-05              |
| 0027         | A plan's commission columns                                                                                                                                     | by 2026-11-19           |
| 0028         | Email style and accent colour on `workspace_email_settings`                                                                                                     | by 2026-11-19           |
| 0029         | Task status `in_progress`                                                                                                                                       | by 2026-11-19           |
| 0030         | `app.erase_restricted_lead_data` (erasure of a restricted lead's data)                                                                                          | by 2026-11-19           |
| 0031         | Staff invitations expire after 14 days                                                                                                                          | by 2026-11-19           |
| 0032, 0033   | Row security on and forced for `app.workspaces`                                                                                                                 | by 2026-11-19           |
| 0034 to 0036 | Ask AI's saved chat: `ai_conversations`, `ai_messages`, `ai_attachments`, `ai_turns.input_tokens`, `app.sweep_unsent_ai_attachments`                            | by 2026-11-19           |
| 0037         | Ask AI effort level on `ai_turns` and `ai_messages`                                                                                                             | by 2026-11-19           |
| 0038         | Plain tasks: `lead_tasks.lead_id` nullable                                                                                                                      | 2026-11-20              |
| 0039         | Erasure reaches saved chats; departed members' chats are deleted (`ai_messages.erased_at`, five functions)                                                      | 2026-11-20              |
| 0040         | `ai_model_settings` (a site's allowed Ask AI models)                                                                                                            | 2026-11-20              |
| 0041         | Get Canada Sim legacy mirror: trigger `leads_mirror_getcanadasim_legacy` (temporary, see below)                                                                 | 2026-11-20              |
| 0042         | Older restricted drafts lose their attribution extras too (`app.restricted_lead_erased_attribution_keys`, a wider `app.guard_restricted_lead`)                  | 2026-11-21              |
| 0043, 0044   | `service_credentials.lead_types` and its backfill: a site key is limited to the lead types it may send                                                          | 2026-11-21              |
| 0045         | `file_object_deletions`: every storage copy of a document is deleted and retried until storage confirms                                                         | 2026-11-21              |
| 0046         | `leads.submitted_at` (order tracking dates an order by its submission)                                                                                          | 2026-11-21, pre-deploy  |
| 0047         | One current file per lead and document type (`files_one_current_per_slot`)                                                                                      | 2026-11-21, post-deploy |
| 0048         | The Get Canada Sim mirror also copies a rescued order once its name and email are complete                                                                      | **Not applied**         |
| 0049         | `lead_activities_opened_idx`: which leads have been opened (the sidebar count and the New badge stay fast as the timeline grows)                                | **Not applied**         |

"By 2026-11-19" means the migration was found applied when the whole
database was checked that day. What each migration contains is its SQL file
and the schema (`packages/db/src/schema.ts`); the history is in `git log`.

Every `prune_operational_rows` version, grant and policy is in the migration
files. On a rebuilt database, run the migrator and then the role settings
below.

### 0048, not applied yet

`0048_getcanadasim_mirror_when_eligible`: a rescued Get Canada Sim order
reaches the old admin once its contact is complete. 0041 skips a submitted
order with no name or email and only looks at a lead when its status changes,
so an order staff rescued without them and completed later never reaches
`public.orders`. 0048 replaces `app.mirror_getcanadasim_legacy_order()` (same
signature, SECURITY DEFINER, empty `search_path`) and recreates the trigger
as `after insert or update of status, full_name, email`; its BACKFILL copies,
once, every submitted order of the site that has a name and email and no
`public.orders` row. It reads the lead's own columns (never `app.contacts`),
inserts only, and leaves a row with that id or order number alone. No table,
grant or policy changes.

Until it is applied nothing breaks: a rescued SIM order whose name or email
is completed later is still not copied to the old admin. On 2026-11-21 no
existing order needed the backfill.

**To apply** (owner, SQL editor as `postgres`, one transaction, **after
0047**): the file's statements without the `--> statement-breakpoint` lines,
then the tracker row: hash
`25f16006a971ef9eaaa58ca97511608f80b5b2a129b1eab2f846358de00a4a58`,
`created_at` `1795294469261` (49 rows). Replacing the function and the
trigger holds a lock on `app.leads` for a moment (writes wait, reads go on).
Re-running it changes nothing. The deploy order does not matter: no backend
code depends on it.

Verify:

```sql
select pg_get_triggerdef(oid) from pg_trigger
 where tgname = 'leads_mirror_getcanadasim_legacy';
  -- … AFTER INSERT OR UPDATE OF status, full_name, email ON app.leads …
-- Submitted orders still not in the old admin, and why.
select l.id, l.external_ref,
       nullif(btrim(l.full_name), '') is null or nullif(btrim(l.email), '') is null as contact_missing
  from app.leads l join app.workspaces w on w.id = l.workspace_id
 where w.slug = 'getcanadasim' and l.lead_type = 'sim_order' and l.status = 'submitted'
   and l.customer_data_restricted_at is null
   and not exists (select 1 from public.orders o where o.id = l.id);
```

Rollback: re-run 0041's `create function app.mirror_getcanadasim_legacy_order`
as `create or replace`, then `drop trigger leads_mirror_getcanadasim_legacy on
app.leads;` and 0041's `create trigger`; delete the tracker row. Rows already
copied stay in `public.orders`.

### 0049, not applied yet

`0049_lead_activities_opened_index`: one partial index on
`app.lead_activities (workspace_id, lead_id)` for the `opened` system
entries. No query changed, so it goes in before or after the deploy; the
planner simply starts using it. `CREATE INDEX` holds a SHARE lock on the
timeline while it builds (writes wait, reads go on), well under a second at
today's size. Apply it **after 0048**, so the tracker rows stay in journal
order, with its tracker row: hash
`70b094dad2eea8c7659805780d7598e7f35616e0bfa7e58446e12d144f19076c`,
`created_at` `1795303383597` (50 rows).

## Operating notes for applied migrations

### Site keys and their lead types (0043, 0044)

A website key lists the lead types it may send; a create or a draft save of
another type answers `403 lead_type_not_permitted` and stores nothing. 0044
gave each existing key the lead types its site already held leads of; on
2026-11-21 `contact_message` was added to the four active keys so a contact
form is not refused (CanadaWide: `internet`, `mobility`, `contact_message`;
Get Canada Sim: `partner_application`, `sim_order`, `contact_message`).
Revoked keys were left as backfilled.

An owner changes an active key's lead types in Settings → Integrations
("Edit lead types"). To read every active key's list:

```sql
select w.slug, c.id, c.lead_types from app.service_credentials c
  join app.workspaces w on w.id = c.workspace_id where c.revoked_at is null order by w.slug;
```

A key with a null list is not limited.

### Document object deletions (0045)

Each storage object to delete is a row of `app.file_object_deletions`,
written in the transaction that orphans it (a finalize's staging copy, a
rejected or expired upload, every tombstone). The hourly `document_cleanup`
deletes due rows (100 at a time, at most 500 per site per run) and completes
a row only when storage confirms; a key a live file still uses is completed
`kept_referenced` and its object stays. A failed delete backs off from 5
minutes to a day and logs `document_object_delete_failed`; after five failed
tries the owner gets one `document_cleanup_stuck` alert. Older leftovers are
enqueued 200 per site per run until none is left. A deleted object comes
back only from a backup taken before its deletion.

```sql
-- The backlog, per site and state (counts only).
select workspace_id, outcome, count(*), max(attempts) from app.file_object_deletions
 group by 1, 2 order by 1, 2;
-- Stuck rows (the alert's), with their codes.
select workspace_id, last_error, count(*) from app.file_object_deletions
 where completed_at is null and attempts >= 5 group by 1, 2;
```

### Erasure of restricted leads (0030, 0039, 0042)

The daily `data_retention` task restricts abandoned drafts and erases their
data: files (tombstoned, objects deleted through 0045), identities, tasks,
note texts, the contact link, custom values, order details and the
attribution extras `utmTerm`, `utmContent` and `landingPath`; in the same
transaction every Ask AI turn that names the lead is emptied. Leads
restricted before a rule existed are finished by later runs, at most 1000
per site per run. All of it is irreversible.

```sql
-- Restricted leads that still hold an attribution extra: 0 once the clean-up has run.
select count(*) from app.leads
 where customer_data_restricted_at is not null
   and jsonb_exists_any(attribution, app.restricted_lead_erased_attribution_keys());
```

### One current document (0047)

A file is current when it is `available`, not superseded and not held for a
change request; the unique index `files_one_current_per_slot` allows one per
lead and document type. This select returns no rows:

```sql
select workspace_id, record_type, record_id, document_type, count(*)
  from app.files
 where status = 'available' and superseded_by_file_id is null and not held_for_change_request
 group by 1, 2, 3, 4 having count(*) > 1;
```

### Submission dates (0046)

`leads.submitted_at` is stamped when the website submits a lead or staff
rescue a checkout; tracking shows and orders by
`coalesce(submitted_at, created_at)`. A lead an older backend submitted
between the migration and the deploy of 2026-11-21 has no stamp. This count
should be 0; if it is not, run the `UPDATE` of
`packages/db/drizzle/0046_lead_submitted_at.sql` once more (it is
idempotent):

```sql
select count(*) from app.leads where status = 'submitted' and submitted_at is null;
```

### The legacy mirrors (0002, 0005, 0006, 0041; temporary)

**CanadaWide (0002).** An AFTER INSERT trigger on `app.leads` copies every new
`internet` or `mobility` lead of the `canadawide` site into
`public.internet_leads` or `public.mobility_leads` under the same id, in the
same transaction, so the old admin and the mobility ID step keep working. It
is insert-only and idempotent and a no-op where the legacy tables do not
exist. The identity functions of 0005 and 0006
(`app.mirror_canadawide_legacy_identity`,
`app.canadawide_legacy_identity_applies`) write a mobility lead's identity to
`public.mobility_id_uploads`. Drop the trigger, its function and both
identity functions in a new migration at CanadaWide's staff cutover.

**Get Canada Sim (0041).** An AFTER INSERT OR UPDATE OF status trigger copies
each `sim_order` lead of the `getcanadasim` site into `public.orders` at the
moment it is submitted, under the same id and `MS-<n>` number
([legacy-import.md](legacy-import.md#after-the-switch-the-mirror) has the
mapping). Drafts are never copied. It never fails the CRM's write: a
legacy-side error skips the copy and logs
`getcanadasim legacy mirror: lead <id> not copied (…)` at LOG level
(Supabase → Logs → Postgres), with the SQLSTATE only.

- **Nothing is synced after the copy**, in either direction. A customer's
  erasure in the CRM must be repeated by hand in the old admin.
- **Old-side numbering.** The mirror writes `order_no` itself and never moves
  `public.orders`' own sequence. Before anything inserts through that
  sequence again (the old checkout, if `CRM_ORDERS` were turned off), move it
  past the CRM's counter ([legacy-import.md](legacy-import.md#rollback)).
- **Never run the Get Canada Sim import again**: the mirrored orders are in
  `public.orders`.
- Retire it, in a new migration that drops the trigger and both functions
  (`app.mirror_getcanadasim_legacy_order()`,
  `app.copy_getcanadasim_legacy_order(app.leads)`), when the owner retires the
  old Get Canada Sim admin.

```sql
-- Every submitted Get Canada Sim order has its public.orders row. Expect no rows
-- (until 0048 is applied, an order rescued without a name or email may be listed).
select l.id, l.external_ref, l.stage, l.created_at
  from app.leads l join app.workspaces w on w.id = l.workspace_id
 where w.slug = 'getcanadasim' and l.lead_type = 'sim_order' and l.status = 'submitted'
   and l.customer_data_restricted_at is null
   and not exists (select 1 from public.orders o where o.id = l.id)
 order by l.created_at;
-- The copies agree on the number: expect no rows.
select l.id, l.external_ref, o.order_no
  from app.leads l join public.orders o on o.id = l.id
 where l.external_ref is distinct from 'MS-' || o.order_no;
```

## Runtime role settings

`app_runtime` carries `idle_in_transaction_session_timeout = 30s`, set by hand
(not a migration; re-apply it on any rebuilt database):

```sql
alter role app_runtime set idle_in_transaction_session_timeout = '30s';
select rolname, rolconfig from pg_roles where rolname = 'app_runtime';
```

Without it a network blip between Railway and the pooler can leave every
pooled connection `idle in transaction`, and staff sign-in then fails with
"Invalid email or password" until the sessions are ended. With it Postgres
ends such a session after 30 s and the pool replaces it
(`RUNTIME_CONNECTION_TIMEOUTS` in `packages/db/src/index.ts` is the backend's
side). If sign-in hangs, check first:

```sql
select pid, now() - state_change as idle_for, left(query, 80)
from pg_stat_activity where usename = 'app_runtime' and state = 'idle in transaction';
```

## Set or rotate the runtime password

```sql
alter role app_runtime password '<generate with: openssl rand -base64 36>';
```

Then update `DATABASE_URL` on the Railway service and redeploy. Rotation
signs nothing out (staff sessions are Supabase Auth); in-flight requests on the
old pool fail once and retry. The `backup_reader` password is set the same
way and lives only in the backup job's secrets ([backup.md](backup.md)).

## Add a site

```sql
insert into app.workspaces (slug, name, domain) values ('<slug>', '<Name>', '<host>');
insert into app.roles (workspace_id, name)
  select id, r from app.workspaces, unnest(enum_range(null::app.role_name)) as r where slug = '<slug>';
insert into app.permissions (workspace_id, name)
  select id, p from app.workspaces, unnest(enum_range(null::app.permission_name)) as p where slug = '<slug>';
```

Then invite the first owner from the admin (or insert a pending membership
with the `owner` role) and create the site's key under Settings →
Integrations, with the lead types the website sends.

Add the site's id to the scheduler entry's `workspaceIds` in
`MACHINE_REGISTRY_JSON` (docs/ENV.md) and redeploy the backend. Without it the
site's automation waits and time triggers never run; the scheduler logs
`automation_site_unscheduled` and alerts the owner once its work is two ticks
overdue, and its flows show "running late".

## Local database

```sh
createdb crm_test
MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/crm_test MIGRATION_DATABASE_SSL_MODE=disable \
  pnpm --filter @gt-sales/db db:migrate
DB_SEED_ALLOW_SYNTHETIC=1 MIGRATION_DATABASE_URL=postgres://postgres@localhost:5432/crm_test MIGRATION_DATABASE_SSL_MODE=disable \
  pnpm --filter @gt-sales/db db:seed
```

Integration suites need `TEST_MIGRATION_DATABASE_URL` (same URL) and
`DB_TEST_ALLOW_DESTRUCTIVE=1`; they set `app_runtime`'s password to a fixed
CI value on that database, which is why the name must end in `_test`.
