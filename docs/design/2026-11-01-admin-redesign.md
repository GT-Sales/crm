# Admin redesign — Shadcnblocks references

Requested by the owner on 2026-11-01. This replaces the previous PR #5 visual
direction for the staff admin. The existing CRM actions, permissions, routes,
tenant boundaries and typed API remain the product's behavior.

## References reviewed

- Live reference: <https://shadcnblocks-admin.vercel.app/ecommerce/dashboard-1>.
  Browser inventory covered 117 linked pages across ecommerce (23), project
  management (18), payments (23), AI tools (33), tasks (9), original admin (8),
  and authentication (3). All returned successful responses. Page screenshots
  and headings were captured locally; representative dashboard, customer
  detail, board, and settings screens informed the implementation.
- Owner-provided `admin-kit-shadcnblocks/shadcn-admin-1.0.0`: sidebar, header,
  theme, settings and table structures.
- Owner-provided blocks: `application-shell/application-shell1.tsx`,
  `stats-card/stats-card1.tsx`, and `chart-card/chart-card1.tsx`. Their layout
  and component patterns are adapted to the CRM's existing shared shadcn UI.
- Template license: Shadcnblocks.com License, copyright 2024 Shadcnblocks.com;
  supplied by the owner for a customized end product.

## Product mapping

| Reference pattern                              | CRM implementation                                                                            |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Grouped application sidebar and compact header | Workspace and Manage navigation, site context, page finder, theme control                     |
| Ecommerce KPI strip                            | Actual received/completed/pending/cancelled lead totals and existing type-specific outcomes   |
| Chart cards and category breakdown             | Daily lead volume, top partners, and a linked stage-distribution panel                        |
| Customer and issue tables                      | Lead table with clearer headers, person markers, roomy rows, existing filters and saved views |
| Customer detail                                | Lead record identity header, order/property cards, tasks and timeline                         |
| Project board and task lists                   | Existing stage board and task groups with softer columns and clearer boundaries               |
| Settings sidebar                               | General, properties/layouts, plans, email and background jobs with active-route context       |
| Document management                            | Useful entry point to the existing lead-bound document review workflow                        |

The dashboard uses backend counts. The reference's sample revenue, percentage
changes, billing, AI tools and unrelated product modules are not CRM features.

## Implementation

The admin defaults to light mode, retaining GT Sales red as the primary action
accent. A browser-local `gt-sales-theme` preference supports dark mode and is
applied before paint. Palette, table, card, chart-grid and responsive-shell
styles live in `apps/admin/src/app/crm-theme.css`, scoped to `.crm-ui`.
Shared UI tokens continue to serve other applications independently.

`ThemeToggle`, `QuickNavigation` (Ctrl/Cmd K), and `SettingsNavigation` use
existing accessible shared components. The page finder searches navigation
labels only. It does not request contacts or lead data. Status colors include
contrasting light and dark variants. Reduced-motion preferences are respected.

No new dependency, API shape, environment variable or migration is needed.

## Verification

Component coverage includes theme switching/storage, keyboard page finding,
dashboard filtering, lead columns, permissions and existing CRM interactions.
The real-backend browser suite additionally checks theme persistence after a
reload, settings navigation, representative screens, and narrow-screen layout.
Final command results and screenshots are recorded with the pull request.

Verified locally: 2,484 unit/integration tests (213 files, none skipped), 47
tooling tests, 14 public desktop/mobile browser checks, and all 15 real-backend
lead journeys normally and under UTC. Production build, typecheck, lint and
format checks passed. The regenerated OpenAPI is unchanged.

The public staff sign-in, invitation, recovery and access-denied pages use a
shared branded frame. The authentication forms and redirects retain their
existing behavior.

## Screenshots

These screenshots use the disposable browser-test database's synthetic data.

![Dashboard](screenshots/design-dashboard.png)

![Lead inbox](screenshots/design-leads.png)

![Settings](screenshots/design-settings.png)

![Mobile dashboard](screenshots/design-mobile-dashboard.png)
