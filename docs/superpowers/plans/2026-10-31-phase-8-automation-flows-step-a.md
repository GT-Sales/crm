# Phase 8, Step A: Automation Flows Engine, Storage and List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every site's automations become flows (a trigger, ordered steps with if/else and wait, a draft and an active version, recorded runs and step runs), the six built-in rules become seeded per-site flows that behave exactly as before, flows fire on submissions, stage moves and a new five-minute scheduler task, rescued checkouts count as submitted, and staff see the flows on a list page with a read-only view of each; flows are built through the API only (the canvas is Step B).

**Architecture:** Contracts define the flow definition (Zod, two schemas: draft and activatable), its limits, the six built-in defaults, the variables, `checkFlowAgainstSite` and `overlappingEmailFlows`, all pure. Migrations 0019/0020 add `automation_versions`, `automation_step_runs`, `automation_waits` and `automation_timers`, widen `automations`, `automation_runs`, `email_templates` and `memberships`, backfill the built-ins and replace `app.prune_operational_rows`. The backend engine (`apps/backend/src/automations/engine.ts`) replaces `runAutomations`: inside the move or submit transaction it reads the site's live flows in one statement, matches, guards loops, checks the flow against the site and runs the steps, each in a savepoint, through the outbox; a wait stores a row and a time trigger stores a timer, and the scheduler's fifth task `automations` resumes and fires them under `FOR UPDATE SKIP LOCKED`. A flow store and the §8 routes manage flows and site-made templates; the admin gets the list page and a read-only flow page.

**Tech Stack:** TypeScript (strict), Zod 4, Express 5, Drizzle + PostgreSQL 17 (local 16), Next.js 16 + React 19 + Tailwind 4 + shadcn, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-31-phase-8-automation-flows-design.md` (owner-approved, commit `0408fb7`; binding; this plan is its Step A, §10 row A). Owner decisions O1–O13: `.superpowers/sdd/2026-10-31-phase-8-automations/decisions.md` (O12: a rescued lead counts as submitted for every lead type; O13: a rescued order can no longer be finished by the customer, accepted). Shared rules, gate and shipping: `docs/superpowers/phases/README.md`. Canadian Plans is out of scope entirely.

**Done when (Step A):** the six built-ins behave exactly as before and are still off; a custom flow with an if/else and a wait, created and activated through the API, is switched on for a test site, fires on a real stage move and on the scheduler, and its run records each step's outcome; a rescued checkout fires the submitted flows; the Automations list and a flow's read-only page show it. (Step B's canvas, Runs tab and "New template" are not in this plan.)

**Rulings made while planning** (read the code on 2026-10-31; spec conflicts are marked):

- **P1. Parallel-safe contract names.** Batch 1 leaves the four endpoints whose response changes (`listAutomations`, `updateAutomation`, `listAutomationRuns`, `listEmailTemplates`) on their old schemas, so the tree stays green, and adds the new shapes under new names (`flowListResponseSchema`, `flowToggleResponseSchema`, `listFlowRunsResponseSchema`, `listSiteEmailTemplatesResponseSchema`). Batch 3 points those four endpoints at the new schemas with their routes and admin screens, then deletes the old schemas. (The spec words it as "`listAutomationsResponseSchema` loses `.length(6)`"; same result, different identifier.)
- **P2. `automations.name` is nullable in the database** (null reads as the built-in's label), CHECK `(name is null and origin = 'builtin') or char_length(btrim(name)) between 1 and 80`. Spec conflict: §4 lists `name` 1–80 without null; a NOT NULL column would make the old backend's toggle insert fail in the deploy window (§6), so null is kept for built-ins and filled by the backfill and `ensureBuiltInFlows`.
- **P3. The notification address is written by a SECURITY DEFINER function** `app.record_staff_notification_email(p_verified_email text)` (0020), called in `bootstrapStaff`'s own actor transaction (one statement, no extra round trip). Spec conflict: §4 says "the grant covers updating that column only", but sign-in runs in an actor-only transaction where the tenant-scoped memberships policy sees no rows; no column grant is added.
- **P4. The six default definitions also live in SQL** as `app.builtin_flow_definition(p_key text) returns jsonb` (IMMUTABLE, 0020), used by the backfill; the SQL ↔ contracts test compares its output with `builtInFlowDefinition(key)` (spec §7's "literal default definitions").
- **P5. Chain depth.** Events at depth 0 to 3 fire flows (CHECK `depth between 0 and 3`); at depth 3 an `update_lead` stage step is skipped `chain_too_deep` (its move would be depth 4) while the run's other steps, emails included, still run. Spec conflict: §5 step 4 says "`depth > 3` → run skipped", which can never be stored under the 0–3 CHECK and would stop the stage emails R8 keeps; Review Focus 6 ("four distinct flows chained stop at depth 3 with `chain_too_deep`") holds under this reading.
- **P6. A resumed run's chain** is rebuilt by walking `parent_run_id` (at most 3 hops; a pruned parent ends the walk). `parent_run_id` has no FK, so pruning a parent never blocks.
- **P7. Lock discipline.** Every bulk change the flow store makes to waits and timers (switch off, archive, activation's recompute) claims rows `FOR UPDATE SKIP LOCKED`; the tick re-checks, on every item it claims, that the flow is on and not archived, that the version is usable and (for a timer) that `event_at + after` of the version active now is due, else it pushes `due_at` or voids. So no transaction ever waits on a row the tick holds while holding the flow row, and the counter update (`run_count`) cannot deadlock with a toggle.
- **P8. A staff notification job carries no address**: payload `{ actorId, flowKey, flowName, siteName, leadId, leadPath, note }`; the handler reads the member's `notification_email` at send time and skips (`member_has_no_address`, `member_unavailable`) if it is gone.
- **P9. Names travel with automation writes.** Timeline entries a flow writes carry `automation` (flow key) and `automationName`; a `customer_emailed` entry for a site-made template also `templateName`. `emailSkipped` gains `flowName` and `templateName`, its `template` takes any template key, its cap becomes 200, and it lists only `no_sender`, `no_customer_email`, `missing_fill_in` and `compose_failed` (never `already_sent`).
- **P10. An empty draft** is `{ schemaVersion: 1, trigger: null, steps: [] }`: `flowDraftSchema` allows a null trigger and zero steps; `flowDefinitionSchema` needs both.
- **P11. A flow cannot send `tracking_code`** (structural refusal: its `{code}` can never be filled).
- **P12. Variables.** An unknown fill-in name in a task title or a site-made template is a structural refusal (`invalid_variable`, `ref` the name); a well-formed `{prop:<key>}` naming a property the site cannot use there is a site issue (`property_unavailable`): a warning on save, a refusal on activation, a skipped run.
- **P13. Site-made templates are capped** at 50 not archived per site (`EMAIL_TEMPLATE_MAX_SITE_MADE`, 409 `email_template_limit_reached`); a built-in template cannot be archived (409 `email_template_builtin`). The spec sets no limit.
- **P14. The 50-flow cap holds under concurrency:** create and restore take `pg_advisory_xact_lock(hashtextextended('automations:' || workspace_id, 0))` before counting.
- **P15. Audit.** `automation.created`, `automation.renamed`, `automation.toggled`, `automation.activated`, `automation.draft_discarded`, `automation.reset`, `automation.archived`, `automation.restored`, `email.template_created`, `email.template_archived`, `email.template_restored`; draft saves are not audited (Step B autosaves; the version row records `created_by`).
- **P16. Plans in conditions.** `plan_unavailable` means not a plan of this site, or of a type the trigger cannot fire for; an inactive plan is allowed (old orders still carry it).
- **P17. Timers have no attempts column** (spec §4); a timer item that throws rolls back, is logged by code and is retried by the next tick. Waits keep `attempts` (≤ 5, then `resume_failed`).
- **P18. A tick takes at most 200 items per site**, due waits first, then due timers, each oldest first.
- **P19. Actors.** Lead changes, tasks and notifications are written as the version's `activated_by` (R5). A customer email keeps the write's actor; in a resumed or timer-fired run that is the activator when there is one, else the scheduler identity's actor.
- **P20. Dead code goes at the merge.** The old `automations/store.ts`, `enabledAutomationKeys`, `automationsForMove`, `automationsForSubmit`, `automationsUsingTemplate` and `tests/automation-store.integration.test.ts` stay until both parallel batches merge (each still compiles against them); the controller deletes them in Task 16.
- **P21. The flow page offers Archive and Restore** for a custom flow, so a mistaken "New flow" can be undone before Step B; "New flow" opens the read-only page, which says "No trigger yet."
- **P22. A write's response includes what its flows did at every depth**: `activities` and `emailSkipped` of the move cover nested flow moves too.
- **P23. The site snapshot** (`loadFlowSite`) is read once per write, lazily, only when some live flow's trigger matches the event.
- **P24. Test seam.** `FireFlowsContext.afterFlowsRead` (an optional hook, called once after the flows are read) lets the mid-move activation test hold a move open; production never sets it.
- **P25. Cancelling a waiting run** sets the run `cancelled` with its reason and `finished_at`, the wait `cancelled`, and writes one `cancelled` step row for the wait step.

**Batches** (at most three implementers at once, one worktree and database each; tasks run in order inside a batch; one review per batch, then the final review):

| Batch               | Worktree, branch, database                          | Tasks                                                                                                                                                                                                                                                                        | Starts                                                                     |
| ------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1 Foundation        | `/home/user/crm-wt/t1`, `p8/t1`, `gt_sales_t1_test` | T1 flow contracts (hard) → T2 API contracts and consumers (hard) → T3 migration pair, paste file, SQL tests (hard) → T4 email language and shared backend modules (hard)                                                                                                     | first, alone; **must be merged into `phase-8-automations` before 2 and 3** |
| 2 Engine            | `/home/user/crm-wt/t2`, `p8/t2`, `gt_sales_t2_test` | T5 the engine and email steps (hard) → T6 lead-changing steps, loops, rescue (hard) → T7 staff notification and address (hard) → T8 timers, waits, scheduler task (hard)                                                                                                     | after Batch 1 merges, in parallel with Batch 3                             |
| 3 Store, API, admin | `/home/user/crm-wt/t3`, `p8/t3`, `gt_sales_t3_test` | T9 flow store lifecycle (hard) → T10 drafts, activation, catalogue (hard) → T11 routes (hard) → T12 site-made templates (hard) → T13 admin pages (hard) → T14 docs (easy) → **T15 journeys (hard), only after Batch 2 is merged into the work branch and then into `p8/t3`** | after Batch 1 merges, in parallel with Batch 2                             |
| Controller          | main checkout                                       | T16 dead code, gate, migration apply, PR, deploy, live check                                                                                                                                                                                                                 | after all                                                                  |

**Shared files and who owns them.** Batch 1 may touch anything (it lands first). After it merges: `packages/contracts/src/{index,endpoints,client,automations,automation-api,customer-email}.ts` belong to **Batch 3** (the four endpoint swaps and the old schemas' removal); Batch 2 changes no contracts file. `docs/api/openapi.json`: regenerated by Batches 1 and 3; at each merge the controller takes either side and reruns `pnpm --filter @gt-sales/contracts build`. `packages/db/src/schema.ts` and `packages/db/drizzle/**`: Batch 1 only. `apps/backend/src/scheduler.ts`, `apps/backend/src/jobs/providers.ts`, `apps/backend/src/staff/store.ts`, `apps/backend/src/leads/**`, `apps/backend/src/email/queue.ts`, `apps/backend/src/tracking/change-requests.ts`, `apps/backend/src/routes/tracking.ts` and `apps/backend/src/automations/{engine,conditions,actions,timers,tick,staff-notification,run}.ts`: Batch 2. `apps/backend/src/routes/{staff,automations,email-settings}.ts`, `apps/backend/src/email/settings-store.ts` (after T4), `apps/backend/src/automations/flow-store.ts` and everything under `apps/admin/**` and `docs/**`, `AGENTS.md`: Batch 3. `apps/backend/src/app.ts`: nobody (no new top-level router). `apps/backend/src/automations/{site,records}.ts` and `apps/backend/src/email/{markup,layout,fill-in-values,compose}.ts`: Batch 1; read-only for 2 and 3 (a needed change is reported to the controller, not made).

## Global Constraints

- Strict TypeScript, no `any`, no `as`; parse with Zod; `pnpm run lint && pnpm run typecheck && pnpm run format` clean before every commit; every SQL value bound (JSON keys and enum lists are fixed internal constants inlined as literals, never input).
- `ENV(n)` as in the phases README for `gt_sales_t<n>_test`; backend filter `backend`. Fixed UUIDs per suite, site prefix `18000000-0000-4000-8000-`, actor prefix `28000000-0000-4000-8000-`, lead prefix `38000000-0000-4000-8000-`, suffix `0000000081NN` (db flows), `82NN` (SQL ↔ contracts), `83NN` (engine), `84NN` (lead-changing steps), `85NN` (notifications), `86NN` (tick), `87NN` (flow store), `88NN` (templates), each padded to 12 hex digits (`000000008301`).
- Keys: flow `^flow_[a-z0-9]{16}$`; template `^tpl_[a-z0-9]{16}$`; step id `^[a-z0-9_]{1,40}$`, `main` only in a built-in; run key shape `^[a-z][a-z0-9_]{2,63}$`; reason shape `^[a-z][a-z0-9_]{0,63}$`.
- Limits (contracts constants, checked on save and on activation): `AUTOMATION_MAX_FLOWS = 50` not archived, built-ins included; `AUTOMATION_MAX_STEPS = 30` nested counted; `AUTOMATION_MAX_BRANCH_DEPTH = 3`; `AUTOMATION_MAX_WAITS = 5`; a wait 1–720 hours or 1–60 days and the waits on any path ≤ 90 days; a trigger delay 1–720 hours or 1–90 days; conditions ≤ 10 items per group, groups 2 levels deep, ≤ 30 per flow; `AUTOMATION_MAX_CHAIN_DEPTH = 3`; `AUTOMATION_RUN_PAGE = 50`; name 1–80, description 0–500; definition ≤ 65 536 bytes as JSON (also a CHECK); task title 1–200; `dueInDays` 0–365; notify `actorIds` 0–10 with ≥ 1 recipient overall, `note` 0–300; plan and stage conditions 1–20 values; `EMAIL_TEMPLATE_MAX_SITE_MADE = 50`.
- Enums: run status `waiting`, `completed`, `skipped`, `failed`, `cancelled`; step outcome `done`, `skipped`, `failed`, `waiting`, `cancelled`; version status `draft`, `active`, `retired`, `discarded`; wait status `pending`, `resumed`, `cancelled`; timer status `pending`, `fired`, `void`; timer kinds `time_in_stage`, `task_overdue`, `after_submitted`; legacy run outcome `queued`, `skipped` (only on rows from before the conversion).
- `AUTOMATION_REASONS` (contracts, tied to the shape by a test): `no_sender`, `no_customer_email`, `missing_fill_in`, `already_sent`, `compose_failed`, `step_failed`, `definition_invalid`, `stage_unavailable`, `template_unavailable`, `property_unavailable`, `plan_unavailable`, `member_unavailable`, `lead_type_unavailable`, `invalid_variable`, `chain_too_deep`, `loop_prevented`, `already_assigned`, `activator_not_allowed`, `illegal_stage_move`, `dispatch_details_required`, `activation_details_required`, `documents_incomplete`, `invalid_field`, `no_staff_sender`, `member_has_no_address`, `lead_archived`, `flow_switched_off`, `resume_failed`.
- Occurrences: a submission `submitted`; a move its `status_change` activity id; the stage entry of a submission (R4) the submission's `system` `submitted` activity id when the lead moved, else `submitted:stage`; timers `stay:<entry occurrence>`, `task:<task id>:<YYYY-MM-DD>`, `after_submitted`; a timer-fired run takes its timer's occurrence. One run per `(workspace, automation_key, lead, occurrence)`.
- Dedupe: a send step `<lead id>:<flow key>:<occurrence>:<step id>`, the step `main` exactly `<lead id>:<flow key>:<occurrence>` (phase 4's key); notify `<lead id>:<flow key>:<occurrence>:<step id>:<member actor id>`; job type `staff_notification_email`.
- Order of firing: submission flows before stage flows of the same write (R4); flows ordered built-ins in `BUILT_IN_AUTOMATION_KEYS` order, then custom by `created_at`, then `id`.
- Scheduler task `automations`, every `AUTOMATION_TICK_INTERVAL_MS = 5 * 60_000`, as the outbox identity (`outbox:run`, its `workspaceIds`), 200 items per site per tick, waits first (P18); time triggers never back-fill (R3).
- `task_overdue` due time: the start of the day after the task's due day in `America/Toronto`, plus `after` (none when `after` is null); a task's due day is the UTC date of its `due_at` (stored at noon UTC). A task created by a flow is due on today in Toronto + `dueInDays`, stored at `T12:00:00.000Z`; a missing variable renders `(none)`.
- Staff notification mail: subject `<site name>: <flow name>`; text `The automation "<flow name>" asks you to look at a lead: <ADMIN_ORIGIN>/w/<slug>/leads/<lead id>` then the note on its own line when there is one; from `RESEND_FROM_NAME` / `RESEND_FROM_EMAIL`; no customer detail, no variables.
- Audit of an automation's write: `actorLabel: 'automation'`, `after.automation: { key, version, runId }`. No PII anywhere in logs, audit, timeline, runs or step runs: keys, ids, versions, fill-in names, field names only (README rule 8); a sensitive property is never offered, evaluated in a run's output or rendered (rule 9).
- No `DELETE` grant on any new table (rule 23); pruning only through `app.prune_operational_rows`.
- Admin copy in sentence case, every control labelled, keyboard-usable, the PR #5 look (rule 15). Commit trailers: `Co-Authored-By:` for the model that wrote the commit, and the session's `Claude-Session:` line.

## Review Focus

1. **A custom and a built-in flow fire on one move.** Both on, both email on Delivered. Expected: two jobs with different dedupe keys (`<lead>:sim_order_dispatched:<occ>` and `<lead>:<flow key>:<occ>:<step>`), two runs, the list warns naming both; the same occurrence fired again gives no third mail and no new run. Tests: Task 5 (`a built-in and a custom flow on one move send two mails, once`), Task 9 (`the list warns when two flows on email on the same event`).
2. **A removed stage or template.** A site-made template archived after an active flow uses it; a definition naming a stage its type no longer lists. Expected: the move succeeds, the run is `skipped` with `template_unavailable` / `stage_unavailable` and `detail` the key, nothing queued; the list says "Needs attention"; Activate refuses. Tests: Task 5 (`a flow naming a stage or template that is gone is skipped whole, with the key`), Task 9 (`an unusable active version marks the flow needs attention`), Task 10 (`activation refuses a draft with any site issue`), Task 12 (`archiving a template an active flow sends marks that flow`).
3. **A flow activated, or switched, mid-move.** Expected: the move runs the version (and the on/off state) it read in its one statement, the run names that version, the next move uses the new one. Tests: Task 5 (`a version activated while a move is in flight: that move runs the old version, the next the new`, `a flow switched off mid-move still runs for that move only`).
4. **Overlapping scheduler ticks.** Two runners on the same due waits and timers, one killed mid-item. Expected: each item runs once, one run per occurrence, one mail per step; the killed item is completed once by a later tick. Tests: Task 8 (`two ticks at once run each due wait and timer once`, `a tick killed mid-item leaves it to the next, which completes it once`).
5. **A wait outlives a deactivation or an edit.** Expected: switched off → the run `cancelled` (`flow_switched_off`) at once and the resume sends nothing; version 2 activated meanwhile → the run resumes on version 1's remaining steps; version 1's template archived meanwhile → the resume cancels it with `template_unavailable`. Tests: Task 9 (`switching off cancels waiting runs and voids pending timers at once`), Task 8 (`a resume after the flow went off sends nothing`, `a run resumes on its own version after a new one is activated`, `a resume whose template was archived cancels with template_unavailable`).
6. **Self-triggering loops.** Flow A (enters Verified → move to Activated) and B (enters Activated → move to Verified); four distinct chained flows. Expected: the repeat is `skipped` `loop_prevented`, the move commits; the fourth flow's move is skipped `chain_too_deep` (P5); every move made still queues its stage's built-in email. Tests: Task 6 (`two flows that move each other stop with loop_prevented and the move commits`, `four chained flows: the last move is skipped chain_too_deep and every move's email is queued`).
7. **A property made sensitive after use.** A condition and a `{prop:…}` task-title variable on a property later marked sensitive. Expected: the list says "Needs attention", the next firing is `skipped` `property_unavailable`, the value appears in no run, step run, task, mail or log line, and Activate refuses. Tests: Task 6 (`a property made sensitive after use skips the run and its value appears nowhere`), Task 9 (needs attention, same fixture), Task 10 (activation refuses).
8. **The conversion never double-mails.** A database holding an enabled built-in and queued and skipped legacy runs. Expected: after 0019–0020 the built-in is on with version 1 and its history reads; an occurrence the old code mailed queues nothing (no run when the legacy run's occurrence was backfilled; `already_sent` when only the job is left). Tests: Task 3 (`0020 backfills legacy-shaped rows once`), Task 5 (`after the conversion, replaying an occurrence the old code mailed queues nothing`).

---

## Batch 1: foundation (lands first)

### Task 1: Contracts: the flow definition

Batch 1. Model: hard.

**Files:**

- Create: `packages/contracts/src/automation-keys.ts`, `packages/contracts/src/automation-flows.ts`, `packages/contracts/src/automation-flows.test.ts`
- Modify: `packages/contracts/src/automations.ts` (import and re-export the keys from `automation-keys.ts`; `BUILT_IN_AUTOMATIONS` stays as the labels and defaults), `packages/contracts/src/index.ts`

**Interfaces (Produces):**

```ts
// automation-keys.ts — imports zod only (breaks the automations ↔ automation-flows cycle)
export const BUILT_IN_AUTOMATION_KEYS = [ 'order_received', 'sim_order_information_needed', 'sim_order_dispatched', 'sim_order_activated', 'sim_order_cancelled', 'mobility_activated' ] as const;
export const builtInAutomationKeySchema = z.enum(BUILT_IN_AUTOMATION_KEYS); export type BuiltInAutomationKey;
export const CUSTOM_FLOW_KEY_PATTERN = /^flow_[a-z0-9]{16}$/;
export const customFlowKeySchema = z.string().regex(CUSTOM_FLOW_KEY_PATTERN);
export const automationKeySchema = z.union([builtInAutomationKeySchema, customFlowKeySchema]); export type AutomationKey = z.infer<…>;
export const AUTOMATION_KEY_SHAPE = /^[a-z][a-z0-9_]{2,63}$/;
export function isBuiltInAutomationKey(key: string): key is BuiltInAutomationKey;
/** `flow_` + 16 of [a-z0-9] from `crypto.getRandomValues`. */
export function generateFlowKey(): string;

