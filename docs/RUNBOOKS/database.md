# Database runbook

Project: Supabase `gtsales-crm` (`xykrphbgpwisqacpyeiv`, Mumbai). The CRM
owns the `app` schema. Get Canada Sim's live tables stay in `public` until
the cutover (merge design §12); nothing here touches them.

## How migrations are tracked

Two trackers must agree:

1. **Drizzle** — `drizzle.__drizzle_migrations` (`hash`, `created_at`). The
   migrator (`pnpm --filter @gt-sales/db db:migrate`) applies every entry of
   `packages/db/drizzle/meta/_journal.json` whose `when` is newer than the
   last row, then records `sha256(file)` + `when`.
2. **Supabase** — `supabase_migrations.schema_migrations`, written only when a
   migration is applied through the Supabase MCP `apply_migration` or the CLI.

The normal path is the Drizzle migrator with `MIGRATION_DATABASE_URL`. When a
migration is instead applied through `apply_migration` (no database password at
hand), add the Drizzle row by hand in the same sitting:

```sql
insert into drizzle.__drizzle_migrations (hash, created_at)
values ('<sha256 of the .sql file>', <journal "when">);
```

Verify against the schema, not the trackers: `select … from pg_tables /
pg_proc / pg_policies where schemaname = 'app'`.

## First install (2026-10-25)

- `0000_app_foundation` applied via `apply_migration` and recorded in both
  trackers.
- `0001_runtime_functions`: the Supabase tool applied the grants, the
  DELETE-free functions and the four triggers, but holds every statement that
  contains REVOKE, ALTER or DELETE for a confirmation prompt the owner never
  received. The remainder (revokes, FORCE RLS, `accept_staff_invitations`,
  `rate_limit_hit`, `prune_operational_rows`, both tracker rows) is in
  [`manual/0001-remaining.sql`](manual/0001-remaining.sql): paste it into the
  SQL editor once. Staff sign-in and website writes need it.
- `app_runtime` role created by `0000`; its password was set the same day and
  lives only in the Railway service's `DATABASE_URL`. The project's pooler is
  the `aws-1-ap-south-1` cluster.
- Sites `getcanadasim` and `canadawide` inserted with the fixed ids from
  `packages/db/src/seed.ts`, each with the seven roles and six permissions, and
  a pending `owner` invitation for the developer's email in both.

## 0002_canadawide_legacy_mirror (2026-10-26)

- Applied with `apply_migration` (Supabase tracker row written by the tool) and
  the Drizzle row added by hand: hash
  `1f725d6481de5750f030e7a03eb11f8e7cc2f8f9c003889b37732e70823a31bc`,
  `created_at` `1793042297882`.
- Verified against the catalog: trigger `leads_mirror_canadawide_legacy` on
  `app.leads`; function `app.mirror_canadawide_legacy_lead()` SECURITY DEFINER,
  owner `postgres` (which has BYPASSRLS, so it can read the site and write the
  legacy tables), `search_path` empty.
- Temporary: drop the trigger and the function in a new migration once phase 2
  retires the old Internet/Mobility Leads pages (docs/HANDOFF.md §2.4).

## 0003_lead_stages_and_staff_names (2026-10-26)

- Additive only, so it went in before the code that reads it: `leads.stage`
  (`text not null default 'new'`, slug check), `memberships.display_name`
  (1–80 characters, trimmed), the board index
  `(workspace_id, lead_type, stage, updated_at)`, the "my tasks" index on
  `lead_tasks`, and covering indexes for the five foreign keys the performance
  advisor flagged (`email_messages`, `follow_up_schedules`,
  `marketing_consents` and `outbox_job_alerts` on their workspace + parent,
  `leads.contact_id`).
- Applied with `apply_migration`; Drizzle row added by hand: hash
  `510072fd8b2d52bb2bc4f39922bf7e5cc89214955184230ddb71a0b179b0e5f1`,
  `created_at` `1793049061874`. Verified against the catalog: both columns,
  all seven indexes, both checks.

