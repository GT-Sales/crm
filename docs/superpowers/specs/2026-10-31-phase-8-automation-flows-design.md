# Merge phase 8: automation flows

Status: design written 2026-10-31 from the owner's decisions of the same day,
for review before planning. Hand-off:
`docs/superpowers/phases/phase-8-review-and-automations.md` (its review part
is done: the owner chose the automation builder). Parent spec:
`docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md` §2
(decision 25), §12 row 8, §14, §15. Decisions:
`.superpowers/sdd/2026-10-31-phase-8-automations/decisions.md`.

Canadian Plans is out of scope (owner, 2026-10-31: "only GT Sales CRM").
Phase 7 is dropped, so there is one deployment and one database
(`xykrphbgpwisqacpyeiv`); wherever the hand-off page speaks of "every
deployment" or "two deployments", read GT Sales only.

## 1. Purpose

Staff of a site build their own automations, and the six built-in rules
become ordinary, editable flows.

- **A flow** is one trigger and an ordered list of steps: actions (send
  email, create task, assign lead, update lead, notify staff) and flow control
  (if/else with two branches, wait). It is edited on a visual canvas like
  Twenty CRM's workflow editor, has a draft and an active version, and
  records every run with the outcome of each step.
- **The six built-ins** (`order_received`, `sim_order_information_needed`,
  `sim_order_dispatched`, `sim_order_activated`, `sim_order_cancelled`,
  `mobility_activated`) become seeded flows of each site with the same keys,
  still off until switched on, with their run history and their dedupe key
  kept, and a "Reset to default".
- **Two shippable steps.** Step A: the engine, storage, migration, API, the
  seeded built-ins and the list page with a read-only view of a flow. Step B:
  the canvas editor, the Runs tab and Settings → Email "New template". Each
  leaves GT Sales working.

Done when (proposed for the plan header): **a custom flow built on the
canvas, with an if/else and a wait, is activated and switched on for a test
site, fires on a real stage move and on the scheduler, and its run shows each
step's outcome on the Runs tab; the six built-ins behave exactly as before.**

## 2. Decisions

### Owner decisions (2026-10-31)

