# @gt-sales/db

**Imported only by `apps/backend`.** The ESLint boundary rule
(`check:frontend-db-boundary` in CI) fails any other import.

## What it owns

The Drizzle schema (`src/schema.ts`), the checked-in migrations (`drizzle/`),
row types, the pooled runtime client with `withTenantTx` / `withActorTx`, and
the synthetic development seed.

Tables live in the private `app` schema: the site registry (`workspaces`),
staff access (`memberships`, `roles`, `membership_roles`, `permissions`,
`membership_permissions`), the global `contacts` table (merge by normalized
email), `leads` with `lead_activities` and `lead_tasks`, `draft_grants`, the
outbox, `service_credentials`, `rate_limit_buckets`, `audit_events`, documents
(`files`, `file_revisions`, `file_review_events`) and the email tables.

## Migrations

- `0000_app_foundation.sql` — drizzle-kit output (tables, indexes, checks,
  policies, `ENABLE ROW LEVEL SECURITY`) with the `app_runtime` role block
  prepended.
- `0001_runtime_functions.sql` — hand-written: grants per table, `FORCE ROW
LEVEL SECURITY`, the SECURITY DEFINER bootstrap functions
  (`list_staff_workspaces`, `accept_staff_invitations`,
  `resolve_website_credential`, `rate_limit_hit`, `prune_operational_rows`),
  and the audit-redaction and customer-restriction triggers.

After changing `schema.ts`: `pnpm --filter @gt-sales/db db:generate`, then
`pnpm exec drizzle-kit generate --custom --name <grants>` for the grants and
FORCE RLS the generator does not emit. Never edit an applied migration.

Apply with the separate, privileged `MIGRATION_DATABASE_URL` (direct port
5432, `postgres` role), never the runtime role:

```sh
pnpm --filter @gt-sales/db db:migrate
```

See [docs/RUNBOOKS/database.md](../../docs/RUNBOOKS/database.md) for the
hosted project, including how to record a migration applied by other means.

## Connections

The backend runtime uses `DATABASE_URL` as the non-owner `app_runtime` role
through Supabase's transaction-mode pooler. The client always sets
`prepare: false` (transaction mode has no named prepared statements) and a
small application-side pool (`DATABASE_POOL_MAX`, default 8).

Every runtime unit of work is `withTenantTx({ workspaceId, actorId }, fn)`: a
transaction that sets `app.workspace_id` and `app.actor_id` with
`set_config(..., true)` (transaction-local, so a pooled connection never leaks
context). Policies use `current_setting(..., true)` plus `nullif(..., '')`, so a
fresh session fails closed. `withActorTx(actorId, fn)` exists only for the two
staff bootstrap functions; it is not a cross-tenant query path.

## Tests and seed

The Vitest integration suite runs only when `TEST_MIGRATION_DATABASE_URL` and
`DB_TEST_ALLOW_DESTRUCTIVE=1` are both set and the database name ends in
`_test`: it sets the runtime role's password to a fixed CI value and writes
fixtures. CI applies the migrations to an empty Postgres first, then proves
missing/wrong context, composite tenant foreign keys, non-bypass runtime
privileges, denied site enumeration, append-only audit and pooled-connection
context cleanup.

`DB_SEED_ALLOW_SYNTHETIC=1 pnpm --filter @gt-sales/db db:seed` adds the two
client sites (`getcanadasim`, `canadawide`) with invented staff. It refuses
`NODE_ENV=production` and any hosted Supabase host unless the database name
ends in `_test` or `_dev`, never renames an existing site and never creates
Auth users.

## Must never import

Applications, UI or API contracts, or any Supabase service-role credential.