// automation-flows.ts
export const FLOW_TRIGGER_KINDS = ['lead_submitted', 'stage_entered', 'time_in_stage', 'task_overdue', 'after_submitted'] as const;
export const FLOW_STEP_KINDS = ['send_email', 'create_task', 'assign_lead', 'update_lead', 'notify_staff', 'if_else', 'wait'] as const;
export const AUTOMATION_RUN_STATUSES, AUTOMATION_STEP_OUTCOMES, AUTOMATION_VERSION_STATUSES, AUTOMATION_WAIT_STATUSES, AUTOMATION_TIMER_STATUSES, AUTOMATION_TIMER_KINDS (= the three time triggers), AUTOMATION_REASONS; // values in Global Constraints, each with its z.enum schema and type
export const AUTOMATION_REASON_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;
export const STEP_ID_PATTERN = /^[a-z0-9_]{1,40}$/; export const BUILT_IN_STEP_ID = 'main';
export const AUTOMATION_MAX_FLOWS = 50, AUTOMATION_MAX_STEPS = 30, AUTOMATION_MAX_BRANCH_DEPTH = 3, AUTOMATION_MAX_WAITS = 5, AUTOMATION_MAX_CONDITIONS = 30, AUTOMATION_MAX_GROUP_ITEMS = 10, AUTOMATION_MAX_CHAIN_DEPTH = 3, AUTOMATION_RUN_PAGE = 50, AUTOMATION_MAX_DEFINITION_BYTES = 65_536, AUTOMATION_MAX_PATH_WAIT_DAYS = 90;
export const durationSchema; export type Duration = { amount: number; unit: 'hours' | 'days' };
export const conditionSchema, conditionGroupSchema; export type Condition, ConditionGroup; // spec §3 shapes; property uses leadPropertyFilterSchema
export const flowTriggerSchema, flowStepSchema, flowDefinitionSchema; export type FlowTrigger, FlowStep, FlowDefinition;
export const flowDraftSchema; export type FlowDraft; // P10: trigger nullable, steps 0..; a step's setting may be null (send_email.template, create_task.title, assign_lead.actorId, update_lead.change, notify recipients, if_else.condition, wait.for, trigger stage/leadType/after)
export const FLOW_ISSUE_CODES = ['stage_unavailable', 'template_unavailable', 'property_unavailable', 'plan_unavailable', 'member_unavailable', 'lead_type_unavailable', 'invalid_variable', 'definition_invalid'] as const; // the last only for a stored definition that no longer parses (list marker, run skip)
export const flowIssueSchema = z.object({ path: z.string().max(200), code: z.enum(FLOW_ISSUE_CODES), ref: z.string().max(200) }).strict(); export type FlowIssue;
export function builtInFlowDefinition(key: BuiltInAutomationKey): FlowDefinition; // trigger from BUILT_IN_AUTOMATIONS, when null, steps [{ id: 'main', kind: 'send_email', template }]
export function builtInFlowName(key: BuiltInAutomationKey): string; // the label
export function walkSteps(steps: readonly FlowStep[], visit: (step: FlowStep, path: string, depth: number) => void): void; // pre-order, `then` before `else`; path like `steps.2.then.0`
export function triggerLeadTypes(trigger: FlowTrigger): readonly LeadType[]; // task_overdue [] → every type
export function triggerMatchesEvent(trigger: FlowTrigger, event: { kind: 'lead_submitted' | 'stage_entered'; leadType: string; stage: string }): boolean;
export function flowHasLeadChangingStep(steps: readonly FlowStep[]): boolean; // assign_lead, update_lead, create_task
export function durationMs(duration: Duration): number;
/** When a time trigger's timer is due; null for a trigger that is not time-based. `dueDay` (YYYY-MM-DD) only for task_overdue. */
export function timerDueAt(trigger: FlowTrigger, input: { eventAt: Date; dueDay?: string }): Date | null;
export const FLOW_TASK_VARIABLES = ['first name', 'last name', 'plan', 'price', 'SIM number', 'courier', 'tracking number', 'order number'] as const;
/** The names written in braces in `text`, normalized (`normalizeFillInName`, or `prop:<key>`); refuses the first unknown one. */
export function parseTextVariables(text: string, allowed: readonly string[]): { ok: true; names: string[] } | { ok: false; name: string };
export interface FlowSiteTemplate { archived: boolean; propertyKeys: readonly string[] }
export interface FlowSite { templates: ReadonlyMap<string, FlowSiteTemplate>; memberIds: ReadonlySet<string>; plans: ReadonlyMap<string, { leadType: string }>; catalog: PropertyCatalog }
export function checkFlowAgainstSite(definition: FlowDefinition | FlowDraft, site: FlowSite): FlowIssue[]; // ordered by path
export interface FlowForOverlap { key: string; name: string; enabled: boolean; definition: FlowDefinition | null }
export const flowOverlapWarningSchema = z.object({ event: z.discriminatedUnion('kind', [{ kind: 'lead_submitted', leadType }, { kind: 'stage_entered', leadType, stage }]), flows: z.array(z.object({ key: automationKeySchema, name: z.string() })).min(2), message: z.string().max(2000) });
export type FlowOverlapWarning = z.infer<typeof flowOverlapWarningSchema>;
export function overlappingEmailFlows(flows: readonly FlowForOverlap[]): FlowOverlapWarning[];
// types exported beside their schemas: FlowTriggerKind, FlowStepKind, AutomationRunStatus, AutomationStepOutcome, AutomationVersionStatus, AutomationWaitStatus, AutomationTimerStatus, AutomationTimerKind, AutomationReason, FlowIssueCode
```

`automation-api.ts` (Task 2) exports the `z.infer` type of each of its schemas under the schema's name without `Schema` (`FlowSummary`, `FlowListResponse`, `FlowDetailResponse`, `FlowRun`, `FlowStepRun`, `FlowVersionSummary`, `FlowCatalogResponse`, `CreateFlowRequest`, `UpdateFlowDetailsRequest`, `ToggleFlowRequest`, `SaveFlowDraftRequest`, `ActivateFlowRequest`, …).

Rules the schemas enforce (both, `superRefine`, `.strict()` objects): unique step ids; `main` only when the caller says it is a built-in (export `flowDefinitionSchemaFor(origin: 'builtin' | 'custom')` and `flowDraftSchemaFor(origin)`; the plain schemas are the `custom` ones); an `if_else` last in its sequence (R7); stages belong to the trigger's type(s) (a `stage` condition: to at least one; `update_lead` stage: to every); `time_in_stage` and `stage_entered` take one type and never its `incomplete` stage; a `plan` condition only when every trigger type is an order type; `assignee.actorId` only with `is`; `send_email.template` never `tracking_code` (P11); task-title variables through `parseTextVariables(title, [...FLOW_TASK_VARIABLES, 'prop:*'])` (unknown → issue `invalid_variable`); every limit of the Global Constraints, the per-path wait sum included; the definition's JSON byte length. A structure error is a Zod issue whose message is the issue code where one applies. `checkFlowAgainstSite`: lead types and stages from `leadTypeCatalog`; `template_unavailable` for a key not in `site.templates` or archived, and `property_unavailable` for each of its `propertyKeys` that is unknown, hidden, sensitive or staff-only for a trigger type; properties in conditions and `update_lead` through `catalog.filterable(type)` / `forType(type)` (editable only for update); a `{prop:}` in a task title unknown, hidden or sensitive; `plan_unavailable` (P16); `member_unavailable` for any `actorId` (assign, task `member`, notify, `assignee is`) not in `memberIds`. `ref` is the key or id at fault. `overlappingEmailFlows`: two or more flows that are on, each with a `send_email` before any `wait` on the path from the top (an if/else branch counts, since either branch may run), on the same `lead_submitted` type or the same `stage_entered` type and stage, a `lead_submitted` flow also counting as the `stage_entered` of `submittedLeadStage(type)` (R4); message `Customers get <n> emails when <event in words>: <name>, <name>.` with the event words `a SIM order moves to Delivered` (`a <type label in lower case> moves to <stage label>`) and `a SIM order is submitted`.

- [ ] **Step 1: Write the failing tests** (`automation-flows.test.ts`): `each built-in default parses and keeps phase 4's trigger and template` (for all six: `flowDefinitionSchemaFor('builtin')` parses, `trigger` equals `BUILT_IN_AUTOMATIONS[i].trigger` plus `when: null`, one step `{ id: 'main', kind: 'send_email', template }`); `a full custom flow round-trips` (stage_entered sim_order/verified with a `when` group, if_else with a nested wait and send, create_task, assign, update_lead stage, notify) unchanged through both schemas; refusals, each one test: duplicate step id, `main` in a custom flow, a step after an if_else, a stage of another type, `stage_entered` on `incomplete`, a plan condition on `contact_message`, `assignee: { op: 'none', actorId }`, `tracking_code`, 31 steps, branch depth 4, 6 waits, a 61-day wait, two 50-day waits on one path (but 50 + 50 in two branches passes), 721 hours, a group of 11, a third group level, 31 conditions, an 81-character name in no schema (names are API), a 65 537-byte definition, `{frist name}` in a task title (`invalid_variable`); `the draft takes nulls the definition refuses` (`{ schemaVersion: 1, trigger: null, steps: [] }` and a send step with `template: null` parse as a draft, not as a definition); `checkFlowAgainstSite reports each issue with its key` (one fixture per code, `ref` the key; a sensitive property in a condition and in a `{prop:}` title → `property_unavailable`; a staff-only property used by a sent site-made template → `property_unavailable`; an archived `tpl_` → `template_unavailable`; a clean site → `[]`); `overlappingEmailFlows warns once per event, naming both` (built-in dispatched + custom "My dispatch note" on delivered → `Customers get 2 emails when a SIM order moves to Delivered: Dispatched email, My dispatch note.`, using each flow's `name`; one off → none; a send after a wait → none; a `lead_submitted` sim_order flow + a `stage_entered` sim_order/pending flow → one warning); `timerDueAt` (time_in_stage 3 days from `2026-11-02T15:00:00Z` → `2026-11-05T15:00:00Z`; task_overdue due day `2026-11-03`, after null → `2026-11-04T05:00:00.000Z` (EST), after 2 hours → `07:00`; a due day `2026-03-08` crosses DST → `2026-03-09T04:00:00.000Z`); `generateFlowKey` matches `CUSTOM_FLOW_KEY_PATTERN` and `AUTOMATION_KEY_SHAPE` 100 times; every `AUTOMATION_REASONS` value matches `AUTOMATION_REASON_SHAPE`; `triggerMatchesEvent` and `flowHasLeadChangingStep` cases.
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- automation-flows` → FAIL.
- [ ] **Step 3: Implement** both files; `automations.ts` re-exports the keys so every current import of `BUILT_IN_AUTOMATION_KEYS`, `automationKeySchema` and `AutomationKey` still resolves.
- [ ] **Step 4: Run** the contracts suite and `pnpm run typecheck` → PASS (the widened `AutomationKey` must not break a consumer; fix any that does by widening its parameter, nothing else).
- [ ] **Step 5: Commit** — `feat(contracts): automation flow definition, limits, built-in defaults and site check`

---

### Task 2: Contracts: the API shapes, email vocabulary and their consumers

Batch 1. Model: hard.

**Files:**

- Create: `packages/contracts/src/automation-api.ts`, `packages/contracts/src/automation-api.test.ts`
- Modify: `packages/contracts/src/customer-email.ts`, `customer-email.test.ts`, `lead-work.ts`, `common.ts`, `endpoints.ts`, `client.ts`, `client.test.ts`, `index.ts`; `apps/backend/src/http/domain-errors.ts` (messages); the consumers typecheck names, at least `apps/backend/src/automations/run.ts` (`flowName`, `templateName` on `emailSkipped`), `apps/admin/src/components/leads/stage-move-dialog.tsx` and `lead-timeline.tsx` (labels through `emailTemplateLabel`)
- Regenerate: `docs/api/openapi.json`

**Interfaces (Produces):**

```ts
// customer-email.ts
export const SITE_TEMPLATE_KEY_PATTERN = /^tpl_[a-z0-9]{16}$/;
export const siteTemplateKeySchema; export const emailTemplateKeySchema = z.union([customerEmailTemplateSchema, siteTemplateKeySchema]); export type EmailTemplateKey;
export function generateTemplateKey(): string;
export const EMAIL_TEMPLATE_MAX_SITE_MADE = 50;
// EMAIL_FILL_IN_KEYS gains 'order number' (hint "The order number, such as MS-1042", every order template)
export function fillInsForTemplate(template: EmailTemplateKey): readonly EmailFillInKey[]; // a tpl_ key: every key but 'code'
export const PROPERTY_FILL_IN_PREFIX = 'prop:';
export const emailFillInNameSchema; export type EmailFillInName = EmailFillInKey | `prop:${string}`; // 'prop:' + propertyKeySchema
export function emailTemplateLabel(key: string, name?: string | null): string; // built-in label, else the name, else 'Site email'
export const siteEmailTemplateSchema = emailTemplateSchema.extend({ key: emailTemplateKeySchema, name: z.string().min(1).max(80), archived: z.boolean(), usedBy: z.array(z.object({ key: automationKeySchema, name: z.string() })).max(AUTOMATION_MAX_FLOWS) });
export const listSiteEmailTemplatesResponseSchema = z.object({ templates: z.array(siteEmailTemplateSchema).max(9 + 2 * EMAIL_TEMPLATE_MAX_SITE_MADE), requestId });
export const createEmailTemplateRequestSchema = z.object({ name: z.string().trim().min(1).max(80), subject: emailSubjectSchema, body: emailBodySchema }).strict();
export const siteEmailTemplateResponseSchema = z.object({ template: siteEmailTemplateSchema, requestId });
// customerEmailJobPayloadSchema.template becomes emailTemplateKeySchema
export const STAFF_NOTIFICATION_JOB_TYPE = 'staff_notification_email';
export const staffNotificationJobPayloadSchema = z.object({ actorId: z.uuid(), flowKey: automationKeySchema, flowName: z.string().min(1).max(80), siteName: z.string().min(1).max(100), leadId: z.uuid(), leadPath: z.string().regex(/^\/w\/[a-z0-9-]{1,64}\/leads\/[0-9a-f-]{36}$/), note: z.string().max(300) }).strict();
// lead-work.ts
emailSkippedSchema = { automation: automationKeySchema, flowName: string 1..80, template: emailTemplateKeySchema, templateName: string 1..80, reason: z.enum(['no_sender','no_customer_email','missing_fill_in','compose_failed']), missing?: emailFillInNameSchema[] };
updateWorkspaceLeadResponseSchema.emailSkipped .max(200) (and changeDecision's stays as is);
activityBase gains automation?: automationKeySchema, automationName?: string 1..80; the system entry's template → emailTemplateKeySchema, templateName?: string 1..80 (its own `automation` moves to the base);
// common.ts domainErrorCodeSchema adds: automation_limit_reached, revision_conflict, flow_invalid, no_active_version, automation_not_builtin, automation_builtin, activation_needs_lead_manage, automation_version_not_found, automation_run_not_found, automation_archived, email_template_not_found, email_template_builtin, email_template_limit_reached
// automation-api.ts
export const flowSummarySchema = z.object({ key: automationKeySchema, origin: z.enum(['builtin', 'custom']), name: z.string().min(1).max(80), description: z.string().max(500).nullable(), enabled: z.boolean(), archived: z.boolean(), trigger: flowTriggerSchema.nullable(), activeVersion: z.int().positive().nullable(), hasDraft: z.boolean(), lastRunAt: isoDateTimeSchema.nullable(), runCount: z.int().min(0), needsAttention: flowIssueSchema.nullable() });
export const flowListQuerySchema = z.object({ archived: z.enum(['1']).optional() }).strict();
export const flowListResponseSchema = z.object({ automations: z.array(flowSummarySchema).max(200), warnings: z.array(flowOverlapWarningSchema).max(100), canManage: z.boolean(), hasSender: z.boolean(), limit: z.literal(AUTOMATION_MAX_FLOWS), requestId });
export const createFlowRequestSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).optional() }).strict();
export const flowVersionSummarySchema = z.object({ version: z.int().positive(), status: z.enum(AUTOMATION_VERSION_STATUSES), activatedAt: isoDateTimeSchema.nullable(), activatedBy: z.uuid().nullable() });
export const flowDetailResponseSchema = z.object({ automation: flowSummarySchema, revision: z.int().min(0), draft: z.object({ version: z.int().positive(), definition: flowDraftSchema, issues: z.array(flowIssueSchema) }).nullable(), active: z.object({ version: z.int().positive(), definition: flowDefinitionSchema }).nullable(), versions: z.array(flowVersionSummarySchema).max(500), canManage: z.boolean(), requestId });
export const updateFlowDetailsRequestSchema = z.object({ expectedRevision: z.int().min(0), name: …optional, description: z.string().trim().max(500).nullable().optional() }).strict();
export const toggleFlowRequestSchema = z.object({ enabled: z.boolean() }).strict();
export const flowToggleResponseSchema = z.object({ automation: flowSummarySchema, requestId });
export const saveFlowDraftRequestSchema = z.object({ expectedRevision: z.int().min(0), definition: flowDraftSchema }).strict();
export const activateFlowRequestSchema = z.object({ expectedRevision: z.int().min(0) }).strict();
export const flowVersionResponseSchema = z.object({ version: flowVersionSummarySchema.extend({ definition: z.unknown() }), requestId }); // a stored definition is shown as stored
export const flowStepRunSchema = z.object({ stepId: z.string(), stepKind: z.enum(FLOW_STEP_KINDS), outcome: z.enum(AUTOMATION_STEP_OUTCOMES), branch: z.enum(['yes', 'no']).nullable(), reason: automationReasonSchema.nullable(), detail: z.string().max(200).nullable(), at: isoDateTimeSchema });
export const flowRunSchema = z.object({ id: z.uuid(), leadId: z.uuid(), leadName: z.string().nullable(), status: z.enum(AUTOMATION_RUN_STATUSES), reason: automationReasonSchema.nullable(), detail: z.string().max(200).nullable(), triggerKind: z.enum(FLOW_TRIGGER_KINDS).nullable(), version: z.int().positive().nullable(), startedAt: isoDateTimeSchema, finishedAt: isoDateTimeSchema.nullable(), resumeAt: isoDateTimeSchema.nullable(), legacy: z.boolean(), steps: z.array(flowStepRunSchema).max(200) });
export const listFlowRunsQuerySchema = z.object({ before: z.uuid().optional() }).strict();
export const listFlowRunsResponseSchema = z.object({ runs: z.array(flowRunSchema).max(AUTOMATION_RUN_PAGE), nextBefore: z.uuid().nullable(), requestId });
export const flowRunResponseSchema = z.object({ run: flowRunSchema, requestId });
export const flowCatalogResponseSchema = z.object({ leadTypes: [{ key, label, stages: [{ key, label }] }], templates: [{ key: emailTemplateKeySchema, name, builtIn: boolean, archived: boolean, fillIns: emailFillInNameSchema[] }], members: [{ actorId: uuid, displayName: string nullable }], plans: [{ id, name, leadType, active }], properties: [{ key, label, kind, options?, leadTypes: string[], condition: boolean, update: boolean, taskVariable: boolean, emailVariable: boolean }], taskVariables: string[], requestId });
```

New endpoints (registry and client, operationIds and client method names equal): `createAutomation` POST `/automations` (201, `flowDetailResponseSchema`); `getAutomationCatalog` GET `/automations/catalog`; `getAutomation` GET `/automations/{key}`; `updateAutomationDetails` PATCH `/automations/{key}`; `saveAutomationDraft` PUT `/automations/{key}/draft`; `discardAutomationDraft` POST `/automations/{key}/draft/discard`; `activateAutomation` POST `/automations/{key}/activate`; `resetAutomation` POST `/automations/{key}/reset`; `archiveAutomation` / `restoreAutomation` POST `/automations/{key}/archive` | `/restore`; `getAutomationVersion` GET `/automations/{key}/versions/{version}`; `getAutomationRun` GET `/automations/{key}/runs/{runId}`; `createEmailTemplate` POST `/email/templates` (201); `archiveEmailTemplate` / `restoreEmailTemplate` POST `/email/templates/{key}/archive` | `/restore`. Every flow mutation answers `flowDetailResponseSchema`; template ones `siteEmailTemplateResponseSchema`. All under `/api/v1/staff/workspaces/{workspaceId}`, auth `staff`. The existing `listAutomations`, `updateAutomation`, `listAutomationRuns`, `listEmailTemplates` are untouched (P1).

- [ ] **Step 1: Write the failing tests.** `automation-api.test.ts`: every response round-trips a full example; `flowListResponseSchema` takes 7 flows (no `.length(6)`); `createFlowRequestSchema` trims and refuses an 81-character name and an extra key; `saveFlowDraftRequestSchema` takes the empty draft (P10); `flowRunSchema` refuses an unknown reason and an unknown status. `customer-email.test.ts`: `fillInsForTemplate('tpl_abcdefghij012345')` is every key but `code`; `order number` is allowed in every order template and not in `tracking_code`; `generateTemplateKey` matches its pattern 100 times; `emailTemplateLabel('dispatched')` is `Dispatched`, `emailTemplateLabel('tpl_…', 'My note')` is `My note`; `staffNotificationJobPayloadSchema` refuses a `leadPath` with `..`; `customerEmailJobPayloadSchema` takes a `tpl_` key. `client.test.ts`: each new method issues its method and path (`activateAutomation(ws, 'flow_…', { expectedRevision: 3 })` → `POST …/automations/flow_…/activate`). The OpenAPI test stays green.
- [ ] **Step 2: Run** `pnpm --filter @gt-sales/contracts test -- automation-api customer-email client openapi` → FAIL.
- [ ] **Step 3: Implement**, add the domain error messages (`automation_limit_reached`: "This site already has 50 flows. Archive one first."; `revision_conflict`: "Someone else changed this flow. Reload to see their changes."; `flow_invalid`: "The flow is not ready to be activated."; `no_active_version`: "Activate the flow before switching it on."; `activation_needs_lead_manage`: "Activating a flow that changes leads needs the Leads permission too."; the rest one plain sentence each), update the consumers typecheck names, then `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** the contracts, backend and admin unit suites and `pnpm run typecheck` → PASS; `pnpm --filter admin test:e2e:leads` still passes (no route changed).
- [ ] **Step 5: Commit** — `feat(contracts): automation flow API shapes, site-made template keys and staff notification job`

