# Ask AI: cards and confirmation

Ask AI never writes. A model tool call only **prepares a card**: a signed
proposal of one change, shown to the member with Confirm and Cancel. The
model has no write-store reference and cannot confirm a card, including when
chat text or a record says "confirm". Every change Ask AI can make is one of
the card kinds below; there is no direct write tool, bulk operation or
autonomous action.

| Card                                | What Confirm does                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `note`                              | Adds a note to one lead (up to 4,000 characters).                                                                     |
| `task`                              | Creates a follow-up task for one lead, or a plain task, for any active member or nobody (title up to 200 characters). |
| `task_update`                       | Changes one task's status, title, due date or assignee.                                                               |
| `email`                             | Queues a plain-text email the member reviewed to the lead's own customer, from the site's sender.                     |
| `template_email`                    | Queues one of the templates staff send by hand (today `sim_number_ready`).                                            |
| lead update                         | Changes one field of a lead: stage, assignee, customer name or phone.                                                 |
| `lead_edit`                         | Changes a lead's stage, order details, form fields and custom values in one signed diff.                              |
| `lead_archive`                      | Archives or restores one lead.                                                                                        |
| `automation_off`                    | Switches one flow off. Nothing switches a flow on or activates one.                                                   |
| automation proposal (its own route) | Saves a flow **draft** explicitly at the flow's expected revision; publishing and switching on stay in the builder.   |

What stays with a person on the CRM's own screens: the customer's email
address, the documents override, sensitive properties, bulk edits, deleting
anything, and switching a flow on.

Each card names the Site and lead and shows exactly what will be saved.
Ambiguous targets, members or dates must be clarified, never guessed
(`askFollowUp` puts one question with two to five choices; a picked choice
grants no authority and is never the Confirm button). The server resolves the
lead through the active, unrestricted Site read; no model-supplied actor,
Site, destination URL, recipient or staff identity is accepted.

## Editing a card, written email, one-field updates

- **Edit.** A pending card has an Edit form. Update draft calls the revise
  route, which validates the old signed token, keeps the lead and the card
  kind, rechecks live permissions and returns a fresh signed card. A revision
  saves no business data. Editing is possible only before a save attempt:
  while saving, or after an uncertain response, the card cannot change and
  Retry save uses its unchanged token.
- **Written email.** `prepareEmail` drafts plain text for one lead's
  customer. The To and From addresses are resolved by the backend, signed
  with the draft, shown on the card only and never given to the model. Send
  rechecks both against the signed preview (a changed address needs a new
  draft) and goes through the site's sender, the outbox, suppression and
  delivery checks, under the key `ai_email:<signed action id>`. No inbox
  reading, arbitrary recipients, attachments or bulk mail. The receipt says
  queued, not delivered.
- **One-field lead update.** `prepareLeadUpdate` signs the field, the
  proposed value and a backend-read version; `getLeadUpdateOptions` supplies
  the stages or the first 24 active members. Confirm locks the lead, checks
  the exact preview version and calls `applyLeadUpdate`, the staff edit's own
  path, so allowed moves, gates, the documents check and flows all apply. A
  stage choice that still needs dispatch details, an activation date or
  approved documents is marked and makes no one-field card (`needs_lead_page`;
  a move that needs details can be a `lead_edit` card, which carries them).
  If a gate refuses at Confirm, the answer is the staff edit's own error
  (`http/lead-update-errors.ts`), never `conflict`.

## Confirmation boundary

