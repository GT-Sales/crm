# Backup runbook

Only the facts the backup design depends on are recorded here for now; the rest
of the runbook arrives with the backup workflows (phase 1, Task 17).

## Facts checked on 2026-10-29

Read on 2026-10-29 from Supabase project `gtsales-crm`
(`xykrphbgpwisqacpyeiv`, Mumbai) through the Supabase MCP `execute_sql`
connector. Every query was a `SELECT`; nothing was created, altered or granted.

### Server and roles

- **Postgres version:** major **17** (Supabase image `17.6.1.141`, engine 17,
  release channel `ga`). Full `version()` string:
  `PostgreSQL 17.6 on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit`.
- **Connector role:** the MCP connector runs as `postgres`
  (`current_user` = `session_user` = `postgres`). Every privilege check below
  was therefore made as the same role that runs the migrations.
- **`postgres` role attributes:** `rolsuper = false`, `rolcreaterole = true`,
  `rolbypassrls = true`. It is not a superuser on Supabase, but it can create
  roles and bypasses row-level security.
- **Existing roles:** `anon`, `app_runtime`, `authenticated` and the Supabase
  service role exist. **`backup_reader` does not exist yet.**

### Auth data

- `postgres` has `USAGE` on schema `auth` and `SELECT` on `auth.users`.
- In `information_schema.role_table_grants` for `auth.users`, `postgres` holds
  `SELECT` **with grant option** (`is_grantable = YES`). Its `INSERT`,
  `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` and `TRIGGER` privileges are
  not grantable (`is_grantable = NO`), which does not matter for a read-only
  role.

### Tables in `app` and `public`

Every table in both schemas is owned by `postgres`. All have row-level
security enabled except `app.workspaces`, which has none by design (no role
but the owner has a grant on it; staff reach sites through the
`list_staff_workspaces()` function, `drizzle/0001_runtime_functions.sql`).

| Schema   | Table                     | Owner      | RLS |
| -------- | ------------------------- | ---------- | --- |
| `app`    | `audit_events`            | `postgres` | yes |
| `app`    | `contacts`                | `postgres` | yes |
| `app`    | `deleted_email_messages`  | `postgres` | yes |
| `app`    | `draft_grants`            | `postgres` | yes |
| `app`    | `email_messages`          | `postgres` | yes |
| `app`    | `email_provider_events`   | `postgres` | yes |
| `app`    | `email_suppressions`      | `postgres` | yes |
| `app`    | `file_review_events`      | `postgres` | yes |
| `app`    | `file_revisions`          | `postgres` | yes |
| `app`    | `files`                   | `postgres` | yes |
| `app`    | `follow_up_schedules`     | `postgres` | yes |
| `app`    | `lead_activities`         | `postgres` | yes |
| `app`    | `lead_identities`         | `postgres` | yes |
| `app`    | `lead_tasks`              | `postgres` | yes |
| `app`    | `leads`                   | `postgres` | yes |
| `app`    | `marketing_consents`      | `postgres` | yes |
| `app`    | `membership_permissions`  | `postgres` | yes |
| `app`    | `membership_roles`        | `postgres` | yes |
| `app`    | `memberships`             | `postgres` | yes |
| `app`    | `outbox_job_alerts`       | `postgres` | yes |
| `app`    | `outbox_jobs`             | `postgres` | yes |
| `app`    | `permissions`             | `postgres` | yes |
| `app`    | `rate_limit_buckets`      | `postgres` | yes |
| `app`    | `roles`                   | `postgres` | yes |
| `app`    | `service_credentials`     | `postgres` | yes |
| `app`    | `workspaces`              | `postgres` | no  |
| `public` | `admin_activity`          | `postgres` | yes |
| `public` | `admins`                  | `postgres` | yes |
| `public` | `internet_leads`          | `postgres` | yes |
| `public` | `mobility_id_uploads`     | `postgres` | yes |
| `public` | `mobility_leads`          | `postgres` | yes |
| `public` | `notifications`           | `postgres` | yes |
| `public` | `order_edit_requests`     | `postgres` | yes |
| `public` | `orders`                  | `postgres` | yes |
| `public` | `partner_earnings`        | `postgres` | yes |
| `public` | `partner_invoice_items`   | `postgres` | yes |
| `public` | `partner_invoices`        | `postgres` | yes |
| `public` | `partners`                | `postgres` | yes |
| `public` | `posts`                   | `postgres` | yes |
| `public` | `posts_backup_pickup_fix` | `postgres` | yes |
| `public` | `rate_limits`             | `postgres` | yes |

That is 26 tables in `app` (25 with RLS) and 15 in `public` (all with RLS),
41 in all. This is the inventory the 0007 migration loop must cover.
`docs/HANDOFF.md` §1 says the `app` schema has 25 tables; the live count is 26.

### Migration history

Schema `supabase_migrations` exists and `postgres` has `USAGE` on it
(`has_history = true`, `history_usage = true`).

### Sizes

| What                                                  | Count | Bytes      | About    |
| ----------------------------------------------------- | ----- | ---------- | -------- |
| Referenced documents (`app.files` with an object key) | 122   | 72,095,045 | 68.8 MiB |
| Whole database (`pg_database_size`)                   | —     | 22,113,427 | 21.1 MiB |

### Storage

| Bucket         | Public |
| -------------- | ------ |
| `documents`    | no     |
| `blog-images`  | yes    |
| `mobility-ids` | no     |

`postgres` has `SELECT` on `storage.objects`.

### What this means for the design

- **pg_dump client:** install the PostgreSQL **17** client tools (`pg_dump`,
  `pg_dumpall`, `psql`) in the workflows. The server is 17.6; the client must
  be the same major or newer.
- **`BACKUP_AUTH_DATA`:** keep the default **`include`**. `postgres` holds
  `SELECT` on `auth.users` with grant option, so the migration can grant it to
  `backup_reader` and staff accounts can be in the backup. The grant itself has
  not been tried (this spike was read-only); the 0007/0008 migration is where it
  is proven, and `skip` stays the documented fallback if the grant is refused.
- **RLS owners:** no `public` table with RLS is owned by a role other than
  `postgres`, so the 0007 policy loop over tables owned by the migration role
  covers all of them and no table needs a manual policy. `app.workspaces` has
  no RLS, so it needs only the `SELECT` grant, not a policy.
- **Sizes:** the database (about 21 MiB) and the referenced documents (about
  69 MiB) together are about 90 MiB, far below the 2 GiB in-memory guard.
- **Connection:** the backup connects through the session pooler (port 5432,
  not the transaction pooler on 6543 that the backend uses), with a connection
  string of the shape
  `postgresql://backup_reader.xykrphbgpwisqacpyeiv:<url-encoded password>@aws-1-ap-south-1.pooler.supabase.com:5432/postgres`.
  The password lives only in the workflow's secret store.
