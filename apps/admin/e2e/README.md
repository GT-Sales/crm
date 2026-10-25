# Admin browser checks

`shell.spec.ts` verifies the public sign-in, invitation, denial and recovery routes at desktop and mobile widths. It also proves that a deployment without an authenticated/configured staff session cannot render the workspace shell. Backend and component tests cover the active-membership workspace list; live Supabase journeys require the staging Auth project and SMTP configuration.

Run `pnpm --filter admin build`, then `pnpm run test:e2e` from the repository root. Playwright starts the production server automatically. Set `CAPTURE_SCREENSHOTS=1` to write review images to `docs/EVIDENCE/T2-screenshots`. These are static shell checks; they do not prove authentication or tenant authorization.

## Order journey (T14)

The full order-processing journey — list filters, permission-aware search, archive
toggle, bulk assign, and detail transitions through `in_progress` →
`ready_for_delivery` → dispatch → activate, plus the stale-edit reload and the
cancel-without-reason block — is covered by Vitest component tests in
`src/components/orders/orders-list.test.tsx` and
`src/components/orders/order-detail.test.tsx`. That suite drives the real
components against a stubbed typed client and a stateful test double of the
backend's transition map.

`orders.spec.ts` (CQ-01, 22 Oct 2026) runs the screens in a real browser against
the real backend harness (`apps/backend/tests/e2e/harness.ts`). It places an
order through the public API, opens the list and the detail, moves the order to
`in_progress`, and proves a stale second tab gets the version-conflict reload
prompt. CI has no Supabase, so the run uses a separate admin build
(`.next-e2e`) with a browser-test session seam: the harness's stub verifier
accepts one fixed token for its seeded owner. The seam is compiled out of every
normal build (CI greps for it), and `next.config.ts` refuses to build it on
Vercel.

Run it with a local Postgres and the disposable `gt_sales_crm_e2e_test`
database: `pnpm --filter admin test:e2e:orders` (the root `pnpm run test:e2e`
includes it). A live journey with real Supabase sign-in still belongs in the
staging run once staff Auth and SMTP are configured.
