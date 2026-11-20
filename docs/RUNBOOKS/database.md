# Database runbook

Project: Supabase `gtsales-crm` (`xykrphbgpwisqacpyeiv`, Mumbai). The CRM
owns the `app` schema. Get Canada Sim's live tables stay in `public` until
the cutover (docs/PLAN.md §7); nothing here touches them.

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

On 2026-11-19 the hosted database was checked: migrations 0000 to 0037 are
all applied, the Drizzle tracker holding rows 1 to 38, each verified against
its file's SHA-256. 0038 is the one prepared and waiting.

## Runtime role settings (2026-11-13)

`app_runtime` carries `idle_in_transaction_session_timeout = 30s`, set by hand
(not a migration; re-apply it on any rebuilt database):

```sql
alter role app_runtime set idle_in_transaction_session_timeout = '30s';
select rolname, rolconfig from pg_roles where rolname = 'app_runtime';
```

Why: on 2026-11-13 a network blip between Railway and the Supabase pooler left
all eight pooled backend connections half-open, each `idle in transaction`
right after its `begin`. Every request then waited on them, so staff sign-in
failed with "Invalid email or password" until the sessions were ended by hand.
With the setting, Postgres ends such a session after 30 s and the backend's
pool replaces it. The backend side has the matching connection timeouts
(`RUNTIME_CONNECTION_TIMEOUTS` in `packages/db/src/index.ts`). No legitimate
backend transaction sits idle that long: every one runs its statements back
to back.

If sign-in hangs again, check first:

```sql
select pid, now() - state_change as idle_for, left(query, 80)
from pg_stat_activity where usename = 'app_runtime' and state = 'idle in transaction';
```

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

- The backup job's read-only login `backup_reader` (merge decision 19,
  docs/PLAN.md §1.1; [backup.md](backup.md)):
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

- Merge phase 2's property engine, generated from `packages/db/src/schema.ts`. Additive only: three new tables
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

- Merge phase 3's plans and order details, generated from `packages/db/src/schema.ts`. Additive: one new table and two
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
  `created_at` `1793326396341`. Applied to the hosted project on 2026-10-30
  (Supabase tracker version `20261030041921`, name `0011_plans`; the Drizzle
  tracker row added in the same run), from the Supabase tool with the file's
  statements verbatim; see 0012 below for the checks.

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
  Canada Sim import run removes it (legacy-import.md). Re-running changes
  nothing (only `{}` leads are touched).
- Drizzle hash `e243ef2f8914f732d0357f88f2b3e97661354b6b3d803d4cba66f9e24e1c36ff`,
  `created_at` `1793326400817`. Applied to the hosted project on 2026-10-30
  (Supabase tracker version `20261030041954`, name `0012_plans_runtime`),
  right after 0011, from the Supabase tool with the file's statements
  verbatim plus the Drizzle tracker row. Pre-check A before: no `plans`,
  neither column, 0 tracker rows, `getcanadasim` present. Reconciliation B
  before (all `getcanadasim`, 139 leads, 44 archived, 3 restricted):
  incomplete 23 (11 archived, 3 restricted), pending 59 (25 archived),
  verified 1, delivered 1, activated 8, completed 13, cancelled 14 (8
  archived), paid 20; `payment_status` null throughout. The seven
  verification selects after: `plans` row security on and forced; policies
  `plans_backup_reader_read`, `plans_tenant_policy`; 29 backup read
  policies; `app_runtime` select/insert/update true, delete false,
  `backup_reader` select true; `leads.order_details` `'{}'::jsonb` not null
  with its check, `properties.website_visible` false not null; the six plans
  at positions 0–5 with the prices above, `sim_order`, CAD, month, payment
  required, active; `moved` 20, `moved_from_invoiced` 0,
  `sim_order_without_payment_status` 0, `old_stages_left` 0,
  `other_leads_with_order_details` 0; both Drizzle tracker rows present. B
  after: incomplete/pending 23 (11 archived, 3 restricted), pending/pending
  59 (25 archived), pending/paid 20, verified/paid 1, delivered/paid 1,
  activated/paid 8, completed/paid 13, cancelled/not_needed 14 (8 archived);
  139 leads, 44 archived, no `paid` or `invoiced` stage, no null payment
  status. Select 7 run again after the phase 3 backend deployed (PR #4,
  `e33a70a`, 2026-10-30): moved 20, `old_stages_left` 0, nothing else
  changed; the SIM-order freeze window is over.
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
  no `paid` or `invoiced`, every lead with a payment status. (Done on
  2026-10-30 through the Supabase tool rather than the paste file: same
  statements, same checks, counts as recorded above.)
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

## 0013_order_tools

- Merge phase 4's order tools and customer email, generated from `packages/db/src/schema.ts`. Additive: six new tables and
  one new nullable column, no data migration.
- `app.idempotency_keys`: a website's double-submit protection. `scope`
  (`lead_submission`), `key_hash` (`^[0-9a-f]{64}$`), `request_fingerprint`
  (`^sha256:[0-9a-f]{64}$`), `lead_id` (FK `(workspace_id, lead_id)` →
  leads, cascade), `status` (`pending` default, `completed`),
  `completed_at`, `created_at`; check `idempotency_keys_completed_check`
  (`completed` exactly when `completed_at` and `lead_id` are set); unique
  `idempotency_keys_scope_key_unique (workspace_id, scope, key_hash)`; index
  `(workspace_id, created_at)` for pruning.
- `app.workspace_email_settings`: one row per site (`workspace_id` is the
  key). `from_name` (1–80 characters once trimmed), `from_address` (≤ 254,
  `^[^\s@]+@[^\s@]+\.[^\s@]+$`), `reply_to` (nullable, the same check),
  `logo_url` and `site_url` (nullable, `^https://`, ≤ 2048), `brand_color`
  (`^#[0-9a-f]{6}$`, default `#d72638`), `footer_text` (≤ 500, default
  `''`), `updated_by`, `updated_at`.
- `app.email_templates`: a site's current copy of one email, content only
  (no on/off: sending is an automation's call). `key` (`tracking_code`,
  `order_received`, `information_needed`, `dispatched`, `activated`,
  `cancelled`, `sim_number_ready`), `subject` (1–150), `body` (1–5000),
  `version` (`> 0`), `updated_by`, `updated_at`; unique `(workspace_id,
key)`.
- `app.email_template_versions`: every saved version, append-only. `key`,
  `version`, `subject`, `body` (the same checks), `created_by`,
  `created_at`; unique `(workspace_id, key, version)`.
- `app.automations`: a site's state of one built-in automation rule. `key`
  (`order_received`, `sim_order_information_needed`,
  `sim_order_dispatched`, `sim_order_activated`, `sim_order_cancelled`,
  `mobility_activated`), `enabled` (default false), `last_run_at`,
  `run_count` (`>= 0`, default 0), `updated_by`, `updated_at`; unique
  `automations_workspace_key_unique (workspace_id, key)`.
- `app.automation_runs`: one firing for a lead, append-only.
  `automation_key` (the same six), `lead_id` (FK `(workspace_id, lead_id)`
  → leads, cascade), `outcome` (`queued`, `skipped`), `reason` (null or
  `no_sender`, `no_customer_email`, `missing_fill_in`), `job_id`,
  `created_at`; checks: `skipped` exactly when there is a reason, `queued`
  exactly when there is a job id; index
  `automation_runs_workspace_key_created_idx (workspace_id, automation_key,
created_at desc)`.
- Each of the six has its tenant policy and `<table>_backup_reader_read`,
  so `app` now has 35 `_backup_reader_read` policies.
- `app.email_messages.template_version`: `integer`, nullable, no default,
  check `email_messages_template_version_check` (`is null or >= 0`): the
  template version a site-content email was rendered from. No rewrite; the
  check scans `email_messages` once.
- Drizzle hash `dc79cd6b92a16064141144d74734b4f9d1a0ca70ef28c7c1f90221e28ea47962`,
  `created_at` `1793349931483`. Applied to the hosted project on 2026-10-30
  (Supabase tracker version `20261030135521`, name `0013_order_tools`; the
  Drizzle tracker row added in the same run), from the Supabase tool with the
  file's statements verbatim. Pre-check A before: the six tables absent, no
  `template_version` column, 0 tracker rows.