---

### Task 3: The migration pair, its paste file and the SQL tests

Batch 1. Model: hard.

**Files:**

- Modify: `packages/db/src/schema.ts` (the §4 tables and columns), `packages/db/tests/order-tools.integration.test.ts`, `customer-tracking.integration.test.ts`, `order-numbers.integration.test.ts` (each "38 read policies" → 42; order-tools' privilege, key and run assertions describe the 0020 state), `apps/backend/tests/operational-retention.integration.test.ts`
- Create: `packages/db/drizzle/0019_automation_flows.sql` (`pnpm --filter @gt-sales/db db:generate -- --name automation_flows`), `packages/db/drizzle/0020_automation_flows_runtime.sql` (`-- --custom --name automation_flows_runtime`), `docs/RUNBOOKS/manual/0019-0020-automation-flows.sql`, `packages/db/tests/automation-flows.integration.test.ts`, `apps/backend/tests/automation-sql-contracts.integration.test.ts`

**Interfaces (Produces):** the tables and columns of spec §4 with these names (drizzle exports `automationVersions`, `automationStepRuns`, `automationWaits`, `automationTimers`; new columns camelCase):

- `automations` + `origin` (default `'builtin'`), `name` (nullable, P2), `description`, `activeVersionId`, `revision` (default 0), `createdBy`, `createdAt` (default now), `archivedAt`; unique `automations_workspace_id_id_unique (workspace_id, id)`; CHECKs `automations_key_check` = `(origin = 'builtin' and key in (<six>)) or (origin = 'custom' and key ~ '^flow_[a-z0-9]{16}$')`, `automations_origin_check`, `automations_archived_check` = `archived_at is null or (origin = 'custom' and not enabled)`, `automations_name_check` (P2), `automations_description_check` (`description is null or char_length(description) <= 500`), `automations_revision_check` (`>= 0`); FK `automations_active_version_fk (workspace_id, active_version_id) → automation_versions (workspace_id, id)` (in 0020 inside a `DO` block guarded by `pg_constraint`, if drizzle-kit cannot emit the cycle).
- `automation_versions` per spec; unique `(workspace_id, id)` and `(workspace_id, automation_id, version)`; partial uniques `automation_versions_one_draft` / `_one_active`; FK to automations cascade; CHECKs status, `version > 0`, `schema_version = 1`, `jsonb_typeof(definition) = 'object' and octet_length(definition::text) <= 65536`, `(status in ('active','retired')) = (activated_at is not null)`, `(status = 'retired') = (retired_at is not null)`.
- `automation_runs`: `outcome` nullable; + `automationId`, `versionId`, `status` (default `'completed'`), `occurrence`, `triggerKind`, `depth` (default 0), `parentRunId` (no FK, P6), `detail`, `updatedAt`, `finishedAt`; unique `automation_runs_workspace_id_id_unique`; CHECKs as spec §4 plus `automation_runs_depth_check` (0–3), `automation_runs_trigger_kind_check`, `automation_runs_occurrence_check` / `_detail_check` (≤ 200); unique index `automation_runs_occurrence_unique`; index `automation_runs_workspace_automation_created_idx (workspace_id, automation_id, created_at desc)`; FKs `automation_id` → automations cascade, `version_id` → versions.
- `automation_step_runs`, `automation_waits`, `automation_timers` per spec, each with `tenantPolicy`, `backupReadPolicy`; waits FK `(workspace_id, run_id)` → runs cascade, `run_id` unique; timers unique `(workspace_id, automation_id, lead_id, occurrence)`; CHECKs: step id pattern, kinds, outcomes, `branch is null or branch in ('yes','no')`, reason shape, detail ≤ 200, `attempts between 0 and 5`, `(trigger_kind = 'task_overdue') = (subject_id is not null)`, `(trigger_kind = 'time_in_stage') = (stage is not null)`.
- `email_templates` / `email_template_versions` key CHECKs `key in (<nine>) or key ~ '^tpl_[a-z0-9]{16}$'`; `email_templates` + `name`, `archivedAt`, CHECKs `email_templates_name_check` (`(key ~ '^tpl_') = (name is not null)` and 1–80 trimmed) and `email_templates_archived_check` (`archived_at is null or key ~ '^tpl_'`).
- `memberships` + `notificationEmail`, CHECK `notification_email is null or (char_length(notification_email) <= 254 and notification_email ~ <emailAddressPattern>)`.
- 0020 (every statement safe to run twice): FORCE RLS on the four tables; grants (Global Constraints, no DELETE); `app.guard_automation_version_definition()` + `BEFORE UPDATE` trigger `automation_versions_definition_guard` raising `automation_version_immutable` (SQLSTATE `23514`) when `definition` changes and `OLD.status <> 'draft'`; `app.builtin_flow_definition(p_key text) RETURNS jsonb LANGUAGE sql IMMUTABLE` (P4); `app.record_staff_notification_email(p_verified_email text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''` (P3: `lower(btrim(...))`, only the `app.actor_id` user's `staff`/`active` memberships whose address is distinct; returns rows changed; `REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO app_runtime`); the backfill of spec §6 guarded by `is null` (names from the six labels as SQL literals; version 1 `active`, `activated_by` null, `created_by` = the row's `updated_by`, definition from `app.builtin_flow_definition`; `active_version_id`; runs: `automation_id` by key, `status` = `completed` for `queued` / `skipped` for `skipped`, `version_id`, `finished_at = created_at`, `occurrence = split_part(j.dedupe_key, ':', 3)` joined on the still-existing job); and, last, `CREATE OR REPLACE FUNCTION app.prune_operational_rows` = 0018's body with the automation-runs block `status <> 'waiting' and coalesce(finished_at, created_at) < p_now - interval '90 days'`, plus `automation_timers` with `status in ('fired','void') and updated_at < p_now - interval '90 days'` (returned as `automation_timers`), comment **OWNER PASTE**.
- The paste file in the 0017–0018 file's form: header (why, order of work, each file's `sha256sum` and journal `when`, the deploy-window note "do not switch automation rules between applying this and the new backend going live" and "the old admin's Automations page may show its load error until the admin deploys"); **A** pre-check (`to_regclass` of the four tables null, `automations.origin` absent, tracker rows 0); `BEGIN` … 0019 and 0020 verbatim (breakpoints removed) … the two `drizzle.__drizzle_migrations` rows and the two `supabase_migrations.schema_migrations` rows … `COMMIT`; the prune replacement repeated in a section marked **OWNER PASTE** for the case where the plain statements go through the Supabase tool; verification selects one at a time (four tables FORCE RLS; 42 backup read policies; `has_table_privilege` per table and privilege, DELETE false everywhere; the replaced CHECK definitions; the trigger present; `prosrc` of the prune names `automation_timers` and `status <> 'waiting'`; the three new functions present and `prosecdef` for the notification one; the tracker rows).