## 0004_staff_access_snapshot (2026-10-27)

- Additive: `app.staff_access_snapshot(workspace, actor)`, SECURITY DEFINER
  with an empty `search_path`, EXECUTE for `app_runtime` only. It returns the
  actor's staff membership in one site with role names and permission
  overrides, so every staff request's authorization read is one autocommit
  call instead of a tenant transaction (four round trips to the pooler).
- Applied with `apply_migration` before the code that calls it; Drizzle row
  added by hand: hash
  `83c04de60ce6af095009cfc105c38ef3f5ca04632e84fcb01e9f3fbf462db914`,
  `created_at` `1793071632834`. Verified against the catalog: definer, owner
  `postgres`, `search_path=""`, PUBLIC cannot execute, `app_runtime` can; the
  owner's CanadaWide snapshot returns one row with `owner`.

## 0005_lead_identities (2026-10-27)

- `app.lead_identities`: the identity a customer gives for a credit check
  (CanadaWide's mobility order, step 2), a licence photo as a `files` row or a
  SIN sealed with AES-256-GCM under `SENSITIVE_FIELDS_KEY` (only its last
  three digits readable). Tenant policy, FORCE RLS, `app_runtime` SELECT and
  INSERT only (append-only), a guard against attaching one to a restricted
  lead. `files` now also accepts `image/webp`, which CanadaWide's form allows.
- Transitional `app.mirror_canadawide_legacy_identity(...)`, SECURITY DEFINER,
  EXECUTE for `app_runtime` only: writes the same identity into
  `public.mobility_id_uploads` (SIN in plain text, as the old admin always
  had) for a CanadaWide mobility lead of the caller's own site. Drop it with
  the 0002 trigger at the staff cutover.
- Applied with `apply_migration`; Drizzle row added by hand: hash
  `1f5d8279451e43700e472cb9166c3797c568066a60f965660aa27db803c5caa7`,
  `created_at` `1793080995362`. Verified against the catalog: RLS forced, one
  policy, no UPDATE or DELETE for the runtime role, the guard trigger, the
  mirror definer and its grants, the widened `files` type check.

## 0006_legacy_identity_mirror_result (2026-10-27)

- Replaces 0005's mirror, which raised for any lead that is not a CanadaWide
  mobility lead: `app.mirror_canadawide_legacy_identity(...)` now returns
  whether it wrote (false: nothing to do, nothing written; also false for a
  licence without its copied photo path), and the new read-only
  `app.canadawide_legacy_identity_applies(lead)` answers the same question
  first, so the backend knows whether to copy a licence photo into
  `mobility-ids`. Both SECURITY DEFINER, empty `search_path`, EXECUTE for
  `app_runtime` only, and both read the site from the tenant transaction.
- Applied 2026-10-27 by the owner from the SQL editor with
  [`manual/0006-legacy-identity-mirror.sql`](manual/0006-legacy-identity-mirror.sql)
  (the Supabase tool's confirm prompt for the `DROP FUNCTION` had timed out
  twice), which recorded both tracker rows: Drizzle hash
  `063cfe0eff5e3a986f093c1cca8b1c1c3255e5e90763beb1b206ddae3d1877ac`,
  `created_at` `1793082645098`. Verified against the catalog: both functions
  return `boolean`, SECURITY DEFINER, `search_path=""`, `app_runtime` can
  execute and `anon` cannot.

## 0007_backup_reader + 0008_backup_reader_policies

- The backup job's read-only login `backup_reader` (merge design spec §10,
  [backup.md](backup.md)):
  `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS`,
  no password. It dumps with `pg_dump --enable-row-security`, so instead of
  `BYPASSRLS` or `pg_read_all_data` (both need a superuser, which Supabase's
  `postgres` is not) it has `USAGE` on `app`, `public` and `drizzle`,
  `SELECT` on every table and sequence there, default privileges so later
  `app` and `public` tables and sequences are readable too (`public` because
  Get Canada Sim's legacy tables live there, all owned by the migration
  role), and a
  `PERMISSIVE FOR SELECT TO backup_reader USING (true)` policy named
  `<table>_backup_reader_read` on every RLS table. No INSERT, UPDATE or
  DELETE anywhere.
