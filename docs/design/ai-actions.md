# Ask AI: confirmed tasks and notes (version 2 foundation)

Version 3 extends these foundations with editable cards, guided questions and
reviewed customer email. See [interactive-ai.md](interactive-ai.md) for the
current scope and address-binding/revision behavior.

Version 2 adds two operations to the existing site-scoped assistant: prepare a
follow-up task and prepare a note. A model tool call only prepares a card. It has
no write-store reference and cannot confirm a card, including when chat text or
a record says "confirm". All other writes remain outside the assistant.

Each card names the Site and lead, shows the exact note text or task title,
calendar due date and assignee (any active member or unassigned, "Wider
cards" below), and offers
Confirm and Cancel. Note text is limited to 4,000 characters and task titles to
200, matching the existing forms. Ambiguous targets or dates must be clarified.
The server resolves the lead through the existing active/unrestricted Site read;
no model-supplied actor, Site, destination URL or staff identity is accepted.

## Confirmation boundary

The backend signs an immutable action id, actor, Site, expiry and validated draft.
The HMAC key is derived with the domain `gt-sales/ai-action/v1` from the existing
server-only Gateway key. Rotation invalidates outstanding cards. Cards expire
ten minutes after preparation. Tokens stay in browser memory and are never
included in model tool results, chat history, URLs or logs.

`POST /api/v1/staff/workspaces/:workspaceId/ai/actions/confirm` accepts only the
token. It verifies its signature, expiry, actor and Site, rechecks live
`workspace.read` and `lead.manage`, and checks the assistant switch and Site
allowlist. Only then does it call the normal `addNote` or `createTask` store.
Read-only Orders/Finance callers retain read tools but receive no action tools
or writable capability. The confirmation endpoint independently refuses them.

The store locks the lead and rechecks archive/restriction status. The signed
action id becomes the new note/task primary key. A retry, including concurrent
requests on different backend replicas, finds that same record under the lead
lock instead of inserting another, updating the lead twice or producing another
audit/timer. Normal forms keep their existing generated ids. No migration,
pending-action table or new deployment secret is needed.

Notes use the existing timeline and `lead.note_added` audit. Tasks use the
existing task store, due timers and `lead.task_created` audit. Both add the
opaque `aiActionId` to audit metadata; note text and task titles are not copied
into the audit. Due dates remain calendar days stored at noon UTC. A confirmed
task participates in existing task automations just like a manually made task.

## Plain tasks and task moves

A task card may name no lead: a **plain task** (`AGENTS.md`, vocabulary). The
`task` draft's `leadId` is then absent, and the card's `leadLabel` and
`leadHref` are too; the card reads "No lead" and links nowhere. The
`prepareTask` tool takes `leadId` as a required, nullable field, so the model
says "no lead" with `null` rather than leaving the id out by accident; a given
id is still checked through the same active, unrestricted Site read. Until
migration 0038 is applied the tool answers `not_available` for `null`, its
description and the system prompt say every task needs a lead, and
capabilities list `taskActions: ['task_update']` only. Confirmation rechecks
`workspace.read` and `lead.manage` and calls `createPlainTask`, the store
function the staff `POST /workspaces/:id/tasks` route calls, with the signed
root id as the task's id (an advisory lock on that id stands in for the lead
lock, so concurrent retries find one task); before 0038 it answers `503
plain_tasks_unavailable`. A revision keeps the card plain: an edited draft that
names a lead is refused as `invalid_request`.

