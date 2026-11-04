# AI automation authoring implementation plan

## Outcome and scope

A user describes an automation in chat. The assistant resolves the site's available
triggers, stages, templates, properties and members, asks only for missing choices,
and presents an editable visual proposal. The user can save it as a draft, open
it in the builder, test it, and explicitly publish it. Creating a draft must not
switch the flow on. Editing an active flow creates a draft and preserves its
active version, On/Off switch and existing waiting runs.

Extend the established Vercel AI SDK chat stack and signed action cards. Keep the
existing automation engine as the only execution engine. Do not generate JavaScript,
SQL, cron expressions, arbitrary HTTP calls or a second workflow language.

## Existing integration points

- Contracts: `packages/contracts/src/automation-flows.ts` and `automation-api.ts`.
- Tenant-scoped read/write service: `apps/backend/src/automations/flow-store.ts`.
- Authorization/API semantics: `apps/backend/src/routes/automations.ts`.
- AI tools and signatures: `apps/backend/src/ai/tools.ts`, `actions.ts` and
  `replay-guard.ts`; action execution in the AI routes.
- Visual editing: `apps/admin/src/components/automations/flow-page.tsx`,
  `canvas/flow-canvas.tsx`, draft mutations and condition builder.

## User journeys

### Create

1. User: “When a SIM order reaches Verified, wait two days and email them.”
2. Resolve Verified against SIM-order stages. Ask which available email template
   to use if the request does not identify one; show named choices.
3. Show a proposed flow with trigger, wait, email and explicit ending. Summarize
   the delay, recipient behavior, selected template and activation state.
4. Permit inline edits and Open in builder. Display validation errors beside the
   affected step. Missing information is a draft issue, never a guessed ID.
5. Save draft requires a user action. Success links to the actual saved flow.
6. Test with sample data is a separate action. Sending a real test email requires
   an explicit recipient and Send test email confirmation.
7. Review and Activate publish a validated version. A separate Turn on action
   starts future matching events. Explain that past events are not backfilled.

### Edit

Resolve the named flow; ask if multiple names match. Read its latest draft,
active version and revision. “Change the delay to three days” preserves unrelated
steps, stable step IDs, names and settings. Show a semantic before/after diff,
including deleted branches, changed recipients and changed triggers. Saving uses
expectedRevision. A conflict requires reloading and presenting a new diff; never
silently overwrite someone else's changes. An unsaved manual draft must be
explicitly selected as the edit base or left intact.

### Explain and troubleshoot

Read permission-filtered flow definitions and bounded run summaries. Explain the
actual stored version and recorded reasons, with links to the flow/run. Never
claim a queued email was delivered or a sample simulation proves live execution.

## Typed tool surface

Read tools: listAutomations (bounded search/page), getAutomation (key/version),
getAutomationCatalog (trigger-specific projection), getAutomationRuns (bounded).
Every call reloads access and derives actor/workspace from the server session.
Run projections follow existing contact-access rules. Catalog results omit hidden
or sensitive properties and notification addresses.

Proposal tools: proposeAutomationCreate and proposeAutomationEdit. Their output
is a strict FlowDraft-compatible structure, purpose summary, unresolved choices,
validation issues and a server-generated semantic diff. They cannot write, test,
publish or enable. Generate new step IDs on the server; preserve valid existing
IDs for edits. Apply current limits: 30 steps, branch depth 3, five waits,
condition/group limits, path-wait limits and 65,536-byte definition limit.

Validation is layered: strict schema; origin-specific draft/definition rules;
checkFlowAgainstSite with a freshly loaded catalog; action permission checks;
execution-time checks already enforced by the engine. Allow bounded repair of
invalid model output (at most two attempts), then show actionable errors.

## Confirmed execution and concurrency

Add typed AI action kinds for create/save draft. Reuse the signed proposal envelope,
binding actor, workspace, operation, flow key, base revision, proposal digest and
expiry. Recheck membership, integration.manage, scope and catalog at execution.
Lead-changing activation additionally requires lead.manage as today.

Do not directly expand the existing 40 KB signed-token cap to accommodate a
65 KB definition. Prefer a tenant-scoped proposal record containing bounded JSON,
with a small signed ID/digest envelope. Add retention/expiry, FORCE RLS and grants
through a new migration. Store only necessary metadata in logs and audit events.
Bind editable updates to server revalidation and a refreshed proposal digest.