- Where each policy comes from: the 25 `app` RLS tables (all but
  `app.workspaces`, which has no RLS) declare `backupReadPolicy(...)` in
  `packages/db/src/schema.ts`, generated into 0008, so every future table
  carries one too. The `public` RLS tables the migration role owns get theirs
  from 0007's loop; a `public` table added later needs one by hand.
- Best effort on Supabase's own schemas, where they exist: `USAGE` + `SELECT`
  on `supabase_migrations`, and `USAGE` on `auth` with `SELECT` on exactly
  `auth.users` and `auth.identities`, never the whole schema: the token,
  session and MFA tables must never be readable by the backup role, and a
  restore brings back accounts, never sessions. Neither case fails 0007: where the
  migration role holds a privilege without grant option, PostgreSQL grants
  nothing for it and prints its own "no privileges were granted" WARNING;
  where it holds none at all, 0007's handler turns the error into a WARNING
  (`auth schema not granted to backup_reader`). Either way the backup cannot
  read what was not granted (docs/RUNBOOKS/backup.md step 5).
- **Applied in production 2026-10-29** through the Supabase tool, after the
  pre-paste check in [backup.md](backup.md) step 5 returned no rows: two
  migrations, `0007_backup_reader` (tracker version `20261029164941`) and
  `0008_backup_reader_policies` (`20261029165006`), each verbatim from
  `packages/db/drizzle/` plus its Drizzle tracker row. Drizzle hashes:
  0007 `4518ddd1a136f26ccdd848a39799de7a888b70121a4d4ce390b5a88b7d9d3587`,
  `created_at` `1793273916007`; 0008
  `6d87bd3afd04885626c3d7d1b656de93a4267bf59ffe98a00de01ee947effcfd`,
  `created_at` `1793273993722`. The role has **no password yet**: the owner
  sets it separately (`alter role backup_reader password '<openssl rand -hex 16>'`),
  stored only in the backup job's secrets. For another deployment the
  paste file
  [`manual/0007-0008-backup-reader.sql`](manual/0007-0008-backup-reader.sql)
  does the same from the SQL editor in one transaction.
- Verified 2026-10-29: role attributes as expected; 25 read policies in
  `app` and 15 in `public` (one per `public` RLS table); no `public` table
  the guard would stop on; `supabase_migrations` readable; `auth`: `USAGE`
  **not** granted (`postgres` holds it without grant option), `SELECT` on
  `auth.users` and `auth.identities` granted, no other `auth` table
  readable, and **row security is on** for both tables. So the gt-sales
  backup runs with `BACKUP_AUTH_DATA=skip` (set in the `backup.yml` matrix;
  [backup.md](backup.md) "Facts", "Auth data").
- Verify with the five selects at the end of the manual file, one at a time
  (the SQL editor shows only the last result): the role's attributes
  (`rolcanlogin` true, `rolsuper`, `rolbypassrls`, `rolcreaterole` false);
  25 `_backup_reader_read` policies in `app`; no `public` table the backup's
  guard would stop on (no `SELECT`, or row security without a PERMISSIVE
  SELECT/ALL `USING (true)` policy naming `backup_reader`, or with a
  RESTRICTIVE SELECT/ALL policy for it or `public`); `USAGE` on `auth` and
  `SELECT` on `auth.users` and `auth.identities` with no other `auth` table
  readable (a false means the `auth` grant warned); and neither of those two
  tables with row security on. A false or a row in the last two means
  `backup_reader` would miss staff accounts (under `--enable-row-security` an
  RLS table it has no policy on reads as empty, and `postgres` cannot add a
  policy to a table it does not own): set `BACKUP_AUTH_DATA=skip` for the
  backup job until that is fixed.