The backend signs an immutable action id, actor, Site, expiry and validated draft.
The HMAC key is derived with the domain `gt-sales/ai-action/v1` from
`AI_ACTION_SIGNING_SECRET` (the Gateway key while that is unset). Rotation
invalidates outstanding cards. Cards expire
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
audit/timer. Normal forms keep their existing generated ids. There is no
pending-action table.

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
id is still checked through the same active, unrestricted Site read. Confirmation rechecks
`workspace.read` and `lead.manage` and calls `createPlainTask`, the store
function the staff `POST /workspaces/:id/tasks` route calls, with the signed
root id as the task's id (an advisory lock on that id stands in for the lead
lock, so concurrent retries find one task). A revision keeps the card plain: an edited draft that
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
signed one (which also catches a change made straight in the database
without touching the update time). Then it makes the same change the
staff `PATCH` makes (`applyTaskUpdate`: the completion time set or cleared,
the `lead.task_updated` audit with `aiActionId`, a lead task's overdue clock)
and writes the receipt in the same transaction. Editing the card changes only
the new status. A refused revision answers for the task, never with
`lead_not_found`: `404 task_not_found` when the task is gone, and otherwise
`409 conflict` with the tool's `details.reason` (`already_in_stage`,
`task_unavailable` when its lead is archived or restricted,
`temporary_failure`). A lead's card (a note, an email, a lead update, a
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
and `taskActions` lists `plain_task` and `task_update` beside it, because an older admin's `actions` enum would refuse
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
  the person on the card and never accepted from the model. The card shows
  exactly what Confirm saves (`leadEditContext.rows`, computed on the server):
  a row for each detail that changes and for each the move requires (a
  courier still to be typed reads "To enter with Edit"), never one for a
  detail that neither changes nor is required; the dispatch or activation
  date a move defaults to (today in Toronto) is written into the signed draft
  and shown as that day ("20 Nov 2026 (today)"), so Confirm saves the day the
  card showed even after midnight. The person's Edit opens only on a card
  that has details to type (a move's courier, dates and activation number and
  account); a plan or quantity card has none and offers no Edit. The documents
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
  assignee, with the same signed version and status check as a move. Saved,
  it reads "Task moved." when only its status changed and "Task updated."
  otherwise.
- **`template_email`**: one of the templates the staff route sends by hand
  (`queueCustomerEmailRequestSchema`; today `sim_number_ready`), rendered on
  the server and shown in full. The card signs the template's version, the
  digest of the rendered mail, the recipient and the sender; Send is refused
  as changed when any differs, with its own `details.reason` and sentence:
  `recipient_changed` (the customer's address), `sender_changed` (the site's
  sender), `template_changed` (the template saved again or no longer usable)
  or `text_changed` (what it fills in from the lead). A written email's Send
  names `recipient_changed` or `sender_changed` the same way. A lead that lacks a fill-in gets no card, and
  the tool names what is missing. It queues under `ai_template_email:<root
id>`, so a retry finds the first job.
- **`lead_archive`**: archive or restore one lead through `setArchived`, whose
  audit keeps the card's root id so a retry answers with the first receipt. A
  lead someone else already archived (or restored) is refused as changed. On
  an archived lead's own page the model is told the open lead is archived,
  so "restore this lead" prepares the restore card there.
- **`automation_off`**: switches one flow off through `setEnabled(false)`
  with the revision the card was prepared against. There is no card that
  switches a flow on or activates one.

Each card that moves a stage, changes a plan, archives, sends mail or
switches a flow off shows what else happens (`sideEffects`), computed on the
server: the flows that fire for the stage entered and what their steps do
("sends the Cancelled email to the customer"), a checkout the move submits, a
plan's re-freeze, the runs and timers an archive cancels. A flow's steps that
always run read as definite; the steps inside an if/else read as ones it
"may, depending on its conditions" do, since the card cannot know a
condition's answer before the move (`flowRunSentence` in
`ai/card-store.ts`). Its digest is signed and recomputed at Confirm; a
difference is `409 conflict` with `details.reason: 'changed'`, as is any
change to what the card touches (`leadEditVersion`: stage, status, order
and the named fields). A lead edit's effects, a stage move's and a plan
change's together, are computed for the preview and again at Confirm by one
function (`leadEditEffects`), so a card that moves the stage and changes the
plan confirms like either alone; a plan no longer active by then is a
change.

