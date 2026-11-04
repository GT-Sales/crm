# Confirmed AI task and note actions — 2026-11-04

Reviewed the implementation merged in PR #21 (`2514bc4`, merge `ed38332`).

Staff ask the assistant to draft a task or note, inspect its Site, lead and exact
contents, then press Confirm. The authenticated endpoint validates the signed
draft and current permissions, writes through the existing tenant-scoped store,
and returns a receipt displayed by the panel.

## Findings

No implementation defect was found in the reviewed confirmation and retry paths.
The follow-up adds regression coverage; it does not change runtime behavior.

| Boundary              | Evidence                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit confirmation | Proposal tools have no write store. Browser tests read the lead before Confirm and find no new note/task; Cancel leaves it unchanged.                                                                                                                   |
| Permissions           | The confirmation endpoint rechecks active membership, `workspace.read` and `lead.manage`. Tests cover missing/pending/revoked memberships, Finance/Orders-only callers, disabled assistant and disabled Site; exact 400/403/503 responses are asserted. |
| Token integrity       | Existing tests cover altered content, expiry, wrong actor/Site, key rotation and extra request fields. The token never enters model tool results.                                                                                                       |
| Tenant isolation      | A real `app_runtime` store call under another Site returns `not_found`, even though the actor belongs to both Sites.                                                                                                                                    |
| Concurrent retries    | Two connections confirm the same IDs: one note, one task and one creation audit each. Archive/restriction checks still apply on replay.                                                                                                                 |
| Later staff work      | Retrying the original task after staff edit and complete it preserves its title/status and adds no creation audit.                                                                                                                                      |
| Lost receipts         | Phone/desktop browser journeys drop successful note and task HTTP responses, retry the same cards, then read back exactly one saved record.                                                                                                             |

## Verification environment

Node 22.19.0, pnpm 9.15.0, disposable local Postgres 17.6 with `app_runtime`.
The focused run passed 12 files and 156 tests. Browser tests use the actual admin,
backend and database with a deterministic model and test staff verifier. They do
not establish live-provider intent recognition or production session behavior.
All 30 authenticated browser journeys passed, including the eight AI journeys;
all 14 general browser shell checks passed too. Typecheck, lint, formatting and
both production builds passed; regenerating OpenAPI produced no diff.
The full suite passed all 225 files: 2,648 tests passed and four backup
tool-dependent tests skipped because local `pg_dump`/`age` are unavailable.
It ran with two workers, 30-second test and 60-second hook timeouts to fit this
workspace while the browser/build checks ran.

No hosted database writes, model spending, production configuration changes or
deployments are part of this review. Live rollout still follows the AI runbook.