- Locally and in CI neither `auth` nor `supabase_migrations` exists, so those
  grants are skipped; `packages/db/tests/backup-reader.integration.test.ts`
  checks the role, the policies, the privileges, the `public` default
  privileges, a re-run of 0007 against a stand-in `auth` schema (idempotent,
  only `users` and `identities` readable) and a real connection as
  `backup_reader` (password from `setTestBackupReaderPassword`).

## 0009_properties

- Phase 2's property engine (docs/superpowers/plans/2026-10-29-phase-2-properties-layout-views.md),
  generated from `packages/db/src/schema.ts`. Additive only: three new tables
  and one new column with a default, so it can go in before the code that
  reads them.
- `app.properties`: a site's property definitions per `object` (`lead` now,
  `plan` later), either a custom property (`origin = 'custom'`) or an
  override of a code built-in (`origin = 'builtin'`: relabel or hide). Checks
  on `object`, `key` (`^[a-z][A-Za-z0-9_]{0,63}$`), `origin`, `label`
  (1–80), `kind` (the 12 kinds of `PROPERTY_KINDS`) and `options` (a JSON
  array). Unique `(workspace_id, id)` and `(workspace_id, object, key)`; the
  second includes tombstones on purpose, so a deleted key is reserved
  forever. Tenant policy.
- `app.property_layouts`: one layout per `(workspace_id, object, lead_type)`,
  `lead_type` `''` for the object's default, `layout` a JSON object. Tenant
  policy.
- `app.saved_views`: a person's private views. `actor_id` with the FK
  `(workspace_id, actor_id) → memberships(workspace_id, user_id)` on delete
  cascade, `name` 1–60 characters once trimmed, `state` a JSON object, unique
  index `saved_views_owner_name_unique (workspace_id, actor_id, object,
lower(name))`. The **owner policy** `saved_views_owner_policy` (helper
  `ownerPolicy` in schema.ts): the tenant predicate plus
  `actor_id = app.actor_id`, so a colleague's view reads as missing and
  nobody can save one for someone else.
- `app.leads.custom_values`: `jsonb not null default '{}'`, check
  `leads_custom_values_check` (`jsonb_typeof = 'object'`). Adding it rewrites
  no rows (constant default); the check scans `leads` once.
- Each new table declares `backupReadPolicy(...)`, so `app` now has 28
  `_backup_reader_read` policies; `backup_reader` needs no new grant (0007's
  default privileges).
- Drizzle hash `fc29a234e9726f0af4aa523a011d67f148203fed528de8794e8a81a4c7c18aaf`,
  `created_at` `1793296569722`. Applied in production 2026-10-29 through the
  Supabase tool as migration `0009_properties` (tracker version
  `20261029215922`), verbatim plus its Drizzle tracker row.

## 0010_properties_runtime

- Hand-written companion to 0009: `FORCE ROW LEVEL SECURITY` on the three
  tables; `app_runtime` gets `SELECT, INSERT, UPDATE` on `properties` (no
  DELETE: a custom property is tombstoned with `deleted_at`) and on
  `property_layouts` (replaced in place), and `SELECT, INSERT, UPDATE,
DELETE` on `saved_views`.
- Trigger `properties_identity_guard` (BEFORE UPDATE on `app.properties`,
  function `app.guard_property_identity()`, invoker, `search_path`
  `pg_catalog, app`) raises `restrict_violation` (SQLSTATE 23001) when
  `workspace_id`, `object`, `key`, `kind` or `origin` changes
  (`property_identity_locked`), when a set `deleted_at` changes at all
  (`property_tombstone_permanent`), or when a built-in row gets a
  `deleted_at` (`builtin_property_not_deletable`).
- Drizzle hash `2ae0e451305f7110cb3262f086535e09f484fb844da2b020c9d090321544815f`,
  `created_at` `1793296580888`. Applied in production 2026-10-29 as
  `0010_properties_runtime` (tracker version `20261029215938`); the six
  verification selects matched (three tables forced, six policies, 28
  backup read policies, grants, the trigger, `custom_values` `'{}'` on all
  912 leads).