| #   | Question                         | Answer                                                                                                                                                                                                             |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O1  | Stages                           | Flows use today's per-type stages. The stage merge comes later; saved flows are updated then.                                                                                                                      |
| O2  | Triggers                         | Lead submitted; lead enters a stage; time-based: N hours or days in a stage (once per stay), follow-up task overdue, N days after submitted.                                                                       |
| O3  | Actions                          | Email the customer; create a staff task; assign the lead (a chosen member, only if unowned unless "reassign"); notify staff by email (a link and the flow's name, no customer details).                            |
| O4  | Conditions                       | Yes: on plan, lead type or a non-sensitive property.                                                                                                                                                               |
| O5  | Site-made email templates        | Yes: Settings → Email "New template".                                                                                                                                                                              |
| O6  | Who builds and switches          | `integration.manage`; reading needs `workspace.read`.                                                                                                                                                              |
| O7  | Editor                           | A visual canvas like Twenty CRM's workflow editor.                                                                                                                                                                 |
| O8  | Branching                        | Yes/no (if/else) branches.                                                                                                                                                                                         |
| O9  | Rescued checkouts                | The first staff move out of Incomplete counts as submitted, so the rules fire.                                                                                                                                     |
| O10 | Built-in and custom on one event | Both send; the page warns.                                                                                                                                                                                         |
| O11 | After the first design           | "Build the things so the rules can be dynamic and flexible. Make the canvas like the Twenty CRM, and the automatic mails like the customer gets when submitting an order will also be added as an automated flow." |

### Controller rulings from O11 (binding)

| #   | Ruling                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | A flow is a trigger plus ordered steps: actions, if/else branches with nested steps, and wait.                                                                             |
| C2  | Two extra actions: **Update lead** (a property, or the stage through the same gates a person passes) and **Wait**.                                                         |
| C3  | Fill-ins (variables) from the lead in email and task text.                                                                                                                 |
| C4  | Draft and active versions with an Activate button; a Runs tab with per-step status.                                                                                        |
| C5  | The six built-ins become seeded per-site flows: same keys, off as today, editable, "Reset to default"; history and dedupe preserved; no double mail during the conversion. |
| C6  | Limits: 50 flows per site (the recommended default).                                                                                                                       |
| C7  | Two shippable steps: A, the engine and the list; B, the canvas.                                                                                                            |

### Design rulings in this spec (for the owner's review)

| #   | Ruling                                                                                                                                                                                                                                                                               | Why                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| R1  | The 50 counts every flow that is not archived, the six built-ins included (44 custom).                                                                                                                                                                                               | "50 flows per site", read literally.                                                                                                |
| R2  | A waiting run continues on the version it started with; switching a flow off (or archiving it) cancels its waiting runs at once.                                                                                                                                                     | A new version may not have the step the run is waiting on; "off" must mean nothing more is sent.                                    |
| R3  | Time triggers never back-fill: they count only stays, overdue tasks and submissions that begin while the flow is on.                                                                                                                                                                 | Switching on "3 days in Pending → email" must not mail every old lead at once.                                                      |
| R4  | A submission counts as entering the stage the lead stands in once submitted (Pending for a SIM order, the first stage for the others), so "enters a stage" flows fire for it after the "submitted" flows.                                                                            | Otherwise "when a SIM order enters Pending" would never fire for a website order.                                                   |
| R5  | Changes a flow makes to a lead (assign, update, create task) are made on the authority of the member who activated the version: activating such a version needs `lead.manage` as well as `integration.manage`, and each run re-checks it; the timeline shows "by automation _name_". | A staff move needs `lead.manage`; an automation must not give a member more reach than they have.                                   |
| R6  | A flow that names a stage, template, property, plan or member that is no longer usable is skipped as a whole, with the reason and the key at fault, and the list marks it "Needs attention".                                                                                         | Predictable: never half a flow; the owner sees it before the next firing.                                                           |
| R7  | An if/else is the last step of its sequence: what comes after it goes inside a branch (as in Twenty).                                                                                                                                                                                | No branch merging, so the layout and the run log stay simple.                                                                       |
| R8  | A flow's stage move may set off other flows, at most 3 deep, and never the same flow twice in one chain.                                                                                                                                                                             | Loops end; a move made by a flow still sends the stage's emails.                                                                    |
| R9  | Staff notification mail goes to a member's sign-in address, recorded on their membership the next time they sign in; never shown anywhere.                                                                                                                                           | The backend keeps no address for an active member today (`invited_email` is cleared on acceptance).                                 |
| R10 | The canvas uses `@xyflow/react` with our own auto-layout (no free dragging), loaded only on the editor page, plus a list view of the same flow.                                                                                                                                      | Pan and zoom for wide branches; the list view is the keyboard and screen reader route; Twenty's own code is AGPL and is not copied. |

Production facts behind the conversion (counts only, read 2026-10-31 from the
hosted project): `app.automations` 0 rows (so 0 enabled), `app.automation_runs`
0, `app.email_templates` 0, `app.workspace_email_settings` 0,
`lead_customer_email` jobs 0, 3 sites. The phase 4 live check (HANDOFF §3.7)
said the same. The conversion is still written to be safe on existing rows,
because local and test databases have them and the owner may switch a rule on
before Step A ships.

## 3. The flow definition (contracts)

A new module `packages/contracts/src/automation-flows.ts`; the old
`automations.ts` keeps `BUILT_IN_AUTOMATIONS` (as the built-ins' defaults and
labels) and re-exports what the admin already imports.

### Keys and ids

- **Flow key**: a built-in's key (`BUILT_IN_AUTOMATION_KEYS`) or, for a custom
  flow, `flow_` and 16 lower-case letters or digits (`/^flow_[a-z0-9]{16}$/`),
  generated by the backend. `automationKeySchema` becomes the union of the two.
- **Step id**: `/^[a-z0-9_]{1,40}$/`, unique within a definition; the admin
  makes `s_` and 8 random characters. `main` is reserved for the built-ins'
  send step (§6).
- **Template key**: one of the nine built-ins or, for a site-made template,
  `tpl_` and 16 lower-case letters or digits. `emailTemplateKeySchema` is the
  union; `customerEmailTemplateSchema` stays the nine.

### Shape (Zod, `.strict()` throughout)

```ts
type Duration = { amount: number; unit: 'hours' | 'days' };

type FlowTrigger = (
  | { kind: 'lead_submitted'; leadTypes: LeadType[] } // 1..5
  | { kind: 'stage_entered'; leadType: LeadType; stage: LeadStage }
  | { kind: 'time_in_stage'; leadType: LeadType; stage: LeadStage; after: Duration }
  | { kind: 'task_overdue'; leadTypes: LeadType[]; after: Duration | null } // [] = every type
  | { kind: 'after_submitted'; leadTypes: LeadType[]; after: Duration }
) & { when: ConditionGroup | null }; // "only when …"

type Condition =
  | { kind: 'lead_type'; in: LeadType[] }
  | { kind: 'stage'; op: 'in' | 'not_in'; stages: LeadStage[] } // 1..20
  | { kind: 'plan'; op: 'in' | 'not_in'; planIds: string[] } // 1..20, the site's plans
  | { kind: 'assignee'; op: 'none' | 'any' | 'is'; actorId?: string } // actorId only with 'is'
  | { kind: 'property'; filter: LeadPropertyFilter }; // the existing filter shape and operators

type ConditionGroup = { match: 'all' | 'any'; items: Array<Condition | ConditionGroup> }; // 1..10 items

type FlowStep =
  | { id; kind: 'send_email'; template: EmailTemplateKey }
  | {
      id;
      kind: 'create_task';
      title: string; // 1..200, may hold variables
      dueInDays: number | null; // 0..365, a calendar day in America/Toronto
      assignee: { kind: 'lead_assignee' } | { kind: 'member'; actorId: string } | { kind: 'none' };
    }
  | { id; kind: 'assign_lead'; actorId: string; reassign: boolean }
  | {
      id;
      kind: 'update_lead';
      change:
        | { kind: 'stage'; stage: LeadStage }
        | { kind: 'property'; key: string; value: string | number | boolean | null };
    }
  | {
      id;
      kind: 'notify_staff';
      toAssignee: boolean;
      actorIds: string[]; // 0..10; at least one recipient overall
      note: string; // 0..300, staff-written, no variables
    }
  | { id; kind: 'if_else'; condition: ConditionGroup; then: FlowStep[]; else: FlowStep[] }
  | { id; kind: 'wait'; for: Duration };

type FlowDefinition = { schemaVersion: 1; trigger: FlowTrigger; steps: FlowStep[] }; // 1.. steps
```

Two schemas share these parts:

- `flowDraftSchema`: what a draft may be while it is being built. The tree,
  the ids, the bounds and the types are checked; the settings a step still
  needs may be `null` (a Send email with no template yet, a trigger with no
  stage yet). The canvas shows such a card as "Needs setup".
- `flowDefinitionSchema`: what may be activated and run. Nothing is `null`
  that the step needs, and the structural rules below hold.

### Structural rules (both schemas, `superRefine`)

- Step ids are unique and `main` appears only in a built-in (§6).
- An `if_else` is the last step of its sequence (R7); each branch may be
  empty.
- `stage` values belong to the lead type(s) the trigger can fire for (from
  `leadTypeCatalog`); `time_in_stage` and `stage_entered` take one type.
- A `plan` condition is allowed only when every trigger type is an order type.
- `update_lead` with `stage` must be a stage of the trigger's type(s).
- The `task_overdue` and `after_submitted` triggers have no stage; a
  `time_in_stage` trigger on a type's `incomplete` stage is refused (an
  unsubmitted lead fires nothing).

### Limits (contracts constants, checked on save and on activation)

| Constant                       | Value                                                                    |
| ------------------------------ | ------------------------------------------------------------------------ |
| `AUTOMATION_MAX_FLOWS`         | 50 flows per site that are not archived, built-ins included (R1)         |
| `AUTOMATION_MAX_STEPS`         | 30 steps per flow, nested ones counted                                   |
| `AUTOMATION_MAX_BRANCH_DEPTH`  | 3 (an if/else inside an if/else inside an if/else)                       |
| `AUTOMATION_MAX_WAITS`         | 5 per flow                                                               |
| `AUTOMATION_MAX_WAIT`          | 1 to 720 hours or 1 to 60 days per wait; the waits on any path ≤ 90 days |
| `AUTOMATION_MAX_TRIGGER_DELAY` | 1 to 720 hours or 1 to 90 days                                           |
| `AUTOMATION_MAX_CONDITIONS`    | 10 items per group, groups 2 levels deep, 30 conditions per flow         |
| `AUTOMATION_MAX_CHAIN_DEPTH`   | 3 (R8)                                                                   |
| `AUTOMATION_RUN_PAGE`          | 50 runs per page                                                         |
| Name / description             | 1–80 / 0–500 characters                                                  |
| Definition size                | at most 64 KiB as JSON (also a CHECK)                                    |

### Variables (fill-ins) in text

The template language and its fill-ins stay as they are (`email/markup.ts`,
`EMAIL_FILL_IN_KEYS`). Added:

- **`{order number}`**, the lead's `externalRef` (`MS-<n>`), a new fill-in key
  for every order template and every site-made template.
