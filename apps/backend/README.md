# Backend

Express + strict TypeScript API, and the **only** application that connects to the
database (PLATFORM_CONTEXT.md §4, invariant 3). It serves the storefront and admin over
`/api/v1`, exposes authenticated `/api/internal` routes for manual job invocation, and runs
its scheduled work (outbox every 60 s, catalogue sync every 300 s, synthetic order check)
on an in-process scheduler when `ENABLE_SCHEDULER=1` (ADR 0004).

## Run locally

```sh
pnpm --filter backend dev          # http://localhost:4000
```

`GET /api/v1/health` needs no credentials. Everything else needs the variables listed in
[docs/ENV.md](../../docs/ENV.md): the pooled restricted database URL, Supabase Auth,
website service credentials, the machine registry, and the provider keys the task needs.

## Where things are

| Path                                                                                                                                | What it holds                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`, `src/server.ts`                                                                                                       | App wiring (middleware, CORS, routes) and the listener.                                                                                                              |
| `src/scheduler.ts`, `src/shutdown.ts`                                                                                               | In-process schedule with overlap guards; graceful shutdown inside Railway's drain window.                                                                            |
| `src/routes/`                                                                                                                       | `website` (storefront), `staff` (admin), `email` (provider webhooks), `jobs`, `catalogue-sync`, `sanity-webhook`, `synthetic-check`, `health`.                       |
| `src/website/`, `src/auth/`, `src/staff/`                                                                                           | Service-credential auth, rate limits and bot check; Supabase staff sessions, permissions and the `aal2` check.                                                       |
| `src/orders/`, `src/leads/`, `src/tracking/`, `src/documents/`, `src/partners/`, `src/deletion/`, `src/retention/`, `src/waitlist/` | Domain services and tenant-scoped stores.                                                                                                                            |
| `src/catalogue/`, `src/jobs/`, `src/email/`, `src/synthetic/`                                                                       | Catalogue sync, outbox runner wiring, email dispatch and the synthetic order check.                                                                                  |
| `src/machines/`                                                                                                                     | The server-only machine registry (webhook and scheduler identities, PLATFORM_CONTEXT §4b).                                                                           |
| `tests/`                                                                                                                            | Vitest unit tests and `*.integration.test.ts` against a disposable Postgres; `tests/e2e` holds the real-backend harness used by the admin and site-1 browser suites. |
| `Dockerfile`                                                                                                                        | Root-context image build for Railway (`railway.json` at the repo root).                                                                                              |

## Reference

- [docs/API.md](../../docs/API.md) and the generated [OpenAPI document](../../docs/api/openapi.json).
- [docs/SCHEMA_HISTORY.md](../../docs/SCHEMA_HISTORY.md) for every migration.
- Runbooks: [outbox jobs](../../docs/RUNBOOKS/outbox-jobs.md),
  [catalogue sync](../../docs/RUNBOOKS/catalogue-sync.md),
  [orders](../../docs/RUNBOOKS/orders.md),
  [release rollback](../../docs/RUNBOOKS/release-rollback.md).