Use the existing replay guard pattern and a stable action ID. Commit the automation
write and successful action receipt atomically; a retried request returns the same
flow/revision. Reject a reused ID with a different payload. For creation, make
flow creation plus initial draft persistence one transaction, preventing orphan
empty flows. Do not route internal execution through a privileged public HTTP call.
Factor shared authorization/service behavior so ordinary UI and AI use the same
rules without assuming the route already authorized the request.

Phase one retains publishing/enabling in the ordinary builder. A later phase may
add separate signed Activate and Turn on cards, each with fresh revision checks
and explicit confirmation. Never bundle save, publish and enable into one model tool.

## Visual interaction

Reuse FlowCanvas in read-only preview mode and the existing editor for full edits.
Show Site, flow name, draft state, trigger, action count and unresolved choices.
Provide Edit, Save draft, Open builder and Discard. For existing flows show the
current On/Off state separately from the proposed version. Surface expired cards,
permission changes, conflicts, provider errors and validation errors inline.
Preserve entered edits during recoverable failures. Use the list view on phones,
keyboard focus management and reduced-motion behavior already implemented.

## Simulation prerequisite

Before exposing automatic AI testing, introduce a pure, no-delivery simulation
mode. The existing test route can enqueue real customer email and must not be
called autonomously. Accept validated synthetic scenarios, evaluate trigger.when,
and show both branch coverage and uncovered branches. Support choosing lead type,
plan, stage, assignee and allowed property values without using customer PII.
Share condition semantics with live execution or prove parity with table-driven
integration tests. Label waits and mutations simulated. Keep live stage/document
checks and provider readiness as separate checks; simulation cannot certify them.

## Delivery sequence and acceptance gates

1. Foundation: close confirmed review defects; specify pure simulation and parity
   tests; document supported triggers/actions. Gate: backend/editor regression green.
2. Read-only assistant: catalog, flow search/detail and explanations. Gate: tenant,
   permission, sensitive-field and bounded-output tests; links resolve correctly.
3. Create proposals: strict schema, clarification UI, visual card, validation/repair.
   Gate: no write occurs during model generation; unknown references stay unresolved.
4. Save drafts: proposal storage, signed receipt, atomic idempotent creation and
   revision-aware edits. Gate: retry, tampering, expiry, permission revocation,
   duplicate creation and simultaneous human edits covered by integration tests.
5. Visual editing/diff: preserve unrelated nodes, manual drafts and historical runs.
   Gate: browser journeys for create, edit, conflict, discard, mobile and keyboard.
6. Pure simulation: scenario editor, branch coverage, honest results. Gate: zero
   outbox rows, emails or lead mutations in preview tests.
7. Limited release: enable for selected internal sites, collect failure codes and
   timings, then widen after acceptance. Keep a server-side capability switch to
   disable AI authoring while the normal builder and existing automations continue.
8. Optional publishing cards: separate review/activate/enable operations only after
   draft authoring is reliable. Gate: explicit consent and current permission checks.

## Evaluation and release evidence

Use a versioned fixture set of at least 30 requests: simple triggers, both branches,
waits, ambiguous members/templates, unsupported integrations, forbidden fields,
prompt injection inside names/notes, cross-site references, permission revocation,
large definitions, conflicting edits and multi-turn correction. Assert structural
intent and allowed references rather than exact wording. Evaluate both create and
edit; edits must preserve unaffected subtrees. Track valid proposals, clarification
accuracy, save failures/conflicts, latency and token cost without logging prompts
or customer data. No release if any fixture writes without confirmation, crosses
tenants or modifies active behavior during draft saving.

Run unit/contracts, disposable-DB integration, browser journeys and CI for each
phase. Operational acceptance uses a dedicated test site and controlled recipient
to verify one event, one wait resume and one delivered email, including replay and
Off cancellation. Rollback disables authoring capability; saved drafts remain
editable, and existing active flows continue on the existing engine.

## Implementation status

The draft authoring, visual editing, revision checks, signed proposal references,
atomic save receipts and synthetic simulation are implemented behind
`AI_AUTOMATION_WORKSPACE_IDS`. The existing AI SDK engine remains in use; authoring
turns have a 4,800-token output ceiling. A scoped 96 KiB revise-body limit accommodates
the existing maximum flow size; chat and other request limits are unchanged.

Synthetic conditions use the same SQL predicate builder as live execution, queried
against synthetic values without inserting a lead. Explicit existing test-email
controls remain in the ordinary builder. The 30-request fixture set has a read/proposal
only runner; real model evaluation is a gate before widening the allowlist, rather
than something deterministic fake-model tests can establish. No hosted migrations,
allowlist changes, activation or real email delivery were performed here.
