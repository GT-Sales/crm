# Merge phase 7: Canadian Plans moves

Status on 2026-10-30: to do. Shared rules, the gate, the shipping procedure
and the working method are in [README.md](README.md#shared-conventions); this
page adds what is particular to phase 7.

## 1. Purpose and done when

Spec §12 row 7: "Canadian Plans moves: new deployment and database,
`apps/site-1` to its own repository, old backend and admin off". Done when:
**a Canadian Plans test order goes through the new deployment.**

In plain words. This repository becomes the product Canadian Plans runs on, as
its second deployment: its own Railway service, Vercel admin project, Supabase
project (database, Auth, Storage), Resend domain and secrets, built from the
same `main` with different environment variables (spec §3). Canadian Plans
holds only test orders, so its new database is built from this repository's
migrations, with no data move (decision 7). Its storefront, `apps/site-1` in
the Canadian Plans repository, moves to a repository of its own and calls the
new deployment's website API with a site key, like Get Canada Sim and
CanadaWide. Then Canadian Plans' own backend and admin are switched off. The
spec puts this after phases 1 to 6 (decision 30); until then the Canadian Plans
repository takes bug fixes only.

## 2. Read first

1. [README.md](README.md): the shared rules, gate, shipping and method.
2. `AGENTS.md`: rules, vocabulary, where things live.
3. `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md`, all of
   it, and §2 (decisions 2, 4, 5, 7, 8, 9, 11, 12, 19, 27, 30, 31), §3, §4, §10,
   §12, §14, §15, §16 (the note for Canadian Plans' `PLATFORM_CONTEXT.md`).
4. `docs/HANDOFF.md` §1 (every system of the GT Sales deployment), §2 (the
   architecture), §2.6 (the website contract a storefront follows), §3.1 (how
   phase 0 stood the deployment up, with what went wrong), §5.1 (owner steps),
   §6 (how to work here).
5. `docs/PLAN.md` §3 (hosting; why the backend sits near its database) and §10.
6. `docs/ENV.md` in full: every variable a new deployment sets.
7. `docs/RUNBOOKS/database.md` (first install, "Add a site", runtime password),
   `docs/RUNBOOKS/backup.md` (a deployment's B2 bucket, keys and GitHub
   Environments), `docs/RUNBOOKS/restore.md`, `docs/RUNBOOKS/legacy-import.md`
   (the pattern for a rehearsed data move, if one turns out to be needed).
8. `.github/workflows/backup.yml`, `backup-monitor.yml`,
   `backup-retention.yml`: the per-deployment matrix.
9. Canadian Plans (`/home/user/canadianplans-web-app`): `AGENTS.md`,
   `PLATFORM_CONTEXT.md` (its apps, stack, invariants and decisions),
   `docs/DEPLOYMENT_INVENTORY.json`, `docs/RUNBOOKS/release-rollback.md` (its
   Railway and Vercel resources), `docs/ENV.md`, `railway.json`,
   `apps/backend/Dockerfile`, `apps/admin/vercel.json`, `apps/site-1/vercel.json`,
   `apps/site-1/package.json`, `apps/site-1/AGENTS.md`,
   `apps/site-1/src/lib/backendClient.ts`, the `/track` flow in
   `apps/site-1/src/app/(track-order)/track/`,
   `packages/adapters/src/static-catalogue/site-1-plans.ts`,
   `docs/LAUNCH_PLANS.md` and `docs/ADR/0005-static-catalogue-regional-plans.md`.

## 3. What already exists to build on

The product and its first deployment:

- **One repository, deployed per business** (spec §3). GT Sales is the first
  deployment: Railway project `GT Sales CRM` (`ea4ffa36-d587-45b8-a64d-9f8f84fbd42f`),
  service `crm` (`01c9dcfa-644d-4c52-ade1-b08d65114443`), environment
  `production` (`112461fd-4e06-44bc-a5ae-13f40438f69e`), health
  `https://crm-production-cf2e.up.railway.app/api/v1/health`; Vercel admin
  project `gt-sales-crm-admin` (team `gt-sales`, root `apps/admin`, Node 22,
  production from `main`); Supabase project `xykrphbgpwisqacpyeiv`.
- **Build files**: `railway.json` (Dockerfile build, `apps/backend/Dockerfile`),
  `apps/admin/vercel.json`, `scripts/affected-builds.mjs` (skips builds a change
  does not touch). A second Railway service and Vercel project can point at the
  same repository and `main`.
- **Migrations** `packages/db/drizzle/0000` to `0014` (plus phases 5 and 6),
  applied to a fresh database with the Drizzle migrator
  (`pnpm --filter @gt-sales/db db:migrate`, `MIGRATION_DATABASE_URL` as the
  project's `postgres` role on the direct port). GT Sales-specific steps in
  them are no-ops elsewhere: the CanadaWide mirror (0002, 0005, 0006) checks the
  site slug and the legacy tables, and 0012 seeds plans only for a site with
  slug `getcanadasim`.
- **Seeding a site**: "Add a site" in `docs/RUNBOOKS/database.md` (site row,
  roles, permissions), then the first owner by invitation from the admin.
  `packages/db/src/seed.ts` is synthetic and refuses hosted databases.
- **Staff sign-in**: Supabase Auth email and password, confirmation on,
  sign-ups allowed (the invitation flow needs them), Site URL and redirect URL
  set to the admin's address, custom SMTP for invitations (HANDOFF §1, §5.1
  item 4). No MFA (spec decision 5), although Canadian Plans required it.
- **Backups per deployment**: the three workflows run a matrix
  (`deployment: [gt-sales]` today); adding one is one matrix entry in each, three
  GitHub Environments named after it with its own secrets, its own B2 bucket
  and keys and its `auth_data` value (`.github/workflows/backup.yml` header,
  `docs/RUNBOOKS/backup.md`).
- **The website contract** a storefront follows (HANDOFF §2.6): a site key
  (`gtsk_…`, scopes `leads:write`, `uploads:customer`), `POST /website/leads`
  with `leadType`, contact, form, attribution, `externalRef` and `submit`,
  draft grants for multi-step forms, `GET /website/plans`, orders as
  `order: { planId, quantity }` with the plan frozen at submission, document
  uploads, `Idempotency-Key`, and (after phase 5) the tracking routes. The
  reference client is CanadaWide's `lib/crm.ts`.
- **Plans** in the admin (Settings → Plans, `order.manage`), one site each, one
  order lead type each, a price in cents, up to 200 per site (`PLAN_LIMIT` in
  `packages/contracts/src/plans.ts`).
- **Lead types are code** (`leadTypeCatalog` in
  `packages/contracts/src/lead-types.ts`, the registry in
  `apps/backend/src/leads/types.ts`): `sim_order`, `internet`, `mobility`
  (order types), `partner_application`, `contact_message`.

Things in the code that name GT Sales or its sites, to make per deployment or
per site (found by a search on 2026-10-30; search again):

- the product name "GT Sales CRM" in `apps/admin/src/app/layout.tsx`,
  `apps/admin/src/components/app-sidebar.tsx`, the login copy in
  `apps/admin/src/app/login/page.tsx`, the owner alert subjects in
  `packages/adapters/src/alerts.ts`, an old template subject in
  `packages/adapters/src/messaging.ts` and the OpenAPI title in
  `packages/contracts/src/openapi.ts`;
- `deliveryLetterUrl` (Get Canada Sim's mailer) on `sim_order` in
  `packages/contracts/src/lead-types.ts`;
- Get Canada Sim and CanadaWide names in `packages/contracts/src/lead-properties.ts`
  and `apps/backend/src/leads/identity-store.ts`;
- the package scope `@gt-sales/*`, which stays until the owner moves and renames
  the repository (decision 27).

Canadian Plans today (read from its repository; its resource ids are in its
`docs/RUNBOOKS/release-rollback.md`, recorded 2026-09-21, not re-checked):

- A Railway project `canadian-plans-backend` (service `backend`), a Vercel team
  `canadian-plans` with projects for the admin and `site-1` (and one named
  `umami`), Supabase in `us-west-2` (`PLATFORM_CONTEXT.md` §3).
- `apps/site-1` depends on the workspace packages `@canadian-plans/contracts`,
  `@canadian-plans/ui` and `@canadian-plans/config` (`apps/site-1/package.json`),
  and calls its backend through `src/lib/backendClient.ts` with
  `SITE_1_BACKEND_URL` and `SITE_1_SERVICE_CREDENTIAL`.
- Its plans live in a repository catalogue
  (`packages/adapters/src/static-catalogue/site-1-plans.ts`, ADR 0005), priced
  by province (`docs/LAUNCH_PLANS.md`). It uses quotes and offer versions,
  which this product does not have (decision 12).
- Its own invariants differ from the product's in places (for example `aal2`
  for privileged actions); the product's rules win (spec §2).

What does not exist: a second deployment, a published contracts package (spec
§3 says it is published privately so website repositories get the types and
client; to do), configuration for a product name per deployment, and a
runbook for standing up a deployment.

## 4. Decisions already made (binding)

Shared rules 1 to 23 in [README.md](README.md#rules-that-bind-every-phase) bind
this phase. In particular: no PII in logs, audit, timeline or runs (8);
sensitive properties never in filters, columns, views or the timeline (9); never
edit an applied migration (3); contracts hold every schema and the endpoint
registry (5); admin copy in sentence case, labelled, keyboard-usable (15);
strict TypeScript (6); integration suites on a `_test` database with fixed UUID
ranges (16); the Orders-only member cannot reach the documents override (11);
rescued incomplete checkouts get no rule mail (13); every rule off until
switched on (12).

| Decision                                                                                                                                      | Why                                                               | Where recorded                         |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| A reusable product: one codebase, one deployment and database per business, each configured for its own modules, rules and branding.          | The owner runs two businesses with the same purpose.              | Spec §2 decision 2; §3                 |
| Websites, Canadian Plans' storefront `apps/site-1` included, live outside the product and call the API with a site key.                       | One product, many storefronts.                                    | Spec §2 decision 4                     |
| Only GT Sales' data is live; Canadian Plans holds test orders and is rebuilt from this product's migrations.                                  | Nothing to migrate.                                               | Spec §2 decision 7                     |
| This repository and its migration history are the base; Canadian Plans features came in through additive migrations.                          | GT Sales keeps its live database.                                 | Spec §2 decision 8                     |
| Plans are a plans object managed in the admin, each belonging to one site; no Sanity sync; no quote step or offer versions.                   | Owner choices.                                                    | Spec §2 decisions 9, 11, 12            |
| Multi-factor sign-in is off in every deployment.                                                                                              | The CRM's 2026-10-25 decision, made product-wide.                 | Spec §2 decision 5                     |
| Each deployment gets the imported backup system: database and documents, encrypted, to its own Backblaze B2 bucket, with a practised restore. | Backups first, for every business.                                | Spec §2 decision 19; §10; phase 1 plan |
| The repository stays at `GT-Sales/crm` with `@gt-sales/*` names; the owner moves and renames it later, in one step.                           | Each extra deployment is one more thing to reconnect at the move. | Spec §2 decision 27; §14               |
| Canadian Plans moves after phases 1 to 6; until then its repository gets bug fixes only.                                                      | Avoid drift while porting.                                        | Spec §2 decision 30; §15               |
| The blog editor and the partner portal are not in the CRM.                                                                                    | Website content gets its own CMS approach; the portal waits.      | Spec §2 decision 31                    |
| `packages/contracts` is published privately so website repositories get the types and the typed client.                                       | Storefronts outside the repository need the contract.             | Spec §3                                |
| Canadian Plans' `PLATFORM_CONTEXT.md` gets a note that new work happens here.                                                                 | Sessions in the old repository must not build there.              | Spec §16                               |
| An order is a lead; one lead is one sale, with a quantity.                                                                                    | Hard to change later.                                             | Spec §2 decisions 13, 29; §14          |
| Every new deployment's migrations are applied deliberately per database, as today.                                                            | Migrations are never part of a deploy.                            | Spec §3; AGENTS.md "Git"               |

## 5. Open decisions to put to the owner before planning

1. **Domains and DNS.** Spec silent. Ask: the admin's address for Canadian
   Plans (a Vercel default host first, or a custom domain), the backend's
   (Railway default host or custom), and whether the storefront's domain moves.
   Recommended: default hosts for the admin and backend first; the storefront
   keeps its domain and its Vercel project is re-pointed at the new repository,
   so DNS does not change.
2. **Regions.** Recommended: put the new backend in the Railway region nearest
   the new Supabase project (the GT Sales lesson: a far database turned a page
   into seven seconds, PLAN §3 "Hosting"). Ask which Supabase region Canadian
   Plans wants (its own docs leave `ca-central-1` open).
3. **Supabase plan.** Ask Free or Pro for the new project (spec §15 asks the
   same for GT Sales).
4. **Data move.** Spec answers: none. Confirm nothing in Canadian Plans'
   database must be kept, including staff accounts (they are re-invited) and
   any test documents.
5. **Freeze window.** Recommended: the storefront's order form is closed from
   the moment the old backend stops taking orders until the new one has passed
   a test order; ask for a day and time.
6. **Rollback.** Recommended: keep the old backend and admin deployable
   (paused, not deleted) for 14 days, with the storefront's previous
   deployment ready to promote; ask for the length.
7. **Lead types and plans.** Ask which forms Canadian Plans' storefront sends
   and how its province prices map. Recommended: its mobility and internet
   forms as the existing `mobility` and `internet` types if their fields fit
   (a new code-defined type otherwise, spec §5.3), and one plan per offer and
   province, since a plan has one price.
8. **Publishing the contracts.** Ask how the storefront gets the types.
   Recommended: a private package in the GitHub organisation, built from
   `packages/contracts`, versioned with the API; the alternative is a copied
   client in the storefront repository.
9. **The storefront's new repository.** Ask its owner and name, and whether to
   keep its history (a history-preserving split) or start fresh.
10. **Product name and branding per deployment.** PLAN §10 leaves the product
    name open. Recommended: a backend and admin variable for the product name,
    used where "GT Sales CRM" appears today, and site-level values (like the
    delivery letter address) moved to per-site settings.
11. **What happens to Canadian Plans features this product dropped** (quotes,
    waitlist, catalogue sync, Sanity, partners, invoices, the blog). Spec
    answers which are skipped or later (§4). Ask what the storefront shows
    instead on the pages that used them.
12. **Who does the dashboard steps.** The session's Vercel token could update
    but not create a project on the GT Sales team, and the owner created the
    Railway project (HANDOFF §3.1). Recommended: plan the creation steps as
    owner steps with exact clicks, and the rest from the session.
13. **Recovery key.** Recommended: a separate `age` key pair per business, so
    one lost or leaked key affects one business.

## 6. Constraints and conventions

[README.md shared conventions](README.md#shared-conventions) first. Then:

- GT Sales keeps working throughout: nothing in this phase changes the GT
  Sales deployment's variables, database or domains, and every code change is
  backward compatible for it.
- No secret is created in or copied through the session's chat or the
  repository; the owner sets them in Railway, Vercel, Supabase and GitHub.
  Docs list variables by name.
- The new database gets the same roles as GT Sales: `app_runtime` (password
  only in Railway's `DATABASE_URL`) and `backup_reader` (for the backup
  workflows); find the right pooler host for the new project (GT Sales' answers
  only on `aws-1`, ENV.md `DATABASE_URL`).
- Code changes that make values per deployment (product name, alert subjects)
  or per site (delivery letter address) are ordinary phase work with tests and
  a pull request; infrastructure steps are recorded in a new runbook as they
  happen.
- Any data move that turns out to be needed is rehearsed on a copy with counts
  reconciled before and after (spec §13).

## 7. Suggested task breakdown

| #   | Task                                                                                                                                                                                                                                                  | Files or systems                                                                                                         | Tests                                                              | Model | Depends on |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ----- | ---------- |
| 0   | Spike: map every call `apps/site-1` makes to its backend onto this product's website API; list what has no counterpart; map its plans and forms to plans and lead types.                                                                              | Canadian Plans `apps/site-1/src/lib/backendClient.ts` and its callers; this repo's `packages/contracts/src/endpoints.ts` | A written map in the plan.                                         | hard  | decisions  |
| 1   | Per-deployment and per-site values: product name, alert subjects, the delivery letter address, any other found by the search in section 3.                                                                                                            | `apps/admin/src/`, `packages/adapters/src/alerts.ts`, `packages/contracts/src/lead-types.ts`, ENV.md                     | Unit and component tests; GT Sales' values unchanged by default.   | easy  | 0          |
| 2   | Contracts publishing (if decision 8 is yes): package metadata, a publish workflow, versioning.                                                                                                                                                        | `packages/contracts/package.json`, `.github/workflows/`                                                                  | A dry-run publish in CI.                                           | hard  | 0          |
| 3   | Any lead type or field the storefront needs that the registry lacks (decision 7).                                                                                                                                                                     | `packages/contracts/src/lead-types.ts`, `lead-properties.ts`, `apps/backend/src/leads/types.ts`                          | Intake unit and integration tests.                                 | hard  | 0          |
| 4   | The new deployment, owner and session together: Supabase project (migrations by the migrator, roles, Auth settings, Storage bucket and S3 keys), Railway service and variables, Vercel admin project, Resend domain, first site and owner invitation. | Railway, Vercel, Supabase, Resend dashboards; `docs/RUNBOOKS/new-deployment.md` (new)                                    | Health 200; the owner signs in; a site key created.                | hard  | 1          |
| 5   | Backups for the new deployment: matrix entries, three GitHub Environments, B2 bucket and keys, recovery key, first run, a restore drill.                                                                                                              | `.github/workflows/backup*.yml`, `docs/RUNBOOKS/backup.md`                                                               | A nightly run lands; the drill is recorded.                        | easy  | 4          |
| 6   | The storefront's own repository: the split, its dependencies (published contracts or a copied client), the calls rewired to the new API, its variables.                                                                                               | The new storefront repository                                                                                            | Its unit and e2e tests against a local backend of this repository. | hard  | 2, 3, 4    |
| 7   | Done when: a Canadian Plans test order through the storefront into the new deployment, worked in its admin (plan frozen, documents, stage moves, email to a test address).                                                                            | Both deployments                                                                                                         | A written record of the order's path.                              | hard  | 5, 6       |
| 8   | Switch-off: the old backend and admin paused for the rollback window, then removed; the Canadian Plans repository archived or marked; its `PLATFORM_CONTEXT.md` note.                                                                                 | Canadian Plans' Railway and Vercel projects; its repository                                                              | The old URLs answer as decided; nothing still calls them.          | easy  | 7          |
| 9   | Docs: HANDOFF §1 per deployment, ENV.md (variables per deployment), the new runbook, PLAN §7 and §10, AGENTS.md, this README.                                                                                                                         | `docs/`                                                                                                                  | Prettier.                                                          | easy  | all        |

Parallel worktrees: 1 ∥ 2 ∥ 3 after the spike; 4 and 5 are mostly dashboard
work alongside; 6 after 2, 3 and 4; then 7, 8, 9.

## 8. How to ship

The code gate (README "Commands and the gate"), for every pull request to this
repository:

```sh
pnpm run lint && pnpm run typecheck && pnpm run format
ENV(n) pnpm run test
pnpm --filter admin test:e2e:leads
pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json
```

PR title "<what it does> (merge phase 7)" with the footer; subscribe and
schedule a check-in; merge with a merge commit; Railway backend first with
health 200, then the Vercel admin, for GT Sales as always.

For the new deployment:

1. Its database is fresh, so apply every migration with the Drizzle migrator
   (`MIGRATION_DATABASE_URL` as `postgres` on the direct port), which records
   the Drizzle tracker; the Supabase tool's prompts do not arise. Then set the
   `app_runtime` and `backup_reader` passwords and run the verification
   selects of each paste file in `docs/RUNBOOKS/manual/` that applies.
2. Deploy its backend (Railway, health 200), then its admin (Vercel), then the
   storefront.
3. Live check: the test order of section 7 task 7, then the switch-off.

## 9. Working method

As in [README.md](README.md#working-method). For this phase:

- Brainstorm the thirteen decisions one at a time. Several need the owner at a
  dashboard; agree a time.
- The spike (task 0) comes before the plan's task list is final.
- Opus for tasks 0, 2, 3, 4, 6 and 7; Sonnet for 1, 5, 8 and 9.
- Keep an infrastructure ledger beside the SDD ledger: every resource created,
  by whom, its id (ids are not secrets), never a key.
- The Review Focus should include: a GT Sales value changed by a per-deployment
  default; the storefront sending a price; a missing variable on the new
  deployment (the backend must refuse to start or report "not configured",
  never run half-set); the backup completeness guard on the new database.

## 10. Definition of done checklist

- [ ] The owner's answers to section 5 are recorded in the plan header.
- [ ] The plan is approved and committed in `docs/superpowers/plans/`.
- [ ] The new deployment runs: health 200, the owner signs in, its site and key
      exist, its variables are listed by name in ENV.md.
- [ ] Its nightly backup lands in its own B2 bucket and a restore drill is
      recorded.
- [ ] The storefront lives in its own repository and calls the new deployment.
- [ ] A Canadian Plans test order went through the new deployment (spec §12).
- [ ] The old backend and admin are off after the rollback window; Canadian
      Plans' `PLATFORM_CONTEXT.md` says new work happens here.
- [ ] GT Sales was unaffected throughout (health, a test lead, the live check).
- [ ] HANDOFF, PLAN, ENV, the new runbook, AGENTS.md and this folder's README
      are current.
