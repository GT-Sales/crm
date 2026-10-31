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

- Phase 4's order tools and customer email
  (docs/superpowers/plans/2026-10-30-phase-4-order-tools-email.md),
  generated from `packages/db/src/schema.ts`. Additive: six new tables and
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

- Merge phase 5, step A
  (docs/superpowers/plans/2026-10-30-phase-5-gcs-orders-and-tracking.md),
  generated from `packages/db/src/schema.ts`. Additive: one new table, no
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

- Merge phase 5, step B
  (docs/superpowers/plans/2026-10-30-phase-5-gcs-orders-and-tracking.md),
  generated from `packages/db/src/schema.ts`. Additive: two new tables, one
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
  Email (docs/HANDOFF.md §5.1, check 1): the backend deployed after these
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

- Merge phase 8, step A
  (docs/superpowers/plans/2026-10-31-phase-8-automation-flows-step-a.md;
  spec docs/superpowers/specs/2026-10-31-phase-8-automation-flows-design.md
  §4), generated from `packages/db/src/schema.ts` and then reordered by hand
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
  the conversion of existing rule rows (name, version 1 active,
  `active_version_id`) and runs (`automation_id`, `status`, `version_id`,
  `finished_at`, the occurrence from the job's dedupe key), guarded by
  `is null`; and last `app.prune_operational_rows` replaced with 0018's body
  except that runs go 90 days after they **finish** (never while waiting)
  and fired or void timers 90 days after they ended.
- **The `CREATE OR REPLACE FUNCTION app.prune_operational_rows` statement is
  the one the owner pastes by hand** (marked `OWNER PASTE` in the paste file,
  and repeated after the verification selects), as in phases 4 and 5.
- Drizzle hash `d0358cece7c5ae47cd3b4072ff12426999752400fb64597e0d216dd45c753cd8`,
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
  checks, the FK, the trigger, the four functions, the prune function naming
  `automation_timers` and `status <> 'waiting'`, the tracker rows). Or apply
  the plain statements through the Supabase tool in small batches, hand the
  owner the OWNER PASTE statement, add the tracker rows by hand and verify
  against the catalog, never the trackers. Record the date, the tracker
  versions and the results here.
- Rehearsed 2026-10-31 (twice, the second after the fix round) on a local
  database migrated to 0018 holding an enabled built-in, a queued run with
  its job and a skipped run: the paste file exited 0, every verification
  select gave its comment's value, the built-in had version 1 active and
  its name, the queued run became `completed` with its occurrence and the
  skipped one `skipped`; the migrator then applied nothing.
- `packages/db/tests/automation-flows.integration.test.ts` covers RLS and
  FORCE, the policies, the grants, site isolation, every check, the version
  guard, the notification function, the re-run and the backfill;
  `apps/backend/tests/operational-retention.integration.test.ts` the new
  prune blocks.

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
