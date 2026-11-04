# Ask AI: confirmed tasks and notes (version 2 foundation)

Version 3 extends these foundations with editable cards, guided questions and
reviewed customer email. See [interactive-ai.md](interactive-ai.md) for the
current scope and address-binding/revision behavior.

Version 2 adds two operations to the existing site-scoped assistant: prepare a
follow-up task and prepare a note. A model tool call only prepares a card. It has
no write-store reference and cannot confirm a card, including when chat text or
a record says "confirm". All other writes remain outside the assistant.

Each card names the Site and lead, shows the exact note text or task title,
calendar due date and assignee (the asking member or unassigned), and offers
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
confirmation. No API key goes to the browser. There is no new direct write tool,
bulk operation, email operation, lead edit, stage change or autonomous action.
