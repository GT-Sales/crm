# GT Sales CRM

One backend and one admin for every GT Sales website — Get Canada Sim,
CanadaWide, and the sites that follow. Each website sends its leads and orders
to the backend with its own key; staff work all of them from one CRM.

**Start with [AGENTS.md](AGENTS.md)** (rules, commands, where things live),
then [docs/HANDOFF.md](docs/HANDOFF.md) (what is live and what comes next),
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how it works),
[docs/PLAN.md](docs/PLAN.md) (decisions) and [docs/ENV.md](docs/ENV.md)
(every variable).

| Path           | What it is                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/backend` | Express + strict TypeScript API. The only database client. Docker image on Railway.                          |
| `apps/admin`   | Next.js CRM for staff. Backend API client only. Vercel.                                                      |
| `packages/*`   | Shared code: contracts (Zod + typed client), db (Drizzle + RLS), types, adapters, ui, config, observability. |
| `jobs`         | Outbox job handlers; the backup, monitor, retention and restore CLIs.                                        |
| `docs/`        | Handoff, architecture, decisions, environment variables, runbooks, the generated OpenAPI document.           |

Websites live in their own repositories and never hold a database key.