## 0014_order_tools_runtime

- Hand-written companion to 0013: `FORCE ROW LEVEL SECURITY` on the six;
  `app_runtime` gets `SELECT, INSERT, UPDATE` on `idempotency_keys`,
  `workspace_email_settings`, `email_templates` and `automations`, and
  `SELECT, INSERT` only on `email_template_versions` and `automation_runs`
  (append-only). No DELETE on any of them.
- `app.prune_operational_rows` replaced (`CREATE OR REPLACE`) with 0001's
  body plus two blocks: `idempotency_keys` older than 7 days (by
  `created_at`, pending or completed) and `automation_runs` older than 90
  days, each at most 1000 rows per call and reported under its table's name;
  then the same `REVOKE ALL … FROM PUBLIC` and `GRANT EXECUTE … TO
app_runtime`. The scheduler's `data_retention` run (on only with
  `OPERATIONAL_RETENTION_ENABLED=1`) picks both up with no code change.
- Every statement is safe to run twice. No data migration.
- Drizzle hash `c84d2ebed00c0fb61f26e79e68887636a2db1e30701d406ef4c7d6acd2c0ea60`,
  `created_at` `1793349941965`. Applied to the hosted project on 2026-10-30
  (Supabase tracker version `20261030151130`, name `0014_order_tools_runtime`,
  inserted by hand), right after 0013, statement for statement from the file:
  the six `FORCE ROW LEVEL SECURITY` and six `GRANT`s through the Supabase
  tool's SQL runner; the `prune_operational_rows` replacement pasted by the
  owner in the SQL editor (the tool asks for a confirmation on a function body
  with `DELETE`s, and the prompt could not be answered from the session); then
  the `REVOKE`/`GRANT EXECUTE` and both tracker rows through the tool. The
  seven verification selects afterwards: six tables `true, true`; twelve
  policies; 35 backup read policies; grants as listed (no `DELETE` anywhere,
  `UPDATE` false on the two append-only tables); `template_version integer`
  nullable, no default, check present; prune function names both new tables
  and is `SECURITY DEFINER`; both Drizzle rows present.
- The steps that were used, kept for the next time a hand apply is needed: before deploying a backend that reads the six tables or
  `email_messages.template_version`: in the SQL editor, as `postgres`, run
  [`manual/0013-0014-order-tools.sql`](manual/0013-0014-order-tools.sql)'s
  pre-check (A: the six tables absent, no `template_version` column, no
  tracker rows); paste `BEGIN` … `COMMIT` once (one transaction, both files
  verbatim and all four tracker rows; the migrator then finds nothing to
  do); run the seven verification selects one at a time (the six forced,
  their twelve policies, 35 backup read policies, the grants per table and
  verb with no DELETE anywhere and no UPDATE on the two append-only tables,
  the nullable column with its check, the prune function naming both new
  tables, both Drizzle rows). Or apply both files verbatim through the
  Supabase tool and add the Drizzle rows in the same sitting. Record the
  date, the Supabase tracker versions and the results here.
- Rehearsed 2026-10-30 on a local database migrated to 0012: pre-check A as
  expected, the paste file ran as written, the seven selects gave the
  expected rows, and the migrator then applied nothing.
- `packages/db/tests/order-tools.integration.test.ts` covers RLS and FORCE
  on the six, their policies and the 35 backup read policies, the grants (no
  DELETE, no UPDATE on versions or runs), site isolation, every check and
  unique constraint, `email_templates` having no `enabled` column, the
  `template_version` column, and re-runs 0014 twice inside a rolled-back
  transaction. `apps/backend/tests/operational-retention.integration.test.ts`
  covers the two new prune blocks (a key 8 days old pruned, 6 days kept; a
  run 91 days old pruned, 89 kept; both tables listed).

## 0015_order_numbers

- Merge phase 5, step A, generated from `packages/db/src/schema.ts`. Additive: one new table, no
  data migration.
- `app.site_counters`: a site's own running numbers, one row per site and
  counter. `workspace_id` (FK → workspaces, cascade), `counter` (check
  `site_counters_counter_check`: `sim_order_ref` only; 0017 adds
  `change_request_no`), `last_value` (`integer`, check
  `site_counters_last_value_check` `>= 0`: the last number issued),
  `updated_at`; primary key `(workspace_id, counter)`. `sim_order_ref` is the
  last `MS-<n>` order number the backend gave a new SIM order: it is advanced
  in the lead's own transaction (`apps/backend/src/leads/site-counter.ts`),
  seeds itself from the site's highest imported `MS-<n>` on first use, and
  is raised on switch day by `manual/gcs-switch-day.sql`.
- Its tenant policy and `site_counters_backup_reader_read`, so `app` now has
  36 `_backup_reader_read` policies.
- Drizzle hash `e5544ea194961ff67154ff03aae20a077a15283273314edc9675afed77619058`,
  `created_at` `1793380650712`. Applied to the hosted project on 2026-10-30
  (Supabase tracker version `20261030175305`, name `0015_order_numbers`,
  inserted by hand) through the Supabase tool's SQL runner, statement for
  statement from the file, with the Drizzle tracker row. Pre-check A before:
  no `app.site_counters`, 0 tracker rows.

## 0016_order_numbers_runtime

- Hand-written companion to 0015: `FORCE ROW LEVEL SECURITY` on
  `app.site_counters`; `app_runtime` gets `SELECT, INSERT, UPDATE` (no
  DELETE: a counter only goes up, and its row goes with its site). No
  function change, no pruning, no data migration. Every statement is safe to
  run twice.
- Drizzle hash `3e6c35c0b2f4c3e8f35adc61a195e8d23027ba9ecf7a39452f0586a4a0015fff`,
  `created_at` `1793380656599`. Applied right after 0015 the same way
  (tracker version `20261030175306`, name `0016_order_numbers_runtime`).
  Verification after both: `site_counters` row security on and forced; its
  two policies; 36 backup read policies; `app_runtime` `SELECT`, `INSERT`,
  `UPDATE` true and `DELETE` false; `backup_reader` `SELECT` true; the four
  constraints; both Drizzle rows; no counter rows yet. No statement tripped
  the confirmation prompt.
- To apply, before deploying a backend that numbers SIM orders: in the SQL
  editor, as `postgres`, run
  [`manual/0015-0016-order-numbers.sql`](manual/0015-0016-order-numbers.sql)'s
  pre-check (A: `site_counters` absent, no tracker rows); paste `BEGIN` …
  `COMMIT` once (one transaction, both files verbatim and all four tracker
  rows; the migrator then finds nothing to do); run the six verification
  selects one at a time (the table forced, its two policies, 36 backup read
  policies, the grants with no DELETE, the two checks, both Drizzle rows).
  Or apply the plain statements through the Supabase tool in small batches,
  hand the `ALTER`s to the owner as a paste, add the tracker rows by hand and
  verify against the catalog. Record the date, the Supabase tracker versions
  and the results here.
- Rehearsed 2026-10-30 on a local database migrated to 0014: pre-check A
  gave `null, 0`, the paste file ran as written, the six selects gave the
  expected rows, and the migrator then applied nothing.
- `packages/db/tests/order-numbers.integration.test.ts` covers RLS and FORCE,
  the two policies and the 36 backup read policies, the grants (no DELETE),
  site isolation, both checks (`change_request_no` and `x` refused, `-1`
  refused), the primary key, the cascade with the site, and re-runs 0016
  twice inside a rolled-back transaction.

## 0017_customer_tracking

- Merge phase 5, step B, generated from `packages/db/src/schema.ts`. Additive: two new tables, one
  new column with a constant default, three widened checks, no data
  migration.
