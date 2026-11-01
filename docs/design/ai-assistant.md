# Ask AI — design, decisions and evidence

Status: **version 1 implemented; live-provider verification pending** (no Gateway
key or model was configured while building it). This file records what was
built, why each choice is safe, and what a reviewer should check before the
assistant touches real data.

Progress (phase gates from `docs/AI-ASSISTANT-IMPLEMENTATION-PROMPT.md`):

- [x] Discovery gate — SDK chosen from the installed package, boundaries read
      in the source, no unresolved architecture choice that could bypass tenancy.
- [x] Phase A — contracts, registry, capability route, disabled behaviour.
- [x] Phase B — authorization-aware reads, projections, five tools, turn budgets.
- [~] Phase C — streaming backend with a fake model (model loop, SSE, limits,
  cancellation and errors implemented and tested; the real Gateway engine
  compiles against `ai@7.0.159` but has never been run against a provider).
- [ ] Phase D — admin panel (in progress, separate change; see §10).
- [x] Phase E — docs, runbook and offline verification; live smoke test not run.

## 1. Discovery: versions and evidence

| Item               | Value                                                        | Evidence                                                                                                                            |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| SDK                | `ai@7.0.159` (backend dependency)                            | `apps/backend/package.json`; the installed package's `dist/index.d.ts` exports `streamText`, `tool`, `stepCountIs`, `createGateway` |
| Gateway provider   | bundled as `ai`'s own dependency (`@ai-sdk/gateway` 4.0.132) | `node_modules/.pnpm/ai@7.0.159_*/node_modules/ai/package.json`                                                                      |
| React hook package | **not installed** — see §9 deviation 1                       | —                                                                                                                                   |
| Node               | 22.19 (repo engines `>=22 <23`)                              | `package.json`                                                                                                                      |
| Zod                | v4 (catalog)                                                 | `pnpm-workspace.yaml` catalog; schemas use `z.uuid()`, `z.int()`, `z.toJSONSchema`                                                  |
| Transport          | server-sent events, one JSON part per frame                  | `packages/contracts/src/ai-assistant.ts`, `apps/backend/src/routes/ai-assistant.ts`                                                 |

The Gateway call is `createGateway({ apiKey })(modelId)`; the model id comes only
from `AI_GATEWAY_MODEL`, with no hard-coded fallback, so a deployment cannot
silently pick a paid model.

## 2. Trust boundaries and where they are enforced

```text
Admin browser (Vercel)
  -> POST /api/v1/staff/workspaces/:id/ai/chat        (authenticated staff router)
  -> live membership read + decideAiAccess            (backend)
  -> distributed per-actor / per-site rate limit      (app.rate_limit_hit)
  -> tools: reauthorize -> withTenantTx as app_runtime -> RLS
  -> projections (field allowlists) -> budget -> JSON tool result
  -> model via AI Gateway -> typed SSE parts -> browser
```

| Input                                 | Authority                                                            | Enforced in                                                    |
| ------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Verified staff session                | The actor; a body-supplied actor id is rejected by the strict schema | `requireStaffSession` (staff router) + `aiChatRequestSchema`   |
| Route `workspaceId` + live membership | The site                                                             | `loadAccess` + `decideAiAccess` in `routes/ai-assistant.ts`    |
| Tool arguments                        | Untrusted proposals                                                  | Zod schemas in `ai/tools.ts`; every value validated            |
| Lead id / context                     | A hint, re-authorized on read                                        | `getLeadSummary` reads by id inside the tenant transaction     |
| Browser chat history                  | Untrusted text                                                       | Re-validated; never produces a source card or an authorization |
| Records, names, notes                 | Untrusted data                                                       | System prompt treats them as data; rendering is escaped text   |
| Tool output                           | Authorized evidence                                                  | Explicit projections in `ai/projections.ts`                    |
| Model text                            | Presentation only                                                    | Rendered as text; links only come from server source cards     |

