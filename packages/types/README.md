# @canadian-plans/types

Shared domain TypeScript types (no runtime code, no validation logic).

## Single responsibility

Define the domain-level TypeScript types (workspace, offer, quote, order,
etc. — added as each feature lands) that both the backend and every frontend
need to agree on, in exactly one place.

## Must never import

- `@canadian-plans/db` (row types live there; this package defines
  domain-level types, not persistence types).
- `@canadian-plans/contracts`, `@canadian-plans/adapters`, `@canadian-plans/ui`.
- Any app (`apps/*`), any provider SDK, or any secret.
