# Reviewed AI lead updates

The assistant can prepare one-field changes to a lead's stage, assigned staff
member, customer name or phone. Each card identifies the Site and lead, shows
current and proposed values, and supports editing the proposed value before
explicit confirmation. Stage and assignee edits use backend-provided choices.
Name/phone edits are plain text. Changes may trigger existing enabled flows.

The model has no write tool. `prepareLeadUpdate` signs the field, proposed
value and a backend-read update version with the existing actor/Site/expiry
binding. Current contact values remain browser-only metadata. A read-only
`getLeadUpdateOptions` tool supplies available stages or active member names/IDs,
with the shared per-turn tool, byte and record budgets. Member choices are
bounded to the first 24 active members; larger teams can use the lead page.
Ambiguous or unnamed members require clarification rather than guessing.

Confirmation rechecks live lead.manage access and the feature/Site allowlist.
Within one tenant transaction it locks the lead, checks its active/unrestricted
state and the exact preview version, then calls the same applyLeadUpdate used
by manual edits. Stage transition, document, assignment and contact rules still
apply. The assistant supplies no order details or document overrides: a move
requiring additional information must be completed on the lead page. Refusals
roll back the entire transaction, including any partial rescue work.

A receipt audit event keyed by the signed action ID commits with the change.
Concurrent and lost-response retries return that receipt without reapplying the
change, retriggering flows, or replacing subsequent staff work. A different
proposal based on an outdated version returns a conflict. Revision keeps the
same lead, kind and field, takes a fresh preview and signs a new ID; it performs
no business write. The user reviews the replacement before confirming.

No migration, new secret or mailbox integration is required. Existing AI and
outbox configuration applies. Payment, email address, plan/order, custom/form
fields, archive and bulk edits are outside this version. Those changes continue
through the manual CRM controls.
