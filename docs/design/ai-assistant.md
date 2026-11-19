# Ask AI — design, decisions and evidence

The read-only core of Ask AI (version 1): its trust boundaries, the fields the
model may see, its limits and the decisions behind them. Ask AI is on for both
sites (docs/HANDOFF.md §3.1); confirmed actions are in
[ai-actions.md](ai-actions.md), [interactive-ai.md](interactive-ai.md) and
[ai-lead-updates.md](ai-lead-updates.md), stored conversations, attached files
and the owner's usage page in [ai-chat.md](ai-chat.md), and operation in
`docs/RUNBOOKS/ai-assistant.md`.

## 1. Discovery: versions and evidence

| Item               | Value                                                        | Evidence                                                                                                                            |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| SDK                | `ai@7.0.159` (backend dependency)                            | `apps/backend/package.json`; the installed package's `dist/index.d.ts` exports `streamText`, `tool`, `stepCountIs`, `createGateway` |
| Gateway provider   | bundled as `ai`'s own dependency (`@ai-sdk/gateway` 4.0.132) | `node_modules/.pnpm/ai@7.0.159_*/node_modules/ai/package.json`                                                                      |
| React hook package | **not installed** — existing typed React state; see §9       | —                                                                                                                                   |
| Node               | 22.19 (repo engines `>=22 <23`)                              | `package.json`                                                                                                                      |
| Zod                | v4 (catalog)                                                 | `pnpm-workspace.yaml` catalog; schemas use `z.uuid()`, `z.int()`, `z.toJSONSchema`                                                  |
| Transport          | AI SDK v7 UI-message SSE, typed transient data parts         | `packages/contracts/src/ai-assistant.ts`, `apps/backend/src/routes/ai-assistant.ts`                                                 |

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

| Input                                 | Authority                                                            | Enforced in                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Verified staff session                | The actor; a body-supplied actor id is rejected by the strict schema | `requireStaffSession` (staff router) + `aiChatRequestSchema`                                          |
| Route `workspaceId` + live membership | The site                                                             | `loadAccess` + `decideAiAccess` in `routes/ai-assistant.ts`                                           |
| Tool arguments                        | Untrusted proposals                                                  | Zod schemas in `ai/tools.ts`; every value validated                                                   |
| Lead id / context                     | A hint, re-authorized on read                                        | `getLeadSummary` reads by id inside the tenant transaction                                            |
| Browser chat history                  | Untrusted text                                                       | Re-validated; never produces a source card or an authorization                                        |
| Stored conversation, attached files   | The member's own, under an owner policy; file content is data        | `ai/conversation-store.ts`, `ai/attachments.ts`; ai-chat.md §3                                        |
| Records, names, notes                 | Untrusted data                                                       | `ai/record-text.ts` cleans every typed string; results carry a data notice; rendering is escaped text |
| Tool output                           | Authorized evidence                                                  | Explicit projections in `ai/projections.ts`, `ai/lead-record.ts`, `ai/read-tools.ts`                  |
| Model text                            | Presentation only                                                    | Rendered as text; links only come from server source cards                                            |

`decideAiAccess` uses the existing `decideAccess` (no second role table):
`workspace.read` **and** at least one of `lead.manage`, `order.manage`,
`financial.read`. Owner/Leads/Orders/Finance pass; Viewer/Content/Partners are
refused with `permission_denied`, and individual deny rules apply unchanged.

Access is rechecked **before every tool call** (`reauthorize` in
`ai/tools.ts`, throwing `AssistantAccessRevokedError`) and **once more before the
answer is released** (`routes/ai-assistant.ts`), which answers `access_lost` and
stops. Text already streamed cannot be recalled; the UI clears the conversation
on `access_lost` and says the member's access changed.

## 3. Reused reads, new queries, and side effects

Each read runs in its own read-only, time-limited tenant transaction where it
reads through `ai/read-service.ts`, and through the staff route's own store
function wherever there is one. A tool is offered to the model only when the
member's live access holds the action its staff route checks and the
deployment has that store; every call checks the access again, and a refusal
carries no data.

