# Merge phase 8: review, then automations

Status on 2026-10-31: the review is done (the owner chose the automation
builder) and **step A is built** (engine, storage, API, the list page and a
read-only flow page; not deployed; migrations 0019 and 0020 to apply). Step B
(the canvas, the Runs tab and Settings → Email "New template") is to plan.
Spec: [2026-10-31-phase-8-automation-flows-design.md](../specs/2026-10-31-phase-8-automation-flows-design.md);
step A plan: [2026-10-31-phase-8-automation-flows-step-a.md](../plans/2026-10-31-phase-8-automation-flows-step-a.md).
Shared rules, the gate, the shipping procedure and the working method are in
[README.md](README.md#shared-conventions); this page adds what is particular
to phase 8.

Canadian Plans is out of scope (owner, 2026-10-31: GT Sales only; phase 7 is
dropped). There is one deployment and one database (`xykrphbgpwisqacpyeiv`):
wherever this page says "every deployment", "per deployment" or "two
deployments", read GT Sales only.

## 1. Purpose and done when

Spec §12 row 8: "Review, then automations". Done when: **"Decided then."** The
spec leaves both the scope and the finish line to this phase.

In plain words, two parts in order:

1. **Review.** With phases 1 to 7 in, look at the product as a whole with the
   owner: what is live, what was parked, what staff ask for, what the
   follow-up lists hold, and whether the automation builder is still the next
   thing worth building. Spec decision 25: "A full builder is wanted, built
   last. Canadian Plans' automation spec stays as it is for reference; the
   feature is re-evaluated before it starts."
2. **Automations**, if the review keeps them: custom rules beside the six
   built-in ones, on the same `app.automations` and `app.automation_runs`
   tables and the same Automations page (ruling D5; HANDOFF §3.7 item 6).

The phase's "done when" is written by the owner at the end of the review and
recorded in the plan header.

## 2. Read first

1. [README.md](README.md): the shared rules, gate, shipping and method.
2. `AGENTS.md`: rules, vocabulary ("automation rule", "run"), where things live.
3. `docs/superpowers/specs/2026-10-28-merge-canadian-plans-design.md` §2
   (decision 25, 15, 24), §4 ("Later"), §14 (stage keys before phase 8), §15.
4. `docs/HANDOFF.md` §3.7 (phase 4, the automations as built), §5.1 (owner
   items), §5.2 (phase 3b and the cutover clean-up), §5.3 (every follow-up list:
   latency, properties, plans, order tools and email, backups), §5.4.
5. `docs/PLAN.md` §7 status and §10 owner items.
6. `docs/superpowers/plans/2026-10-30-phase-4-order-tools-email.md` (Task 5
   the automation store, Task 10 rules firing, Task 14 routes, Task 17 the
   page) and the phase 5, 6 and 7 plans once they exist.
7. Canadian Plans (`/home/user/canadianplans-web-app`), for reference only:
   `docs/superpowers/specs/2026-10-27-admin-crm-and-automations.md` (its owner
   decisions for a Twenty-style builder: triggers, conditions, actions, a
   canvas, a "Manage automations" permission) and
   `docs/ADR/0006-in-app-automations.md`.

## 3. What already exists to build on

The rule model (phase 4):

- **The catalogue** `BUILT_IN_AUTOMATIONS` in
  `packages/contracts/src/automations.ts`: six rules, keys in
  `BUILT_IN_AUTOMATION_KEYS` (`order_received`, `sim_order_information_needed`,
  `sim_order_dispatched`, `sim_order_activated`, `sim_order_cancelled`,
  `mobility_activated`), each a `trigger` (`AutomationTrigger`:
  `{ kind: 'lead_submitted', leadTypes }` or
  `{ kind: 'stage_entered', leadType, stage }`) and an `action`
  (`AutomationAction`: `{ kind: 'send_email', template }`), with Zod forms
  `automationTriggerSchema` and `automationActionSchema`, and the lookups
  `automationsForMove`, `automationsForSubmit`, `automationsUsingTemplate`.
- **The tables** (`packages/db/src/schema.ts`, migration 0013, grants 0014):
  `app.automations` (one row per site and key: `enabled` default false,
  `last_run_at`, `run_count`, `updated_by`, `updated_at`; unique
  `automations_workspace_key_unique`) and the append-only
  `app.automation_runs` (`automation_key`, `lead_id`, `outcome` `queued` or
  `skipped`, `reason`, `job_id`, `created_at`; pruned after 90 days by
  `app.prune_operational_rows`). `app_runtime` has `SELECT, INSERT, UPDATE` on
  the first and `SELECT, INSERT` only on the second; no `DELETE`.
- **CHECK constraints hard-code the key lists**: `automations_key_check` and
  `automation_runs_automation_key_check` list the six keys
  (`automationKeyList`), and `automation_runs_reason_check` lists exactly three
  reasons (`automationRunReasonList`: `no_sender`, `no_customer_email`,
  `missing_fill_in`). The template keys are CHECK lists too
  (`emailTemplateKeyList`). So a new rule key, a new skip reason or a new
  template needs a new migration that drops and re-adds the constraint;
  0013 is applied and is never edited. No test ties these SQL lists to the
  contracts (HANDOFF §5.3).
- **The store** `DatabaseAutomationStore` (`apps/backend/src/automations/store.ts`):
  `list`, `setEnabled` (audits `automation.toggled` only on a change),
  `recordRun` (inside the caller's transaction), `listRuns` (newest 50, the lead
  name only when `includeLeadNames`), and `enabledAutomationKeys`.
- **Firing** `runAutomations` (`apps/backend/src/automations/run.ts`), called in
  the transaction of a stage move or a website submit: a rule that is off does
  nothing; a lead that is not submitted fires no `stage_entered` rule; each rule
  composes in a savepoint; a skip records a `skipped` run and comes back in the
  move's `emailSkipped`; a mail is queued once per
  `<lead id>:<rule key>:<occurrence>` (the move's `status_change` activity id,
  or `submitted`) and records a `queued` run with its job id.
- **Routes** (`apps/backend/src/routes/automations.ts`):
  `GET /workspaces/:id/automations` (`workspace.read`, with `canManage` and
  `hasSender`), `PUT /workspaces/:id/automations/:key` (`integration.manage`,
  `{ enabled }` only, 404 `automation_not_found` after the permission check),
  `GET /workspaces/:id/automations/:key/runs` (`workspace.read`).
- **Admin** `apps/admin/src/components/automations/` (`automations-list.tsx`,
  `automation-runs.tsx`, `use-automations.ts`), page
  `apps/admin/src/app/w/[workspace]/automations/page.tsx`, sidebar entry in
  `nav-items.ts`.
- **Templates and fill-ins** (`packages/contracts/src/customer-email.ts`,
  `apps/backend/src/email/`) are what a `send_email` action sends.
- **Tests**: `apps/backend/tests/automation-store.integration.test.ts`,
  `automatic-emails.integration.test.ts`, `automation-routes.test.ts`,
  `order-flow.integration.test.ts`; admin component tests beside the components;
  the phase 4 journey in `apps/admin/e2e/leads.spec.ts`.

Parked findings this phase inherits (phase 4 final review and its re-review;
HANDOFF §5.3):

- **A compose failure is invisible on the Automations page.** When a stored
  template no longer parses, or a mail would not fit its job payload (a long
  name can push a subject past 300 characters), `runAutomations` logs
  `automation_compose_failed` and goes on: no run, no `emailSkipped`, nothing
  mailed, the move still succeeds. Showing it as a run needs a new reason
  value, so a migration (the three-reason CHECK). Ruled in phase 4 to take the
  existing failure path rather than edit the migration.
- **A skipped run does not name the missing fill-ins**: the run row has no
  column for them; only the notice right after a move does.
- **Rescued incomplete checkouts get no rule mail** (README rule 13). If the
  owner wants them mailed, flip `status` to `submitted` on the first staff move
  out of Incomplete.
- **A staff "email the customer this number" send of an unparseable template
  answers 500** rather than a clear message.
- **The first-ever concurrent toggle of a rule can write two audit rows**; a
  queued run without a job id fails as a bare database check error (store
  guards are missing).
- **The `order.override` reach** (README rule 11) and **`property.manage`
  owner-only** (no per-member grant) are owner decisions waiting for a reason
  to change.

Other open work to review (HANDOFF §5.2, §5.3): phase 3b (cross-site inbox,
contact page, split/merge), the CanadaWide cutover clean-up, latency levers,
properties and plans follow-ups, backups follow-ups, partners (spec §4 "Later").

## 4. Decisions already made (binding)

Shared rules 1 to 23 in [README.md](README.md#rules-that-bind-every-phase) bind
this phase. In particular: no PII in logs, audit, timeline or runs (8);
sensitive properties never in filters, columns, views or the timeline (9); never
edit an applied migration (3); contracts hold every schema and the endpoint
registry (5); admin copy in sentence case, labelled, keyboard-usable (15);
strict TypeScript (6); integration suites on a `_test` database with fixed UUID
ranges (16); the Orders-only member cannot reach the documents override (11);
rescued incomplete checkouts get no rule mail (13); every rule off until
switched on (12).

| Decision                                                                                                                                                         | Why                                                                                  | Where recorded                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------- |
| A full automation builder is wanted, built last, and re-evaluated before it starts; Canadian Plans' automation spec is a reference only.                         | The owner's long-term wish, weighed against what is live by then.                    | Spec §2 decision 25; §4                             |
| Automatic emails are automation rules: a trigger and an action, switched per site on an Automations page; templates are content only.                            | One place decides sending.                                                           | Ruling D5 (owner, 2026-10-30); AGENTS.md vocabulary |
| The builder adds custom rules to the same `app.automations` and `app.automation_runs` tables and the same page.                                                  | Built so in phase 4.                                                                 | HANDOFF §3.7 item 6; PLAN §7                        |
| Every rule, built-in or custom, is off until switched on; switching needs `integration.manage`; reading needs `workspace.read`.                                  | No customer gets two emails.                                                         | Spec §15; phase 4 Global Constraints                |
| A rule that is off queues nothing and records no run; a firing records `queued` with its job or `skipped` with a reason; a skip never blocks the move or submit. | The owner sees what each rule did, staff are never stopped by mail.                  | Phase 4 Global Constraints; HANDOFF §3.7 item 6     |
| A rule fires inside the transaction of the move or submit, once per occurrence, through the outbox.                                                              | A retry never mails twice.                                                           | Phase 4 plan, Task 10; AGENTS.md rule 6             |
| A lead the customer never submitted fires no stage rule.                                                                                                         | "Order" rules mean orders, not abandoned forms.                                      | Phase 4 final review ruling I1; HANDOFF §3.7        |
| The CHECK lists hard-code the keys; a new key or reason is a new migration.                                                                                      | SQL cannot import the contracts; phase 8 was expected to bring its own shape anyway. | Phase 4 ledger, pre-flight ruling on Task 2         |
| A compose failure takes the existing failure path (log, no run, no job), not a new skip reason.                                                                  | 0013 was hashed; adding a reason meant editing it.                                   | Phase 4 fix-wave ruling (payload check)             |
| Stage keys are referenced by automations; settle stages before this phase.                                                                                       | Labels change freely; keys do not.                                                   | Spec §14                                            |
| Partners, partner commission and invoices are later; build no screens or payouts until the owner asks.                                                           | Owner choice.                                                                        | Spec §2 decision 15; §4                             |
| No n8n or outside connections were decided for this product; Canadian Plans had them "later" on an approved list.                                                | Spec silent for this product; listed here so nobody assumes them.                    | Canadian Plans spec 2026-10-27 §1 decision 11       |

## 5. Open decisions to put to the owner before planning

Part 1, the review:

1. **What the review covers and produces.** Recommended: one written review
   (a document in `docs/superpowers/specs/`) of what is live per deployment,
   every open follow-up in HANDOFF §5.3 ranked by effect on staff and
   customers, phase 3b, the owner items still open in PLAN §10, and staff
   feedback; the owner then picks what phase 8 builds.
2. **Is the automation builder still next?** Spec answers "re-evaluated before
   it starts". Recommended: ask after the review, with the concrete rules staff
   would make in the first month.

Part 2, automations (if kept):

3. **Which custom rules.** Ask for real examples. Recommended first set: the
   existing triggers (a lead submitted on the website; a lead entering a
   stage) for any lead type and stage, with the action "send one of the site's
   templates", plus an optional condition on the plan or a property.
4. **New triggers.** Ask whether time-based rules are wanted ("N days in a
   stage", "a follow-up task overdue"); they need a scheduler task. Recommended:
   not in the first version.
5. **New actions.** Ask whether rules may create a task, assign a lead, notify
   staff, or move a stage. Recommended: email and create a task only; moving a
   stage would have to pass the same gates a person does (dispatch, activation,
   documents), which Canadian Plans' spec required too.
6. **New templates.** Custom rules may want their own emails. Recommended:
   allow site-made templates in the same tables, which means replacing the
   template CHECK lists with a key shape in a migration.
7. **Who may build rules.** Recommended: `integration.manage` (the owner, and
   members given the Integrations permission), as switching does today.
   Canadian Plans planned a separate "Manage automations" permission; ask.
8. **Showing failures.** Recommended: a new run reason for a compose failure
   (and the missing fill-ins on a skipped run), in this phase's migration.
9. **Rescued checkouts.** Ask whether a staff move out of Incomplete should
   count as submitted for the rules (README rule 13).
10. **The editor.** Canadian Plans planned a full canvas. Recommended: a form
    ("When … if … then …") first; a canvas only if rules grow beyond one
    trigger and a few actions.
11. **Limits.** Recommended: at most 50 custom rules per site and one email per
    lead, rule and occurrence (the dedupe that exists).

## 6. Constraints and conventions

[README.md shared conventions](README.md#shared-conventions) first. Then:

- Built-in rules keep their keys, labels and behaviour; a custom rule never
  changes what a built-in does.
- A custom rule's definition is validated by Zod in the contracts on save and
  again when it fires; a rule that no longer validates (a stage or template
  removed) is skipped with a recorded reason, never thrown.
- Rule definitions, runs and audit carry keys, ids and template versions only;
  a condition on a property never stores a lead's value, and a sensitive
  property is never offered as a condition (README rule 9).
- Every new key or reason value is added to the contracts and to a new
  migration's CHECK together, with a test that ties the two.
- Migrations: the next free pair after phase 7's (check
  `packages/db/drizzle/meta/_journal.json`), generated plus `_runtime`, with a
  paste file. A changed CHECK on `automation_runs` (about 90 days of rows) and
  `automations` is a short lock; apply out of busy hours.

## 7. Suggested task breakdown

Part 1, the review (no code): read the follow-up lists, query production for
counts only (rules on per site, runs and skips per reason, jobs failed), talk
to the owner, write the review, get the owner's choice and a "done when".

Part 2, if the builder is kept:

| #   | Task                                                                                                                                                                  | Files (main)                                                                                                     | Tests                                                                                           | Model | Depends on |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----- | ---------- |
| 1   | Contracts: a custom rule definition (trigger, conditions, actions), its request and response shapes, new reasons, endpoints, client; built-ins unchanged.             | `packages/contracts/src/automations.ts`, `endpoints.ts`, `client.ts`, `index.ts`; `docs/api/openapi.json`        | Contracts unit tests, including every built-in still parsing.                                   | hard  | decisions  |
| 2   | Database: custom rule storage (a definition column or a rules table), the key CHECKs widened to a key shape, the reason CHECK widened, template CHECKs if decision 6. | `packages/db/src/schema.ts`, `packages/db/drizzle/`, paste file, `docs/RUNBOOKS/database.md`                     | `packages/db/tests/` integration; a test tying SQL lists to the contracts.                      | hard  | none       |
| 3   | Backend: the rule store (create, edit with `expectedVersion`, switch, list), audit by key.                                                                            | `apps/backend/src/automations/store.ts`                                                                          | Integration on `ENV(n)`: site isolation, limits, versions.                                      | hard  | 1, 2       |
| 4   | Backend: firing generalised from `BUILT_IN_AUTOMATIONS` to the site's rules, conditions evaluated, new reasons recorded, compose failures visible.                    | `apps/backend/src/automations/run.ts`, `apps/backend/src/leads/work-store.ts`, `apps/backend/src/leads/store.ts` | Integration: off means nothing; dedupe; unsubmitted leads; a broken rule skipped with a reason. | hard  | 3          |
| 5   | Backend routes: create, edit, list, delete-as-archive (no hard delete) with the permission from decision 7.                                                           | `apps/backend/src/routes/automations.ts`                                                                         | Route tests with mocked stores.                                                                 | easy  | 1, 3       |
| 6   | Admin: the rule editor on the Automations page, runs with reasons and missing fill-ins.                                                                               | `apps/admin/src/components/automations/`, `apps/admin/src/lib/api.ts`                                            | Component tests: keyboard, labels, each state.                                                  | hard  | 1 (mocks)  |
| 7   | Done when (as the owner wrote it): an integration test and a Playwright journey that builds a rule, fires it and reads its run.                                       | `apps/backend/tests/`, `apps/backend/tests/e2e/harness.ts`, `apps/admin/e2e/leads.spec.ts`                       | All journeys pass.                                                                              | hard  | 4 to 6     |
| 8   | Docs: AGENTS.md vocabulary, HANDOFF §2.3, §2.4, §3, §5.3, PLAN §7, this README.                                                                                       | `docs/`                                                                                                          | Prettier.                                                                                       | easy  | all        |
| 9   | Gate, PR, migration, deploy, live check.                                                                                                                              | none                                                                                                             | The gate.                                                                                       | easy  | all        |

Parallel worktrees: 1 ∥ 2; then 3; then 4 ∥ 5 ∥ 6 (admin against mocks); then
7, 8, 9.

## 8. How to ship

The gate (README "Commands and the gate"):

```sh
pnpm run lint && pnpm run typecheck && pnpm run format
ENV(n) pnpm run test
pnpm --filter admin test:e2e:leads
pnpm --filter @gt-sales/contracts build && git diff --exit-code docs/api/openapi.json
```

Then, as in README "How to ship": PR titled "Automation builder (merge phase
8)" (or what the review decided) with the footer, subscribe and schedule a
check-in; apply the migration pair to every deployment's database before its
merge and deploy (after phase 7 there are two: GT Sales' `xykrphbgpwisqacpyeiv`
and Canadian Plans'), each through `execute_sql` in small batches with the
owner pasting what trips the prompt, tracker rows by hand, the verification
selects one at a time, and the record in `docs/RUNBOOKS/database.md`; merge;
Railway backend with health 200 per deployment; then Vercel admin per
deployment.

Live check: every rule still off on every site after the deploy unless the
owner had switched it on; one custom rule built, switched on for a test site,
fired, and its run read on the Automations page.

## 9. Working method

As in [README.md](README.md#working-method). For this phase:

- The review comes first and is a conversation with the owner, one topic at a
  time; nothing is planned before the owner's choice.
- Opus for tasks 1 to 4, 6 and 7; Sonnet for 5, 8 and 9.
- The Review Focus should include: a custom rule and a built-in firing on the
  same move (two mails or one, as decided); a rule naming a stage or template
  that is later removed; a rule switched on while a move is in flight; a
  condition on a property that is later made sensitive or deleted; the same
  migration applied on two deployments.

## 10. Definition of done checklist

- [ ] The review is written and the owner has chosen the scope and the "done
      when", recorded in the plan header.
- [ ] The plan is approved and committed in `docs/superpowers/plans/`.
- [ ] (If built) custom rules can be made, switched, fired and read; built-in
      rules behave as before; every rule starts off.
- [ ] Compose failures and missing fill-ins are visible to the owner (if
      decided).
- [ ] The migration pair is applied to every deployment and recorded.
- [ ] The gate is green; the PR merged with a merge commit; each deployment's
      backend and admin deployed in order.
- [ ] The owner's "done when" is met and recorded in HANDOFF.
- [ ] HANDOFF, PLAN, ENV, AGENTS.md and this folder's README are current.
