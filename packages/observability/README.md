# @gt-sales/observability

Browser-safe PII scrubbing, structured log records and the error-tracker contract that
every app shares (REQ 40, PLATFORM_CONTEXT.md invariant 12).

## Single responsibility

Be the one scrubber and log shape for backend, admin and jobs: `scrubValue` /
`scrubRecord` redact emails, phones, names, documents and tokens; `safeIdentifier` and
`safeRoute` bound what may be logged; `buildLogRecord` and `buildErrorEvent` produce the
records the apps emit; `ErrorTracker` is the interface the adapters implement, with
`FakeErrorTracker` for tests. No app invents its own allowlist.

## Must never import

Provider SDKs, `@gt-sales/db`, or anything server-only. The package has no runtime
dependencies so it can run in the browser, on the server and in the jobs CLIs alike.