- **`{prop:<key>}`**, the value of one of the site's properties for the lead,
  formatted as the record page shows it. Allowed in site-made templates and
  task titles only. In a customer email only a property that is neither
  sensitive nor staff-only; in a task title any property that is not
  sensitive. A sensitive property is never offered and never rendered (README
  rule 9).
- A **site-made template** may use every fill-in except `code`
  (`fillInsForTemplate` learns the `tpl_` keys).
- A **task title** may use `first name`, `last name`, `plan`, `price`,
  `SIM number`, `courier`, `tracking number`, `order number` and `{prop:<key>}`
  (`FLOW_TASK_VARIABLES`). A value the lead lacks renders as "(none)": an
  internal task is never skipped for a missing first name, unlike a customer
  email (`missing_fill_in`).
- A **staff notification** carries no variables at all (O3).

The admin's variable picker lists these by label; the backend refuses an
unknown or disallowed one on save (`invalid_variable`, with the name), as it
refuses a misspelt fill-in in a template today.

### Validation against the site, on save, on activation and on every run

One pure function in contracts, `checkFlowAgainstSite(definition, site)`,
where `site` is the site's current lead types and stages (code), templates
(keys, archived or not), active members (ids), plans (id, lead type) and
property catalogue (`PropertyCatalog`). It returns issues
`{ path, code, ref }` with `code` one of `stage_unavailable`,
`template_unavailable`, `property_unavailable` (unknown, hidden, deleted or
sensitive, or staff-only in a customer email), `plan_unavailable`,
`member_unavailable`, `lead_type_unavailable`, `invalid_variable`, and `ref`
the key or id at fault, never a value.

- **Save (draft):** structure errors refuse the save (400 `flow_invalid`);
  site issues come back as warnings with the draft and are drawn on the cards.
- **Activate:** any issue refuses (400 `flow_invalid`, `details.issues`).
- **Run (and resume after a wait):** the stored definition is parsed with
  `flowDefinitionSchema` and checked again; any problem skips the whole run
  (R6) with `reason` = the first issue's code (or `definition_invalid` for a
  parse failure) and `detail` = its `ref`. Nothing is thrown, the move or
  submit goes ahead.
- **List:** the same check on each active version gives the list's "Needs
  attention" marker and its reason.

## 4. Storage

All in schema `app`, every table with `workspace_id`, a `tenantPolicy`, a
`backupReadPolicy`, FORCE RLS and `app_runtime` grants (README rule 2), and no
`DELETE` grant anywhere (README rule 23). Pruning goes through
`app.prune_operational_rows`.

### `app.automations` (existing, one row per flow)

Kept: `id`, `workspace_id`, `key`, `enabled` (default false), `last_run_at`,
`run_count`, `updated_by`, `updated_at`, unique `(workspace_id, key)`.

Added:

| Column              | Type                                            | Meaning                                                                        |
| ------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `origin`            | text not null default `'builtin'`               | `builtin` or `custom`; every existing row is a built-in                        |
| `name`              | text, 1–80                                      | the name staff see; a built-in's is its label (backfilled)                     |
| `description`       | text, 0–500, null                               |                                                                                |
| `active_version_id` | uuid null, FK `(workspace_id, id)` of a version | the live version; null until the first activation                              |
| `revision`          | integer not null default 0                      | bumped by every draft save, discard, reset and activation (`expectedRevision`) |
| `created_by`        | uuid null                                       |                                                                                |
| `created_at`        | timestamptz not null default now()              |                                                                                |
| `archived_at`       | timestamptz null                                | custom flows only; an archived flow is off                                     |

CHECKs: `automations_key_check` is replaced by
`(origin = 'builtin' and key in (<the six>)) or (origin = 'custom' and key ~ '^flow_[a-z0-9]{16}$')`;
`automations_origin_check` (`origin in ('builtin','custom')`);
`automations_archived_check` (`archived_at is null or (origin = 'custom' and not enabled)`);
name and description lengths. The store refuses switching on a flow with no
active version (409 `no_active_version`).

### `app.automation_versions` (new)

| Column           | Type                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| `id`             | uuid pk                                                                      |
| `workspace_id`   | uuid                                                                         |
| `automation_id`  | uuid, FK `(workspace_id, automation_id)` → automations, cascade              |
| `version`        | integer > 0, unique per flow                                                 |
| `status`         | `draft`, `active`, `retired` or `discarded`                                  |
| `schema_version` | integer default 1                                                            |
| `definition`     | jsonb, at most 64 KiB (`octet_length(definition::text) <= 65536`)            |
| `created_by`     | uuid not null; `created_at`                                                  |
| `activated_by`   | uuid null (null for a seeded built-in default); `activated_at`; `retired_at` |

Partial unique indexes: one `draft` per flow, one `active` per flow. CHECK
`(status in ('active','retired')) = (activated_at is not null)`. A
`BEFORE UPDATE` trigger (runtime file) refuses any change to `definition`
unless the old status is `draft`, so an activated version can never change
under a waiting run. Grants `SELECT, INSERT, UPDATE`.

### `app.automation_runs` (existing, one row per firing of a flow for a lead)

Kept, as the legacy record: `automation_key`, `lead_id`, `outcome`, `reason`,
`job_id`, `created_at`. `outcome` becomes nullable: it is set only on rows
written before the conversion (`queued` or `skipped`).

Added: `automation_id` (uuid null, backfilled), `version_id` (uuid null),
`status` (text not null default `'completed'`: `waiting`, `completed`,
`skipped`, `failed`, `cancelled`), `occurrence` (text null, ≤ 200),
`trigger_kind` (text null), `depth` (integer not null default 0, 0–3),
`parent_run_id` (uuid null: the run whose stage move set this one off),
`detail` (text null, ≤ 200: keys and ids only), `updated_at`, `finished_at`.

CHECKs: the key list becomes a key shape `^[a-z][a-z0-9_]{2,63}$`; the reason
list becomes a reason shape `^[a-z][a-z0-9_]{0,63}$` (the reasons themselves
are a contracts enum, `AUTOMATION_REASONS`, tied to the shape by a test, so a
new reason needs no migration); `automation_runs_status_check` (the five);
`outcome is null or outcome in ('queued','skipped')`; the old
"skipped has a reason" and "queued has a job" checks keep their meaning only
for legacy rows (`outcome is distinct from 'queued' or job_id is not null`,
`outcome is distinct from 'skipped' or reason is not null`); and
`status <> 'waiting' or finished_at is null`.

Unique index `automation_runs_occurrence_unique` on
`(workspace_id, automation_key, lead_id, occurrence) where occurrence is not null`:
a flow runs once per lead and occurrence. Grants gain `UPDATE` (a run moves
from `waiting` to its end); this loosens phase 4's append-only grant, and the
store only ever updates `status`, `reason`, `detail`, `updated_at` and
`finished_at`.

