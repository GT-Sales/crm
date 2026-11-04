# Interactive AI drafts, guided questions and reviewed email

Version 3 adds three requested behaviors to the existing Site-scoped assistant.

- Pending task/note/email cards have an Edit form. Task title, due date and
  assignment (You/Unassigned), note text, email subject and message can change.
  Update draft calls the authenticated revision endpoint; it validates the old
  signed token, preserves the lead and action kind, rechecks live permissions
  and returns a fresh signed card. Revision does not save business data.
- `askFollowUp` emits one question and two to five choices. The staff member can
  click a choice or type freely. The question is included in the next turn's
  text history. Old choices become disabled when a newer turn starts. Choice
  text grants no authority; all tools still validate inputs and Site access.
- `prepareEmail` drafts plain text for one lead's customer. The authorized
  browser card receives backend-resolved To/From addresses, which are signed
  with the draft and omitted from the model's tool result/history. Send uses
  the existing Site sender, customer-email outbox, suppression and delivery
  checks. The model has no send tool or arbitrary recipient input.

## Save and retry behavior

Confirmation still requires active `workspace.read` and `lead.manage`. Email
preview and queue reads exclude archived/restricted/other-Site leads. Sending
rechecks the recipient and sender against the signed preview; a changed address
requires a new draft. A previously accepted action returns its existing outbox
receipt without another job, timeline entry or audit. Its key is
`ai_email:<signed action id>`. The existing worker receives a per-action `tpl_`
transport label and version 0 with rendered text; no saved Settings template is
created or loaded for an ad hoc message. Audit metadata includes the action ID,
not the message or address.

Editing is available only before any save attempt. During saving, or after an
uncertain response, the card cannot change; Retry save uses its unchanged token.
Revision failures retain the original unsaved card. Actor/Site changes discard
drafts; access-denied responses clear private chat. The receipt says queued for
delivery, not delivered. Delivery failures/suppression remain visible through
the existing outbox and email delivery paths.

## Boundaries and rollout

This is customer outbound email, not mailbox access. No inbox reading, arbitrary
addresses, attachments, bulk mail, autonomous sends, lead edits or stage changes.
The user's selected flow is draft → edit → Send. No production email is sent by
automated tests. There is no migration or new secret; existing AI and customer
email configuration plus Site email settings are required. Deploy backend/admin
together and verify with a synthetic Site and controlled recipient before staff
send real customer email. Real-model intent/clarification quality remains a live
evaluation; deterministic tests establish wiring, authorization and retries.
