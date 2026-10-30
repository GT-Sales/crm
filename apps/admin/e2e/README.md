# Admin browser checks

Two suites, both run in CI.

## Shell (`shell.spec.ts`)

The public sign-in, invitation, denial and recovery routes at desktop and
mobile widths, and proof that a deployment without an authenticated,
configured staff session never renders the workspace shell. Run
`pnpm --filter admin build`, then `pnpm run test:e2e` from the repository root;
Playwright starts the production server itself.

## Lead journeys (`leads.spec.ts`)

Staff working leads in a real browser against the real backend: the inbox's
type tabs, counts and search; a board move that survives a reload; the lead
page's assignment, note and task; completing that task from My tasks; the
archive and restore; custom properties, saved views and plans; and a SIM order
taken from Pending to Activated: the passport approved, the Dispatched and
Activated automations switched on and queuing their emails, and a template
edited, previewed and saved.

`pnpm --filter admin test:e2e:leads` builds the admin into `.next-e2e` with a
browser-test session seam, then `playwright.leads.config.ts` starts two
servers: the backend harness (`apps/backend/tests/e2e/harness.ts`) on 4100
against the disposable `gt_sales_crm_e2e_test` database, and the e2e admin
build on 3101. The harness runs the real app, routes, authorization store,
stores and RLS; its one seam is a stub session verifier that admits one seeded
owner for a fixed token, because CI has no Supabase Auth project. Email goes
through the fake provider and documents are reviewed against an in-memory object
store (nothing is uploaded or opened). Each start resets and reseeds the e2e
sites.

The seam is compiled out of every normal build (CI greps for it), and
`next.config.ts` refuses to build it on Vercel. Locally the suite needs
Postgres on `localhost:5432` with a `gt_sales_crm_e2e_test` database
(`createdb gt_sales_crm_e2e_test`). A journey with real Supabase sign-in still
belongs in a staging run.