### `app.automation_step_runs` (new, append-only)

One row per step outcome: `run_id` (FK, cascade), `step_id`, `step_kind`,
`outcome` (`done`, `skipped`, `failed`, `waiting`, `cancelled`), `branch`
(`yes` or `no`, only for an if/else), `reason` (shape as above), `detail`
(≤ 200: a key, an id or a list of fill-in names, never a value), `job_id`,
`task_id`, `created_at`. A wait writes `waiting` when it starts and `done`
when it resumes. Index `(workspace_id, run_id, created_at)`. Grants
`SELECT, INSERT`.

### `app.automation_waits` (new)

A run paused at a wait step: `run_id` (unique), `automation_id`, `lead_id`,
`step_id` (the wait), `resume_at`, `status` (`pending`, `resumed`,
`cancelled`), `attempts` (0–5), `created_at`, `updated_at`. Index
`(workspace_id, status, resume_at)`. Grants `SELECT, INSERT, UPDATE`. Goes with
its run.

### `app.automation_timers` (new)

A time trigger waiting for its moment, created only while its flow is on
(R3): `automation_id`, `lead_id`, `trigger_kind` (`time_in_stage`,
`task_overdue`, `after_submitted`), `occurrence`, `subject_id` (the task, for
`task_overdue`), `stage` (for `time_in_stage`), `event_at` (when the stay,
task due day or submission began), `due_at`, `status` (`pending`, `fired`,
`void`), `created_at`, `updated_at`. Unique
`(workspace_id, automation_id, lead_id, occurrence)`; index
`(workspace_id, status, due_at)`. Grants `SELECT, INSERT, UPDATE`.

### Templates, memberships, pruning

- `app.email_templates` and `app.email_template_versions`: the key CHECKs
  become `key in (<the nine>) or key ~ '^tpl_[a-z0-9]{16}$'`. `email_templates`
  gains `name` (1–80, required exactly for a `tpl_` key) and `archived_at`
  (only a `tpl_` key). `email_messages.template` has no CHECK and needs none.
- `app.memberships` gains `notification_email` (text null, ≤ 254, the plain
  address pattern), set by the backend from the verified sign-in address when
  it is missing or different (R9), never returned by any route; the grant
  covers updating that column only.
- `app.prune_operational_rows` is replaced with 0018's body, except that
  automation runs are deleted 90 days after they **finish**
  (`status <> 'waiting'` and `coalesce(finished_at, created_at) < now - 90 days`)
  so a waiting run is never pruned, plus `fired` and `void` timers after 90
  days and `resumed` or `cancelled` waits with their run. Step runs go with
  their run by cascade.

## 5. Execution

### Firing inside the move or submit (the synchronous part)

`runAutomations` (apps/backend/src/automations/run.ts) is generalised from
`BUILT_IN_AUTOMATIONS` to the site's flows; it is still called in the
transaction of the write, and everything it does goes through the outbox
(AGENTS rule 6).

1. **The event**: `{ kind: 'lead_submitted' | 'stage_entered', leadId,
occurrence, actorId, depth, chain, parentRunId }`. `occurrence` is today's:
   `submitted` for a submission, the move's `status_change` activity id for a
   move (R4: the submission's own stage entry uses the submitted move's
   `system` activity id, or `submitted:stage` for a type that does not move).
2. **The flows**: one statement reads the site's flows that are on, not
   archived, with their active version (joined on `active_version_id`), in a
   fixed order (built-ins in key order, then custom by `created_at`). Reading
   the version through that one row is what makes activation atomic for a move
   in flight: a move sees the old version or the new, never a mix.
3. **Unsubmitted leads** fire nothing (as today). Submission flows run before
   the stage flows of the same write (R4).
4. **Per flow**, in a savepoint so a failure never aborts the move: does the
   trigger match (kind, type, stage), and does its `when` hold? If not, nothing
   is recorded (a flow that does not apply is like a rule that is off). Then
   the loop guard (R8): `depth > 3` → run `skipped` `chain_too_deep`; the flow's
   key already in `chain` → `skipped` `loop_prevented`. Then the site check
   (§3) → `skipped` with the issue. Then the run is inserted
   `on conflict do nothing` on the occurrence index: a conflict means the
   flow already ran for this occurrence, and nothing more happens.
5. **Steps** run in order, each recorded in `automation_step_runs`:

