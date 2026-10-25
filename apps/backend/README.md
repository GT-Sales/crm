# Backend

Express 5 + strict TypeScript API, and the **only** application that connects
to the database (AGENTS.md rule 1). It serves the websites and the admin over
`/api/v1`, exposes authenticated `/api/internal` routes for manual job runs,
and drains the outbox, sweeps expired uploads and prunes operational rows on an
in-process scheduler when `ENABLE_SCHEDULER=1`.

## Run locally

```sh
pnpm --filter backend dev          # http://localhost:4000
```

`GET /api/v1/health` needs no credentials. Everything else needs the variables
in [docs/ENV.md](../../docs/ENV.md): the pooled restricted database URL,
Supabase Auth, and the machine registry for the scheduler.

## Where things are

| Path                                        | What it holds                                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/app.ts`, `src/server.ts`               | App wiring (middleware, CORS, routes) and the listener with graceful shutdown.                                                     |
| `src/scheduler.ts`, `src/shutdown.ts`       | In-process schedule with overlap guards; shutdown inside Railway's drain window.                                                   |
| `src/routes/`                               | `website` (lead intake, draft resume, customer uploads), `staff` (admin), `email` (Resend events), `jobs` (manual runs), `health`. |
| `src/website/`, `src/auth/`, `src/staff/`   | Service-credential auth, per-endpoint rate limits and bot check; Supabase staff sessions, per-action authorization.                |
| `src/leads/`                                | Lead store (lead types, contact merge by normalized email, draft grants, attribution sanitizer, source label).                     |
| `src/documents/`                            | Signed upload intents, finalize with file-signature verification, staff review, download links, expired-upload cleanup.            |
| `src/email/`, `src/jobs/`, `src/retention/` | Email persistence (hashed contacts, suppressions, consents, follow-ups), outbox store and provider wiring, retention tasks.        |
| `src/machines/`                             | The server-only machine registry (webhook and scheduler identities).                                                               |
| `src/crypto/cipher.ts`                      | AES-256-GCM sealing, kept for SIN protection in phase 1.                                                                           |
| `tests/`                                    | Vitest unit tests and `*.integration.test.ts` against a disposable Postgres; `isolation.spec.ts` is the tenant-isolation gate.     |
| `Dockerfile`                                | Root-context image build for Railway (`railway.json` at the repo root).                                                            |

## Reference

- The generated [OpenAPI document](../../docs/api/openapi.json) (rebuild with
  `pnpm --filter @gt-sales/contracts build`).
- [docs/RUNBOOKS/database.md](../../docs/RUNBOOKS/database.md) for migrations,
  the runtime role and adding a site.
