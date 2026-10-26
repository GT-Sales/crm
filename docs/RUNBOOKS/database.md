# Database runbook

Project: Supabase `gtsales-crm` (`xykrphbgpwisqacpyeiv`, Mumbai). The CRM
owns the `app` schema. Get Canada Sim's live tables stay in `public` until
phase 3 (docs/PLAN.md §7); nothing here touches them.

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