| Step           | Does                                                                                                                                                                                                                                                                                                                                                                                                   | Skipped (run goes on) when                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send_email`   | `composeCustomerEmail` and `queueComposedEmail` as today, from the lead as now stored; dedupe `<lead id>:<flow key>:<occurrence>:<step id>`, or exactly `<lead id>:<flow key>:<occurrence>` for the step `main` (§6). The `customer_emailed` timeline entry names the flow.                                                                                                                            | `no_sender`, `no_customer_email`, `missing_fill_in` (detail: the fill-in names), `already_sent` (a dedupe hit)                                     |
| `create_task`  | A `lead_tasks` row through the same code as the staff route (title with variables rendered, due day = today in Toronto + N, stored at noon UTC like every task, assignee resolved), audit `lead.task_created`.                                                                                                                                                                                         | `member_unavailable` (the chosen member left), `activator_not_allowed`                                                                             |
| `assign_lead`  | Sets the assignee through `applyLeadUpdate`'s assignment path (timeline `assignment`, audit).                                                                                                                                                                                                                                                                                                          | `already_assigned` (owned and not `reassign`), `member_unavailable`, `activator_not_allowed`                                                       |
| `update_lead`  | Through `applyLeadUpdate` with only `stage`, or only one custom property or editable form field, exactly as a staff `PATCH`: allowed moves and the dispatch, activation and documents gates apply, and the documents override is never used. A stage move here is a new `stage_entered` event at `depth + 1` with this flow added to `chain` (R8), and starts `time_in_stage` timers like any move.    | `illegal_stage_move`, `dispatch_details_required`, `activation_details_required`, `documents_incomplete`, `invalid_field`, `activator_not_allowed` |
| `notify_staff` | One `staff_notification_email` outbox job per recipient (the lead's assignee if asked, and the chosen members), dedupe `<lead id>:<flow key>:<occurrence>:<step id>:<member id>`. The mail: subject "<site name>: <flow name>", a line naming the flow and a link to the lead (`ADMIN_ORIGIN` + `/w/<slug>/leads/<id>`), from the deployment's `RESEND_FROM_*` sender. No customer detail at all (O3). | `no_staff_sender`, `member_unavailable`, `member_has_no_address` (per recipient, in `detail`)                                                      |
| `if_else`      | Evaluates its condition group; records `done` with `branch` `yes` or `no`; continues into that branch.                                                                                                                                                                                                                                                                                                 | never                                                                                                                                              |
| `wait`         | Records `waiting`, inserts the `automation_waits` row with `resume_at = now + for`, sets the run `waiting`, and stops.                                                                                                                                                                                                                                                                                 | never                                                                                                                                              |

A step that throws is rolled back to its savepoint and recorded `failed`
(`compose_failed` for a mail that will not compose or fit its payload, which
closes phase 4's parked "compose failure is invisible"; `step_failed`
otherwise); a failed step ends the run as `failed`. A run that reaches the
end is `completed`; `run_count` and `last_run_at` count every run that
started (`completed`, `waiting`, `failed`). 6. **The move's response** keeps `emailSkipped` (every send step skipped in
this write, any depth), with `automation` widened to the flow key and a new
`flowName`.

**Conditions** are evaluated in one SQL statement per group on the lead row,
reusing `propertyFilterCondition` from `leads/staff-queries.ts`, so a property
condition means exactly what the same filter means on the inbox; `plan` reads
the frozen plan's id (`order_details->'plan'->>'id'`), else `planId`;
`assignee` and `stage` read the columns. Bound parameters only.

**Actor and permissions (R5).** Customer emails keep today's attribution (the
write's actor, with the flow key on the timeline entry). Lead changes, tasks
and notifications are written with `actorId` = the version's `activated_by`,
audit `actorLabel: 'automation'` and
`after.automation: { key, version, runId }`; the timeline renders "by
automation <name>". Activation of a version with an assign, update or task
step needs `lead.manage` too (403 `activation_needs_lead_manage`); at run time
each such step checks, with the same `decideAccess` the routes use, that the
activator is still an active member holding `lead.manage`, else the step is
skipped `activator_not_allowed`. Seeded built-ins only send email and have no
activator.

### Rescued checkouts (O9)

In `applyLeadUpdate`, a staff stage move of a lead whose `status` is
`incomplete` out of its current stage (for a SIM order, out of Incomplete)
also, in the same transaction: sets `status = 'submitted'`; freezes the plan
exactly as the website's submission would (`submittedOrder`, when the order
has a `planId` and that plan is still available, else it stays unfrozen); adds
a `system` `submitted` timeline entry by the staff member and `status` in the
audit; fires the `lead_submitted` flows (occurrence `submitted`, so a later
duplicate cannot mail twice) and then the `stage_entered` flows of the stage
entered (the move's own occurrence). This replaces README rule 13 (§12).
Consequences, by design: the customer's draft grant now answers
`draft_submitted`, so a customer still filling the checkout in cannot finish
it; the lead counts as submitted in the source report, appears on the
customer's `/track` list and is no longer restricted as abandoned after 90
days.

### Waits and time triggers (the scheduler task `automations`)

A fifth scheduler task, `automations`, every 5 minutes
(`AUTOMATION_TICK_INTERVAL_MS`), with the same overlap guard, jitter and
failure logging as the others, as the outbox identity (`outbox:run`, its
`workspaceIds`), like `document_cleanup` and `data_retention`. Per authorised
site, at most 200 due items per tick, oldest first:

- **Due waits** (`pending`, `resume_at <= now`): one tenant transaction per
  item that claims its row `FOR UPDATE SKIP LOCKED`, then: lead archived or
  restricted → run `cancelled` (`lead_archived`); flow off or archived →
  `cancelled` (`flow_switched_off`; normally already done by the switch);
  otherwise the run's **own version** (R2) is checked against the site again
  (§3) and, if usable, the steps after the wait run with the lead as it is now,
  the run's `depth` and `chain`; the wait becomes `resumed`. A failure inside
  is rolled back to a savepoint, `attempts` goes up, and after 5 the run is
  `failed` (`resume_failed`).
- **Due timers** (`pending`, `due_at <= now`): claimed the same way. Still
  true? `time_in_stage`: the lead is at `stage` and has no `status_change`
  after `event_at`; `task_overdue`: the task is open and its due day is the
  one in the occurrence; all: the lead is not archived and the flow is still on
  with an active version whose trigger still matches. If not, the timer
  becomes `void` and nothing is recorded. If so, it becomes `fired` and the
  flow runs from its first step with the version active **now**, depth 0.

Timers are written in the transaction of the event, for each flow that is on
and whose active version has the matching trigger:

| Trigger           | Written when                                                                                   | `occurrence`                     | `due_at`                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- |
| `time_in_stage`   | a submitted lead enters the stage (a staff or flow move, a rescue, a submission's stage entry) | `stay:<occurrence of the entry>` | `event_at + after`                                               |
| `task_overdue`    | a task of a submitted lead is created or its due day changes                                   | `task:<task id>:<YYYY-MM-DD>`    | start of the day after the due day in America/Toronto, `+ after` |
| `after_submitted` | the lead is submitted (website, or rescue)                                                     | `after_submitted`                | `event_at + after`                                               |

Activating a new version recomputes `due_at` of the flow's pending timers from
`event_at` and the new `after`, and voids those whose trigger no longer
matches; switching a flow off voids its pending timers and cancels its
waiting runs (R2, R3).

**Idempotency.** Every item is claimed with `SKIP LOCKED`, every run is
unique per occurrence, every mail is deduped in the outbox: two overlapping
ticks, a second replica or a retried transaction produce one run and one
mail. Lock order is always the wait or timer row, then the lead; the switch
locks the flow row and then updates its waits and timers; the resume never
locks the flow row, so the two cannot deadlock.

## 6. The built-ins as seeded flows (the conversion)

- **Defaults in code.** `builtInFlowDefinition(key)` in contracts gives each
  built-in's version-1 definition: today's trigger (`lead_submitted` for the
  order types, or `stage_entered` for the type and stage), no `when`, and one
  step `{ id: 'main', kind: 'send_email', template }`. `BUILT_IN_AUTOMATIONS`
  keeps the labels, which are the default names.
- **Seeding is lazy and idempotent.** `ensureBuiltInFlows(tx, site, actor)`
  inserts, `on conflict do nothing`, any missing built-in row (`origin`
  `builtin`, `enabled` false, the label as `name`) with version 1 `active`
  (`activated_by` null), and repairs a built-in row that has no active version.
  It runs on the list, the flow page, the toggle and the editor routes, never
  in a move or submit. Firing reads only rows that exist, are on and have an
  active version, so a site that never opened the page has every rule off,
  exactly as today (README rule 12).
- **Existing rows (the migration).** The runtime file backfills, for every
  existing `automations` row: `name` from the label, version 1 `active` from a
  literal copy of the six default definitions, `active_version_id`; and for
  every existing run: `automation_id` by key, `status` (`completed` for
  `queued`, `skipped` for `skipped`), `version_id` = that version 1,
  `finished_at = created_at`, and `occurrence` = the third part of its job's
  dedupe key (`<lead>:<key>:<occurrence>`) where the job still exists. A test
  ties the literal definitions to `builtInFlowDefinition` (§7). In production
  this is a no-op (0 rows) but it is written for rows.
- **Keys, state and history.** Keys stay; `enabled` stays as stored; legacy
  runs stay in `automation_runs` and show on the flow's Runs tab as one
  "Send email" step with their old outcome and reason.
- **No double mail during or after.** The `main` step queues with the very
  dedupe key phase 4 used, `<lead id>:<key>:<occurrence>`, with the same
  occurrence values, and the outbox's unique `(workspace, job_type,
dedupe_key)` stops a second job whichever code queued the first: the old
  backend during the deploy, the new one after. A second step added to a
  built-in gets its own key.
- **Editing a built-in** is editing a flow (a draft, then Activate). It may get
  conditions, more steps or another template. It cannot be archived (only
  switched off) and its trigger kind may change like any other.
- **Reset to default** (built-ins only) replaces the draft with
  `builtInFlowDefinition(key)` and the default name; Activate applies it.
- **The deploy window.** Between applying the migration and the new backend
  going live, the old backend can still switch a rule on, creating a row with
  no version that the new firing would ignore until the list repairs it. The
  runbook says: do not switch rules in that window (production has none on).

## 7. Migration pair

The next free numbers (journal ends at `0018_customer_tracking_runtime`):
**`0019_automation_flows.sql`** (generated from `schema.ts`) and
**`0020_automation_flows_runtime.sql`** (`--custom`), and the paste file
**`docs/RUNBOOKS/manual/0019-0020-automation-flows.sql`** in the 0017–0018
file's form (header with each file's `sha256sum` and journal `when`, a
pre-check, `BEGIN` … both files verbatim and the four tracker rows …
`COMMIT`, then verification selects one at a time), rehearsed on a local
database migrated to 0018 that holds a toggled built-in and runs of both
outcomes.

**0019 (generated):** the four new tables with their checks, indexes,
policies and FKs; the new columns on `automations`, `automation_runs`,
`email_templates` and `memberships` (all nullable or with constant defaults:
no table rewrite); `ALTER COLUMN outcome DROP NOT NULL`; the CHECKs of §4
dropped and re-added (key lists to shapes, as 0017 did for the template
keys). Short locks only; the tables are empty in production. The circular FK
`automations.active_version_id` → `automation_versions` goes in 0020 if
drizzle-kit cannot express it.

**0020 (hand-written, safe to run twice):** FORCE RLS on the four new tables;
grants (`SELECT, INSERT, UPDATE` on versions, waits and timers;
`SELECT, INSERT` on step runs; `UPDATE` added on `automation_runs`; the
`memberships.notification_email` column grant); the versions'
`BEFORE UPDATE` immutability trigger; the backfill of §6 (guarded with
`where … is null` so a second run changes nothing); and
`CREATE OR REPLACE FUNCTION app.prune_operational_rows` (the **OWNER PASTE**
statement, as in phases 4 and 5).

**SQL tied to the contracts.** A new integration test
`apps/backend/tests/automation-sql-contracts.integration.test.ts` reads the
migrated `_test` database's `pg_constraint` definitions and checks: the
built-in key list in `automations_key_check` equals `BUILT_IN_AUTOMATION_KEYS`;
the template key list equals `CUSTOMER_EMAIL_TEMPLATES`; generated flow and
template keys match the key shapes; every `AUTOMATION_REASONS` value matches
the reason shape; the run status, step outcome and timer kind lists equal the
contracts enums; and 0020's literal default definitions parse and equal
`builtInFlowDefinition(key)` for each key. This closes HANDOFF §5.3's "no test
ties these SQL lists to the contracts" for the automation and template lists.

## 8. API

All under `/api/v1/staff/workspaces/:workspaceId/…`, schemas and endpoints
in `packages/contracts` (`endpoints.ts`, the typed client,
`docs/api/openapi.json` regenerated). Reading needs `workspace.read`;
everything that changes a flow or a template needs `integration.manage` (O6).
A key in the path is checked after the permission (404 `automation_not_found`),
as today.

| Method | Path                                        | Permission                             | Does                                                                                                                                                                                                                                                                                                      |
| ------ | ------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/automations`                              | workspace.read                         | The site's flows (seeds the built-ins): key, origin, name, enabled, trigger summary, active version, `hasDraft`, `lastRunAt`, `runCount`, `needsAttention` (the first issue), and `warnings` (O10). `?archived=1` lists the archived. Plus `canManage`, `hasSender`, `limit`.                             |
| POST   | `/automations`                              | integration.manage                     | Creates a custom flow `{ name, description? }` with an empty draft. 409 `automation_limit_reached` at 50 (R1).                                                                                                                                                                                            |
| GET    | `/automations/catalog`                      | workspace.read                         | The editor's pickers: lead types and their stages, templates (built-in and site-made, with their allowed fill-ins), active members (id, display name), plans (id, name, type, active), the properties usable in conditions, in Update lead and as variables, per type.                                    |
| GET    | `/automations/:key`                         | workspace.read                         | The flow, its draft (with `revision` and site warnings) and active definitions, and its versions (number, status, activated at and by).                                                                                                                                                                   |
| PATCH  | `/automations/:key`                         | integration.manage                     | `{ expectedRevision, name?, description? }`.                                                                                                                                                                                                                                                              |
| PUT    | `/automations/:key`                         | integration.manage                     | `{ enabled }`, kept as phase 4 made it; switching on needs an active version; switching off cancels waits and voids timers. Audit `automation.toggled`.                                                                                                                                                   |
| PUT    | `/automations/:key/draft`                   | integration.manage                     | `{ expectedRevision, definition }` (`flowDraftSchema`); creates the draft from the active version when there is none. 409 `revision_conflict`.                                                                                                                                                            |
| POST   | `/automations/:key/draft/discard`           | integration.manage                     | Marks the draft `discarded`.                                                                                                                                                                                                                                                                              |
| POST   | `/automations/:key/activate`                | integration.manage (+ lead.manage, R5) | `{ expectedRevision }`. In one transaction: lock the flow row, check the draft with `flowDefinitionSchema` and the site (400 `flow_invalid`), old active → `retired`, draft → `active`, `active_version_id`, timers recomputed. Audit `automation.activated` (key, version). Does not switch the flow on. |
| POST   | `/automations/:key/reset`                   | integration.manage                     | Built-ins only (else 409 `automation_not_builtin`): the draft becomes the default.                                                                                                                                                                                                                        |
| POST   | `/automations/:key/archive`, `/restore`     | integration.manage                     | Custom only (409 `automation_builtin`); archive switches off first. Audited. Restore counts against the limit.                                                                                                                                                                                            |
| GET    | `/automations/:key/versions/:version`       | workspace.read                         | One version's definition, read-only.                                                                                                                                                                                                                                                                      |
| GET    | `/automations/:key/runs?before=<runId>`     | workspace.read                         | Newest 50 runs: lead id, lead name only with contact access (as today), status, reason, detail, trigger kind, version, started, finished, and each step's outcome in order.                                                                                                                               |
| GET    | `/automations/:key/runs/:runId`             | workspace.read                         | One run with every step row.                                                                                                                                                                                                                                                                              |
| POST   | `/email/templates`                          | integration.manage                     | Creates a site-made template `{ name, subject, body }` (the markup and its fill-ins checked as on save).                                                                                                                                                                                                  |
| POST   | `/email/templates/:key/archive`, `/restore` | integration.manage                     | Site-made templates only; archiving one an active flow uses makes that flow "Needs attention".                                                                                                                                                                                                            |

