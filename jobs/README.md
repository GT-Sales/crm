# jobs

Backend-invoked outbox orchestration and provider handlers. The runner receives a
tenant-scoped store from `apps/backend`; it never imports the database or discovers
tenants itself. The backend scheduler registry supplies the explicit workspace set.

Each handler runs under a per-handler abort timeout (the signal is passed as the
handler's optional second argument) and the whole run stops claiming new jobs
after a run deadline. A timeout is recorded `uncertain` with `handler_timeout`.
`createFailingJobHandlerRegistry(code)` builds a registry whose handlers fail
permanently with one code, used when no provider adapter is configured.

Jobs are claimed one at a time immediately before execution, up to `batchSize`
per authorized workspace. Pending jobs do not spend their lease waiting behind
earlier handlers, and the run deadline is checked before each claim. Provider
timeouts remain uncertain and require reconciliation; this is not an exactly-once
delivery guarantee across process crashes.

Ordinary handlers receive database operations from backend-owned orchestration;
`jobs/**` has no blanket database-import exemption. Any future offline migration,
backup, restore or database-test entry point must have its exact file path added to
`offlineDbFiles` in `packages/config/boundaries.js`, with its responsibility and
exception documented in the same task.
