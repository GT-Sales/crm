# AI assistant branch review — 2026-11-02

## Completion follow-up — 2026-11-03

PR #18 is merged. Follow-up branch `claude/finish-ai-chat` addresses interrupted
turns: Stop, provider errors and disconnected streams no longer contribute
partial assistant text to the next model request. Completed turns and user
questions remain available as context. The production SDK adapter rejects the
`other` finish reason the SDK synthesizes for a stream missing its provider
finish frame; the HTTP route also requires an explicit engine finish before
sending sources or `done`.

Regression coverage exercises all three interruption paths, a truncated stream
through the actual SDK adapter, and the HTTP terminal-frame contract. Live
Railway inspection on this date found no `AI_*` variables in the CRM production
service (including sealed variables). No real provider call or deployment was
performed. Configure and validate one synthetic Site before enabling customer
data; the earlier offline evidence below does not establish live answer quality.

Follow-up verification uses Node 22.19.0, pnpm 9.15.0 and a disposable local
Postgres 17.6 container. Focused AI checks: 9 files, 109 passing tests, including
the database reads, HTTP streaming, SDK adapter and panel regressions. All six
authenticated AI browser journeys pass (375/1440 px, both themes, Stop and
nested lead sheets). Typecheck, lint, formatting, both production builds and
47 tooling tests pass; regenerating OpenAPI produces no diff.

An initial broad test run under concurrent build load hit 5-second timeouts
in unrelated automation/email suites and was stopped. It is not counted as a
passing full-suite run.
The rerun with two workers and 30-second test/60-second hook timeouts passed
all 223 files: 2,617 tests passed and four backup tool-dependent tests skipped
(no local `pg_dump`/`age`). All 14 general browser shell checks also pass.

## Original review

Reviewed `claude/ai-chat-implementation`, original head `2d2757d`, against
`docs/AI-ASSISTANT-IMPLEMENTATION-PROMPT.md`, after reading the repository's
agent guide, architecture/handoff, plan, configuration, existing read/auth
paths, SDK sources, test harnesses and CI requirements.

**Verdict on the original branch: substantial implementation, but not complete
or ready to enable.** Real database checks exposed two production blockers;
unit tests alone had passed. This review fixes those blockers and the gaps below.
Changes are local to the review checkout; nothing was deployed or enabled.

## Findings and corrections

| Finding                                                                                                                           | Correction                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Capabilities selected `app.workspaces`, which `app_runtime` is deliberately forbidden to read.                                    | Use the existing read-only `app.list_staff_workspaces()` function, scoped to the requested Site. No new grant or migration.                                                             |
| Overview/task date filters passed JavaScript Dates through raw SQL parameters; the actual driver rejected them.                   | Bind ISO timestamps with explicit timestamptz casts. Real Postgres tests now exercise the production role.                                                                              |
| Email/phone lookup and useful order details were absent.                                                                          | Site-scoped contact matching without returning contact values; explicit order allowlist, live catalogue checks, monetary/payment/commission fields gated by effective `financial.read`. |
| An open lead's ID was lost before the model prompt.                                                                               | Include the verified ID as a hint; all factual reads still go through authorized tools.                                                                                                 |
| Assignee UUIDs were accepted without checking membership.                                                                         | Validate active staff membership within the selected Site. Unknown/foreign member filters are typed invalid results.                                                                    |
| Results could exceed byte limits, especially one large row or nested notes/tasks; Other could evade record accounting.            | Measure the actual serialized candidate, trim whole records, charge exact accepted bytes/records, preserve Other and aggregate totals. Validate final minimized output schemas.         |
| Query failures and missing records shared a result category; archived detail and submitted-only cohorts lacked explicit controls. | Separate temporary failure; archived-summary opt-in; submitted-only overview; truthful pagination/truncation metadata.                                                                  |
| Source report lacked the AI statement deadline and used a different time boundary from the reported scope.                        | Internal deadline/as-of options preserve existing report semantics and defaults. Scope-specific source IDs prevent a later period from inheriting an earlier card's scope.              |
| A dependency fallback silently allowed requests without a distributed limiter.                                                    | Fall back to the real database limiter; failure refuses the request.                                                                                                                    |
| Custom SSE departed from the required SDK wire protocol.                                                                          | Use SDK v7 UI-message stream helpers and typed transient data parts; generated contract and client updated. Reader cleanup cancels the underlying stream.                               |
| SDK's default error handler could print provider errors, including sensitive request/response contents.                           | Override it with a silent handler; route logs fixed codes only. Added actual SDK regression coverage.                                                                                   |
| Revoked access left private conversation text visible; token refresh unnecessarily erased completed history.                      | Clear and close on denied/expired access; scope conversation to Site/member, retain completed history across same-member token refresh.                                                 |
| No context Remove control or history-trimming notice; Site switches could retain panel drafts.                                    | Add both controls; remount Site/member state synchronously. Unicode limits count code points.                                                                                           |
| Mobile sheet focused a header control; the mobile lead sheet hid the only AI trigger.                                             | Focus composer through the modal lifecycle; restore trigger focus; provide the trigger inside the mobile lead sheet. Both nested sheets retain the note draft.                          |
| No authenticated AI browser journey or actual SDK-loop test.                                                                      | Add real-backend/database Chromium journeys and `MockLanguageModelV4` adapter tests; add an explicitly opt-in synthetic live smoke and evaluation fixture.                              |