Changed shapes: `listAutomationsResponseSchema` loses `.length(6)`;
`listEmailTemplatesResponseSchema` loses `.length(9)` and each template gains
`name`, `archived` and `usedBy` (the flows whose active version sends it,
replacing the code lookup `automationsUsingTemplate` on the settings page);
the template routes accept `tpl_` keys; `emailSkippedSchema.automation` takes
any flow key and gains `flowName`; `customerEmailJobPayloadSchema.template`
takes any template key.

**Warnings (O10).** `overlappingEmailFlows(flows)`, a pure contracts
function: two flows that are on and both have a send step before any wait,
on the same event (`lead_submitted` with a lead type in common; `stage_entered`
on the same type and stage, counting a submission's stage entry as the
`lead_submitted` event of that type, R4), give one warning naming both:
"Customers get 2 emails when a SIM order moves to Delivered: Dispatched email,
My dispatch note." Both still send.

## 9. Admin

### Automations list (Step A)

`/w/[workspace]/automations`, the PR #5 look. A real table: Name (a link to
the flow), When (the trigger in words: "A SIM order moves to Delivered"), On
(the existing labelled switch, disabled with the permission note for those
without `integration.manage`), Last run, Runs, and a status chip: "Draft
changes", "Needs attention: <reason in words>" or "Not activated". Above it,
one notice per O10 warning and the existing "no sender" notice. "New flow"
(with `integration.manage`) asks for a name and opens the flow; "Archived
flows" lists the archived with Restore. "Built in" marks the six.

