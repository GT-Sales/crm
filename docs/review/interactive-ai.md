# Interactive AI verification — 2026-11-04

Implemented editable action cards, structured clarification questions and reviewed
customer email. The selected email flow is draft → edit → Send, not autonomous
sending. Design and rollout: `docs/design/interactive-ai.md`.

| Boundary            | Verification                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Card editing        | UI tests edit a note, obtain a fresh signed proposal and confirm only its new token. The revision route rejects changing the signed lead/kind and performs no business write.              |
| Guided conversation | The SDK tool emits a validated question/choices part only after a completed turn. Choosing a reply sends a new staff message, with the question preserved in bounded text history.         |
| Email review        | UI and authenticated phone/desktop journeys edit subject/body before Send. To/From are backend-resolved browser-only metadata bound to the signed preview.                                 |
| Address changes     | Real Postgres tests refuse both a changed recipient and changed sender before queueing. Archived/restricted/foreign-Site leads remain unavailable.                                         |
| Retries             | Two database connections confirm the same email concurrently: one outbox job and one creation audit. Phone/desktop journeys lose a successful Send response and retry its unchanged token. |
| Delivery            | The existing outbox handler's fake adapter receives the reviewed subject/body and Site sender, after eligibility checking and delivery preparation. The UI claims queued, not delivered.   |
| Rendering           | Model-authored HTML is escaped; template fill-ins remain literal text in ad hoc email. Recipient addresses and confirmation tokens are not model tool results/history.                     |

Node 22.19.0, pnpm 9.15.0 and disposable local Postgres 17.6. Full run: 225
files passed, 2,656 tests passed and four backup tool-dependent tests skipped
(`pg_dump`/`age` unavailable). Final mail-store concurrency checks passed all 20
tests; the email handler suite passed all 14 tests. Typecheck, lint, formatting
and both production builds passed. OpenAPI was regenerated with 78 paths.

All 32 distinct authenticated browser journeys passed across the main run and
targeted rerun, including ten AI journeys. The main run stopped at an existing
lead-resize animation check that missed an active transition during concurrent
checks. That case, the five not-yet-run journeys and the two new AI scenarios
all passed on the quieter eight-test rerun. An initial new phone test raced the
opening lead sheet; it now scopes the trigger to the mobile dialog.
All 14 general browser shell checks passed as well.

Browser tests use the actual local admin/backend/database with a deterministic
model and test session verifier. No hosted records, real customer sends or model
spending were used. Real-model clarification quality, provider availability and
live delivery remain rollout checks on a controlled synthetic Site/recipient.
No migration or new secret is required. No production release was performed.