A **`task_update` card** (`{ kind: 'task_update', taskId, status }`) moves one
task, a lead's or a plain one, to `open`, `in_progress`, `done` or
`cancelled`. `prepareTaskUpdate` reads the task as the card is prepared (a
plain task, or one on an active, unrestricted lead) and refuses a move to the
status it already has. The card shows the task's title, its current and new
status, and its lead when it has one (`taskUpdateContext`: `version`, `title`,
`before`, `leadId`). The task's version, its update time in microseconds, and
its status then are signed into the card (`taskUpdateVersion`,
`taskUpdateBefore`), never taken from the browser. Confirmation rechecks
access, locks the task, returns the receipt (an `ai.task_updated` audit event
keyed by the draft's root id) when the move was already saved, refuses a task
on an archived lead (`409 lead_trashed`), a gone one (`404 task_not_found`)
and a stale card (`409 conflict`, as a stale lead update is): one whose task's
update time is no longer the signed version, or whose status is no longer the
signed one, which also catches the nightly Get Canada Sim sync
(`manual/gcs-nightly-sync.sql`), which changes an imported task's status,
title and completion time without touching its update time. Then it makes the
same change the
staff `PATCH` makes (`applyTaskUpdate`: the completion time set or cleared,
the `lead.task_updated` audit with `aiActionId`, a lead task's overdue clock)
and writes the receipt in the same transaction. Editing the card changes only
the new status. A refused revision answers for the task, never with
`lead_not_found`: `404 task_not_found` when the task is gone, and otherwise
`409 conflict` with the tool's `details.reason` (`already_in_stage`,
`task_unavailable` when its lead is archived or restricted,
`temporary_failure`); a plain-task card's revision before 0038 answers `503
plain_tasks_unavailable`. A lead's card (a note, an email, a lead update, a
lead's task) keeps `404 lead_not_found`.

`listOpenTasks` finds tasks to move: it lists plain tasks beside lead tasks,
with each task's status, filters by status (`active`, the default, or one
status) and by `titleContains` (1–100 characters, case-insensitive, `%`, `_`
and `\` taken literally, escaped as the lead search escapes them), and orders
so the task a person means is within its five pages of 20: done tasks most
recently completed first, cancelled ones most recently changed first, active
ones undated first (most recently changed first; no due window reaches them,
and after every dated task they would sit past the last page), then soonest
due, the task id breaking every tie. On a site with 156,000 done tasks the done
list takes about 0.6 s (the per-statement limit is 5 s), as it did in due-date
order.

Both are additive on the wire: `actions` in capabilities keeps its four kinds
and `taskActions` lists `plain_task` (once 0038 is applied) and
`task_update` beside it, because an older admin's `actions` enum would refuse
the whole document. An older admin given a stream `actions` part that holds a
plain-task or `task_update` card fails to parse that one part and skips it,
with every card it carried; the rest of the stream reads as before.

## Wider cards

Every card kind needs the staff actions its staff route checks, read from
one table (`AI_CARD_ACTIONS` in `apps/backend/src/ai/card-safeguards.ts`):
`workspace.read` and `lead.manage` for every lead and task card,
`workspace.read` and `integration.manage` for an automation's switch, which
is offered only on a site in `AI_AUTOMATION_WORKSPACE_IDS`. The same table
decides the capabilities' `cardActions`, which tools the model is offered (a
member without the actions is not offered the tool), and whether revise and
confirm accept the card, each decided again at the moment of the call with
`decideAccess`, so an individual deny applies.

The kinds beyond note, task, email, lead update and task move:

- **`lead_edit`**: one lead's stage, order details (plan, quantity, payment
  status, carrier commission, courier, tracking number, dispatch and
  activation dates and the activation number and account), form fields and
  custom values in one signed diff, at most 12 fields. Its `changes` are a
  subset of the staff `PATCH` body; confirmation parses them again with that
  route's own schema (`updateWorkspaceLeadRequestSchema`) and saves through
  `applyLeadUpdate` with the site's property catalogue, so custom keys and
  hidden properties are refused exactly as on the lead page. A move whose
  gate needs a courier or an activation date carries those fields on the card
  (`leadEditContext.inputs`): the model may pass a courier, tracking number
  and dates the person gave; the activation number and account are typed by
  the person on the card and never accepted from the model. The documents
  check stays: a move whose required documents are not approved makes no
  card, and the tool answers which documents and leaves a link to the lead
  page. A card can never carry a documents override or a contact change.
  A sensitive property is neither listed nor accepted (the lead page masks
  its value), so its edit stays on the lead page. `getLeadEditOptions` lists
  the moves, the active plans of the lead's type and the editable fields by
  key and label, never a value; its labels and names are cleaned like every
  read's text (`ai/record-text.ts`) and it carries the same data notice, as
  does `getAssigneeOptions`. Current values are shown on the card only, and
  only those the lead page shows the member (every Ask AI user is a contacts
  role, `staff/lead-visibility.ts`); commission amounts are never on a card.
- **`task`** takes any active member as assignee (`getAssigneeOptions` lists
  them); **`task_update`** changes any of status, title, due date and
  assignee, with the same signed version and status check as a move.
- **`template_email`**: one of the templates the staff route sends by hand
  (`queueCustomerEmailRequestSchema`; today `sim_number_ready`), rendered on
  the server and shown in full. The card signs the template's version, the
  digest of the rendered mail, the recipient and the sender; Send is refused
  as changed when any differs. A lead that lacks a fill-in gets no card, and
  the tool names what is missing. It queues under `ai_template_email:<root
id>`, so a retry finds the first job.
- **`lead_archive`**: archive or restore one lead through `setArchived`, whose
  audit keeps the card's root id so a retry answers with the first receipt. A
  lead someone else already archived (or restored) is refused as changed.
- **`automation_off`**: switches one flow off through `setEnabled(false)`
  with the revision the card was prepared against. There is no card that
  switches a flow on or activates one.

Each card that moves a stage, archives, sends mail or switches a flow off
shows what else happens (`sideEffects`), computed on the server: the flows
that fire for the stage entered and what their steps do ("sends the
Cancelled email to the customer"), a checkout the move submits, the runs and
timers an archive cancels. Its digest is signed and recomputed at Confirm; a
difference is `409 conflict` with `details.reason: 'changed'`, as is any
change to what the card touches (`leadEditVersion`: stage, status, order
and the named fields).

An email or note whose text names another lead read in the same turn (its
name or reference, as whole words) carries `mentions` and
`acknowledgementRequired`; Confirm without `acknowledged: true` is `409
conflict` with `details.reason: 'acknowledgement_required'`. The turn's leads
are every lead any read named: those in a tool result (`leadId` beside
`name`/`reference` or `leadName`/`leadReference`), every lead a read gave a
source card (an automation run's lead has no id in its result, only its
card), and the open lead; each is compared under what the result said and
under its real name and reference, looked up at prepare time with
`leadLabels` (a lookup that fails refuses the card). Both sides are
normalised as the reads clean text: control, format and bidi characters
count as spaces and, a second time, as nothing, so a hidden character
inside a name or reference never hides it. The other leads' ids are signed,
so a revision checks its new text against the same leads.

Every card about a lead gives the answer that lead's source card, so a
stored answer that prepared one is not replayed once the lead is restricted
and is found by the 0039 erasure ([ai-chat.md](ai-chat.md) §6 and §13).

A card's lead label is "‹reference› · ‹name› (‹type›, created ‹day›)"; the
reference is set by the site's own server, never typed by the customer.

Each member has two daily caps per site, counted at Confirm through
`app.rate_limit_hit` in UTC days: `AI_CARD_LIMITS.changesPerMemberPerDay`
(200) confirmed changes of any kind, and `mailPerMemberPerDay` (50) emails
(written or template). Past either, Confirm answers `429 ai_rate_limited`
with `details.reason` `daily_changes` or `daily_mail`; a limiter that cannot
be reached refuses with `503 ai_unavailable`. A retry of a saved card counts
again.

On the wire every addition is optional. The stream sends every card in full
in the `action_cards` part, then the cards an older admin can show in their
older shape in `actions`; a card with a new kind, a widened draft or a
required tick is only in `action_cards`, which an older admin ignores. A
revision answers in the older shape unless the request has `wide: true`,
which a newer admin sends only when the capabilities list `cardActions`.
AI-made changes read "via Ask AI" on the lead's timeline.

## Browser behavior

Cards are released only after a successful model turn and final permission
check. The UI renders card contents as escaped text, never executable model
markup. A click marks the card Saving immediately, preventing double submission.
Only a successful backend receipt marks it saved. Closing and reopening the
panel retains receipts; Site/member changes and New chat discard cards. A
confirmed write may finish after the panel closes, as an ordinary form save can.

An uncertain network result offers Retry save with the same token, never a new
model-generated action. Dismissing an uncertain result tells staff to check the
lead; it does not claim nothing was saved. Expired cards require checking the
lead before requesting a new draft. Permission loss clears private chat. Saved
actions refresh the open lead and My tasks through a Site-scoped refresh event.

## Verification and rollout

Tests cover altered/expired/cross-actor/cross-Site tokens, permission changes,
disabled configuration, no writes during preparation, concurrent idempotent
saves, archive/restriction checks, calendar dates, confirmation/cancellation and
lost HTTP responses. Authenticated phone/desktop journeys use a deterministic
model over real backend/database paths. No production customer record is used
for automated writes. Deploy backend and admin together; old clients ignore the
new stream part while builds roll. Staff should refresh before using the cards.

The existing `AI_ASSISTANT_ENABLED` switch disables reads, preparation and
confirmation. No API key goes to the browser. There is no direct write tool,
bulk operation or autonomous action; every change is one of the reviewed
cards above or of [ai-lead-updates.md](ai-lead-updates.md).