### Flow page, read-only (Step A)

`/w/[workspace]/automations/[key]`: name, on/off, the active version number,
and the definition as a **list view**, an ordered list read top to bottom:
"When … only when …", each step as a sentence ("Send the Dispatched email",
"Wait 2 days", "If the plan is Student: yes → …, no → …") with branches as
nested lists. The flow's latest runs as today's Recent runs, in the new shape.
Step B keeps this list view as a toggle beside the canvas.

### The canvas editor (Step B)

Like Twenty's workflow editor, re-implemented (Twenty's code is AGPL and is
not copied):

- **Rendering.** `@xyflow/react` (React Flow 12, MIT, pinned to an exact
  version at plan time; React 19 supported), a new admin dependency loaded
  with `next/dynamic` only on the flow page, so no other page pays for it.
  Justified by pan, zoom and fit-to-view for wide branches; everything else
  (layout, cards, menus, panel) is ours.
- **Layout is computed, never dragged.** A pure function
  `layoutFlow(definition) → { nodes, edges }` (unit-tested) places the trigger
  card at the top and each step below its predecessor, one column wide, with a
  fixed gap that holds the "+" button. An if/else spans the width of its two
  branches (each at least one column), its "Yes" branch on the left and "No"
  on the right, each continuing downwards with its own "+" at the end. Nodes
  are emitted in flow order. `nodesDraggable`, `nodesConnectable` and
  `elementsSelectable` free selection are off; edges are derived, never drawn
  by hand.