`decideAiAccess` uses the existing `decideAccess` (no second role table):
`workspace.read` **and** at least one of `lead.manage`, `order.manage`,
`financial.read`. Owner/Leads/Orders/Finance pass; Viewer/Content/Partners are
refused with `permission_denied`, and individual deny rules apply unchanged.

Access is rechecked **before every tool call** (`reauthorize` in
`ai/tools.ts`, throwing `AssistantAccessRevokedError`) and **once more before the
answer is released** (`routes/ai-assistant.ts`), which answers `access_lost` and
stops. Text already streamed cannot be recalled; the UI clears the conversation
on `access_lost`.

## 3. Reused reads, new queries, and side effects

| Tool                   | Source                                                                                                                                               | Side effects                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `getSiteOverview`      | New narrow parameterized counts in `ai/read-service.ts` over `app.leads` (type, window, `deleted_at is null`, `customer_data_restricted_at is null`) | none                                                                             |
| `findLeads`            | New narrow list in `ai/read-service.ts` (name/reference ILIKE, type, stage, assignee, archive, page) with `count(*) over ()` as the exact total      | none                                                                             |
| `getLeadSummary`       | New narrow read of one lead + up to 10 open tasks + up to 10 activity rows                                                                           | none — deliberately **not** the staff lead page's getters, which record "opened" |
| `listOpenTasks`        | New narrow list in `ai/read-service.ts`; due-day filters reuse the `dueCutoff` rule from `leads/staff-queries.ts`                                    | none                                                                             |
| `getSourcePerformance` | The existing `DatabaseReportStore.sourceReport` (`reports/store.ts`), unchanged                                                                      | none                                                                             |

No getter that marks a lead opened, seeds automations, writes a timeline entry or
queues a job is called. The only writes a turn makes are the existing
`app.rate_limit_hit` counters.

## 4. Transport

- `GET  …/ai/capabilities` — ordinary JSON; `cache-control: no-store`.
- `POST …/ai/chat` — `text/event-stream`, `event: part`, one
  `aiStreamPartSchema` object per `data:` line: `progress`, `text`, `sources`,
  `error`, `done`.
- Errors before the first frame are the normal JSON error envelope
  (`ai_unavailable` 503, `ai_rate_limited` 429, `permission_denied` 403,
  `invalid_request` 400). After the first frame, only typed `error` parts.
- The registry (`packages/contracts/src/endpoints.ts`) describes the stream with
  a new `stream` field; `openapi.ts` publishes the frame schema under
  `text/event-stream` (generated, never hand-written).
- The client (`packages/contracts/src/client.ts`) reads frames with
  `readServerSentEvents` and yields validated parts; it never calls
  `response.json()` on a stream.