## Verification

Environment: Node 22.19.0, pnpm 9.15.0, frozen lockfile, disposable local
Postgres 17.6 with `app_runtime`, PostgreSQL client 17.11 and age 1.2.1.
No hosted/customer database was accessed.

| Check                                                | Final result                                                |
| ---------------------------------------------------- | ----------------------------------------------------------- |
| `pnpm test` with disposable database configuration   | 223 files, **2,616 tests passed**, no skipped suites        |
| Targeted AI/database/contracts-client regression run | 11 files, **147 passed**                                    |
| `pnpm run typecheck`                                 | All packages passed                                         |
| `pnpm run lint`                                      | Passed                                                      |
| `pnpm run format`                                    | Passed                                                      |
| `pnpm run build`                                     | All workspace builds passed, including admin and backend    |
| `pnpm --filter @gt-sales/contracts build`            | Generated 76 paths; second regeneration byte-identical      |
| `pnpm run test:tooling`                              | **47 passed**                                               |
| `pnpm run test:e2e`                                  | **14 passed**, desktop and mobile shell                     |
| `pnpm --filter admin test:e2e:leads`                 | **28 passed**: 22 existing lead journeys plus 6 AI journeys |
| Synthetic live-smoke guard                           | Expected exit 2 without opt-in/key/model; no provider call  |

The AI browser journeys cover 375/1440 px, both themes, streaming, Stop,
New chat, repeated open/close/focus, and nested lead sheets preserving an unsaved
note. Initial browser failures identified the mobile focus issue; final reruns
passed after the fix and separating authenticated journeys from the shell suite.

The original full review run passed 2,613 tests; the final three additions prove
Unicode limits, incremental delivery before HTTP completion, and suppression of
the SDK's default provider-error logger. The final targeted run also covers the
last summary truncation and submitted-only query assertions.

## Remaining distinctions and release steps

The wire protocol now uses the AI SDK. The frontend deliberately retains its
existing typed React state and shared client instead of adding `@ai-sdk/react`
`useChat`. This is the remaining package-level departure from the prompt;
conversation behavior is exercised end to end. General custom-property access,
documents, writes, persistent chats and cross-site analysis are not introduced.

No real Gateway model was exercised. The fake model tests establish wiring and
permissions, not natural-language answer quality or injection resistance of a
particular provider. A synthetic staging evaluation, current model/account
availability, pricing, retention, spend budget, real Supabase auth refresh and
deployed Vercel-to-Railway streaming remain external checks. Physical mobile
keyboards and screen readers still need device testing.

Backend configuration remains `AI_ASSISTANT_ENABLED=true`, `AI_GATEWAY_API_KEY`,
`AI_GATEWAY_MODEL` and a narrow `AI_ASSISTANT_WORKSPACE_IDS` allowlist. Access
requires active `workspace.read` plus `lead.manage`, `order.manage` or
`financial.read`, including existing permission overrides. Begin with one
synthetic Site using the runbook. Roll back by setting
`AI_ASSISTANT_ENABLED=false` and restarting/redeploying the backend.