- **Cards.** The trigger card ("When", the trigger in words, its "only when"
  summary) and one card per step (icon, kind, one-line summary, and a "Needs
  setup" or issue badge from the draft's warnings). Each card is a `<button>`
  named by its summary; Enter or a click opens the side panel.
- **"+" between cards and at each branch's end** opens the step menu, a
  dropdown with two labelled groups: **Actions** (Send email, Create task,
  Assign lead, Update lead, Notify staff) and **Flow** (If/else, Wait),
  arrow-key navigable. Each "+" is a button named "Add a step after <card>".
  Inserting an if/else before existing steps moves those steps into its
  "Yes" branch (R7), and says so.
- **Side panel.** A right-hand panel (`packages/ui` sheet, non-modal, 400 px)
  titled with the step's kind, focus moved to its heading on open, Escape
  closing it and returning focus to the card. Per kind: the trigger's type,
  stage, delay and an "Only when" condition builder; Send email: the template
  (a link to Settings → Email to make one); Create task: title with an
  **Insert variable** menu (lead fields and fill-ins by label, inserted at the
  caret), due in N days, assignee; Assign lead: member and "Reassign if
  someone already owns it"; Update lead: stage or a property and its value
  (an input of the property's kind); Notify staff: the assignee checkbox,
  members, a note; If/else: the condition builder (All/Any, rows of property,
  operator, value; add group); Wait: amount and unit. "Remove step" at the
  bottom (an if/else asks first, naming how many steps go with it).
- **Draft and active.** The page header shows "Draft" or "Active, version n",
  the on/off switch, **Activate** (disabled with the issues listed when the
  draft cannot be activated; a confirmation names what changes), "Discard
  draft", "Reset to default" for a built-in, and a version menu opening older
  versions read-only. Opening an active flow shows the active version; the
  first edit creates the draft. Edits save as the draft automatically (a
  debounced `PUT …/draft` with `expectedRevision`; a conflict says "Someone
  else changed this flow. Reload to see their changes.").
- **Keyboard and labels (README rule 15).** Tab follows the flow: trigger,
  then each card and its "+", branch by branch, Yes before No; the zoom and
  fit buttons are labelled; nothing needs a mouse or a drag; motion respects
  `prefers-reduced-motion`; "List view" shows the same flow as the read-only
  list, with the same buttons. Sentence case everywhere.

### Runs tab (Step B)

On the flow page, "Runs": a table of the newest 50 (then "Load more"): Lead
(the name with contact access, else "Lead" and a short id, linking to the
lead), Started, Status in words ("Completed", "Waiting until 3 Nov 14:00",
"Skipped: names a stage that no longer exists", "Failed", "Cancelled: the flow
was switched off"), Version, and the steps as a compact row of labelled
markers. A row expands (a button with `aria-expanded`) into each step with its
outcome and reason in words, including the missing fill-ins of a skipped mail
(closing phase 4's parked finding).

### Settings → Email "New template" (Step B)

On `settings/email`, "New template" (with `integration.manage`) opens the
existing template editor with a name field; the fill-in hint lists what a
site-made template may use. The list shows site-made templates after the
nine, with "Used by" from the backend and Archive or Restore.

## 10. Two steps

| Step                         | Ships                                                                                                                                                                                                                                                                                                                                                                                                                             | GT Sales after it                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A**: engine, storage, list | Contracts (§3, §8), migration pair and paste file (§7), the store, `runAutomations` generalised, conditions, the five actions and two flow steps, the scheduler task, timers, O9, seeded built-ins and conversion (§6), every route of §8 (template creation included), the staff address capture (R9), the store guards for a first concurrent toggle and a queued run without a job, the list page and the read-only flow page. | The six built-ins behave as before, still off; flows can be made through the API only; rescued checkouts now fire the rules. Migration applied before the backend deploy. |
| **B**: canvas and runs       | `@xyflow/react`, `layoutFlow`, the editor, the side panel, the step menu, the condition builder, the variable picker, draft and Activate, the Runs tab, Settings → Email "New template" and template archive. No migration, no backend change beyond fixes.                                                                                                                                                                       | Staff build, activate and read flows on the canvas.                                                                                                                       |

**Deploy window.** Backend first, then admin (README "How to ship"). In the
minutes between, the old admin's Automations page may show its load error
(its schema expects exactly six rules); nothing else changes and no rule is on
in production. The runbook records it.

## 11. Testing

- **Contracts unit:** both schemas round-trip; every structural rule and
  limit; each built-in's default parses and equals today's trigger and
  template; `checkFlowAgainstSite` for each issue code; variables allowed per
  context; `overlappingEmailFlows`; key generators match their shapes.
- **Backend unit:** the condition SQL against a table of filters (same meaning as the inbox filter), the Toronto due-day
  arithmetic for `task_overdue`, dedupe key composition (`main` keeps the
  phase 4 key).
- **Backend integration (`ENV(n)`, fixed UUID range of its own):** off means
  nothing and no run; a condition that does not hold records nothing; each
  action and its skip reasons; nested branches; a wait resumed by the task;
  each time trigger fires once per occurrence and never back-fills; O9 rescue;
  site isolation of every table; limits; revision conflicts; the SQL ↔
  contracts test of §7; the migration on a database holding legacy rows.
- **Routes:** permissions per route (and `lead.manage` for lead-changing
  activation), 404 after the permission, every refusal code.
- **Admin (Step A and B):** component tests for the list's states, chips and
  warnings, the list view; for the canvas: `layoutFlow` (no overlap, branch
  widths, DOM order equals flow order), the step menu and the side panel by
  keyboard, focus return, Activate disabled with issues, the Runs tab rows
  (React Flow needs `ResizeObserver` stubbed in jsdom). One Playwright journey
  builds a flow with an if/else on the canvas, activates it, switches it on,
  moves a lead and reads the run (and the journeys pass under `TZ=UTC`).

### Review focus

Each with its test:

1. **A custom and a built-in flow on one move.** Both on, both email on
   Delivered: two jobs with different dedupe keys, two runs, the list warns;
   the same occurrence fired again gives no third mail and no new run.
2. **A removed stage or template.** A site-made template archived after a flow
   uses it, and a definition naming a stage the type no longer lists: the move
   succeeds, the run is `skipped` with `template_unavailable` /
   `stage_unavailable` and the key, nothing is queued, the list says "Needs
   attention", Activate refuses.
3. **A flow activated mid-move.** A move's transaction has read the flows;
   another connection activates version 2 and commits; the move finishes: its
   run names version 1 and runs version 1's steps only; the next move runs
   version 2. Likewise for switching on and off mid-move.
4. **Overlapping scheduler ticks.** Two runners process the same due waits
   and timers at once (and one is killed mid-item): each item runs once, one
   run per occurrence, one mail per step; the killed item is retried and
   completes once.
5. **A wait that outlives a deactivation or an edit.** Switched off while a
   run waits: the run is `cancelled` (`flow_switched_off`) at once and the
   resume sends nothing. Edited and version 2 activated while it waits: the
   run resumes on version 1's remaining steps. Version 1 names a template
   archived meanwhile: the resume cancels it with `template_unavailable`.
6. **Self-triggering loops.** Flow A (enters Verified → move to Activated)
   and flow B (enters Activated → move to Verified): the chain stops, the
   repeat is `skipped` `loop_prevented`, the move's transaction commits; four
   distinct flows chained stop at depth 3 with `chain_too_deep`; the stage
   rules' emails still fire for each move made.
7. **A property made sensitive after use.** A condition and a `{prop:…}`
   variable on a property later marked sensitive: the list says "Needs
   attention", the next firing is `skipped` `property_unavailable`, the value
   never appears in a run, a task, a mail or a log, and Activate refuses it.
8. **The conversion.** On a database at 0018 holding an enabled built-in and
   queued and skipped runs: after 0019–0020 and the new backend, the built-in
   is on with version 1, its history shows, and replaying an occurrence the
   old code already mailed queues nothing (`already_sent`).

## 12. Rules and documents this changes

- **README rule 13** is replaced: "A lead the customer never submitted fires
  no flow, except that the first staff stage move of an incomplete lead marks
  it submitted, freezes its plan and fires the submitted and stage flows
  (owner decision O9, 2026-10-31)."
- **README rule 12** is kept and widened to flows: every flow, built-in or
  custom, is off until someone with `integration.manage` switches it on; off
  queues nothing, records no run and cancels waiting runs.
- **AGENTS.md vocabulary**: "automation rule" becomes **flow** (trigger,
  steps, versions, runs, step runs, waits, timers); "no stage-move automation
  runs" on a submission is replaced by R4; where things live gains the flow
  modules and the canvas.
- HANDOFF §2.3 (routes), §2.4 (tables), §3 (this phase), §5.3 (the parked
  automation findings closed here: compose failures, missing fill-ins, the
  SQL ↔ contracts test, the concurrent first toggle and the queued-run-without-
  job guard, both now in the store), PLAN §7, `docs/RUNBOOKS/database.md`
  (0019, 0020), the phase README's row 8, and the hand-off page's two-deployment
  wording.

## 13. Not in this phase

Triggers on assignment, property changes, documents, change requests or a
schedule; a manual "run on this lead"; outside connections (webhooks, n8n,
HTTP); SMS; marketing email; round-robin assignment; a test run on a sample
lead; a daily email cap or a deployment kill switch; branch merging; free
dragging of cards; mailing unsubmitted (abandoned) checkouts; the stage merge
(O1).