- [ ] **Step 1: Write the failing tests.** `automation-flows.integration.test.ts` (sites `…8101`, `…8102`; actor `…8111`): `the four tables have RLS enabled and forced, two policies each, and 42 read policies in all`; `app_runtime may select, insert and update versions, waits, timers and runs, insert step runs, and never delete; backup_reader reads all four`; `a row of each new table is visible and writable only inside its site`; `an active version's definition cannot change, its status can` (update of a draft's definition passes, of an active one fails `23514`, status `active → retired` with `retired_at` passes); `one draft and one active version per flow`; `automations keys follow their origin; an archived flow is custom and off; a custom flow has a name; a built-in may have none`; `runs: legacy outcomes keep their checks, new runs need none; status, depth 0 to 3 and the occurrence index` (two runs with the same key, lead and occurrence → `23505`; null occurrences repeat freely; `depth 4` → `23514`; `waiting` with `finished_at` → `23514`); `email templates take tpl_ keys with a name, built-ins without, and archive only tpl_`; `memberships take a plain notification address or none`; `record_staff_notification_email sets the caller's active memberships only, once` (two sites active + one revoked: returns 2, then 0 for the same address, 2 for a new one; another actor's row untouched; called with no actor → error); `0020's statements re-run cleanly`; `0020 backfills legacy-shaped rows once` (after migration, insert as admin an `automations` row `sim_order_dispatched` enabled with `name` null and no version, a queued run with a job whose dedupe key is `<lead>:sim_order_dispatched:<uuid>` and a skipped `no_sender` run; run 0020's statements: the row has its label, version 1 active equal to `app.builtin_flow_definition('sim_order_dispatched')` and `active_version_id`; the queued run is `completed` with the occurrence `<uuid>`, the skipped one `skipped`, both with `finished_at = created_at` and `version_id`; a second run changes nothing (row counts and `updated_at`s equal)); `the prune keeps waiting runs, drops finished runs with their steps and waits after 90 days, and old fired and void timers` (`operational-retention.integration.test.ts` extended likewise). `automation-sql-contracts.integration.test.ts` (no rows needed; reads `pg_constraint` with `pg_get_constraintdef`): the built-in key list inside `automations_key_check` equals `BUILT_IN_AUTOMATION_KEYS`; the template lists in both template key checks equal `CUSTOMER_EMAIL_TEMPLATES`; the custom flow and template regexes in the checks equal `CUSTOM_FLOW_KEY_PATTERN.source` and `SITE_TEMPLATE_KEY_PATTERN.source`; `automation_runs_reason_check` and `automation_step_runs_reason_check` carry `AUTOMATION_REASON_SHAPE.source` and every `AUTOMATION_REASONS` value matches it; the run status, step outcome, step kind, version status, wait status, timer status and timer kind lists equal their contracts enums; for each built-in key `select app.builtin_flow_definition(key)` parses with `flowDefinitionSchemaFor('builtin')` and deep-equals `builtInFlowDefinition(key)`.
- [ ] **Step 2: Run** `ENV(1) pnpm --filter @gt-sales/db test -- automation-flows` and `ENV(1) pnpm --filter backend test -- automation-sql-contracts` → FAIL.
- [ ] **Step 3: Implement** `schema.ts`, generate 0019, write 0020 and the paste file (compute the hashes after the files are final). Update the existing db tests named above.
- [ ] **Step 4: Rehearse the paste file** on a database migrated to 0018: `git -C /home/user/crm-wt/t1 worktree add /tmp/p8-0018 origin/main`, migrate `gt_sales_paste_test` from it, insert the legacy rows of the backfill test, run section A, `BEGIN … COMMIT` with `psql -v ON_ERROR_STOP=1`, then every verification select → the values in its comment; remove the temporary worktree.
- [ ] **Step 5: Run** `ENV(1) pnpm run test` (db and backend suites), typecheck, lint, format → PASS. The old engine still fires on the migrated schema (`automatic-emails.integration.test.ts` green).
- [ ] **Step 6: Commit** — `feat(db): automation flows tables, conversion of the built-ins and their paste file (0019, 0020)`

---

### Task 4: The email language for flows and the shared backend modules

Batch 1. Model: hard.

**Files:**

- Modify: `apps/backend/src/email/markup.ts`, `layout.ts`, `fill-in-values.ts`, `compose.ts`, `settings-store.ts` (`readEmailTemplate` only), `apps/backend/src/automations/run.ts` (`automationLeadOf` / `readAutomationLead` gain the new lead fields)
- Create: `apps/backend/src/automations/site.ts`, `apps/backend/src/automations/records.ts`
- Test: `apps/backend/tests/email-markup.test.ts`, `email-compose.integration.test.ts` (extend), `apps/backend/tests/automation-records.integration.test.ts` (sites `…8291`, `…8292`)

**Interfaces:**

- Consumes: Task 1 (`FlowSite`, `FlowSiteTemplate`, `FlowStepKind`, enums, `AutomationReason`), Task 2 (`EmailTemplateKey`, `EmailFillInName`, `fillInsForTemplate`), Task 3 tables.
- Produces:

```ts
// markup.ts — every parse takes any EmailTemplateKey; `{order number}`; `{prop:<key>}` only in a tpl_ template
export interface MarkupOptions { /** Save-time check of a `{prop:…}` (true = usable in a customer email); absent at render time. */ property?: (key: string) => boolean }
export function parseEmailBody(text: string, template: EmailTemplateKey, options?: MarkupOptions): …; // existing result shape, `invalid_fill_in` names the typed text
export function parseEmailSubject(text: string, template: EmailTemplateKey, options?: MarkupOptions): …;
export function templatePropertyKeys(subject: string, body: string): string[]; // the `{prop:…}` keys, sorted, unique; [] when it does not parse
// layout.ts
export type FillInValues = Partial<Record<EmailFillInKey, string>> & { readonly props?: Readonly<Record<string, string>> };
export function renderCustomerEmail(input: { template: EmailTemplateKey; … }): RenderedEmail; // `missing` becomes EmailFillInName[]
// fill-in-values.ts
export interface FillInLead { leadType: string; fullName: string | null; externalRef: string | null; form: Readonly<Record<string, unknown>>; customValues: Readonly<Record<string, unknown>>; order: LeadOrder | null }
export type PropertyAudience = 'customer' | 'staff';
/** A property's value as the record page shows it, or undefined when absent or not usable by `audience` (hidden, sensitive, or staff-only for a customer). */
export function leadPropertyText(lead: FillInLead, catalog: PropertyCatalog, key: string, audience: PropertyAudience): string | undefined;
export function fillInValuesForLead(lead: FillInLead, site: { siteName: string; siteUrl: string | null }, options?: { catalog: PropertyCatalog; propertyKeys: readonly string[] }): FillInValues; // 'order number' = externalRef
// compose.ts
export type ComposeOutcome = { kind: 'ready'; payload; templateName: string } | { kind: 'skipped'; reason: 'no_sender' | 'no_customer_email' | 'missing_fill_in' | 'template_unavailable'; missing?: EmailFillInName[] };
export function composeCustomerEmail(tx, environment, input: { workspaceId: string; template: EmailTemplateKey; recipient: ComposeRecipient; catalog?: PropertyCatalog }): Promise<ComposeOutcome>;
// settings-store.ts
export interface StoredEmailTemplate { key: EmailTemplateKey; name: string | null; archived: boolean; subject; body; version; updatedAt; updatedBy }
export function readEmailTemplate(tx, workspaceId: string, key: EmailTemplateKey): Promise<StoredEmailTemplate | undefined>; // undefined only for a tpl_ key with no row or an archived row
// automations/site.ts
export async function loadFlowSite(tx: TenantTransaction, workspaceId: string, catalog?: PropertyCatalog): Promise<FlowSite>; // the nine built-ins (archived false, propertyKeys []), every tpl_ row with `archived` and templatePropertyKeys, active staff member actor ids, every plan's id and type, the catalogue (loadPropertyCatalog when not given)
// automations/records.ts
export interface StepRunRecord { runId: string; stepId: string; stepKind: FlowStepKind; outcome: AutomationStepOutcome; branch?: 'yes' | 'no'; reason?: AutomationReason; detail?: string; jobId?: string; taskId?: string }
export async function insertStepRun(tx, workspaceId: string, record: StepRunRecord): Promise<void>; // throws StepRunShapeError when a done send_email has no jobId, a done create_task no taskId, a branch on a non-if_else, a detail over 200
export async function finishRun(tx, workspaceId: string, runId: string, end: { status: 'completed' | 'skipped' | 'failed' | 'cancelled'; reason?: AutomationReason; detail?: string }): Promise<void>; // sets finished_at, updated_at
export async function cancelWaitingRun(tx, workspaceId: string, input: { runId: string; reason: AutomationReason; detail?: string }): Promise<boolean>; // P25; false when the wait was not pending or is locked (SKIP LOCKED)
export async function cancelFlowWork(tx, workspaceId: string, automationId: string, reason: 'flow_switched_off'): Promise<{ cancelledRuns: number; voidedTimers: number }>; // P7: SKIP LOCKED
/** Keys, ids and fill-in names only, joined by `,` and cut to 200 characters. */
export function detailOf(parts: readonly string[]): string;
```

