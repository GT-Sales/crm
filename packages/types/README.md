# @gt-sales/types

Shared domain TypeScript types (no runtime code, no validation logic).

## Single responsibility

Define the domain-level TypeScript types (workspace, offer, quote, order,
etc. — added as each feature lands) that both the backend and every frontend
need to agree on, in exactly one place.

## Must never import

- `@gt-sales/db` (row types live there; this package defines
  domain-level types, not persistence types).
- `@gt-sales/contracts`, `@gt-sales/adapters`, `@gt-sales/ui`.
- Any app (`apps/*`), any provider SDK, or any secret.
