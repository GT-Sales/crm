# @gt-sales/contracts

Zod request/response schemas, the error envelope, the endpoint registry
(`src/endpoints.ts`), the typed API client, and the OpenAPI generator
(`pnpm --filter @gt-sales/contracts build` writes `docs/api/openapi.json`,
which CI diffs).

## Single responsibility

Be the one place that defines what the backend accepts and returns, so the
backend and every frontend validate against the same schema instead of each
re-declaring it.

## Must never import

- `@gt-sales/db` — DB row types are not API response types
  (docs/PLAN.md §3, rule 10). Contracts expose only the fields
  each audience is allowed to see.
- `@gt-sales/adapters` or any provider SDK/secret — this package is
  bundled into the browser.
- Any app (`apps/*`).