- To apply both (the Supabase tool holds ALTER and GRANT statements for a
  confirm prompt): paste
  [`manual/0009-0010-properties.sql`](manual/0009-0010-properties.sql) into
  the SQL editor once, as `postgres`. It is one transaction with both files
  verbatim and all four tracker rows; the migrator then finds nothing to do.
  Then run its six verification selects one at a time: the three tables with
  RLS enabled and forced; their six policies; 28 backup read policies in
  `app`; the runtime grants above and `backup_reader` `SELECT` on all three;
  the trigger enabled; and `leads.custom_values` with its default, `NOT
NULL` and its check. Record the date and the Supabase tracker versions
  here afterwards.
- `packages/db/tests/properties.integration.test.ts` covers the owner policy
  (two people's views named "Mine", a colleague's select, update and delete
  touching nothing, no view saved for someone else), the reserved key, the
  guard, the shape checks, `custom_values`, FORCE RLS, the policies and the
  grants.

## 0011_plans

- Phase 3's plans and order details
  (docs/superpowers/plans/2026-10-30-phase-3-plans-stages-archive.md),
  generated from `packages/db/src/schema.ts`. Additive: one new table and two
  new columns with constant defaults.
- `app.plans`: a site's plans, one order lead type each. `lead_type`
  (`^[a-z0-9_]{1,64}$`), `name` (1–120 characters once trimmed),
  `price_minor bigint` (cents, `>= 0`, default 0), `currency` (`= 'CAD'`),
  `billing_period` (`one_time`, `month`, `30_days`, `90_days`, `year`;
  default `month`), `payment_required` (default false), `active` (default
  true), `required_documents text[]` (default `{}`), `custom_values` (a JSON
  object: the site's custom plan properties), `position`, `version`,
  `created_by`, `updated_by`, timestamps. Unique `(workspace_id, id)` and
  unique index `plans_workspace_type_name_unique (workspace_id, lead_type,
lower(name))`. Tenant policy and `plans_backup_reader_read`, so `app` now
  has 29 `_backup_reader_read` policies.
- `app.leads.order_details`: `jsonb not null default '{}'`, check
  `leads_order_details_check` (`jsonb_typeof = 'object'`): an order lead's
  plan link, frozen plan, quantity, payment status and carrier commission;
  `{}` for every other lead. `app.properties.website_visible`: `boolean not
null default false` (plan properties shown to the website). Neither
  rewrites rows (constant defaults); the check scans `leads` once.
- Drizzle hash `ce21f737d78ea05f0c3ccd46dbe86d76aff29a01bee10b1a997095770e524ca0`,
  `created_at` `1793326396341`. Not applied in production yet.

## 0012_plans_runtime

- Hand-written companion to 0011: `FORCE ROW LEVEL SECURITY` on `plans`;
  `app_runtime` gets `SELECT, INSERT, UPDATE` (no DELETE: a plan no longer
  sold is made inactive).
- Seed: for the site with slug `getcanadasim`, when it exists, Get Canada
  Sim's six SIM plans (contracts `SIM_PLANS`; the labels are the names, the
  label's dollars ×100 the price: 5000, 4000, 3500, 4000, 3500, 7500;
  `sim_order`, `month`, payment required, active, positions 0–5), `ON
CONFLICT DO NOTHING` on the name index.
- Data migration, every `sim_order` lead whose `order_details` is still `{}`
  (archived and restricted ones included): `order_details = { planId: null,
plan: null, quantity: 1, paymentStatus, carrierCommission }`, where
  `paymentStatus` is `paid` for the stages paid, verified, delivered,
  activated, completed and invoiced, `not_needed` for cancelled and on_hold,
  otherwise `pending`; `carrierCommission` is `invoiced` for an invoiced
  lead, else from the form's `commissionStatus` (`invoiced`,
  `commission_received` → `received`, `claw_back` → `clawback`), else
  `not_yet`. Then `paid` → `pending` and `invoiced` → `completed`, with one
  `system` timeline entry per moved lead (body `Stage Paid became Pending;
payment status set to Paid (phase 3 migration)` or `Stage Invoiced became
Completed; carrier commission set to Invoiced (phase 3 migration)`, data
  `{"migration":"0012"}`, actor the legacy-import actor
  `00000000-0000-4000-8000-00000000a001`, which the Get Canada Sim import
  does not count as CRM work). `updated_at` is left alone. Other lead types
  keep `{}`. The form's `commissionStatus` stays where it was; the next Get
  Canada Sim import run removes it (legacy-import.md). Re-running changes nothing (only `{}` leads are touched).
