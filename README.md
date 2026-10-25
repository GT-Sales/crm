# GT Sales CRM

One backend and one admin for every GT Sales website — Get Canada Sim,
CanadaWide, and the sites that follow. Each website sends its leads and orders
to the backend with its own key; staff work all of them from one CRM.

**Start with [docs/PLAN.md](docs/PLAN.md).** It records the decisions, the
architecture, what is reused from the Canadian Plans platform, and the phased
build.

| Path           | What it is                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/backend` | Express + strict TypeScript API. The only database client. Docker image on Railway.                   |
| `apps/admin`   | Next.js CRM for staff. Backend API client only. Vercel.                                               |
| `packages/*`   | Shared code: contracts (Zod + typed client), db (Drizzle + RLS), adapters, ui, config, observability. |
| `docs/`        | Plan, decisions, runbooks.                                                                            |

Websites live in their own repositories and never hold a database key.