An email or note whose text names another lead the model can see carries
`mentions` and `acknowledgementRequired`; Confirm without `acknowledged:
true` is `409 conflict` with `details.reason: 'acknowledgement_required'`.
The leads it can see are every lead any read of the turn named: those in a
tool result (`leadId` beside `name`/`reference` or
`leadName`/`leadReference`), every lead a read gave a source card (an
automation run's lead has no id in its result, only its card), and the open
lead; and, in a stored conversation, the leads the source cards of the
replayed earlier answers link (the newest first, at most half the turn's
200-lead cap, `MAX_SEEN_LEADS`). Each is compared under what the result said
and under its real name and reference, looked up with `mentionLabels`
(an archived lead included, a restricted one never; a lookup that fails
refuses the card).

Both sides are compared word by word: Unicode compatibility forms folded
(NFKC, so full-width letters and a non-breaking space read as their plain
forms), accents and common Cyrillic and Greek look-alike letters folded,
then split on everything that is not a letter or a digit, so every dash,
space and punctuation mark separates words alike. Control and format
characters count as spaces and, a second time, as nothing, so a hidden
character inside a name or reference never hides it; line breaks and other
spacing controls are separators both times, so a subject's last word and a
body's first are never glued together. A reference matches with only its
letters and digits ("MS 9001", "MS9001" and "MS–9001" all name MS-9001); a
name matches as all of its words in order ("Robin-Example"), or as its given
name and surname, three characters or more each, within two words of each
other in either order ("Example, Robin"). One word of a longer name alone, or
a name or reference under three characters, never matches.

Every lead a card was checked against is signed into it, the ones it names
first (up to the turn's cap), so a revision checks its new text against all
of them, an archived one included, with the same lookup; a lookup that fails
refuses the revision (`503 ai_unavailable`), as it refuses a new card. The
tick is required again whenever the revised text still names one.

Every card about a lead gives the answer that lead's source card, so a
stored answer that prepared one is not replayed once the lead is restricted
and is found by the 0039 erasure ([ai-chat.md](ai-chat.md) §6 and §13).

A card's lead label is "‹reference› · ‹name› (‹type›, created ‹day›)"; the
reference is set by the site's own server, never typed by the customer.

Each member has two daily caps per site, counted at Confirm through
`app.rate_limit_hit` in UTC days: `AI_CARD_LIMITS.changesPerMemberPerDay`
(200) confirmed changes of any kind, and `mailPerMemberPerDay` (50) emails
(written or template). An email asks its own cap first, so one the mail cap
refuses is not counted as a change; one counted as mail before the changes
cap refuses it is past that cap anyway, and both open again at the same
moment. Past either, Confirm answers `429 ai_rate_limited` with
`details.reason` `daily_changes` or `daily_mail` and `details.retryAfterSeconds`;
the card then says when it opens again and offers no Retry save. A limiter
that cannot be reached refuses with `503 ai_unavailable`. A retry of a saved
card counts again, and so does a confirmation refused after the caps for a
reason of its own (a stale card): the limiter has no way to give a count
back, and adding one is a migration.

A member who keeps Ask AI but may no longer make a card's change (a role
changed from Leads to Orders while the card was open) is refused that card
alone: `403 permission_denied` with `details.reason: 'card_not_permitted'`
on Confirm and revise. The card says so and offers no Retry save; the
conversation stays. A member who lost Ask AI altogether gets the plain `403
permission_denied`, after which the admin clears the chat as before.

On the wire every addition is optional. The stream sends every card in full
in the `action_cards` part, then the cards an older admin can show in their
older shape in `actions`; a card with a new kind, a widened draft or a
required tick is only in `action_cards`, which an older admin ignores. A
chat request offers the new kinds (`lead_edit`, `template_email`,
`lead_archive`, `automation_off`) and the member list only with `wide:
true`, which a newer admin sends when the capabilities list `cardActions`;
without it the turn is offered the older kinds alone, unchanged, and
prepares no card the older shape cannot carry (a task for another member, a
task edit beyond its status, a card that needs the tick), so an older admin
never shows "Draft ready" without its card. A revision answers in the older
shape unless the request has `wide: true`, sent on the same condition.
AI-made changes read "via Ask AI" on the lead's timeline.

## Browser behavior

Cards are released only after a successful model turn and final permission
check. The UI renders card contents as escaped text, never executable model
markup. A click marks the card Saving immediately, preventing double submission.
Only a successful backend receipt marks it saved. Closing and reopening the
panel retains receipts; Site/member changes and New chat discard cards. A
confirmed write may finish after the panel closes, as an ordinary form save can.

An uncertain network result offers Retry save with the same token, never a new
model-generated action. A refusal no retry can get past (a daily cap, a change
the member may no longer make) offers none. Focus follows each step for a
keyboard: Edit moves it into the form, Update draft to the card's status line
and then to Confirm, Confirm to the status line (a polite live region) through
saving, saved or a refusal; a card that changes on its own takes no focus from
elsewhere, and the side panel's composer gets focus back when an answer ends. Dismissing an uncertain result tells staff to check the
lead; it does not claim nothing was saved. Expired cards require checking the
lead before requesting a new draft. Permission loss clears private chat. Saved
actions refresh the open lead and My tasks through a Site-scoped refresh event.

## Verification

Tests cover altered, expired, cross-actor and cross-Site tokens, permission
changes, disabled configuration, no writes during preparation, concurrent
idempotent saves, archive and restriction checks, calendar dates,
confirmation, cancellation and lost HTTP responses. Authenticated phone and
desktop journeys use a deterministic model over real backend and database
paths. No production customer record is used for automated writes.

`AI_ASSISTANT_ENABLED` disables reads, preparation and confirmation
together. No API key goes to the browser.