- Drizzle hash `e243ef2f8914f732d0357f88f2b3e97661354b6b3d803d4cba66f9e24e1c36ff`,
  `created_at` `1793326400817`. Not applied in production yet.
- To apply both, before deploying a backend that reads `plans` or
  `order_details` and before the next Get Canada Sim import run: in the SQL
  editor, as `postgres`, run
  [`manual/0011-0012-plans.sql`](manual/0011-0012-plans.sql)'s pre-check (A:
  no `plans`, neither column, no tracker rows, `getcanadasim` present) and
  its reconciliation (B: `sim_order` leads per site, stage and payment
  status, archived and restricted counted) and keep B's rows as the
  **before** counts; paste `BEGIN` … `COMMIT` once (one transaction, both
  files verbatim and all four tracker rows; the migrator then finds nothing
  to do); run the seven verification selects one at a time (`plans` forced,
  its two policies, 29 backup read policies, the grants, both columns, the
  six plans, the 20 moved leads with nothing left in `paid`/`invoiced`), then
  B again for the **after** counts. Expected from production on 2026-10-30
  (139 `sim_order` leads, 44 archived): before incomplete 23, pending 59,
  verified 1, delivered 1, activated 8, completed 13, cancelled 14, paid 20;
  after pending 79 (59 `pending` + 20 `paid`), every other stage unchanged,
  no `paid` or `invoiced`, every lead with a payment status. Record the date,
  the Supabase tracker versions and both sets of counts here afterwards.
- Rehearsed 2026-10-30 on a local database migrated to 0010 with those
  production counts: the paste file ran as written and its checks and the
  after counts were as above; the migrator then applied nothing.
- `packages/db/tests/plans.integration.test.ts` covers RLS and FORCE on
  `plans`, the policies and grants (no DELETE), site isolation, the name
  unique per type ignoring case, the defaults and every check,
  `order_details` and `website_visible`, and re-runs 0012 inside a
  rolled-back transaction: the seed (six plans for `getcanadasim`, none
  elsewhere, idempotent) and the mapping for every stage, both commission
  sources, an archived and a restricted lead, one entry per moved lead, an
  `internet` lead left at `{}`, and a second run changing nothing.

## Historical CanadaWide import (2026-10-27)

Not a migration: a re-runnable data script, `packages/db/sql/canadawide-legacy-import.sql`,
run as `postgres`. Procedure, mapping and the run log: [legacy-import.md](legacy-import.md).

## Set or rotate the runtime password

```sql
alter role app_runtime password '<generate with: openssl rand -base64 36>';
```

Then update `DATABASE_URL` on the Railway service and redeploy. Rotation
signs nothing out (staff sessions are Supabase Auth); in-flight requests on the
old pool fail once and retry.

## Add a site

```sql
insert into app.workspaces (slug, name, domain) values ('<slug>', '<Name>', '<host>');
insert into app.roles (workspace_id, name)
  select id, r from app.workspaces, unnest(enum_range(null::app.role_name)) as r where slug = '<slug>';
insert into app.permissions (workspace_id, name)
  select id, p from app.workspaces, unnest(enum_range(null::app.permission_name)) as p where slug = '<slug>';
```

Then invite the first owner from the admin (or insert a pending membership
with the `owner` role) and create the site's key under Settings so the
website can send leads.

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