- [ ] **Step 1: Write the failing tests.** `email-markup.test.ts`: `{order number}` parses in `dispatched` and is refused in `tracking_code`; `{prop:custom_size}` is refused in `dispatched` and accepted in a `tpl_` template; with `options.property` returning false it is `invalid_fill_in` naming `prop:custom_size`; `templatePropertyKeys` sorts and dedupes. `email-compose.integration.test.ts`: a `tpl_` template renders a custom property's formatted value (money `$40.00`, yes/no `Yes`, a choice's label) and `{order number}` as `MS-1042`; a property marked sensitive or staff-only after the template was saved is never rendered and the mail is skipped `missing_fill_in` with `missing: ['prop:custom_size']`; an archived or unknown `tpl_` key is `template_unavailable`; a built-in template still composes exactly as before (the existing assertions unchanged); `templateName` is the label or the name. `automation-records.integration.test.ts`: `insertStepRun` refuses a done send without a job and a 201-character detail before any SQL; `cancelFlowWork` cancels the flow's pending waits and their runs (status `cancelled`, reason `flow_switched_off`, a `cancelled` step row for the wait step), voids its pending timers, leaves another flow's alone, and skips a wait another connection holds `FOR UPDATE` (returns 0 for it, the row unchanged); `loadFlowSite` lists the nine built-ins, a `tpl_` row's archived flag and property keys, active members only, and every plan with its type.
- [ ] **Step 2: Run** `pnpm --filter backend test -- email-markup` and `ENV(1) pnpm --filter backend test -- email-compose automation-records` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite with `ENV(1)`, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): order number and property fill-ins, site-made templates in compose, flow site snapshot and run records`

**Batch 1 review, then merge `p8/t1` into `phase-8-automations`; Batches 2 and 3 branch from it.**

---

## Batch 2: the engine (after Batch 1, in parallel with Batch 3)

### Task 5: The engine: firing in the transaction, conditions, email, if/else and wait

Batch 2. Model: hard.

**Files:**

- Create: `apps/backend/src/automations/engine.ts`, `apps/backend/src/automations/conditions.ts`, `apps/backend/src/automations/actions.ts` (the step executors; this task's three)
- Modify: `apps/backend/src/automations/run.ts` (remove `runAutomations`, keep `automationLeadOf` and `readAutomationLead`), `apps/backend/src/leads/store.ts` (submissions fire `lead_submitted` then the R4 stage entry; `recordSubmittedMove` returns its activity id), `apps/backend/src/leads/work-store.ts` (moves fire through the engine; `LeadUpdateContext = { emailEnvironment: CustomerEmailEnvironment }`; the constructors lose the `AutomationStore` argument), `apps/backend/src/leads/staff-queries.ts` (export `propertyFilterCondition` and `resolvePropertyFor`), `apps/backend/src/email/queue.ts` (`automation: { key: AutomationKey; name: string } | null`; writes `automation`, `automationName`, and for a `tpl_` template `templateName`, into the `customer_emailed` entry), `apps/backend/src/tracking/change-requests.ts`, `apps/backend/src/routes/tracking.ts` (the context)
- Test: `apps/backend/tests/automation-engine.integration.test.ts` (sites `…8301`–`…8305`), `apps/backend/tests/automation-conditions.integration.test.ts` (`…8306`), `apps/backend/tests/automatic-emails.integration.test.ts` (rewritten onto flows: the six built-ins behave as before)

**Interfaces:**

- Consumes: Tasks 1, 2, 4 (`loadFlowSite`, `insertStepRun`, `finishRun`, `composeCustomerEmail`, `fillInValuesForLead`); `propertyFilterCondition`.
- Produces:

```ts
// engine.ts
export interface FlowEvent {
  kind: 'lead_submitted' | 'stage_entered';
  leadId: string;
  leadType: string;
  stage: string;
  occurrence: string;
  depth: number;
  chain: readonly string[];
  parentRunId: string | null;
  at: Date;
}
export interface FireFlowsContext {
  workspaceId: string;
  actorId: string;
  requestId: string;
  environment: CustomerEmailEnvironment;
  catalog?: PropertyCatalog;
  /** P24, tests only. */ afterFlowsRead?: () => Promise<void>;
}
export interface FireFlowsResult {
  skipped: EmailSkipped[];
  activities: LeadActivity[];
}
/** Every live flow each event triggers, in order; never throws for a flow's sake. */
export function fireFlows(
  tx: TenantTransaction,
  context: FireFlowsContext,
  events: readonly FlowEvent[],
): Promise<FireFlowsResult>;
export interface LiveFlow {
  id: string;
  key: AutomationKey;
  name: string;
  origin: 'builtin' | 'custom';
  versionId: string;
  version: number;
  activatedBy: string | null;
  definition: unknown;
}
export function readLiveFlows(tx: TenantTransaction, workspaceId: string): Promise<LiveFlow[]>; // one statement: enabled, not archived, joined on active_version_id, ordered as Global Constraints
export interface RunState {
  id: string;
  flow: LiveFlow;
  definition: FlowDefinition;
  occurrence: string;
  depth: number;
  chain: readonly string[];
  triggerKind: FlowTrigger['kind'];
}
/** Runs `steps` from `path` (`[]` = the top), recording each; stops at a wait or the end. T8 calls it to resume. */
export function runSteps(
  tx,
  context: FireFlowsContext,
  run: RunState,
  startAt: readonly number[],
): Promise<FireFlowsResult & { ended: 'completed' | 'waiting' | 'failed' }>;
// conditions.ts
/** One statement on the lead row; property conditions mean exactly what the same inbox filter means. */
export function evaluateConditionGroup(
  tx,
  input: {
    workspaceId: string;
    leadId: string;
    leadType: string;
    group: ConditionGroup;
    catalog: PropertyCatalog;
  },
): Promise<boolean>;
export function conditionGroupSql(
  group: ConditionGroup,
  leadType: string,
  catalog: PropertyCatalog,
): SQL; // plan: order_details->'plan'->>'id', else ->>'planId'; stage and assignee from the columns
// actions.ts
export interface StepContext {
  tx: TenantTransaction;
  fire: FireFlowsContext;
  run: RunState;
  lead: AutomationLead;
  site: FlowSite;
}
export interface StepResult {
  outcome: AutomationStepOutcome;
  reason?: AutomationReason;
  detail?: string;
  jobId?: string;
  taskId?: string;
  branch?: 'yes' | 'no';
  emailSkipped?: EmailSkipped;
  activities?: LeadActivity[];
  nested?: FireFlowsResult;
}
export function sendEmailStep(
  ctx: StepContext,
  step: Extract<FlowStep, { kind: 'send_email' }>,
): Promise<StepResult>;
```

The per-flow algorithm (spec §5 steps 1–5) in one savepoint per flow: match (`triggerMatchesEvent`; an unsubmitted lead fires nothing; then `when` through `evaluateConditionGroup`) → no match, nothing recorded; loop guard (P5, P6): the flow's key in `event.chain` → run `skipped` `loop_prevented`; parse the stored definition with `flowDefinitionSchemaFor(origin)` (failure → `skipped` `definition_invalid`) and `checkFlowAgainstSite` against the lazily loaded site (P23; an issue → `skipped` with the first issue's code and `detail` its `ref`); insert the run `status = 'completed'`, occurrence, `trigger_kind`, depth, `parent_run_id`, `on conflict do nothing` on `automation_runs_occurrence_unique` (no row → stop: it already ran); bump `run_count` and `last_run_at`; `runSteps`; `finishRun` unless waiting. Steps: each in its own savepoint; a throw → step `failed` (`compose_failed` for send, else `step_failed`), run `failed`. `send_email` composes from the lead as stored now (`readAutomationLead` per step) with the site catalogue, dedupe per Global Constraints, a dedupe hit → `skipped` `already_sent`; skips collect into `emailSkipped` (P9). `if_else` records `done` with the branch and descends. `wait` records `waiting`, inserts the `automation_waits` row (`resume_at = now + for`), sets the run `waiting`, stops. Submissions (website create and draft submit): events `[lead_submitted(occurrence 'submitted'), stage_entered(submittedLeadStage, occurrence = the submitted activity id or 'submitted:stage')]`, actor the website credential; a move: `[stage_entered(occurrence = status_change id)]`, actor the staff member. `emailSkipped` and `activities` of the move response come from `fireFlows` (P22).

- [ ] **Step 1: Write the failing tests.** `automatic-emails.integration.test.ts` keeps every phase 4 assertion, now with the built-ins seeded the way `ensureBuiltInFlows` will seed them (insert the row and version 1 through the admin connection with `app.builtin_flow_definition`): off → no job, no run; on → one job with dedupe `<lead>:sim_order_dispatched:<status_change id>`, one run `completed` with one step row `main` `done` and its `job_id`; no sender → run `completed`, step `skipped` `no_sender`, `emailSkipped` item with `flowName` and `templateName`; a missing fill-in → `detail` the fill-in names and `missing` on `emailSkipped`; `fireFlows on a lead that is still incomplete records nothing` (called directly with both event kinds; staff moves of such a lead are Task 6's rescue). `automation-engine.integration.test.ts`: `a built-in and a custom flow on one move send two mails, once` (Review Focus 1: two jobs, keys `<lead>:sim_order_dispatched:<occ>` and `<lead>:<flow key>:<occ>:s_mail0001`, two runs; firing the same events again → still two jobs, two runs); `a flow whose when does not hold records nothing`; `nested branches take the branch the condition picks and record it`; `a wait stores its resume time and leaves the run waiting` (run `waiting`, `finished_at` null, a `waiting` step row, an `automation_waits` row `pending` at now + 2 days ± 1 s); `a flow naming a stage or template that is gone is skipped whole, with the key` (Review Focus 2: an active version naming `sim_order` stage `paid` written as admin, and one sending an archived `tpl_`: the move commits, runs `skipped` `stage_unavailable` / `template_unavailable`, `detail` `paid` / the `tpl_` key, no job, no step rows); `a definition that no longer parses is skipped definition_invalid`; `a step that throws fails the run and leaves the move committed` (a template body made unparseable as admin → step `failed` `compose_failed`, run `failed`, the lead's stage moved); `a version activated while a move is in flight: that move runs the old version, the next the new` (Review Focus 3: `afterFlowsRead` waits on a promise while a second connection, as admin, retires v1, inserts v2 active with a different template and points `active_version_id` at it, commits; the move finishes: its run's `version_id` is v1 and its job's template v1's; the next move's run is v2); `a flow switched off mid-move still runs for that move only`; `submission flows run before the stage flows of the same submit` (run `created_at` order and ids for a `lead_submitted` flow and a `stage_entered` sim_order/pending flow on a website create; occurrences `submitted` and the system activity id); `a type that does not move on submit enters its first stage as submitted:stage` (internet); `after the conversion, replaying an occurrence the old code mailed queues nothing` (Review Focus 8: a legacy run with occurrence X and its job → firing X creates no run, no job; a job alone with dedupe `<lead>:sim_order_dispatched:Y` and no run → a run whose step is `skipped` `already_sent`, no second job); `a move's response carries what its flows wrote`. `automation-conditions.integration.test.ts`: for a table of filters (`text eq`, `number gt`, `choice in`, `empty` on a form field, a custom property and an order property) `evaluateConditionGroup` is true exactly for the leads `selectLeadPage` with `where: [filter]` returns; `plan in` reads the frozen plan's id, else `planId`; `stage not_in`, `assignee none | any | is`; `all` vs `any` and a nested group.
- [ ] **Step 2: Run** `ENV(2) pnpm --filter backend test -- automation-engine automation-conditions automatic-emails` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite with `ENV(2)` (lead-work, order-flow, tracking and change-request suites stay green), typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): automation flows fire in the move or submit transaction with conditions, email, if/else and wait`

---

### Task 6: Lead-changing steps, the loop guard and rescued checkouts

Batch 2. Model: hard.

**Files:**

- Modify: `apps/backend/src/automations/actions.ts` (`createTaskStep`, `assignLeadStep`, `updateLeadStep`), `apps/backend/src/automations/engine.ts` (nested events), `apps/backend/src/leads/work-store.ts` (`applyLeadUpdate` takes an optional `automation` attribution; the rescue; task create shares one helper with the flow step)
- Test: `apps/backend/tests/automation-actions.integration.test.ts` (sites `…8401`–`…8405`), `apps/backend/tests/rescued-checkouts.integration.test.ts` (`…8406`–`…8408`)

**Interfaces:**

- Consumes: Task 5's `StepContext`, `StepResult`, `fireFlows`; `decideAccess`; `app.staff_access_snapshot`.
- Produces:

```ts
// work-store.ts
export interface AutomationAttribution {
  key: AutomationKey;
  name: string;
  version: number;
  runId: string;
  depth: number;
  chain: readonly string[];
}
export function applyLeadUpdate(
  tx,
  context: LeadUpdateContext,
  input: UpdateLeadWorkInput & { automation?: AutomationAttribution },
): Promise<UpdateLeadWorkOutcome>; // with `automation`: entries carry automation/automationName, audit actorLabel 'automation' and after.automation { key, version, runId }; the move's flows fire at depth + 1 with chain + key; never the documents override
/** The one insert of a task, its audit and (T8) its timers; the staff route and the flow step both call it. */
export function insertLeadTask(
  tx,
  input: WriteScope & {
    leadId: string;
    title: string;
    dueAt: string | null;
    assignedActorId: string | null;
    automation?: AutomationAttribution;
  },
): Promise<{ taskId: string }>;
// actions.ts
export function createTaskStep(ctx: StepContext, step): Promise<StepResult>;
export function assignLeadStep(ctx: StepContext, step): Promise<StepResult>;
export function updateLeadStep(ctx: StepContext, step): Promise<StepResult>;
/** R5: the activator is an active member holding lead.manage now. */
export function activatorMayChangeLeads(
  tx,
  workspaceId: string,
  activatedBy: string | null,
): Promise<boolean>;
```

Step rules (spec §5 table): every step here first checks `activatorMayChangeLeads` (else `skipped` `activator_not_allowed`; a built-in with a null activator that gained such a step is skipped the same way); writes as `actorId = activatedBy` (P19). `create_task`: title rendered with `fillInValuesForLead` + `leadPropertyText(…, 'staff')`, a missing value `(none)`; due day today in Toronto + `dueInDays`, `T12:00:00.000Z`; assignee `lead_assignee` (none when unassigned), `member` (gone → `member_unavailable`), `none`; `detail` the task id, `task_id` set. `assign_lead`: owned and not `reassign` → `already_assigned`; the member gone → `member_unavailable`; else through `applyLeadUpdate` (`assignedActorId`). `update_lead`: through `applyLeadUpdate` with only `stage`, or only `customValues: { key: value }` / `form: { key: value }`; refusals map one to one to the reasons (`illegal_stage_move`, `dispatch_details_required`, `activation_details_required`, `documents_incomplete`, `invalid_field`); a stage change at depth 3 → `chain_too_deep` (P5); success records `done` and merges the nested result. The rescue (O9, O12, every lead type): a staff move (no `automation`) of a lead with `status = 'incomplete'` also sets `status = 'submitted'`, freezes the plan with `submittedOrder` when `planId` names a plan `isPlanAvailable` for the type (else unfrozen), adds a `system` `submitted` entry by the staff member, puts `status` in the audit's `before`/`after`, and fires `[lead_submitted('submitted'), stage_entered(the move's occurrence)]`.

- [ ] **Step 1: Write the failing tests.** `automation-actions.integration.test.ts`: `create_task renders variables and dues it in Toronto days` (title `Call {first name} about {order number} ({prop:custom_size})` → `Call Nadia about MS-1042 (Large)`; a lead without the size → `(Large)` becomes `((none))`; `dueInDays: 2` at `2026-11-02T03:00:00Z` (Toronto still 1 Nov) → due `2026-11-03T12:00:00.000Z`; audit `lead.task_created` with `actorLabel: 'automation'` and `after.automation.key`); `assign_lead respects an owner unless reassign`; `a chosen member who left skips member_unavailable`; `update_lead moves through the same gates staff pass` (to Delivered without a courier → `dispatch_details_required`; documents missing → `documents_incomplete`, no override even for an owner activator; a legal move → `done`, the timeline entry says `automation`/`automationName`, the stage's built-in email queued); `update_lead sets one custom property or editable form field, never a hidden one` (`invalid_field`); `an activator who lost lead.manage or left skips activator_not_allowed`; `two flows that move each other stop with loop_prevented and the move commits` (Review Focus 6); `four chained flows: the last move is skipped chain_too_deep and every move's email is queued` (A d0 → B d1 → C d2 → D d3: D's run `completed` with its stage step `skipped` `chain_too_deep`; the built-in emails of the three moves made, one job each); `a property made sensitive after use skips the run and its value appears nowhere` (Review Focus 7: a condition and a `{prop:custom_secret}` title on value `ZX-SECRET-9`; mark sensitive as admin; the move → run `skipped` `property_unavailable`, `detail` `custom_secret`; `ZX-SECRET-9` absent from `automation_runs`, `automation_step_runs`, `lead_tasks`, `outbox_jobs.payload`, `lead_activities`, `audit_events` and the captured console output). `rescued-checkouts.integration.test.ts`: `a staff move out of Incomplete submits the lead, freezes its plan and fires the submitted and stage flows` (sim_order with `planId`: `status` submitted, `order_details.plan` frozen, a `submitted` entry by the staff member, audit `status`, `order_received` job deduped `<lead>:order_received:submitted`, the stage flow's run with the move's occurrence); `the same for every lead type` (internet, mobility, partner_application, contact_message with a `lead_submitted` custom flow each: one run each, O12); `a rescued plan no longer available stays unfrozen`; `the customer's draft grant then answers draft_submitted` (O13, through `DatabaseLeadStore.updateLead`); `a second move fires no second submitted mail`; `a rescued lead counts as submitted in the source report and on the tracking list`.
- [ ] **Step 2: Run** `ENV(2) pnpm --filter backend test -- automation-actions rescued-checkouts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite with `ENV(2)`, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): flow tasks, assignment and lead updates on the activator's authority, the loop guard, and rescued checkouts`

---

### Task 7: Staff notifications and the notification address

Batch 2. Model: hard.

**Files:**

- Create: `apps/backend/src/automations/staff-notification.ts`
- Modify: `apps/backend/src/automations/actions.ts` (`notifyStaffStep`), `apps/backend/src/jobs/providers.ts` (register the handler), `apps/backend/src/staff/store.ts` (`bootstrapStaff` calls `app.record_staff_notification_email` after `accept_staff_invitations`)
- Test: `apps/backend/tests/staff-notification.integration.test.ts` (sites `…8501`–`…8503`), `apps/backend/tests/staff-notification.test.ts` (handler unit, fakes), `staff-routes.test.ts` (bootstrap still answers when the address is unchanged)

**Interfaces:**

```ts
export interface StaffNotificationEnvironment {
  ready: boolean;
  adminOrigin: string;
  sender: { fromName: string; fromAddress: string } | null;
  contactHash(address: string): string;
}
export function staffNotificationEnvironmentFromEnv(
  env?: NodeJS.ProcessEnv,
): StaffNotificationEnvironment; // ready only with EMAIL_PROVIDER resend (RESEND_FROM_NAME and RESEND_FROM_EMAIL set) or fake outside production; adminOrigin = ADMIN_ORIGIN
export function notifyStaffStep(ctx: StepContext, step): Promise<StepResult>;
export function createStaffNotificationHandler(options: {
  email: EmailAdapter;
  eligibility: EmailEligibilityChecker;
  delivery?: EmailDeliveryRecorder;
  environment: StaffNotificationEnvironment;
  database?: Pick<DatabaseClient, 'withTenantTx'>;
}): JobHandler;
```

Rules: recipients = the lead's assignee when `toAssignee` (none → nobody from it) plus `actorIds`, deduplicated; not ready → step `skipped` `no_staff_sender`; per recipient: not an active member → `member_unavailable`, no `notification_email` → `member_has_no_address` (both listed in `detail` as `<reason>:<actor id>`); one job per remaining recipient with the dedupe of the Global Constraints and the payload of P8 (`leadPath` from the site's slug); the step is `done` when at least one job was queued, else `skipped` with the first reason. The handler: payload parse; re-reads the membership (`member_unavailable` / `member_has_no_address` → completed `skipped:<reason>`), checks transactional eligibility on its contact hash, renders subject and text of the Global Constraints (HTML = the text in `<p>`s, escaped), sends with the deployment sender, records delivery with template `staff_notification`. Never logs the address.

- [ ] **Step 1: Write the failing tests.** Integration: `notify_staff queues one job per recipient without an address in it` (assignee + one member: two jobs, payload has no `@`, dedupe keys end with each actor id; firing again queues none); `a member without an address or gone is named in the detail`; `no deployment sender skips no_staff_sender`; `sign-in records the verified address on every active membership, and only when it changed` (bootstrap twice with the same address → one change then none; a new address → updated; a revoked membership untouched); `the address is never returned` (members list and access routes' JSON has no `notification`). Unit: the handler sends subject `GetCanadaSim: Follow up new orders` and the link `https://crm.example/w/getcanadasim/leads/<id>`, the note on its own line, from the deployment sender; skips for a revoked member and a missing address; the rendered text has no customer field (the payload has none to give).
- [ ] **Step 2: Run** `ENV(2) pnpm --filter backend test -- staff-notification staff-routes` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite with `ENV(2)`, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): notify staff steps with a staff notification job, and the sign-in address capture`

---

### Task 8: Timers, waits and the scheduler task

Batch 2. Model: hard.

**Files:**

- Create: `apps/backend/src/automations/timers.ts`, `apps/backend/src/automations/tick.ts`
- Modify: `apps/backend/src/automations/engine.ts` (write timers at events; `resumeRun`), `apps/backend/src/leads/work-store.ts` (`insertLeadTask` and `updateTask` write `task_overdue` timers when the due day is set or changes), `apps/backend/src/scheduler.ts`
- Test: `apps/backend/tests/automation-tick.integration.test.ts` (sites `…8601`–`…8606`), `apps/backend/tests/scheduler.test.ts` (extend)

**Interfaces:**

```ts
// timers.ts
export type TimerEvent =
  | { kind: 'stage_entered'; stage: string; occurrence: string; at: Date }
  | { kind: 'submitted'; at: Date }
  | { kind: 'task_due'; taskId: string; dueDay: string };
/** For each live flow whose active trigger is the matching time trigger: one pending timer, `on conflict do nothing`. Submitted leads only. */
export function writeTimers(tx, input: { workspaceId: string; leadId: string; leadType: string; event: TimerEvent }): Promise<number>;
// tick.ts
export const AUTOMATION_TICK_INTERVAL_MS = 5 * 60_000;
export const AUTOMATION_TICK_BATCH = 200;
export interface AutomationTickResult { resumed: number; cancelled: number; failed: number; fired: number; voided: number; deferred: number }
export interface AutomationTickDependencies { database?: Pick<DatabaseClient, 'withTenantTx'>; environment: CustomerEmailEnvironment; now?: () => Date }
export function runAutomationTick(dependencies: AutomationTickDependencies, input: SchedulerRunInput): Promise<AutomationTickResult>;
// engine.ts
export function resumeRun(tx, context: FireFlowsContext, waitId: string, now: Date): Promise<'resumed' | 'cancelled' | 'failed' | 'skipped'>;
export function fireTimer(tx, context: FireFlowsContext, timerId: string, now: Date): Promise<'fired' | 'void' | 'deferred' | 'skipped'>;
// scheduler.ts
export type SchedulerTaskName = 'outbox' | 'document_cleanup' | 'data_retention' | 'intake_check' | 'automations';
BackendSchedulerDependencies += { runAutomationTick(input: SchedulerRunInput): Promise<unknown> };
```

Writing: `stage_entered` timers at every stage entry of a submitted lead (staff move, flow move, rescue, a submission's stage entry), occurrence `stay:<entry occurrence>`, `stage`, `event_at` the entry, `due_at` from `timerDueAt`; `after_submitted` at every submission and rescue; `task_due` from `insertLeadTask` and `updateTask` (status open, due day set or changed). The tick (per authorised site, P18): candidates by `(workspace_id, status, resume_at|due_at)` oldest first; each item its own `withTenantTx` as the scheduler actor; claim `… where id = $1 and status = 'pending' for update skip locked` (none → `skipped`). A wait: lead archived or restricted → `cancelWaitingRun` `lead_archived`; flow off or archived → `flow_switched_off`; its run's **own** version (R2) parsed and checked against the site → an issue cancels with that code and `detail`; else write the wait's step row `done`, mark the wait `resumed` and `runSteps` from the step after it with the lead as it is now, the run's depth and chain (P6); a throw → rolled back to a savepoint, `attempts + 1`, at 5 → run `failed` `resume_failed`. A timer (P7): void when the lead is archived or restricted, not submitted, or (`time_in_stage`) not at `stage` or has a `status_change` after `event_at`, or (`task_overdue`) the task is not open or its due day is not the occurrence's, or the flow is off, archived, without an active version, or its active trigger no longer the timer's kind and stage, or its `when` is false; recompute `due_at` from the version active now: not due → update `due_at`, `deferred`; else `fired` and the flow runs from its first step with the active version, depth 0, the timer's occurrence (the same insert-on-conflict as Task 5). Lock order wait/timer → lead; the tick never locks the flow row before the counter update. The scheduler adds `{ name: 'automations', intervalMs: AUTOMATION_TICK_INTERVAL_MS, run: () => dependencies.runAutomationTick(outbox) }` with prefix `scheduler:automations`; the default dependencies wire `runAutomationTick({ environment: customerEmailEnvironmentFromEnv() }, input)`; the tick logs one JSON line `{ event: 'automation_tick', workspaceId, …counts }` and per failing item `{ event: 'automation_tick_item_failed', kind, id, code }` (code via the intake check's `intakeCheckCode`).

- [ ] **Step 1: Write the failing tests.** `automation-tick.integration.test.ts` (an injected clock): `a wait resumes on its due tick and runs the steps after it` (wait 2 days then send: before → nothing; at +2 days → step rows `done` for the wait and the send, run `completed`, one job); `each time trigger fires once per occurrence` (`time_in_stage` 3 days; `task_overdue` 1 hour after the due day; `after_submitted` 1 day: each one run, a second tick none); `time triggers never back-fill` (leads that entered the stage before the flow was switched on get no timer and no run); `a timer whose stay ended or whose task closed is voided and records nothing`; `a re-activated delay moves a pending timer`; `a resume after the flow went off sends nothing` (Review Focus 5: set the flow off and call `cancelFlowWork` as the store will; a tick → no job; a wait the store skipped as locked is cancelled by the tick's own check); `a run resumes on its own version after a new one is activated` (v2 active with other steps: the resume runs v1's step after the wait); `a resume whose template was archived cancels with template_unavailable`; `a resume that keeps failing gives up after five tries` (`resume_failed`); `two ticks at once run each due wait and timer once` (Review Focus 4: two `runAutomationTick` calls with `Promise.all` on 20 due waits and 20 due timers → 20 resumes, 20 fires, one job per step); `a tick killed mid-item leaves it to the next, which completes it once` (a dependency that throws inside the first item's transaction after the claim: the item is still `pending`, the next tick completes it, one job). `scheduler.test.ts`: `registers automations every 5 minutes with the outbox identity` (called with `{ authorizedWorkspaceIds, actorId }` after the startup delay and again 5 min later); `skips an automations tick while the previous run is still in flight`; the other tasks' tests pass with `runAutomationTick` added.
- [ ] **Step 2: Run** `ENV(2) pnpm --filter backend test -- automation-tick scheduler` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite with `ENV(2)`, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): automation waits and time triggers on a five-minute scheduler task`

**Batch 2 review, then merge `p8/t2` into `phase-8-automations`.**

---

## Batch 3: store, API and admin (after Batch 1, in parallel with Batch 2)

### Task 9: The flow store: seeding, list, create, rename, switch, archive, runs

Batch 3. Model: hard.

**Files:**

- Create: `apps/backend/src/automations/flow-store.ts`, `apps/backend/tests/flow-store.integration.test.ts` (sites `…8701`–`…8706`)

**Interfaces:**

- Consumes: Tasks 1–4 (`builtInFlowDefinition`, `builtInFlowName`, `checkFlowAgainstSite`, `overlappingEmailFlows`, `generateFlowKey`, `loadFlowSite`, `cancelFlowWork`).
- Produces:

```ts
export interface StoredFlow {
  id: string;
  key: AutomationKey;
  origin: 'builtin' | 'custom';
  name: string;
  description: string | null;
  enabled: boolean;
  archived: boolean;
  revision: number;
  activeVersion: {
    id: string;
    version: number;
    definition: unknown;
    activatedAt: Date;
    activatedBy: string | null;
  } | null;
  draft: { id: string; version: number; definition: unknown } | null;
  lastRunAt: Date | null;
  runCount: number;
  createdAt: Date;
}
export type FlowStoreOutcome<T> =
  | { status: 'ok'; value: T }
  | {
      status:
        | 'not_found'
        | 'revision_conflict'
        | 'limit_reached'
        | 'no_active_version'
        | 'not_builtin'
        | 'builtin'
        | 'archived'
        | 'needs_lead_manage';
    }
  | { status: 'invalid'; issues: FlowIssue[] | string[] };
export interface FlowListResult {
  flows: StoredFlow[];
  needsAttention: ReadonlyMap<string, FlowIssue>;
  warnings: FlowOverlapWarning[];
}
export interface FlowStore {
  /** Seeds missing built-ins first (`ensureBuiltInFlows`, spec §6); returns the flows not archived, or only the archived ones. */
  list(ctx: WriteScope, options: { archived: boolean }): Promise<FlowListResult>;
  get(ctx: WriteScope, key: AutomationKey): Promise<StoredFlow | undefined>; // also seeds
  create(ctx: WriteScope, input: CreateFlowRequest): Promise<FlowStoreOutcome<StoredFlow>>;
  updateDetails(
    ctx: WriteScope,
    key: AutomationKey,
    input: UpdateFlowDetailsRequest,
  ): Promise<FlowStoreOutcome<StoredFlow>>;
  setEnabled(
    ctx: WriteScope,
    key: AutomationKey,
    enabled: boolean,
  ): Promise<FlowStoreOutcome<StoredFlow>>;
  archive(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  restore(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  listRuns(
    ctx: Scope,
    key: AutomationKey,
    options: { before?: string; includeLeadNames: boolean },
  ): Promise<{ runs: FlowRun[]; nextBefore: string | null } | undefined>;
  getRun(
    ctx: Scope,
    key: AutomationKey,
    runId: string,
    options: { includeLeadNames: boolean },
  ): Promise<FlowRun | undefined>;
}
export class DatabaseFlowStore implements FlowStore {
  constructor(database?: Pick<DatabaseClient, 'withTenantTx'>);
}
export function ensureBuiltInFlows(tx: TenantTransaction, scope: WriteScope): Promise<void>;
```

Rules: a built-in row's `name` null reads as `builtInFlowName(key)`, and seeding fills it; `create`: P14 lock, count not archived ≥ 50 → `limit_reached`, key `generateFlowKey()` (retry on a unique clash), `origin 'custom'`, version 1 `draft` with the empty draft (P10), audit `automation.created`; `updateDetails`: `expectedRevision` ≠ stored → `revision_conflict`, bumps `revision`, audit `automation.renamed` naming the changed fields; `setEnabled`: lock the flow row; on with no active version → `no_active_version`; archived → `archived`; no change → no audit; off → `cancelFlowWork` (P7); audit `automation.toggled` `{ key, enabled }` before/after (one audit even for two concurrent first toggles: seeding made the row, the lock serialises); `archive`: custom only (`builtin`), switches off first (with `cancelFlowWork`), sets `archived_at`, audit; `restore`: P14 lock and the limit, clears `archived_at`, stays off, audit; runs newest first by `(created_at, id)`, page 50, `before` a run id of this flow; a legacy run (`outcome` not null) reads as `legacy: true` with one step `{ stepId: 'main', stepKind: 'send_email', outcome: queued → 'done' | skipped → 'skipped', reason }`; a waiting run carries its wait's `resume_at`; names only with `includeLeadNames`. `needsAttention`: the first `checkFlowAgainstSite` issue of each enabled-or-not active version, or `{ path: 'definition', code: 'definition_invalid', ref: 'definition' }` when the stored definition no longer parses; `null` otherwise.

- [ ] **Step 1: Write the failing tests:** `the list seeds the six built-ins, off, with version 1 active, once` (two concurrent `list` calls → six rows, six versions; names the labels); `a site that never opened the page fires nothing` (no rows → `readLiveFlows` empty: assert through a raw select, since the engine is Batch 2's); `create makes a custom flow with an empty draft and stops at 50` (44 creates after the six succeed, the 45th `limit_reached`; on another site with 46 flows, 10 concurrent creates → exactly 4 succeed); `rename needs the current revision`; `switching on needs an active version`; `two concurrent first toggles write one audit row`; `switching off cancels waiting runs and voids pending timers at once` (Review Focus 5: waits and timers inserted as admin); `archive is custom only, switches off first, and restore counts against the limit`; `runs page by 50 with before, legacy runs read as one send step, names only with contact access`; `the list warns when two flows on email on the same event` (Review Focus 1); `an unusable active version marks the flow needs attention` (Review Focus 2 and 7: an archived template, a stage not listed, a property made sensitive); `another site's flows and runs are invisible`.
- [ ] **Step 2: Run** `ENV(3) pnpm --filter backend test -- flow-store` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite with `ENV(3)`, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): flow store with seeded built-ins, the 50-flow limit, switching and archive`

---

### Task 10: The flow store: drafts, activation, reset, versions and the catalogue

Batch 3. Model: hard.

**Files:**

- Modify: `apps/backend/src/automations/flow-store.ts`, `apps/backend/tests/flow-store.integration.test.ts` (sites `…8707`–`…8712`)

**Interfaces (Produces):**

```ts
FlowStore += {
  saveDraft(ctx: WriteScope, key: AutomationKey, input: SaveFlowDraftRequest): Promise<FlowStoreOutcome<{ flow: StoredFlow; issues: FlowIssue[] }>>; // structure via flowDraftSchemaFor(origin) → 'invalid' with Zod messages; site issues returned as warnings
  discardDraft(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  activate(ctx: WriteScope, key: AutomationKey, input: ActivateFlowRequest & { mayChangeLeads: boolean }): Promise<FlowStoreOutcome<StoredFlow>>;
  reset(ctx: WriteScope, key: AutomationKey): Promise<FlowStoreOutcome<StoredFlow>>;
  getVersion(ctx: Scope, key: AutomationKey, version: number): Promise<{ version: number; status; definition: unknown; activatedAt: Date | null; activatedBy: string | null; createdAt: Date } | undefined>;
  versions(ctx: Scope, key: AutomationKey): Promise<FlowVersionSummary[]>;
  catalog(ctx: Scope): Promise<Omit<FlowCatalogResponse, 'requestId'>>;
};
```

Rules: `saveDraft`: `expectedRevision` check; no draft → a new `draft` version numbered max + 1, its definition the given one (a first edit of an active flow sends the active definition plus the change); else update the draft's definition; bump `revision`; no audit (P15). `discardDraft`: the draft → `discarded`; bump; audit. `activate` (one transaction): lock the flow row; revision check; no draft → `invalid` `['no_draft']`; `flowDefinitionSchemaFor(origin)` and `checkFlowAgainstSite` → any problem `invalid`; `flowHasLeadChangingStep` and not `mayChangeLeads` → `needs_lead_manage`; old active → `retired` (`retired_at`), draft → `active` (`activated_by`, `activated_at`), `active_version_id`, bump; the flow's pending timers (SKIP LOCKED, P7): `due_at` recomputed with `timerDueAt` from `event_at` (and the occurrence's due day), or `void` when the new trigger's kind or stage no longer matches; audit `automation.activated` `{ key, version }`; the flow's on/off state is untouched. `reset`: built-ins only (`not_builtin`), the draft becomes `builtInFlowDefinition(key)` and the name the label, bump, audit. `catalog`: every lead type of `leadTypeCatalog` with its stages; templates (the nine with `fillInsForTemplate`, then site-made not archived with theirs plus their property keys as `prop:<key>`; `tracking_code` left out, P11); active members (actor id, display name); plans (id, name, type, active); properties of `catalog.all` that are not sensitive and not hidden, each with the types it applies to and whether it may be a condition (filterable), an update (editable custom or form), a task variable and an email variable (not staff-only); `taskVariables` = `FLOW_TASK_VARIABLES`.

- [ ] **Step 1: Write the failing tests:** `the first draft save copies from nothing and bumps the revision`; `a stale revision is refused and changes nothing`; `a draft keeps site issues as warnings`; `a structure error is refused with its message`; `activation refuses a draft with any site issue` (Review Focus 2 and 7); `activation of a lead-changing draft needs lead.manage`; `activation retires the old version, keeps the flow's switch, recomputes and voids pending timers` (a `time_in_stage` pending timer: a longer delay moves `due_at`; a new stage voids it; a timer locked by another connection is skipped and left `pending`); `an activated version's definition never changes` (save after activation creates version n + 1); `discard then save makes a new draft number`; `reset puts the built-in default back as a draft, built-ins only`; `versions list and one version read`; `the catalogue leaves out sensitive and hidden properties and tracking_code, and names what each property may be used for`.
- [ ] **Step 2: Run** `ENV(3) pnpm --filter backend test -- flow-store` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the backend suite with `ENV(3)`, typecheck, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): flow drafts, activation with timer recompute, reset to default and the editor catalogue`

---

### Task 11: The automation routes and their permissions

Batch 3. Model: hard.

**Files:**

- Modify: `apps/backend/src/routes/automations.ts` (rewritten on `FlowStore`), `apps/backend/src/routes/staff.ts` (`flowStore?: FlowStore` replacing `automationStore`, an `unconfiguredFlowStore`, the wiring), `packages/contracts/src/{automations,endpoints,client,index}.ts` (`listAutomations` → `flowListQuerySchema` / `flowListResponseSchema`, `updateAutomation` → `toggleFlowRequestSchema` / `flowToggleResponseSchema`, `listAutomationRuns` → `listFlowRunsQuerySchema` / `listFlowRunsResponseSchema`; delete `automationSchema`, `listAutomationsResponseSchema`, `automationResponseSchema`, `automationRunSchema`, `listAutomationRunsResponseSchema`, `updateAutomationRequestSchema`), `client.test.ts`
- Test: `apps/backend/tests/automation-routes.test.ts` (rewritten, mocked store)
- Regenerate: `docs/api/openapi.json`

**Interfaces:**

- Consumes: Tasks 9–10's `FlowStore`; `PlanRouteDependencies['decide' | 'reportFailure']`; `decideAccess`; `canSeeContacts`.
- Produces: `export interface AutomationRouteDependencies { store: FlowStore; customerEmail: Pick<CustomerEmail, 'available'> | undefined; decide; reportFailure; canSeeContacts(access): boolean }`; `export function createAutomationRoutes(dependencies): Router` with the routes of spec §8 (catalogue registered before `/:key`).

Order per route: bad uuid or body → 400 `invalid_request`; `decide(req, ws, 'workspace.read' | 'integration.manage')` denied → 403; then the key (`automationKeySchema`), a bad key → 404 `automation_not_found` (after the permission); activation also computes `mayChangeLeads = decideAccess(access, 'lead.manage').allowed`, refusing a lead-changing draft with 403 `activation_needs_lead_manage` (the store's `needs_lead_manage`); outcomes: `not_found` 404 `automation_not_found` (`automation_version_not_found`, `automation_run_not_found` for those reads), `revision_conflict` 409, `limit_reached` 409 `automation_limit_reached`, `no_active_version` 409, `not_builtin` 409 `automation_not_builtin`, `builtin` 409 `automation_builtin`, `archived` 409 `automation_archived`, `invalid` 400 `flow_invalid` with `details.issues` (site issues) or `details.problems` (structure messages); a throw → `reportFailure` and 500 `internal_error`. Every flow response is `flowDetailResponseSchema` built from `StoredFlow`, `versions`, the draft's issues and `canManage`; list answers `canManage`, `hasSender`, `limit: 50`, `warnings`; mutations run in a `WriteScope` with `requestId: req.id`.

- [ ] **Step 1: Write the failing tests:** per route, a `viewer` reads (200) but cannot change (403); `integration.manage` without `lead.manage` activates an email-only draft (200) and is refused a lead-changing one (403 `activation_needs_lead_manage`); an unknown key → 404 only after the permission (a viewer's PUT on `nope` is 403, not 404); every refusal code above from a store stub; `before` and `archived=1` pass through; lead names only for contact roles; the response parses with its contracts schema; `GET …/automations/catalog` is not mistaken for a key.
- [ ] **Step 2: Run** `pnpm --filter backend test -- automation-routes` → FAIL.
- [ ] **Step 3: Implement**, then `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** backend and contracts suites (`ENV(3)`), typecheck (the admin's automations components fail to typecheck until Task 13; run `pnpm --filter backend --filter @gt-sales/contracts typecheck` here), lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): automation flow routes with permissions and the lead.manage activation check`

---

### Task 12: Site-made templates

Batch 3. Model: hard.

**Files:**

- Modify: `apps/backend/src/email/settings-store.ts` (`listTemplates` with site-made and `usedBy`, `createTemplate`, `setTemplateArchived`, `putTemplate` for `tpl_` keys with the `{prop:}` check), `apps/backend/src/routes/email-settings.ts` (the three routes; every template route takes `emailTemplateKeySchema`), `packages/contracts/src/{customer-email,endpoints,client,index}.ts` (`listEmailTemplates` → `listSiteEmailTemplatesResponseSchema`; delete the old list schema), `apps/admin/src/components/email/template-list.tsx` (the nine built-ins only, as today, with "Used by" from `usedBy`; site-made ones are Step B), `packages/contracts/src/automations.ts` (no caller of `automationsUsingTemplate` remains in Batch 3's files)
- Test: `apps/backend/tests/email-settings-store.integration.test.ts` (sites `…8801`–`…8803`), `email-settings-routes.test.ts`, `apps/admin/src/components/email/template-list.test.tsx`

**Interfaces (Produces):**

```ts
EmailSettingsStore += {
  createTemplate(ctx: WriteScope, input: CreateEmailTemplateRequest, catalog: PropertyCatalog): Promise<{ kind: 'saved'; template: StoredEmailTemplate } | { kind: 'limit_reached' } | ({ kind: 'invalid' } & MarkupError)>;
  setTemplateArchived(ctx: WriteScope, key: EmailTemplateKey, archived: boolean): Promise<{ kind: 'saved'; template: StoredEmailTemplate } | { kind: 'not_found' | 'builtin' | 'limit_reached' }>;
};
// listTemplates(ctx) returns the nine (starters at version 0) then site-made by name, archived included, each with usedBy: the flows (key, name) whose active version sends it
```

Rules: create takes the P13 limit under `pg_advisory_xact_lock(hashtextextended('email_templates:' || ws, 0))`, `generateTemplateKey()`, version 1 with its `email_template_versions` row, the markup checked with `MarkupOptions.property` = the property is in the catalogue, not hidden, not sensitive and not staff-only for any type (P12), audit `email.template_created` `{ key, version }`; archive/restore: `tpl_` only (`builtin`), restore counts against the limit, audits; `putTemplate` on a `tpl_` key applies the same property check and refuses an archived one (`not_found`). Routes: POST `/email/templates` 201; archive/restore; 404 `email_template_not_found`, 409 `email_template_builtin`, 409 `email_template_limit_reached`, 400 with the markup error as today; permission `integration.manage` (read `workspace.read`), the key checked after the permission.

- [ ] **Step 1: Write the failing tests:** `a site-made template is created at version 1 with its version row and audit`; `a sensitive, staff-only or unknown property is refused; a usable one is accepted`; `{code}` is refused in a site-made template; `the 51st template is refused, concurrently too`; `archive and restore are site-made only and counted`; `archiving a template an active flow sends marks that flow` (Review Focus 2: through `DatabaseFlowStore.list`, needs attention `template_unavailable`); `usedBy lists the flows whose active version sends each template`; routes: permissions, codes, 404 after permission; admin: the list shows "Used by: Dispatched email" from `usedBy` and no site-made row.
- [ ] **Step 2: Run** `ENV(3) pnpm --filter backend test -- email-settings` and `pnpm --filter admin test -- template-list` → FAIL.
- [ ] **Step 3: Implement**, then `pnpm --filter @gt-sales/contracts build`.
- [ ] **Step 4: Run** backend, contracts and admin email suites, typecheck of backend and contracts, lint, format → PASS.
- [ ] **Step 5: Commit** — `feat(backend): site-made email templates with archive, the 50-template limit and used-by`

---

### Task 13: Admin: the Automations list and a flow's read-only page

Batch 3. Model: hard.

**Files:**

- Create: `apps/admin/src/app/w/[workspace]/automations/[key]/page.tsx`, `apps/admin/src/components/automations/flow-page.tsx`, `flow-list-view.tsx`, `flow-words.ts`, their tests
- Modify: `apps/admin/src/components/automations/automations-list.tsx` (a table), `use-automations.ts`, `automation-runs.tsx` (the new run shape), `apps/admin/src/lib/api.ts` (the new calls), `apps/admin/src/components/leads/lead-timeline.tsx` ("by automation <name>" and the site-made template name; the automation link goes to `/w/<slug>/automations/<key>`), `apps/admin/src/components/leads/stage-move-dialog.tsx` (`emailSkippedText` names `templateName` and `compose_failed`: "… was not sent: the email could not be made. Check the template in Settings → Email."), existing tests

**Interfaces:**

```ts
// flow-words.ts
export interface FlowNames {
  leadType(key: string): string;
  stage(type: string, key: string): string;
  template(key: string): string;
  member(actorId: string): string;
  plan(id: string): string;
  property(key: string): string;
}
export function namesFromCatalog(catalog: FlowCatalogResponse): FlowNames;
export function describeTrigger(trigger: FlowTrigger, names: FlowNames): string; // 'A SIM order moves to Delivered', 'A SIM order is submitted', 'A SIM order has been in Pending for 3 days', 'A follow-up task is overdue', 'An internet lead was submitted 2 days ago'
export function describeCondition(group: ConditionGroup, names: FlowNames): string; // 'the plan is Student or Visitor', 'all of: …'
export function describeStep(step: FlowStep, names: FlowNames): string; // 'Send the Dispatched email', 'Wait 2 days', 'If the plan is Student', 'Create the task "Call …" due in 2 days for the lead's owner', 'Assign the lead to Sam (if no one owns it)', 'Move the lead to Verified', 'Set Size to Large', 'Email Sam and the lead's owner'
export function reasonText(reason: AutomationReason, detail: string | null): string; // 'names a stage that no longer exists (paid)', 'the flow was switched off', …
export function runStatusText(run: FlowRun): string; // 'Completed', 'Waiting until 3 Nov 14:00', 'Skipped: <reason>', 'Failed: <reason>', 'Cancelled: <reason>'
export function flowStatusChip(
  flow: FlowSummary,
): { label: string; tone: 'warning' | 'neutral' } | null; // needs attention > 'Not activated' > 'Draft changes'
// components
export function AutomationsList(props: { workspaceSlug: string }): JSX.Element;
export function FlowPage(props: { workspaceSlug: string; flowKey: string }): JSX.Element;
export function FlowListView(props: {
  definition: FlowDefinition | FlowDraft;
  names: FlowNames;
}): JSX.Element; // an ordered list; branches as nested lists labelled "Yes" and "No"; Step B reuses it
```

Behaviour: the list page (heading `Automations`): one notice per `warnings[]` (its `message`) and the existing no-sender notice above a table (`<caption class="sr-only">Automation flows</caption>`, columns Name, When, On, Last run, Runs, Status) of the active flows; Name links to `/w/<slug>/automations/<key>`, with a "Built in" badge for the six; When is `describeTrigger` or "No trigger yet"; On is the existing labelled switch (`aria-label` the flow's name; disabled with the permission note without `canManage`; a switch on a flow with no active version is disabled with "Activate the flow first."); the chip from `flowStatusChip`. With `canManage`: "New flow" opens a dialog (labelled name field, Create; refusals: the limit's message) and goes to the new flow's page. "Archived flows" (a disclosure button with `aria-expanded`) lists `?archived=1` with Restore. The flow page: heading the name, "Built in" or nothing, the switch, "Active, version n" or "Not activated", the chip, the active definition through `FlowListView` (none → "No trigger yet." or "Not activated yet."), a draft notice "There are draft changes; the editor arrives in a later release." when `draft` exists, the latest runs (`automation-runs.tsx`, the new shape: lead link with contact access else "Lead" and its first 8 characters, `runStatusText`, version, started), and for a custom flow Archive / Restore (P21) with a confirmation. Errors as the other pages do (`role="alert"`, Try again).

- [ ] **Step 1: Write the failing tests** (`vi.mock('../../lib/api')`): the list renders seven rows with the six "Built in" badges, When in words, a warning notice with its message, the chips ("Needs attention: names a stage that no longer exists (paid)", "Not activated", "Draft changes"), the switch disabled with the note for a viewer and for a flow with no active version; toggling calls `updateAutomation` and keeps the confirmed state on failure with the reason; "New flow" by keyboard creates and navigates; the limit refusal is shown; archived flows open and restore. The flow page: the list view of a flow with an if/else and a wait reads, in DOM order, "When a SIM order moves to Verified", "Only when the plan is Student", "If the plan is Student", "Yes", "Create the task …", "No", "Wait 2 days", "Send the Activated email"; the runs show "Waiting until …", "Skipped: …" and a legacy run as "Completed"; the draft notice; Archive asks first. `flow-words` cases for every trigger, condition and step kind and every reason. The timeline: "Verified by automation Follow up new orders" style entry for an entry with `automationName`; a site-made template's name in a `customer_emailed` line. Existing automations and lead tests updated to the new shapes.
- [ ] **Step 2: Run** `pnpm --filter admin test -- automations lead-timeline stage-move` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the admin suite, `pnpm run typecheck` (whole repo green again), lint, format → PASS (delete `apps/admin/.next` if typecheck reads stale route types).
- [ ] **Step 5: Commit** — `feat(admin): automations as a table of flows with a read-only flow page`

---

### Task 14: Docs and the phases README

Batch 3 (written from this plan's names for Batch 2; the controller checks them against Batch 2's merged code). Model: easy.

**Files:**

- Modify: `AGENTS.md`, `docs/HANDOFF.md`, `docs/PLAN.md`, `docs/ENV.md`, `docs/RUNBOOKS/database.md`, `docs/superpowers/phases/README.md`, `docs/superpowers/phases/phase-8-review-and-automations.md` (status line, the two-deployment wording read as GT Sales only)

Content:

- **AGENTS.md** vocabulary: "automation rule" becomes **flow** (trigger, steps, draft and active **versions**, **runs**, **step runs**, **waits**, **timers**, the six **built-in flows** seeded per site, **site-made templates** `tpl_…`, the **notification address**), firing order and R4 replacing "no stage-move automation runs" on a submission, the rescue (O9, O12, O13), the loop guard (P5), the 50-flow limit; where things live: `src/automations/{engine,conditions,actions,timers,tick,flow-store,site,records,staff-notification,run}.ts`, the routes, `packages/contracts/src/{automation-keys,automation-flows,automation-api}.ts`, `apps/admin/src/components/automations/` and `app/w/[workspace]/automations/[key]`, the scheduler's five tasks.
- **HANDOFF**: §2.1 the fifth scheduler task; §2.3 every §8 route with its permission; §2.4 the four tables and the new columns; §2.6 unchanged except "a rescued checkout counts as submitted"; §3 a new entry "2026-10-31: merge phase 8, step A, automation flows" with rulings P1–P25; §5.1 owner steps (the migration paste, switching built-ins on is unchanged, staff sign in once so their notification address is recorded); §5.3: close the parked automation findings (compose failures now a `compose_failed` step, missing fill-ins in `detail`, the SQL ↔ contracts test, the concurrent first toggle, the queued run without a job), add the follow-ups (Step B; the deploy-window note; a timer that keeps throwing is retried every tick, P17).
- **PLAN** §7: phase 7 dropped by the owner on 2026-10-31 ("Canadian Plans out of scope; GT Sales only"); phase 8 step A built.
- **ENV.md**: `ADMIN_ORIGIN` now also builds the lead link in staff notifications; `RESEND_FROM_NAME` / `RESEND_FROM_EMAIL` also send staff notifications (unset: notify steps skip `no_staff_sender`).
- **database.md**: 0019 and 0020, the paste file, the OWNER PASTE statement, the deploy window.
- **Phases README**: row 7's status "Dropped by the owner (2026-10-31): Canadian Plans out of scope; GT Sales only." (title and page link kept); row 8's title "Review, then automation flows", done when "A custom flow built on the canvas, with an if/else and a wait, fires on a stage move and on the scheduler, and its run shows each step; the six built-ins behave as before.", status "Step A built (engine, storage, API, list page), not deployed; migrations 0019 and 0020 to apply. Step B (canvas, Runs tab, New template) to plan." with the spec and plan links; rule 12 widened ("Every flow, built-in or custom, is off until someone with `integration.manage` switches it on; a site without a row has the built-ins off; off queues nothing, records no run and cancels waiting runs."); **rule 13 replaced** with: "**A lead the customer never submitted fires no flow, except that the first staff stage move of an incomplete lead marks it submitted, freezes its plan and fires the submitted and stage flows** (owner decisions O9 and O12, 2026-10-31; the customer can then no longer finish that checkout, O13)."; the "Where things are" row for Canadian Plans marked out of scope.

- [ ] **Step 1: Write the files**, `pnpm exec prettier --write` on every changed Markdown file, `pnpm run format` → PASS.
- [ ] **Step 2: Commit** — `docs: phase 8 step A, automation flows`

---

### Task 15: Done when: the automation journeys

Batch 3. **Starts only after Batch 2 is merged into `phase-8-automations` and the work branch is merged into `p8/t3`.** Model: hard.

**Files:**

- Modify: `apps/backend/tests/e2e/harness.ts` (Get Canada Sim gains one abandoned SIM order "Omar Haddad", `submit` false, with a plan and an email; and one custom flow "Verified follow-up" created through `DatabaseFlowStore` as the owner: trigger `stage_entered` sim_order/`verified`, then `if_else` plan = the first plan: yes → `create_task` "Call {first name} about {order number}" due in 1 day for the lead's owner; no → `wait` 2 days, then `send_email` `activated`; activated, left off; update the header comment), `apps/admin/e2e/leads.spec.ts` (the existing automations journey on the table; two new journeys; update the header comment)

- [ ] **Step 1: Update** "a SIM order is approved, dispatched and activated by automations…" for the table: six built-in rows and the custom one, all off; switch Dispatched and Activated by their row's switch; after the moves, their Runs cells read 1; opening the Dispatched flow's page shows its run for Nadia Khan as "Completed".
- [ ] **Step 2: Add** "a custom flow with an if/else and a wait is read on its page, switched on and fires on a move": `/w/getcanadasim/automations` → row "Verified follow-up", When "A SIM order moves to Verified", no chip → open it → the list view in order (as Task 13's test) → back, switch it on → open a SIM order on Pending whose plan is the first plan, move to Verified → the timeline shows a task-created entry "by automation Verified follow-up" and the task "Call <first name> about MS-<n>" on the lead → the flow page's runs show "Completed" for that lead → no console errors.
- [ ] **Step 3: Add** "a rescued checkout is submitted and gets the Order received email": switch on "When an order is submitted on the website → send the Order received email" → open Omar Haddad (stage Incomplete) → move to Pending → the timeline shows "Order received email queued by an automation" and the submitted entry → the lead reads as submitted.
- [ ] **Step 4: Run** `pnpm --filter admin test:e2e:leads` and again with `TZ=UTC` → PASS, every journey (free ports 4100 and 3101 first).
- [ ] **Step 5: Commit** — `test: automation flow journeys (list, read-only flow, rescued checkout)`

**Batch 3 review (Tasks 9–15), then merge `p8/t3` into `phase-8-automations`.**

---

## Task 16: Controller: dead code, gate, migrations, pull request, deploy, live check

After all three batches. Not an implementer task.

- [ ] **Step 1: Merge and sweep.** Merge `p8/t2` and `p8/t3` into `phase-8-automations` (Task 15 already holds both); resolve `docs/api/openapi.json` by `pnpm --filter @gt-sales/contracts build`. Delete what nothing imports any more (P20): `apps/backend/src/automations/store.ts` (`DatabaseAutomationStore`, `enabledAutomationKeys`), `apps/backend/tests/automation-store.integration.test.ts`, `automationsForMove`, `automationsForSubmit`, `automationsUsingTemplate` and the old `AutomationTrigger` / `AutomationAction` schemas if unused; `pnpm run typecheck` proves it. Check Task 14's docs against the merged names. Commit `chore: remove the phase 4 automation store and rule helpers`.
- [ ] **Step 2: The gate:** `pnpm run lint && pnpm run typecheck && pnpm run format`; `ENV(9) pnpm run test`; `pnpm run test:tooling`; `pnpm --filter admin test:e2e:leads` and again under `TZ=UTC`; `pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json` → all green. Then the final whole-branch review on Opus with the deferred minors, one fix wave, one scoped re-review (README "Working method").
- [ ] **Step 3: Pull request** "Automation flows, step A: engine, storage and list (merge phase 8)": what changed, the migrations to apply first, the deploy window (do not switch rules between the migration and the backend; the old admin's page may show its load error until the admin deploys), the gate's results, the footer; subscribe to its activity and schedule a check-in (`send_later`).
- [ ] **Step 4: Migrations on `xykrphbgpwisqacpyeiv`, before the merge.** Section A; the plain DDL, grants, functions, trigger and backfill of 0019–0020 through `execute_sql` in small batches; hand the owner the **OWNER PASTE** `app.prune_operational_rows` replacement and wait for "done"; insert the two Drizzle tracker rows and the two `supabase_migrations.schema_migrations` rows; run the verification selects one at a time against the catalog (never the trackers); record the date, tracker versions and every result in `docs/RUNBOOKS/database.md` and HANDOFF §5.1 (commit `docs: migrations 0019 and 0020 applied`).
- [ ] **Step 5: Merge and deploy in order:** merge with a merge commit once `verify` is green → Railway builds the backend → deployment succeeded and `GET /api/v1/health` 200 → the Vercel admin from `main`.
- [ ] **Step 6: Live check** as the owner: Automations for each of the three sites lists the six built-ins, off, "Built in", no chip, no warning; `select count(*)` per site of `automations` = 6 and of versions = 6 after the pages were opened, `automation_runs` unchanged; a built-in's page reads "Send the … email"; with the owner's agreement, on a test lead of a site with a sender: switch one built-in on, move the lead, see one run "Completed" and the timeline entry, switch it off again; the scheduler's `automation_tick` log line appears every 5 minutes with zero counts. Record what was seen in HANDOFF §5.1 and set the phases README row 8 to "Step A deployed …".