| Tool                                                                            | Source (the staff route it mirrors)                                                                                                                                                                                                                    | Action                                                        |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `getSiteOverview`                                                               | Narrow counts in `ai/read-service.ts` (type, window, not archived, not restricted)                                                                                                                                                                     | `workspace.read`                                              |
| `findLeads`                                                                     | `selectLeadPage` in `leads/staff-queries.ts` (`GET /leads`): search, type, stage, assignee, status, view (`new` reads the inbox's "not opened yet"), `dueBy`, property filters checked with `areValidLeadPropertyFilters` against the site's catalogue | Ask AI access (the contacts roles)                            |
| `getLeadSummary`                                                                | The lead row and tasks in `ai/read-service.ts`, and `selectLeadWithWork` (`GET /leads/:leadId`'s query) for the timeline, documents, change request and values; never `LeadWorkStore` getters                                                          | Ask AI access                                                 |
| `listOpenTasks`                                                                 | Narrow list in `ai/read-service.ts` (lead tasks on active, unrestricted leads and plain tasks), with `completedSince` and a due-day range by the `dueCutoff` rule                                                                                      | Ask AI access                                                 |
| `getSourcePerformance`                                                          | `DatabaseReportStore.sourceReport` (`GET /reports/sources`), unchanged                                                                                                                                                                                 | `workspace.read`                                              |
| `getInboxCounts`                                                                | `selectLeadSummary` (`GET /leads/summary`)                                                                                                                                                                                                             | `workspace.read`                                              |
| `listPlans`                                                                     | `PlanStore.list` (`GET /plans`)                                                                                                                                                                                                                        | `workspace.read`                                              |
| `getPropertyCatalog`                                                            | `PropertyStore.catalog` (`GET /properties`)                                                                                                                                                                                                            | `workspace.read`                                              |
| `getAnalytics`                                                                  | `AnalyticsStore.analytics` with `withoutMoney` (`GET /analytics`)                                                                                                                                                                                      | `workspace.read`                                              |
| `getWebAnalytics`                                                               | The Umami reader (`GET /web-analytics`)                                                                                                                                                                                                                | `workspace.read`                                              |
| `getDocumentQueue`                                                              | `DocumentReviewQueueStore.list` (`GET /documents/review-queue`)                                                                                                                                                                                        | contacts roles                                                |
| `listSentMail`                                                                  | `MailboxStore.list` (`GET /mail`) and the delivery counters (`EmailStore.deliverySummary`)                                                                                                                                                             | contacts roles                                                |
| `listJobs`                                                                      | `JobAdminStore.listActive` (`GET /jobs`)                                                                                                                                                                                                               | `workspace.read`                                              |
| `getMyAccess`                                                                   | The live access snapshot (`GET /access`)                                                                                                                                                                                                               | `workspace.read`                                              |
| `listMembers`                                                                   | `StaffStore.listAssignableMembers` (`GET /members`)                                                                                                                                                                                                    | `workspace.read`                                              |
| `getEmailSettings`, `getEmailTemplate`                                          | `EmailSettingsStore` (`GET /email/settings`, `GET /email/templates`)                                                                                                                                                                                   | `integration.manage`                                          |
| `linkToScreen`                                                                  | A fixed list of admin paths in `ai/sources.ts`                                                                                                                                                                                                         | `workspace.read`                                              |
| `listAutomations`, `getAutomation`, `getAutomationCatalog`, `getAutomationRuns` | `FlowStore` (`GET /automations…`)                                                                                                                                                                                                                      | Ask AI access; with authoring, `integration.manage` as before |

Lead names and references in the sent box, the review queue and automation
runs are read with `leadLabels` (active, unrestricted leads only), because
those screens' own rows name a lead by "name, else email". Each lead these
three name also gets its lead source card, so a stored answer that names it is
not replayed once the lead is restricted and is found by the erasure
([ai-chat.md](ai-chat.md) §6 and §13); `listOpenTasks` names a task's lead
without a card (its link is the tasks page), so such an answer is found only
by the lead's order number.

No getter that marks a lead opened, seeds automations, writes a timeline entry or
queues a job is called. The only writes a turn makes are the
`app.rate_limit_hit` counters, its `app.ai_turns` row of counts and, in a
stored conversation, that conversation's own rows ([ai-chat.md](ai-chat.md) §5).

## 4. Transport

- `GET  …/ai/capabilities` — ordinary JSON; `cache-control: no-store`.
- `POST …/ai/chat` — SDK `createUIMessageStream` and
  `pipeUIMessageStreamToResponse`, protocol header `v1`, typed transient
  `data-assistant` parts carrying `progress`, `text`, `sources`, `error`, `done`
  (and, in a stored conversation, `notice`: [ai-chat.md](ai-chat.md) §8),
  followed by the SDK `[DONE]` terminator. `aiWirePartSchema` describes the wire.
- The request may carry the optional `effort` (`high` only, and only where
  capabilities list it in `efforts`; §8); without it the turn is Normal.
- The request may carry the optional `conversationId` and `attachmentIds` of a
  stored conversation; only then does the stream send a `conversation` part
  and `done.messageId`, and `history` must be empty because the server replays
  its own store. Without them the request and the stream are the memory-only
  ones. The conversation and attachment routes and the owner's usage route sit
  beside the chat; all of it is in [ai-chat.md](ai-chat.md) §8.
- Errors before the first frame are the normal JSON error envelope
  (`ai_unavailable` 503, `ai_rate_limited` 429, `permission_denied` 403,
  `invalid_request` 400; for a stored conversation also
  `conversation_not_found` 404, `conversation_full` 409,
  `conversation_limit_reached` 409, `conflict` 409 and
  `attachments_unavailable` 503). After the first frame, only typed `error` parts.
- The registry (`packages/contracts/src/endpoints.ts`) describes the stream with
  a new `stream` field; `openapi.ts` publishes the frame schema under
  `text/event-stream` (generated, never hand-written).
- The client (`packages/contracts/src/client.ts`) reads frames with
  `readServerSentEvents` and yields validated parts; it never calls
  `response.json()` on a stream.
- Cancellation: `res.on('close')` (response completion semantics, **not** the
  request body's `end`) aborts the controller, which aborts the SDK call and the
  fake engine; late chunks are dropped.
- Whole-turn timeout 60 s (180 s at High effort, §8); per-tool deadline 5 s, set inside each read's own
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

What reaches the AI provider from the CRM, by tool. "Contacts roles" are the
roles that see a lead's details (`lead.manage`, `order.manage` or
`financial.read`, `staff/lead-visibility.ts`); every Ask AI user is one.

| Data                                                                                                                                                                                                                                                                                                                                                              | Sent                             | Condition                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lead: id, type and stage labels, status, reference, name, assignee's display name, created/updated dates, archive state                                                                                                                                                                                                                                           | Yes                              | —                                                                                                                                                                                      |
| Order: plan name, quantity, courier, dispatch and activation dates                                                                                                                                                                                                                                                                                                | Yes                              | the catalogue's property is neither hidden nor sensitive                                                                                                                               |
| Order: price (integer CAD cents), currency, payment status, commission state                                                                                                                                                                                                                                                                                      | Yes                              | contacts roles, as on the lead page (`moneyVisibilityOf`); the catalogue's property not hidden or sensitive                                                                            |
| Commission amounts (a frozen plan's or a plan's), commission earned and expected                                                                                                                                                                                                                                                                                  | Yes                              | `revenue.view` only                                                                                                                                                                    |
| Timeline: kind, time, who (display name, "Automation", "Customer"), stage from → to, assignment from → to by display name, edited field labels, the template sent and its delivery status, a review's document type and decision, a change request's number, field labels and document types, a documents override's missing types, the flow's name, "via Ask AI" | Yes, the 10 newest (notes aside) | —                                                                                                                                                                                      |
| Note excerpts (≤ 500 characters, at most 5)                                                                                                                                                                                                                                                                                                                       | Yes                              | only with the `notes` section                                                                                                                                                          |
| Documents: type, review status, upload and review dates                                                                                                                                                                                                                                                                                                           | Yes, at most 16                  | —                                                                                                                                                                                      |
| A change request: whether one waits, since when, its number                                                                                                                                                                                                                                                                                                       | Yes                              | —                                                                                                                                                                                      |
| Form and custom values                                                                                                                                                                                                                                                                                                                                            | Yes, at most 30                  | only with the `details` section, and only when the property is not hidden, not sensitive, not of kind email or phone and not an address or SIN number field (`isModelVisibleProperty`) |
| Tasks: id, lead id/reference/name (null for a plain task), title, status, assignee, due instant and day                                                                                                                                                                                                                                                           | Yes                              | —                                                                                                                                                                                      |
| Inbox counters, lead counts, stage distribution, source report rows                                                                                                                                                                                                                                                                                               | Yes                              | —                                                                                                                                                                                      |
| Plans: name, type, price, billing period, payment required, required document types, active                                                                                                                                                                                                                                                                       | Yes                              | —                                                                                                                                                                                      |
| Property catalogue: key, label, kind, storage, hidden/sensitive flags, filterable, visible choices                                                                                                                                                                                                                                                                | Yes (definitions, no values)     | —                                                                                                                                                                                      |
| Analytics: KPIs, stages, top sources, partners and plans, delivery, payment and commission states, each member's counts by display name                                                                                                                                                                                                                           | Yes                              | money figures only with `revenue.view`                                                                                                                                                 |
| Website traffic: totals, top pages, referrers, countries, devices                                                                                                                                                                                                                                                                                                 | Yes                              | —                                                                                                                                                                                      |
| Review queue: counts, document type, required, upload date, lead reference/name/type/stage                                                                                                                                                                                                                                                                        | Yes, 10 per page                 | contacts roles                                                                                                                                                                         |
| Sent mail: direction, time, template name, a hand-written mail's subject line, delivery status, flow name, lead reference/name; the delivery counters                                                                                                                                                                                                             | Yes, 10 per page                 | contacts roles                                                                                                                                                                         |
| Background jobs: kind, status, attempts, last error code, times                                                                                                                                                                                                                                                                                                   | Yes, at most 20                  | —                                                                                                                                                                                      |
| The member's own roles, individual permissions, and what they may and may not do, in words                                                                                                                                                                                                                                                                        | Yes                              | —                                                                                                                                                                                      |
| Members: display name, roles, whether it is the member                                                                                                                                                                                                                                                                                                            | Yes, 20 per page                 | —                                                                                                                                                                                      |
| Email settings: from name and address, reply-to, style, footer; templates' names, subjects, versions, the flows that send them; one template's subject and body text                                                                                                                                                                                              | Yes                              | `integration.manage`                                                                                                                                                                   |
| Automations: flows, versions, definitions, catalogue, run statuses; a run's lead reference and name                                                                                                                                                                                                                                                               | Yes                              | the lead only for contacts roles, never a restricted lead                                                                                                                              |

Never sent: a contact's email, phone and address (they stay searchable and
appear only on cards in the browser); values of hidden or sensitive
properties and of email, phone and address properties; documents, file ids,
download links; a mail's or a reply's words (and a reply's subject); sealed
identities; tracking numbers, activation numbers and accounts; a documents
override's reason; a change request's values; job payloads; the email
settings' logo and site links; anything about a restricted (erasure-requested)
lead; actor and membership ids; confirmation tokens; the property catalogue's
values outside the details rule; headers and environment.

Every string a customer or a colleague typed (names, references, form and
custom values, UTM and referrer labels, note excerpts, task titles, plan and
property labels, display names, flow, template and partner names, template
text, source card labels) is cleaned in `ai/record-text.ts`: control, format
and bidirectional characters removed, whitespace collapsed (long text keeps
its line breaks), each bounded; every serialized result is cleaned once more
(`neutralizeSerialized`) and carries `notice`, which says its text is data,
never instructions. Property filter and search values are never echoed back
in a result's scope.

A file the member attaches to a message of a stored conversation is sent with
that turn, whatever it contains: an image's or PDF's bytes, a text file's
decoded text in a labelled block, and the files of earlier messages within the
per-turn limits and the member's daily file budget ([ai-chat.md](ai-chat.md)
§7 and §9). The member chooses to
send it; nothing of the CRM's own is attached for them.

## 7. Limits (constants in `AI_ASSISTANT_LIMITS`)

| Limit              | Normal          | High     | Constant (Normal / High)                                  |
| ------------------ | --------------- | -------- | --------------------------------------------------------- |
| Model steps        | 5               | 8        | `maxModelSteps` / `maxModelStepsHigh`                     |
| Tool calls         | 6               | 10       | `maxToolCalls` / `maxToolCallsHigh`                       |
| Lead summaries     | 3               | 5        | `maxLeadSummaries` / `maxLeadSummariesHigh`               |
| Output tokens      | 1,200           | 4,000    | `maxOutputTokens` / `maxOutputTokensHigh`                 |
| Reasoning room     | —               | 8,000    | `maxReasoningTokensHigh`, only with reasoning             |
| Whole turn         | 60 s            | 180 s    | `requestTimeoutMs` / `requestTimeoutMsHigh`               |
| Records per turn   | 50              | 50       | `maxRecordsPerTurn`                                       |
| One tool result    | 6 KiB           | 6 KiB    | `maxToolResultBytes`                                      |
| All tool results   | 24 KiB          | 24 KiB   | `maxToolDataBytes`                                        |
| Requests per actor | 10/min          | +20/h    | `perActorPerMinute` / `highPerActorPerHour`               |
| Requests per site  | 60/min, 500/day | +100/day | `perSitePerMinute`, `perSitePerDay` / `highPerSitePerDay` |

Automation authoring keeps its 4,800 output tokens at either level (High takes
the larger of the two). The High rate limits apply on top of the Normal ones.
One active request per browser chat. Tool results are trimmed by whole records
with `truncated: true`; totals never change.

## 8. Model and provider

One model per effort level, each an exact Gateway id checked in the live
Gateway catalogue: `AI_GATEWAY_MODEL` for Normal and `AI_GATEWAY_MODEL_HIGH` for
High (unset, High uses `AI_GATEWAY_MODEL`); no fallback model, no automatic
provider switching, and `AI_GATEWAY_PROVIDERS` pins the hosts of both. One
automatic retry is allowed before any text is shown (`maxRetries: 1`); a
partial stream is never retried invisibly. Provider/Gateway retention is
documented in the runbook and must be reviewed by the owner before real data
is used.

**Two effort levels.** A member chooses Normal or High per message in the
composer; High is offered only with `AI_HIGH_EFFORT_ENABLED=true`
(capabilities `efforts: ['normal', 'high']`). A request for High where it is
not offered is `400 invalid_request` (`details.reason: 'effort_unavailable'`)
before any work, never quietly answered at Normal. A Normal turn is exactly the
assistant as it was: the same request (the admin never sends `effort:
'normal'`), limits, model, engine input and stream.

What High changes, and nothing else:

- **The model**: `AI_GATEWAY_MODEL_HIGH` when set. `ai_turns.model` and the
  `ai_turn` line record the model that served the turn, beside its `effort`.
- **Reasoning**, when `AI_HIGH_EFFORT_REASONING` names a word (`minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`): sent as the installed SDK's
  portable `reasoning` call option (`ai@7.0.159`, `LanguageModelCallOptions`:
  `reasoning?: 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' |
'high' | 'xhigh' | 'max'`), which the Gateway provider forwards in its
  request body and each provider maps to its own setting (OpenAI's reasoning
  effort, Anthropic's thinking, Google's thinking level), rounding down to a
  level the model has. A model that cannot reason returns an `unsupported`
  warning and ignores it; a provider that refuses the call outright fails the
  turn with the typed `provider_unavailable`. Unset, no reasoning option is
  sent. With reasoning the output limit gains `maxReasoningTokensHigh`, because
  OpenAI-style models count reasoning inside the output limit and
  budget-based providers size the thinking budget from it; a turn whose
  reasoning still fills it ends `budget_exceeded`. Reasoning tokens arrive in
  `totalUsage.outputTokens` (with `outputTokenDetails.reasoningTokens` beside
  it), so they are counted as output tokens.
- **Reasoning is never forwarded**, stored or logged: the engine drops every
  reasoning part and yields only that a step began reasoning, once per step;
  on a High turn the route turns that into the `progress` part "Thinking", so
  a long quiet stretch reads as work. A Normal turn's stream never carries it,
  whatever its model does.
- **The budgets of §7**, the 180 s timer and the High rate limits
  (`ai_high_actor:` and `ai_high_site_day:` keys; a refusal is `429
ai_rate_limited` with `retry-after` and `details: { reason: 'high_effort',
retryAfterSeconds }`).

Never changed by High: the access checks before every tool and before the
answer, the tool set and its policy, the projections and every data limit,
cards and their confirmation, history replay, attachments, the saved
conversation and cancellation. Nothing above the route ends a High turn before
180 s: the Node server keeps its defaults (no response timeout), the browser
calls the backend directly with a 210 s whole-turn limit for High (90 s for
Normal), and Railway's edge allows 15 minutes while data flows.

## 9. Decisions and deviations (for review)

1. **SDK wire protocol; existing React state retained.** The review replaced
   the custom SSE framing with AI SDK v7's supported UI-message stream and
   typed `data-assistant` parts. The shared client validates those parts; it
   temporarily accepts old frames for staggered backend/frontend deployment.
   `@ai-sdk/react` / `useChat` is still not installed: the small existing provider
   keeps cancellation, capability errors and actor/Site lifecycle in one place.
   This is a documented departure from the requested hook package,
   not a claim that it was installed. No SDK UI arrays or client tool results
   are forwarded to the model.
2. **History.** Without a stored conversation, history lives in React memory
   only and the browser sends it back signed (CHAT-2). With one, the server
   keeps it in `app.ai_conversations` and `app.ai_messages` (migrations
   0034–0036) and replays its own store ([ai-chat.md](ai-chat.md)).
3. **Search** matches name, reference, email and phone within the selected
   Site; results and source labels never echo contact search values.
4. **Per-statement timeout**: each read opens its own tenant transaction and sets
   `statement_timeout = 5000` locally before the query, so the 5 s deadline is the
   database's, not a promise from the application.
5. **`findLeads` matching text is not echoed** in logs or source labels.

## 10. Admin panel

The admin side:

| File                                   | Role                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/lib/ai-transport.ts`   | Builds the one accepted request (oldest whole turns dropped until the char/byte limits fit, `trimmed` reported) and maps every failure to `unavailable / session_expired / denied / rate_limited / failed / cancelled`                                                                                  |
| `components/ai/assistant-provider.tsx` | Capabilities, in-memory conversation, abort controller, generation counter, lead context; clears on Site/member/sign-out or denied access; same-member token refresh retains completed history                                                                                                          |
| `components/ai/assistant-trigger.tsx`  | The header button; rendered only when capabilities are `ready` and `available` (never while loading, never after a failed load)                                                                                                                                                                         |
| `components/ai/assistant-panel.tsx`    | Desktop 440 px sheet and mobile full-width sheet; header with site name, New chat and Close; suggestions filtered by the site's lead types; Enter/Shift+Enter/IME; Stop; autoscroll only near the bottom with "Jump to latest"; one polite `role="status"` region (the log itself is `aria-live="off"`) |
| `components/ai/assistant-message.tsx`  | Restricted Markdown through `assistant-markdown.tsx`: headings, emphasis, lists, and mobile-scrollable tables; raw HTML and images disabled, model links rendered as text; Copy/Retry states                                                                                                            |
| `components/ai/assistant-sources.tsx`  | "Sources checked" from `sources` parts only; a Next `<Link>` only for a href starting with `/` (and not `//` or a backslash); otherwise plain text                                                                                                                                                      |

Every stream part is checked against the turn's generation before it can touch
state, so Stop, New chat, unmount and a credential change all make late chunks
no-ops. Nothing is written to `localStorage`, `sessionStorage` or IndexedDB.
Against a backend that stores conversations, the panel shows the member's
current stored conversation and links to the full page; the page, its
components and the stored state are in [ai-chat.md](ai-chat.md) §10.

## 11. Evidence and known limits

The runbook (`docs/RUNBOOKS/ai-assistant.md` §10) lists what has not been
verified live. Known limitations to state plainly:

- Synthetic notes, names and values containing instructions are covered by
  the prompt, the record text cleaning and the projection (notes and values
  only on request); the tests check that such text arrives cleaned and
  labelled, but there is no automated "model ignores the injection" test,
  because that requires a real model.
- Real Chromium journeys cover 375 px and desktop, both themes, focus,
  cancellation, sources and nested lead sheets. Physical on-screen keyboards,
  assistive technology and deployed clipboard behavior still need device checks.

The real SDK loop is tested with `MockLanguageModelV4`; browser journeys use a
synthetic engine over real HTTP, database authorization and reads. Neither is
reported as live-provider quality. The opt-in synthetic Gateway smoke is
`apps/backend/scripts/ai-live-smoke.ts`. Evaluation prompts and expectations
are in `apps/backend/tests/fixtures/ai-evaluation.json`.