- Cancellation: `res.on('close')` (response completion semantics, **not** the
  request body's `end`) aborts the controller, which aborts the SDK call and the
  fake engine; late chunks are dropped.
- Whole-turn timeout 60 s; per-tool deadline 5 s, set inside each read's own
  tenant transaction as `set local statement_timeout = 5000`, so a pathological
  query is cancelled by Postgres rather than holding a pooled connection and the
  chat stream open.
- No transaction or pooled connection is held while awaiting the model: each tool
  opens and closes its own `withTenantTx`.

## 5. Count definitions and dates

- **Received** = every lead in the cohort, drafts included. **Submitted** =
  `status = 'submitted'`. Both exclude archived (`deleted_at`) and
  customer-restricted (`customer_data_restricted_at`) leads.
- **Stage distribution** = the _current_ stage of leads received in the window,
  not stage transitions (no transition query exists, and none is faked).
- **Activated this month** is not answerable exactly: there is no activation-date
  report, so the model is instructed to say so instead of substituting stages.
- Windows: `today` (Toronto business day, DST-correct), `last_7_days`,
  `last_30_days`, `last_90_days` (rolling, same as the source report),
  `all_time`. Default `last_30_days`, always disclosed in `scope.window.label`.
- **Tasks**: a due date is a calendar day stored at noon UTC. `overdue`,
  `due_today` and `due_today_or_earlier` compare against the next UTC midnight of
  the Toronto day label — the same rule as `dueCutoff` — never by converting the
  stored timestamp into another timezone.
- The source report keeps its own semantics: `received`/`submitted`/`madeIt`,
  `SOURCE_REPORT_SUCCESS_STAGES`, and its **Other** row (an aggregate, never a
  campaign).

## 6. Fields the model may see

Leads: id, type and stage labels, reference, name, staff display name of the
assignee, created/updated dates, archive state. Tasks: id, lead id/reference/name,
title, assignee display name, due instant and due day. Activity: kind and time;
a note excerpt (≤500 characters, at most 5) **only** when the caller asked for
notes.

Never sent: email, phone, address, country, SIN, passport or visa content,
document ids or signed URLs, custom values, order details, money amounts,
payment/commission state, the access snapshot, property catalogue, headers and
environment. The financial gate (`financial.read`) exists in the policy but v1
projects no monetary field at all, so an owner sees no more than a Finance
member.

## 7. Limits (constants in `AI_ASSISTANT_LIMITS`)

5 model steps · 6 tool calls · 3 lead summaries · 50 records · 6 KiB per result ·
24 KiB per turn · 1200 output tokens · 60 s per turn · 10 requests/actor/minute ·
60 requests/site/minute · 1 active request per browser chat. Tool results are
trimmed by whole records with `truncated: true`; totals never change.

## 8. Model and provider

One model, chosen by `AI_GATEWAY_MODEL` after checking it in the live Gateway
catalogue; no fallback model, no automatic provider switching. One automatic
retry is allowed before any text is shown (`maxRetries: 1`); a partial stream is
never retried invisibly. Provider/Gateway retention is documented in the runbook
and must be reviewed by the owner before real data is used.

## 9. Decisions and deviations (for review)

1. **Own SSE protocol, not the AI SDK UI-message protocol.** The SDK supplies the
   model/tool loop (`streamText`), but the wire format is our own typed parts so
   the endpoint registry, generated OpenAPI, client validation and error
   mapping keep one source of truth, and so no client-supplied tool result or
   message part can ever reach the model. Consequence: `@ai-sdk/react`'s
   `useChat` is not used; the admin consumes the typed parts directly. If the
   team prefers the SDK protocol, the swap is confined to
   `packages/contracts/src/client.ts` and `apps/admin/src/lib/ai-transport.ts`.
2. **No new tables or migrations.** History lives in React memory only; a
   durable conversation is explicitly a later phase.
3. **Search** covers name and reference number only in v1; it deliberately does
   not search contact values, so those never appear in tool output or logs.
4. **Per-statement timeout**: each read opens its own tenant transaction and sets
   `statement_timeout = 5000` locally before the query, so the 5 s deadline is the
   database's, not a promise from the application.
5. **`findLeads` matching text is not echoed** in logs or source labels.

## 10. Admin panel (Phase D)

Implemented in the same branch:

| File                                   | Role                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/lib/ai-transport.ts`   | Builds the one accepted request (oldest whole turns dropped until the char/byte limits fit, `trimmed` reported) and maps every failure to `unavailable / session_expired / denied / rate_limited / failed / cancelled`                                                                                  |
| `components/ai/assistant-provider.tsx` | Capabilities, in-memory conversation, abort controller, generation counter, lead context; clears synchronously on site, token or sign-out change                                                                                                                                                        |
| `components/ai/assistant-trigger.tsx`  | The header button; rendered only when capabilities are `ready` and `available` (never while loading, never after a failed load)                                                                                                                                                                         |
| `components/ai/assistant-panel.tsx`    | Desktop 440 px sheet and mobile full-width sheet; header with site name, New chat and Close; suggestions filtered by the site's lead types; Enter/Shift+Enter/IME; Stop; autoscroll only near the bottom with "Jump to latest"; one polite `role="status"` region (the log itself is `aria-live="off"`) |
| `components/ai/assistant-message.tsx`  | Answer text as escaped plain text (`whitespace-pre-wrap`); no HTML, no Markdown images, no clickable model-authored URLs; Copy/Retry states                                                                                                                                                             |
| `components/ai/assistant-sources.tsx`  | "Sources checked" from `sources` parts only; a Next `<Link>` only for a href starting with `/` (and not `//` or a backslash); otherwise plain text                                                                                                                                                      |

Every stream part is checked against the turn's generation before it can touch
state, so Stop, New chat, unmount and a credential change all make late chunks
no-ops. Nothing is persisted: no `localStorage`, `sessionStorage` or IndexedDB.

## 11. Evidence

See §12 for the exact checks and results recorded when this document was written;
the runbook (`docs/RUNBOOKS/ai-assistant.md`) lists the remaining live checks.

Known limitations to state plainly:

- The Gateway engine has never run against a real provider here (no key); the
  offline tests exercise the fake engine, the tools and the transport.
- The SQL in `ai/read-service.ts` is typechecked but was **not** executed against
  a database in this environment (no local Postgres, no disposable `_test`
  database available). Integration cases for it exist in
  `apps/backend/tests/ai-reads.integration.test.ts` and run in CI, not here.
- Synthetic notes containing instructions are covered by the prompt and by the
  projection (notes only on request); there is no automated "model ignores the
  injection" test, because that requires a real model.
- The admin panel's real-browser layout at 375 px, real clipboard and
  screen-reader behaviour are reasoned and unit-tested, not visually reviewed.

## 12. Checks run (offline)

Recorded after the final run of each command, on the branch
`claude/ai-chat-implementation`:

| Check                                                                        | Result                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm run typecheck` (every package)                                         | pass                                                                 |
| `pnpm --filter @gt-sales/contracts test`                                     | 20 files, 404 tests pass                                             |
| `pnpm --filter backend exec vitest run --exclude "**/*.integration.test.ts"` | 59 files, 734 pass / 9 skipped                                       |
| AI backend suites (`tests/ai-*.test.ts`)                                     | 59 pass; `ai-reads.integration.test.ts` 8 skipped without a database |
| `pnpm --filter admin exec vitest run`                                        | 49 files, 515 tests pass                                             |
| `pnpm run lint`                                                              | clean                                                                |
| `pnpm run format`                                                            | clean                                                                |
| `pnpm run test:tooling`                                                      | 47 pass                                                              |
| `pnpm --filter backend build`                                                | pass                                                                 |
| `pnpm --filter admin build`                                                  | pass                                                                 |
| `pnpm --filter @gt-sales/contracts build`                                    | regenerates `docs/api/openapi.json` with the two AI operations       |
| `pnpm --filter admin exec playwright test --project=desktop`                 | 7 pass (includes "Ask AI never renders when unauthenticated")        |
| `pnpm --filter admin test:e2e:leads`                                         | **not run** — needs Postgres and the backend harness                 |

A separate adversarial review of this change produced 12 "should-fix" findings
and no blockers. All of them were addressed before this record: nested records
now count against the turn budget and an over-budget summary is refused rather
than silently oversized; source cards are capped and labels truncated; the
source report's **Other** row survives truncation; the rate-limiter fallback
refuses instead of allowing; a mid-turn revocation aborts the model loop and is
reported as `access_lost`; the identical-read cache reauthorizes; notes are read
in their own bounded query; an unknown lead type is distinguished from a real
zero; the open-lead id is validated and given to the model as a hint only; the
panel's Close cancels its stream; a stream without `done` is a failed answer; and
graceful shutdown aborts in-flight turns. Its four test-quality notes were also
fixed (capability deny case, revocation-mid-tool case, 48 KiB byte-ceiling case,
and transport tests for frame parsing and end-of-stream).

Not run / not available here: database integration suites (no Postgres), the
lead browser journeys against a real backend, `pnpm run test` as a whole, and any
live Gateway call.
