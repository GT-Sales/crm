# @gt-sales/adapters

Server-only provider adapters: the object store (S3 protocol, used with
Supabase Storage), Resend email, owner alerts, error tracking, logging and the
Umami analytics sink, each behind an interface, plus in-memory fakes for
tests.

## Single responsibility

Isolate every third-party provider SDK and secret behind a small interface
so the backend depends on an interface, not a vendor.

## Must never import

- `@gt-sales/db` — adapters don't run queries; the backend composes
  db + adapters.
- `@gt-sales/ui` — this package is never bundled for the browser.
- Any app (`apps/*`).

Only `apps/backend` and `jobs/` may depend on this package.

Document PUT signatures bind the validated declared file length. Browser callers
must send the original `File` as the request body so the browser supplies its
`Content-Length`; do not manually set that forbidden browser header. Finalization
checks the private candidate's size and bounds its streamed body independently
before signature and checksum verification, including for older upload URLs.