- `app.tracking_challenges`: one six-digit code a customer asked for on
  `/track`. `workspace_id` (FK → workspaces, cascade), `email_hash` and
  `code_hash` (keyed hashes, each `^[0-9a-f]{64}$`; never the email or the
  code), `attempts` (`>= 0`, default 0), `status` (`pending` default,
  `consumed`), `expires_at`, `consumed_at`, `created_at`; check
  `tracking_challenges_consumed_check` (`consumed` exactly when
  `consumed_at` is set); index `tracking_challenges_workspace_email_idx
(workspace_id, email_hash, status, created_at desc)`.
- `app.change_requests`: a customer's request to change an order, decided by
  staff. `lead_id` (FK `(workspace_id, lead_id)` → leads, cascade),
  `request_no` (`> 0`; unique `change_requests_workspace_request_no_unique
(workspace_id, request_no)`), `status` (`pending` default, `approved`,
  `rejected`), `requested` (jsonb, default `{}`: the values asked for,
  personal data, never copied elsewhere), `staged_file_ids` (`uuid[]`,
  default empty), `version` (`> 0`, default 1), `created_by`,
  `resolved_by`, `resolved_at`, `created_at`, `updated_at`; check
  `change_requests_resolved_check` (`pending` exactly when `resolved_at` is
  null, and `resolved_at` null exactly when `resolved_by` is: never half
  resolved); unique `(workspace_id, id)`; partial
  unique index `change_requests_one_pending (workspace_id, lead_id) where
status = 'pending'`; index `(workspace_id, lead_id, created_at desc)`.
- `app.leads` index `leads_workspace_email_idx (workspace_id,
lower(btrim(email)))`: the tracking lookups match a site's leads by the
  normalized email. A plain `CREATE INDEX`, which holds writes to
  `app.leads` while it builds (seconds at today's size).
- `app.files.held_for_change_request`: `boolean not null default false`
  (constant default, no rewrite): a customer's document sent with a pending
  change request, not current until the request is approved.
- `email_templates_key_check` and `email_template_versions_key_check` now
  also name `change_approved` and `change_rejected` (nine keys);
  `site_counters_counter_check` now names `sim_order_ref` and
  `change_request_no`. Each is dropped and re-added, which scans its table
  once.
- Each new table has its tenant policy and `<table>_backup_reader_read`, so
  `app` now has 38 `_backup_reader_read` policies.
- Drizzle hash `7b4e5292e29ac1fdc8ab891e604d82dbbe9e3997e5756d73f6d2f120c817ad94`,
  `created_at` `1793385700370`. **Applied** to the hosted project on
  2026-10-31 through the Supabase tool's `execute_sql`, verified against the
  schema (the column, the widened counter check); the tracker rows go in
  after the owner's `prune_operational_rows` paste (0018 below).

## 0018_customer_tracking_runtime

- Hand-written companion to 0017: `FORCE ROW LEVEL SECURITY` on both new
  tables; `app_runtime` gets `SELECT, INSERT, UPDATE` on both (no DELETE:
  challenges are pruned, change requests are kept, both go with their site).
- `app.prune_operational_rows` replaced (`CREATE OR REPLACE`) with 0014's
  body plus one block: `tracking_challenges` whose `expires_at` is more than
  a day before `p_now`, at most 1000 rows per call, reported as
  `tracking_challenges`; then the same `REVOKE ALL … FROM PUBLIC` and
  `GRANT EXECUTE … TO app_runtime` as 0014. Change requests are never
  pruned.
- **The `CREATE OR REPLACE FUNCTION app.prune_operational_rows` statement is
  the one the owner pastes by hand** in the SQL editor (the Supabase tool
  asks for a confirmation on a function body with `DELETE`s, as in phase 4);
  it is marked `OWNER PASTE` in the paste file.
- Every statement is safe to run twice. No data migration.
- Drizzle hash `900a964eac69947a733e022e05e1664a2c03f312cced36c510383e9faa99ffc2`,
  `created_at` `1793385701352`. **Applied** to the hosted project on
  2026-10-31 through `execute_sql` (FORCE RLS, the policies and grants
  verified against the schema), **except the owner-pasted
  `app.prune_operational_rows` replacement**: until it is pasted the daily
  pruning skips tracking challenges. After that paste, insert the 0017 and
  0018 tracker rows (both trackers) and run the paste file's verification
  selects for the prune function and the tracker rows.
- Before applying, check that every sending site has saved Settings →
  Email (docs/HANDOFF.md §5.1, the Senders check): the backend deployed after these
  migrations no longer reads `EMAIL_SENDERS_JSON`, so a site without saved
  settings stops sending customer mail at that deploy. On 2026-10-30
  production had no saved settings for either site and had sent no customer
  mail in 30 days.
- To apply, before deploying a backend that uses customer tracking: in the
  SQL editor, as `postgres`, run
  [`manual/0017-0018-customer-tracking.sql`](manual/0017-0018-customer-tracking.sql)'s
  pre-check (A: both tables absent, no `held_for_change_request` column, no
  tracker rows); paste `BEGIN` … `COMMIT` once (one transaction, both files
  verbatim and all four tracker rows; the migrator then finds nothing to
  do); run the eight verification selects one at a time (the two forced,
  their four policies, 38 backup read policies, the grants per table and
  verb with no DELETE, the column with its default and the email index, the
  resolved check, the two template checks and the counter check naming the
  new keys, the prune function naming
  `tracking_challenges`, both Drizzle rows). Or apply the plain DDL and
  grants through the Supabase tool in small batches, hand the `ALTER`s, the
  `REVOKE` and the function replacement to the owner as a paste, add the
  tracker rows by hand and verify against the catalog (`pg_class`,
  `pg_policies`, `pg_proc`, `has_table_privilege`), never the trackers.
  Record the date, the Supabase tracker versions and the results here.
- Rehearsed 2026-10-30 on a local database migrated to 0016: pre-check A
  gave `null, null, false, 0`, the paste file ran as written, the eight
  selects gave the expected rows, and the migrator then applied nothing.
- `packages/db/tests/customer-tracking.integration.test.ts` covers RLS and
  FORCE on both, their policies and the 38 backup read policies, the grants
  (no DELETE), site isolation, every check and unique constraint (one
  pending request per lead, request numbers per site, no half-resolved
  request), the leads email index, the cross-site lead
  FK and the cascade, the two template keys in both tables, the
  `change_request_no` counter, the file column's default, and re-runs 0018
  twice inside a rolled-back transaction.
  `apps/backend/tests/operational-retention.integration.test.ts` covers the
  new prune block (a challenge expired 25 hours ago pruned, 23 hours kept,
  another site's kept; a change request never pruned; the table listed).

## 0019_automation_flows

- Merge phase 8, step A (automation flows), generated from `packages/db/src/schema.ts` and then reordered by hand
  before any apply (the `(workspace_id, id)` unique constraints on
  `automations` and `automation_runs` come before the composite FKs that
  reference them; `db:generate` reports no drift). Additive: every new
  column is nullable or has a constant or `now()` default, so no table is
  rewritten.
- New tables, each with its tenant policy and `<table>_backup_reader_read`
  (so `app` now has 42 `_backup_reader_read` policies):
  `app.automation_versions` (a flow's draft, active, retired and discarded
  versions; one draft and one active per flow; the definition at most 64 KiB),
  `app.automation_step_runs` (one row per step outcome, append-only,
  `created_at` from `clock_timestamp()` so a run's steps read in order),
  `app.automation_waits` (a run paused at a wait step; `attempts` 0 to 5) and
  `app.automation_timers` (a time trigger waiting for its moment; once per
  `(workspace, automation, lead, occurrence)`).
- New columns: `automations` `origin` (default `builtin`), `name` (null for
  a built-in until seeded), `description`, `active_version_id`, `revision`,
  `created_by`, `created_at`, `archived_at`; `automation_runs`
  `automation_id`, `version_id`, `status` (default `completed`),
  `occurrence`, `trigger_kind`, `depth` (0 to 3), `parent_run_id`, `detail`,
  `updated_at`, `finished_at`, with `outcome` made nullable (set only on rows
  from before the conversion); `email_templates` `name` and `archived_at`
  (site-made `tpl_…` templates only); `memberships` `notification_email`.
- The key, reason and outcome checks of `automations`, `automation_runs`,
  `email_templates` and `email_template_versions` are dropped and re-added
  as shapes (custom flow keys `^flow_[a-z0-9]{16}$`, template keys
  `^tpl_[a-z0-9]{16}$`, reasons `^[a-z][a-z0-9_]{0,63}$`); each re-added check
  scans its table once. Unique index `automation_runs_occurrence_unique`: a
  flow runs once per lead and occurrence.
- Drizzle hash `c91f1c89269e3e1fa63110fc594d1f250b72d884889000ad5e7af4a19aadcd1b`,
  `created_at` `1793450665432`. **To apply** (below, with 0020).

## 0020_automation_flows_runtime

- Hand-written companion to 0019, every statement safe to run twice: FORCE
  RLS on the four new tables; `app_runtime` gets `SELECT, INSERT, UPDATE` on
  versions, waits and timers, `SELECT, INSERT` on step runs, and `UPDATE` of
  exactly `status`, `reason`, `detail`, `updated_at` and `finished_at` on
  `automation_runs` (no DELETE anywhere); the FK from a flow to its live
  version (a guarded `DO` block: the two tables reference each other); the
  trigger `automation_versions_definition_guard`, which keeps an activated
  version fixed (its definition, its activation and every status move but
  `active → retired`; `automation_version_immutable`, SQLSTATE 23514);
  `app.builtin_flow_definition(key)` and `app.builtin_flow_name(key)` (the six
  defaults and labels, tied to contracts by
  `apps/backend/tests/automation-sql-contracts.integration.test.ts`);
  `app.record_staff_notification_email(address)` (SECURITY DEFINER: the
  signed-in member's own notification address on their active memberships);
  `app.current_workspace_identity()` (SECURITY DEFINER: the open tenant
  transaction's own site slug and name, for a staff notification's subject
  and link; it takes no argument, needs the site and actor settings every
  tenant policy needs, and `app_runtime` still has no grant on
  `app.workspaces`); the conversion of existing rule rows (name, version 1 active,
  `active_version_id`) and runs (`automation_id`, `status`, `version_id`,
  `finished_at`, the occurrence from the job's dedupe key), guarded by
  `is null`; and last `app.prune_operational_rows` replaced with 0018's body
  except that runs go 90 days after they **finish** (never while waiting)
  and fired or void timers 90 days after they ended.
- **The `CREATE OR REPLACE FUNCTION app.prune_operational_rows` statement is
  the one the owner pastes by hand** (marked `OWNER PASTE` in the paste file,
  and repeated after the verification selects), as in phases 4 and 5.
- Drizzle hash `49d165bbb384a89f564456e349c83547826a5c6f67b4e8369b275ca8076b220c`,
  `created_at` `1793450690795`. **To apply**, before the backend of merge
  phase 8 step A is deployed.
- **The deploy window.** Do not switch automation rules between applying
  these migrations and the new backend going live: the old backend can still
  switch a rule on, creating a row with no version that the new firing
  ignores until the Automations list repairs it (production had no rule on
  on 2026-10-31). The old admin's Automations page may show its load error
  (its schema expects exactly six rules) until the admin deploys.
- To apply: in the SQL editor, as `postgres`, run
  [`manual/0019-0020-automation-flows.sql`](manual/0019-0020-automation-flows.sql)'s
  pre-check (A: the four tables absent, no `automations.origin`, no tracker
  rows); paste `BEGIN` … `COMMIT` once (one transaction, both files verbatim
  and all four tracker rows); run the verification selects one at a time
  (FORCE RLS on the four, 42 backup read policies, the grants per table and
  verb with no DELETE and the five updatable run columns, the replaced
  checks, the FK, the trigger, the five functions and who may run
  `current_workspace_identity`, the prune function naming
  `automation_timers` and `status <> 'waiting'`, the tracker rows). Or apply
  the plain statements through the Supabase tool in small batches, hand the
  owner the OWNER PASTE statement, add the tracker rows by hand and verify
  against the catalog, never the trackers. Record the date, the tracker
  versions and the results here.
- Rehearsed 2026-10-31 (by Batch 1, twice, and again after Batch 2 added
  `app.current_workspace_identity()`) on a local database migrated to 0018 holding an enabled built-in, a queued run with
  its job and a skipped run: the paste file exited 0, every verification
  select gave its comment's value, the built-in had version 1 active and
  its name, the queued run became `completed` with its occurrence and the
  skipped one `skipped`; the migrator then applied nothing.
- `packages/db/tests/automation-flows.integration.test.ts` covers RLS and
  FORCE, the policies, the grants, site isolation, every check, the version
  guard, the notification function, the re-run and the backfill;
  `apps/backend/tests/operational-retention.integration.test.ts` the new
  prune blocks.

## 0023_lead_activity_clock_time (2026-11-05)

One statement: `lead_activities.created_at` defaults to `clock_timestamp()`
instead of the transaction start, so moves a flow chains into one write keep
their order (a stage timer fires only while its entry is the latest move).
Metadata-only (`ALTER COLUMN … SET DEFAULT`): no table rewrite. Safe in
either order with the deploy: until it is applied, moves chained into one write
share a time and a stay timer behaves as before (a stay a chain left and
re-entered can still fire twice). Rollback: `ALTER TABLE app.lead_activities
ALTER COLUMN created_at SET DEFAULT now();` (the code keeps working).

- **Applied in production 2026-11-05** through the Supabase tool (tracker
  version `20261105174854`, name `0023_lead_activity_clock_time`), the file's
  statement verbatim plus its Drizzle tracker row in the same migration: hash
  `57f150ea27e79ce9f8c507738d75f90b18fd9b4539cbfa53b2f3e3d472112df7`, `when`
  `1793899404943`. Before: tracker at 0022, default `now()`. After: default
  `clock_timestamp()`, Drizzle row id 24; the migrator then finds nothing to do.

## 0024_ai_turns and 0025_ai_turns_and_automation_overdue_runtime (2026-11-05)

Phase C of the AI and automation review. Apply both **before** deploying the
code that uses them.

- `0024_ai_turns`: the new `app.ai_turns` table (one row of counts per Ask AI
  turn, no text), tenant RLS and the backup read policy.
- `0025_…_runtime`: `FORCE ROW LEVEL SECURITY` on it and `SELECT, INSERT` for
  `app_runtime` (no update or delete); `prune_operational_rows` replaced with
  the same windows plus `ai_turns` after 90 days; and
  `app.automation_overdue_sites(p_before)`, `SECURITY DEFINER`, which returns
  the site ids with pending automation waits or timers due before `p_before`
  (ids and counts only), for the scheduler's unscheduled-site check.

Without them the code degrades rather than fails: a turn record is reported
to the error tracker and the answer still streams, and the tick logs
`automation_overdue_check_failed` after doing its work. Rollback: the code
keeps working without the table rows; drop the function and the table only
after reverting the code.

- **0024 applied in production 2026-11-05** through the Supabase tool with its
  Drizzle tracker row (hash
  `c243e70ad47af932a4a4330f471e05ca42bea928e43a8223e8483b47c44f7129`, `when`
  `1793902088184`). The tool's confirm prompt for 0025 timed out twice; apply it
  from the SQL editor with
  [`manual/0025-ai-turns-runtime.sql`](manual/0025-ai-turns-runtime.sql), which
  records both tracker rows (Drizzle hash
  `eeb2ce5ca4cb53d8582a127049f7a7ab9a3498c7861067f1454747a4e4f30482`, `when`
  `1793902130131`).
- **0025 applied in production 2026-11-05** by the owner from the SQL editor
  with that file. Verified against the catalog: `ai_turns` forces RLS,
  `app_runtime` may insert but not delete, `automation_overdue_sites` is
  SECURITY DEFINER and executable by `app_runtime`, `prune_operational_rows`
  prunes `ai_turns`, and both trackers list 0024 and 0025.

Verify after applying:

```sql
select relforcerowsecurity from pg_class where oid = 'app.ai_turns'::regclass;  -- true
select has_table_privilege('app_runtime', 'app.ai_turns', 'delete');            -- false
select proname, prosecdef from pg_proc where proname = 'automation_overdue_sites'; -- t
```

## 0026_automation_run_chain (2026-11-05)

Phase D of the AI and automation review (ENG-L1). One nullable column,
`automation_runs.chain text[]` (the flows a run's write came through, at most
three, checked by `automation_runs_chain_check`). New runs write it; a resume
reads it and falls back to walking `parent_run_id` for runs written before, so
the deploy and the migration may go in either order. Metadata-only: no table
rewrite, no backfill. Rollback: `ALTER TABLE app.automation_runs DROP COLUMN
chain;` after reverting the code.

- **Applied in production 2026-11-05** through the Supabase tool with its
  Drizzle tracker row (hash
  `22874a2caa5ce865b58ac9c01630017fec1698798945a29f45a68eaf1bb8c240`, `when`
  `1793908019352`). Verified: `chain` is `text[]`, the check exists and
  `app_runtime` may insert it. The Supabase tracker also lists an older,
  unrelated `0026_orders_billing_contract`; only the name prefix is shared.

## 0027_plan_commission (2026-11-08)

A plan's staff-only commission, for the dashboard's commission revenue. Three
columns on `app.plans`: `commission_type text not null default 'none'`
(`none`, `percent` or `fixed`), `commission_rate_bps integer` (percent × 100,
0–10000, set only for `percent`) and `commission_minor bigint` (cents, ≥ 0,
set only for `fixed`), tied together by `plans_commission_check`. Every
existing plan becomes `none`. `app_runtime` already holds table-level
`SELECT, INSERT, UPDATE` on `app.plans` (0012), so no grant changes; RLS and
policies are untouched. Adding a column with a constant default is
metadata-only (no rewrite). The owner-only `revenue.view` action that guards
these figures is code (`staff/authorization.ts`), so nothing about roles
changes in the database. Rollback, after reverting the code:
`ALTER TABLE app.plans DROP CONSTRAINT plans_commission_check, DROP COLUMN
commission_type, DROP COLUMN commission_rate_bps, DROP COLUMN commission_minor;`

- **To apply** (owner), before deploying a backend that reads the columns:
  run the file through the Supabase tool or the SQL editor, then insert the
  Drizzle tracker row: hash `bd633da4d64b17c6814c4af341fc9f205d35e08c3d49d61e19f8b9c42483cb20`, `created_at` `1794117979433`.
- Verify against the schema:

```sql
select column_name, data_type, column_default from information_schema.columns
 where table_schema = 'app' and table_name = 'plans' and column_name like 'commission%';  -- 3 rows
select conname from pg_constraint where conname = 'plans_commission_check';               -- 1 row
```

## 0028_email_style (2026-11-08)

A site's customer mail style (Settings → Email → Style). Two columns on
`app.workspace_email_settings`: `style text not null default 'classic'`
(`classic` or `hero`, `workspace_email_settings_style_check`) and
`accent_color text` (null, or `#rrggbb` in lower case,
`workspace_email_settings_accent_color_check`; the hero style's status pill).
Every saved site becomes `classic`, which draws exactly the mail it drew
before. `app_runtime` already holds table-level `SELECT, INSERT, UPDATE` on
the table (0014), so no grant changes; RLS and policies are untouched. Adding a
column with a constant default is metadata-only (no rewrite). Rollback, after
reverting the code: `ALTER TABLE app.workspace_email_settings DROP CONSTRAINT
workspace_email_settings_style_check, DROP CONSTRAINT
workspace_email_settings_accent_color_check, DROP COLUMN style, DROP COLUMN
accent_color;`

- **To apply** (owner), before deploying a backend that reads the columns:
  run the file through the Supabase tool or the SQL editor, then insert the
  Drizzle tracker row: hash `35d76dfc60e8fa27d06a42ba10248061270178152fd749aa4d589893bf0a9fd8`, `created_at` `1794159298930`.
- Verify against the schema:

```sql
select column_name, data_type, column_default from information_schema.columns
 where table_schema = 'app' and table_name = 'workspace_email_settings'
   and column_name in ('style', 'accent_color');                                         -- 2 rows
select conname from pg_constraint
 where conname in ('workspace_email_settings_style_check',
                   'workspace_email_settings_accent_color_check');                       -- 2 rows
```

## 0029_task_in_progress (2026-11-10)

A task status between To do and Done, for the Tasks board. One constraint on
`app.lead_tasks` is replaced: `lead_tasks_status_check` now allows
`'open', 'in_progress', 'done', 'cancelled'` (it allowed the other three).
Existing rows need no change and none is made; `lead_tasks_completion_check`
(`done` exactly when `completed_at` is set) is untouched, so an in-progress
task has no completion time. `app_runtime` already holds table-level
`SELECT, INSERT, UPDATE` on the table (0001), so no grant changes; RLS,
policies and indexes are untouched. Re-adding the check scans the table once
under its lock (a few hundred rows). The exact SQL:

```sql
ALTER TABLE "app"."lead_tasks" DROP CONSTRAINT "lead_tasks_status_check";
ALTER TABLE "app"."lead_tasks" ADD CONSTRAINT "lead_tasks_status_check" CHECK ("app"."lead_tasks"."status" in ('open', 'in_progress', 'done', 'cancelled'));
```

Rollback, after reverting the code: move any in-progress task back to open
(`UPDATE app.lead_tasks SET status = 'open' WHERE status = 'in_progress';`),
then `ALTER TABLE app.lead_tasks DROP CONSTRAINT lead_tasks_status_check, ADD
CONSTRAINT lead_tasks_status_check CHECK (status in ('open', 'done',
'cancelled'));`

- **To apply** (owner), before deploying a backend that writes the status:
  run the file through the Supabase tool or the SQL editor, then insert the
  Drizzle tracker row: hash `de4d29e1ba012926e8ba46175bfe2ec1c08b4b8e01ffb9a8561f7930d8b58413`, `created_at` `1794336266083`.
  An older backend keeps working on the new constraint (it never writes
  `in_progress`); a newer backend on the old constraint refuses the move to
  In progress with a 500.
- Verify against the schema:

```sql
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'lead_tasks_status_check';   -- …ARRAY['open', 'in_progress', 'done', 'cancelled']…
```

## 0030_restricted_lead_erasure (2026-11-10, audit M-2)

One SECURITY DEFINER function, `app.erase_restricted_lead_data(workspace,
lead ids, contact ids)`, that the daily `data_retention` task calls when it
restricts an abandoned draft (and, a batch per run, for leads restricted
before this). For leads of the transaction's own site that are already
restricted it deletes their `lead_identities` (and the same ids in
CanadaWide's legacy `public.mobility_id_uploads`, when that table exists),
nulls the `body` of their timeline entries, and deletes the given contacts
that no lead on any site references. The backend itself tombstones the
leads' files and deletes their objects, deletes their tasks, clears their
contact link and trims attribution and order details. `search_path = ''`,
revoked from `PUBLIC`, granted to `app_runtime` only. No table, grant or
policy changes. Paste file:
[`manual/0030-restricted-lead-erasure.sql`](manual/0030-restricted-lead-erasure.sql).

- **To apply** (owner): run the paste file (it inserts both tracker rows:
  hash `d9f606b7fb11c80c9953650a1e1824cbba4e0dc4a39c7725aa30ae2f89069a31`,
  `created_at` `1794348226604`). A backend deployed before it still
  restricts drafts and erases their files, tasks and contact link, and logs
  `restricted_lead_erasure_function_missing` until it is applied.
- **First run after deploying** finishes up to 1000 previously restricted
  leads per site per day: their files are tombstoned and objects deleted,
  identities, tasks and note texts removed. This is irreversible.
- Rollback: `DROP FUNCTION app.erase_restricted_lead_data(uuid, uuid[], uuid[]);`
  after reverting the code (the code checks for it before calling).
- Verify against the schema:

```sql
select prosecdef, proconfig from pg_proc where proname = 'erase_restricted_lead_data';  -- t, {search_path=""}
```

## 0031_invitation_expiry, 0032_workspaces_rls and 0033_workspaces_rls_force (2026-11-10, applied, verified 2026-11-19)

Two small hardening changes from the 2026-11-10 security review (audit L-16
and I-2). Neither is applied by the deploy; the owner applies them in order, after 0030,
through the SQL editor (the Supabase tool holds statements with REVOKE, ALTER
or DELETE for a confirmation prompt), then inserts the Drizzle tracker rows.

**0031 (L-16).** `app.accept_staff_invitations` is replaced (same signature,
SECURITY DEFINER, empty `search_path`, same grants). The only change from the
0001 body is `AND created_at > clock_timestamp() - interval '14 days'` on the
pending-invitation loop: an invitation is claimable for 14 days from when it
was sent. An older pending row is not deleted, it is simply never matched, and
a new invitation to the same address retires it (`DatabaseStaffStore.inviteStaff`
revokes an expired pending row first, so the one-pending-per-address index does
not block the re-invite). **Before applying**, list what will stop working and
re-invite whoever still needs to join:

```sql
select workspace_id, invited_email, created_at from app.memberships
 where membership_type = 'staff' and status = 'pending'
   and created_at <= now() - interval '14 days';
```

The two seeded `owner` invitations from first install (2026-10-25) are in this
list unless they were accepted; check that the developer's own sign-in has
already claimed them before applying. Also confirm in Supabase Auth that
"Confirm email" is ON and that anonymous, phone and unverified-OAuth sign-ins
are off: the invitation check is only as strong as the provider's email
confirmation, and expiry only narrows the window.

**0032 (I-2, generated).** `app.workspaces`, the one `app` table without row
security, gets `ENABLE ROW LEVEL SECURITY` and the backup login's read policy
`workspaces_backup_reader_read` (as every `app` table has, 0008): without it
`backup_reader`, which has NOBYPASSRLS, would dump an empty site registry.

**0033 (I-2, hand-written).** `FORCE ROW LEVEL SECURITY` on `app.workspaces`.
`app_runtime` has no grant and no policy on it, so nothing changes for the
backend; the SECURITY DEFINER functions that read it are owned by `postgres`
(BYPASSRLS) and are unaffected; a future grant or an API exposure of the `app`
schema now returns no rows instead of every site.

- **To apply** (owner): run the three files in order, then the tracker rows
  (hash, `created_at`):
  `0031_invitation_expiry` `160ed5093f39fab56f531cecd3e2ade8301b0308d0e4e13292377f34a60ec60a`, `1794351038728`;
  `0032_workspaces_rls` `34f8ac3004ca1cc837cc8b29930405e66858a4f7a6e1b505997d85f24906c6f1`, `1794351039747`;
  `0033_workspaces_rls_force` `22e037104544da6e58c5aba70186bacec05c309464eb309ff351249370f573a7`, `1794351040645`.
  (Renumbered from 0030–0032 when the two security tracks merged; the hash is
  the SHA-256 of the file, `created_at` the journal's `when`.) An older backend
  keeps working on all three.
- Rollback: `ALTER TABLE app.workspaces NO FORCE ROW LEVEL SECURITY;`,
  `DROP POLICY workspaces_backup_reader_read ON app.workspaces; ALTER TABLE
app.workspaces DISABLE ROW LEVEL SECURITY;`, and for 0031 re-run the
  `app.accept_staff_invitations` definition from `0001_runtime_functions.sql`.
- Verify against the schema:

```sql
select relrowsecurity, relforcerowsecurity from pg_class
 where oid = 'app.workspaces'::regclass;                     -- true, true
select polname from pg_policy where polrelid = 'app.workspaces'::regclass;
                                                             -- workspaces_backup_reader_read
select pg_get_functiondef('app.accept_staff_invitations(text,uuid)'::regprocedure)
  like '%interval ''14 days''%';                              -- true
```

After applying, run the next nightly backup and check its row counts include
`app.workspaces` (the backup's completeness guard compares them).

## 0034_ai_conversations, 0035_ai_conversations_runtime and 0036_ai_attachment_sweep (2026-11-18, applied, verified 2026-11-19)

Ask AI's saved chat (docs/design/ai-chat.md). Not applied by the deploy; the
owner applies them in order through the SQL editor (0034 and 0035 hold
`ALTER`, 0036 holds `REVOKE`, which the Supabase tool holds for a
confirmation prompt), then inserts the Drizzle tracker rows. The deploy and
the migrations may go in either order: an older backend never touches the new
tables, and its `ai_turns` insert leaves `input_tokens` to its default.

Apply 0034 and 0035 only once BOTH the backend and the admin of this release
are live, and let open admin tabs be reloaded first: the saved chat switches
itself on when the tables appear, and the first message of a new chat carries
`newConversation`, which this backend requires and an earlier build of the
saved chat neither sends nor accepts. For the same reason, do not roll either
app back to a build from before this release while the tables exist; to go
back, switch Ask AI off (`AI_ASSISTANT_ENABLED`) instead.

**0034 (generated).** Three tables, `app.ai_conversations` (a member's
conversation; the id is chosen by the browser), `app.ai_messages` (one row per
question and per answer) and `app.ai_attachments` (a message's files: rows
only, the bytes in the `documents` bucket), with their checks and indexes, an
owner policy each (`<table>_owner_policy`: site and actor, as `saved_views`
has) and the backup login's read policy (`<table>_backup_reader_read`). The
foreign keys to a conversation carry `actor_id`, and messages and files
cascade from their conversation. `app.ai_turns` gets
`input_tokens integer not null default 0` (metadata-only, no rewrite) and
`ai_turns_counts_check` is re-added with it, which scans the table once (its
rows of the last 90 days).

**0035 (hand-written).** `FORCE ROW LEVEL SECURITY` on the three tables and
the grants to `app_runtime`: `SELECT, INSERT, UPDATE, DELETE` on
`ai_conversations` and `ai_attachments`, `SELECT, INSERT` only on
`ai_messages` (a message is written once and goes only with its conversation,
by cascade). `prune_operational_rows` is unchanged: conversations are kept
until the member deletes them. `backup_reader` needs no grant (0007's default
privileges).

**0036 (hand-written).** `app.sweep_unsent_ai_attachments(site, before,
limit)`, SECURITY DEFINER with an empty `search_path`, revoked from `PUBLIC`
and executable by `app_runtime` only. For the transaction's own site, with an
actor set, it deletes at most `limit` (1 to 1000) unsent files older than a day
(whatever `before` says), skipping rows a turn has locked, and returns their
bucket and key so the backend deletes the objects after the commit. The
scheduler's `document_cleanup` task calls it.

- **To apply** (owner): run the three files in order, then the tracker rows
  (hash, `created_at`):
  `0034_ai_conversations` `7b7abbfb41c92d94653b071f728b28b3655662e32a4c8a542696acce23354a18`, `1794971808423`;
  `0035_ai_conversations_runtime` `de67006e751f07849a04d40045b419abd1b4822491332563c8f7c3f8b5584c2b`, `1794971816462`;
  `0036_ai_attachment_sweep` `e1528958f575536d53c04a5d38cf392d38c8e19b3c7c4a9eac454e4f6b415f9d`, `1794974355695`.
  (The hash is the SHA-256 of the file, `created_at` the journal's `when`.)
- **After applying**: the backend checks the catalogue and switches the saved
  chat on by itself within 5 minutes of 0034 and 0035, with no redeploy;
  until then it answers as memory-only Ask AI. The sweep starts with the first
  `document_cleanup` run after 0036. Then docs/RUNBOOKS/ai-assistant.md §12.
- Rollback, after reverting the code, and only knowing it deletes every
  member's stored conversations: `DROP FUNCTION
app.sweep_unsent_ai_attachments(uuid, timestamptz, integer); DROP TABLE
app.ai_attachments, app.ai_messages, app.ai_conversations;` and `ALTER TABLE
app.ai_turns DROP CONSTRAINT ai_turns_counts_check, DROP COLUMN input_tokens,
ADD CONSTRAINT ai_turns_counts_check CHECK (duration_ms >= 0 and
output_tokens >= 0 and tool_calls >= 0 and records >= 0 and data_bytes >= 0);`.
  The attached files' objects stay in the bucket under
  `workspaces/<site>/ai-attachments/`. A backend that has seen the tables keeps
  believing they exist until it restarts.
- Verify against the schema:

```sql
select relname, relrowsecurity, relforcerowsecurity from pg_class
 where oid in ('app.ai_conversations'::regclass, 'app.ai_messages'::regclass,
               'app.ai_attachments'::regclass);                    -- 3 rows, true, true
select has_table_privilege('app_runtime', 'app.ai_messages', 'update'),
       has_table_privilege('app_runtime', 'app.ai_messages', 'delete'),
       has_table_privilege('app_runtime', 'app.ai_attachments', 'delete');  -- false, false, true
select polname from pg_policy where polrelid = 'app.ai_messages'::regclass;
                                  -- ai_messages_owner_policy, ai_messages_backup_reader_read
select column_name, column_default from information_schema.columns
 where table_schema = 'app' and table_name = 'ai_turns' and column_name = 'input_tokens';  -- 1 row, 0
select prosecdef, proconfig from pg_proc where proname = 'sweep_unsent_ai_attachments';    -- t, {search_path=""}
select has_function_privilege('app_runtime',
  'app.sweep_unsent_ai_attachments(uuid,timestamptz,integer)', 'execute');                -- true
```

## 0037_ai_effort (2026-11-18, applied, verified 2026-11-19)

Ask AI's effort levels (docs/design/ai-assistant.md §8). Not applied by the
deploy; the owner applies it through the SQL editor after 0034–0036 (it holds
`ALTER`), then inserts the Drizzle tracker row. The deploy and the migration
may go in either order: an older backend never names the columns and its
inserts take the defaults, and this backend runs before 0037 (below).

**0037 (generated).** `app.ai_turns` gets `effort text not null default
'normal'` with `ai_turns_effort_check` (`normal` or `high`), and
`app.ai_messages` gets `effort text` (null for rows written before it) with
`ai_messages_effort_check` (null, `normal` or `high`), set on both rows of a
turn stored after it. Adding the columns is metadata-only (a constant default,
no rewrite); each check scans its table once (`ai_turns` holds 90 days). No
custom companion: the runtime role's table-level grants (0025 for `ai_turns`,
0035 for `ai_messages`) cover every column of the table, and the owner and tenant policies
are row policies, unchanged.

- **To apply** (owner): run the file, then the tracker row (hash,
  `created_at`): `0037_ai_effort`
  `4621ff73aadcd0c0d05e26f6dffb1188d037bcbeafbb830bb2d48003d6096551`,
  `1794983004391`.
- **Before it is applied**: High effort works where it is switched on
  (`AI_HIGH_EFFORT_ENABLED`); the backend leaves both columns out of its
  inserts, a reloaded conversation shows no _High effort_ tag, and the usage
  page counts every turn as Normal.
- **After applying**: the backend checks the catalogue and starts writing the
  level within 5 minutes, with no redeploy. Turns already recorded stay
  `normal`; messages already stored stay null.
- Rollback, after reverting the code: `ALTER TABLE app.ai_messages DROP COLUMN
effort; ALTER TABLE app.ai_turns DROP COLUMN effort;` (the checks go with
  their columns). Every recorded level is lost. A backend that has seen the
  columns keeps naming them until it restarts.
- Verify against the schema:

```sql
select table_name, column_default, is_nullable from information_schema.columns
 where table_schema = 'app' and column_name = 'effort'
   and table_name in ('ai_turns', 'ai_messages') order by table_name;
                                  -- ai_messages, null, YES; ai_turns, 'normal'::text, NO
select conname from pg_constraint
 where conname in ('ai_turns_effort_check', 'ai_messages_effort_check');      -- 2 rows
```

## 0038_plain_tasks (2026-11-19, prepared, not applied)

A **plain task** is a task with no lead (the Tasks page's "New task", Ask
AI's task card when the person names no lead). Not applied by the deploy; the
owner applies it through the SQL editor (it holds `ALTER`), then inserts the
Drizzle tracker row. The deploy and the migration may go in either order: an
older backend never writes a null `lead_id` and reads every task through its
lead as before, and this backend runs before 0038 (below).

**0038 (generated).** One statement:

```sql
ALTER TABLE "app"."lead_tasks" ALTER COLUMN "lead_id" DROP NOT NULL;
```

Dropping `NOT NULL` is a catalogue change only (no rewrite, no scan). The
composite foreign key `lead_tasks_workspace_lead_fk` (`(workspace_id,
lead_id)` → `app.leads`, `ON DELETE CASCADE`) stays: under Postgres's default
`MATCH SIMPLE` it is not checked for a row whose `lead_id` is null and still
ties every other task to a lead of its own site. The status, title and
completion checks, the three indexes, `lead_tasks_tenant_policy`, the backup
read policy and the runtime role's table-level grants (0001) are unchanged, so
no custom companion is needed. The Tasks board and My tasks still read the
`(workspace_id, assigned_actor_id, status, due_at)` and `(workspace_id,
status, due_at)` indexes for plain tasks; their join to `app.leads` is a left
join (`leads/staff-queries.ts`).

- **To apply** (owner): run the file, then the tracker row (hash,
  `created_at`): `0038_plain_tasks`
  `c0ba77eb32df8619d3776d86433e6a496c2c075c76008cd9fb44d67050d62245`,
  `1795054241116`.
- **Before it is applied**: `POST /workspaces/:id/tasks` answers `503
plain_tasks_unavailable` and writes nothing, Ask AI's task tool asks which
  lead a task is for (its capabilities list `taskActions: ['task_update']`
  only), and every other task read and write works as it did
  (`leads/task-schema.ts` asks the catalogue, never the journal).
- **After applying**: the backend checks the catalogue and takes plain tasks
  within 5 minutes, with no redeploy.
- **Deploy the admin no later than the backend for this release**: an admin
  from before it drops a stream's whole `actions` part when it holds a
  plain-task or task-move card (with any other card of that answer). GT Sales
  (and Canadian Plans) deploy both apps from the same merge, the admin on
  Vercel and the backend on Railway, so the window is the minutes between the
  two builds finishing.
- Rollback, after reverting the code, and only once no plain task is left
  (delete them, or attach each to a lead):
  `select count(*) from app.lead_tasks where lead_id is null;` (0), then
  `ALTER TABLE app.lead_tasks ALTER COLUMN lead_id SET NOT NULL;`. A backend
  that has seen the column nullable keeps believing it is until it restarts;
  until then a plain task's insert fails on the constraint and answers `503
plain_tasks_unavailable`.
- Verify against the schema:

```sql
select is_nullable from information_schema.columns
 where table_schema = 'app' and table_name = 'lead_tasks' and column_name = 'lead_id';  -- YES
select pg_get_constraintdef(oid) from pg_constraint
 where conname = 'lead_tasks_workspace_lead_fk';
  -- FOREIGN KEY (workspace_id, lead_id) REFERENCES app.leads(workspace_id, id) ON DELETE CASCADE
```

## 0039_ai_chat_erasure (2026-11-19, prepared, not applied)

Audit B2 and C13 (docs/design/ai-chat.md §13): a customer's data
restriction reaches Ask AI's saved chats, and the chats of someone who left a
site are deleted. Not applied by the deploy; the owner applies it through the
SQL editor after 0034–0037 (it holds `ALTER` and creates functions), then
inserts the Drizzle tracker row. The deploy and the migration may go in either
order: an older backend never names the column or the functions, and this
backend runs before 0039 (below).

**0039 (generated, with a hand-written part).** `app.ai_messages` gets
`erased_at timestamptz` (null; metadata-only, no rewrite). Then five SECURITY
DEFINER functions with an empty `search_path`, `EXECUTE` revoked from
`PUBLIC` and granted to `app_runtime` only, each refusing a site other than
the transaction's own (`workspace_context_mismatch`) and more than 1000 ids
or rows (`too_many_ids`, `limit_out_of_range`). They run as the migration
role, which bypasses row security; FORCE RLS on the three chat tables (0035)
is unchanged, and the runtime role still holds no `UPDATE` or `DELETE` on
`app.ai_messages`:

- `app.erase_restricted_lead_ai_turns(site, lead_ids)`: for leads of the site
  that are already restricted, every member's turns that name them lose their
  text. A turn is named when its answer's source cards link the lead
  (`lead-<id>`, or an href ending in `/leads/<id>`) or when either row's text
  holds the lead's `MS-<n>` order number as a whole word (case-insensitive).
  Both rows of the turn (paired by request id) keep their place with `text =
''`, `sources = []`, `follow_up = null` and `erased_at` set; the question's
  text files lose their `extracted_text`; a conversation whose first question
  was erased, or whose title holds the number, is retitled "Chat with a
  removed message". Called by the abandoned-lead restriction
  (`retention/abandoned-leads.ts`) in its own transaction.
- `app.erased_ai_attachments(site, limit)` and
  `app.delete_erased_ai_attachments(site, ids)`: the files of erased turns,
  listed for the backend to delete their objects first, then those rows only
  (the delete re-checks that the turn is erased). Needs an actor.
- `app.departed_ai_conversations(site, before, limit)` and
  `app.delete_departed_ai_conversations(site, before, ids)`: conversations,
  untouched since `before`, of an actor with no active membership on the site
  and a revocation older than `before` (or no membership row), with their
  files' objects; the delete re-checks the same rule under a row lock. A
  cutoff less than a day ago is moved back to a day ago. Needs an actor.

At the end a `DO` block runs the erasure once, a thousand leads at a time,
for every site that has a conversation, over every lead already restricted
(it sets `app.workspace_id` for its own transaction and clears it after).
On the current data that is a few hundred rows at most; it reads each site's
messages once per thousand restricted leads.

- **To apply** (owner): run the file, then the tracker row (hash,
  `created_at`): `0039_ai_chat_erasure`
  `0f3cb50e066d069905a56038a29af01dd32fa20f1ea933747812292ee0209b43`,
  `1795070872298`.
- **Before it is applied**: a turn whose answer links a restricted (or
  deleted) lead is never replayed to the model, whatever its state
  (`ai/conversation-store.ts` reads the lead itself); the stored text stays
  and the member still sees it. Each restriction run logs
  `ai_chat_erasure_function_missing` with the site id. `document_cleanup`
  reports the chat cleanup as skipped (`aiChats.skippedSites`), so erased
  files and departed members' chats stay.
- **After applying**: the catch-up has emptied the turns of every lead
  restricted so far; later restrictions empty theirs in the same transaction.
  The backend's catalogue check (`ai/chat-schema.ts`, `chatErasure`) sees the
  column and the five functions within 5 minutes, with no redeploy, and the
  next hourly `document_cleanup` deletes erased turns' files and the chats of
  people gone from a site for 30 days (`AI_DEPARTED_MEMBER_CHAT_DAYS`),
  objects first.
- Rollback, after reverting the code: `DROP FUNCTION
app.erase_restricted_lead_ai_turns(uuid, uuid[]); DROP FUNCTION
app.erased_ai_attachments(uuid, integer); DROP FUNCTION
app.delete_erased_ai_attachments(uuid, uuid[]); DROP FUNCTION
app.departed_ai_conversations(uuid, timestamptz, integer); DROP FUNCTION
app.delete_departed_ai_conversations(uuid, timestamptz, uuid[]); ALTER TABLE
app.ai_messages DROP COLUMN erased_at;`. Text already erased is not brought
  back (it is gone); dropping the column makes those rows read as ordinary
  empty answers. A backend that has seen the functions keeps calling them
  from the cleanup until it restarts, which then fails per site
  (`ai_chat_cleanup_failed`); a restriction asks the catalogue each run and
  logs `ai_chat_erasure_function_missing` instead.
- Verify against the schema:

```sql
select is_nullable from information_schema.columns
 where table_schema = 'app' and table_name = 'ai_messages' and column_name = 'erased_at';  -- YES
select p.proname, p.prosecdef, p.proconfig,
       has_function_privilege('app_runtime', p.oid, 'EXECUTE') as runtime,
       has_function_privilege('public', p.oid, 'EXECUTE') as public
  from pg_proc p
 where p.pronamespace = 'app'::regnamespace
   and p.proname in ('erase_restricted_lead_ai_turns', 'erased_ai_attachments',
     'delete_erased_ai_attachments', 'departed_ai_conversations',
     'delete_departed_ai_conversations')
 order by p.proname;              -- 5 rows: t, {search_path=""}, t, f
select has_table_privilege('app_runtime', 'app.ai_messages', 'UPDATE');      -- f
```

## 0040_ai_model_settings (2026-11-20, prepared, not applied)

Ask AI's model choice (Settings → AI models, docs/RUNBOOKS/ai-assistant.md
§14): a site's owner allows up to 8 Vercel AI Gateway models and marks one as
the site's default. Not applied by the deploy; the owner applies it through the
SQL editor (it creates a table and grants), then inserts the Drizzle tracker
row. The deploy and the migration may go in either order: an older backend
never names the table, and this backend runs before 0040 (below).

**0040 (generated, with a hand-written part).** One new table,
`app.ai_model_settings`: `workspace_id` (primary key, foreign key to
`app.workspaces`, `ON DELETE CASCADE`), `allowed_models jsonb` (an array of
`{"id", "label"}`, 1–8 entries, at most 4 KiB), `default_model text` (1–120
characters, and one of the ids in `allowed_models`, a check constraint),
`updated_by uuid` and `updated_at`. Row security is enabled with the
site-scoped `ai_model_settings_tenant_policy` (the same predicate as
`workspace_email_settings`) and `ai_model_settings_backup_reader_read`; the
hand-written part at the end FORCEs row security and grants the runtime role
`SELECT, INSERT, UPDATE` (no `DELETE`: the row goes only with its site).
`backup_reader` reads it through 0007's default privileges. Nothing is
back-filled: every site starts with no row, which means the deployment's
`AI_GATEWAY_MODEL`, exactly as before.

- **To apply** (owner): run the file, then the tracker row (hash,
  `created_at`): `0040_ai_model_settings`
  `2bf58c6a01a279806aeefde4add6b47bce683fbac258c6cf2a88218536853804`,
  `1795161147368`.
- **Before it is applied**: Settings → AI models says model choice is not
  switched on yet and cannot save (`PUT …/ai/model-settings` answers `503
ai_models_unavailable`, `details.reason: 'storage'`), capabilities list no
  `models`, the composer shows no model menu, a chat naming a `model` is
  refused (`400 invalid_request`, `model_unavailable`) and every turn uses the
  deployment's models (`ai/model-schema.ts` asks the catalogue, never the
  journal).
- **After applying**: the backend sees the table and its grants within 5
  minutes, with no redeploy; the owner saves a list in Settings → AI models.
  Each save writes an `ai.models_updated` audit event with the model ids only.
- Rollback, after reverting the code: `DROP TABLE app.ai_model_settings;`.
  Sites go back to `AI_GATEWAY_MODEL`. A backend that has seen the table keeps
  reading it until it restarts; until then each read fails and is reported
  (`ai_model_settings_failed`), turns with no model named run on the
  deployment's model, and a question naming one is refused (`503
ai_unavailable`).
- Verify against the schema:

```sql
select c.relrowsecurity, c.relforcerowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'app' and c.relname = 'ai_model_settings';             -- t, t
select polname from pg_policy where polrelid = 'app.ai_model_settings'::regclass
 order by polname;  -- ai_model_settings_backup_reader_read, ai_model_settings_tenant_policy
select has_table_privilege('app_runtime', 'app.ai_model_settings', 'SELECT'),
       has_table_privilege('app_runtime', 'app.ai_model_settings', 'INSERT'),
       has_table_privilege('app_runtime', 'app.ai_model_settings', 'UPDATE'),
       has_table_privilege('app_runtime', 'app.ai_model_settings', 'DELETE');  -- t, t, t, f
select conname from pg_constraint where conrelid = 'app.ai_model_settings'::regclass
 and contype = 'c' order by conname;
  -- ai_model_settings_allowed_models_check, ai_model_settings_default_model_check
```

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
