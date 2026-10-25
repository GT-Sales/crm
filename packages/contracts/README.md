# @canadian-plans/contracts

Zod request/response schemas, the error envelope, generated OpenAPI (added
later), the typed API client, and browser-safe CMS schema definitions under
an explicit `cms` export.

## Single responsibility

Be the one place that defines what the backend accepts and returns, so the
backend and every frontend validate against the same schema instead of each
re-declaring it.

## Must never import

- `@canadian-plans/db` — DB row types are not API response types
  (PLATFORM_CONTEXT.md §4 invariant 14). Contracts expose only the fields
  each audience is allowed to see.
- `@canadian-plans/adapters` or any provider SDK/secret — this package is
  bundled into the browser.
- Any app (`apps/*`).
