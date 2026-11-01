# Phase 8, Step B: Automation Flows Visual Canvas, Runs Tab and Email Templates Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Merge Phase 8, Step B for GT Sales CRM: the Twenty CRM-style vertical visual canvas editor for automations (trigger on top, steps below, '+' step insertion, binary if/else yes/no branches, right-hand side panel for editing, variable pickers, auto-save draft & atomic activation), the Runs tab with step-by-step outcomes, and Settings → Email "New template" + archive/restore and sample values for `{prop:…}` test sends.

**Architecture:**

- **Canvas Renderer & Auto-Layout:** `@xyflow/react` (MIT) loaded dynamically only on `/w/[workspace]/automations/[key]`. Pure deterministic layout function `layoutFlow(definition, draftWarnings)` computes node positions without free dragging.
- **Canvas Nodes & Edges:** Custom nodes for Trigger card, Step cards, If/Else branching cards, and accessible '+' insertion nodes. Edges connect nodes vertically, branching out on If/Else with 'Yes' on the left and 'No' on the right.
- **Side Panel & Forms:** Accessible slide-over side panel (`@gt-sales/ui` Sheet) to edit step configuration, condition builder (All/Any, property/plan/stage/assignee), variable picker for task titles and templates, and step deletion.
- **Draft & Version Management:** Autosaved draft (`PUT /automations/:key/draft`), Atomic Activate (`POST /automations/:key/activate`), Discard Draft, Reset to Default (for built-ins), and List View toggle.
- **Runs Tab:** Paginated flow runs list, expanding into step-by-step outcome cards with plain-English reasons (`flow-words.ts`).
- **Settings → Email:** "New template" creation modal, archive/restore for site-made templates (`tpl_...`), and backend sample property values for test email sends (`sampleFillInValues`).

**Tech Stack:** Next.js 16 + React 19, `@xyflow/react`, Tailwind CSS 4 + shadcn / `@gt-sales/ui`, Vitest + Testing Library, Playwright, Express 5 + PostgreSQL.

---

## Tasks

- [x] **Task 1: Backend Sample Property Values for Test Send & Compose (T5 backend prerequisite)**
  - Update `apps/backend/src/email/fill-in-values.ts`: extend `sampleFillInValues(site, options?)` to generate realistic formatted sample values for any property keys in `options.propertyKeys` using `options.catalog`.
  - Update `apps/backend/src/email/compose.ts`: pass `properties` into `sampleFillInValues` when `recipient.kind === 'staff_test'`.
  - Update `apps/backend/src/routes/email-settings.ts`: verify test send with `{prop:…}` site-made templates queues successfully without `property_fill_ins` error.
  - Add backend unit/integration tests in `apps/backend/tests/email-compose.test.ts` (or equivalent).

- [x] **Task 2: Deterministic Flow Auto-Layout Engine (`layout-flow.ts`)**
  - Create `apps/admin/src/components/automations/canvas/layout-flow.ts`:
    - Pure function `layoutFlow(definition, options)` producing `{ nodes, edges }`.
    - Handles trigger at top, linear steps, binary `if_else` with two branches (Yes left, No right), nested branches up to depth 3, and terminal '+' nodes.
    - Card widths 280px, horizontal column spacing 60px, vertical spacing 48px.
    - Guarantees: no node overlaps, stable ordering matching flow sequence, works in SSR / Node.js.
  - Create unit tests in `apps/admin/src/components/automations/canvas/layout-flow.test.ts`.

- [x] **Task 3: Canvas Custom Nodes & UI Components**
  - Create `apps/admin/src/components/automations/canvas/trigger-node.tsx`: Trigger card with icon, kind, stage/type summary, "only when" summary, and status/warning badge.
  - Create `apps/admin/src/components/automations/canvas/step-node.tsx`: Action/wait card with icon, title, description, and status/issue badge.
  - Create `apps/admin/src/components/automations/canvas/if-else-node.tsx`: Branching condition card with summary and Yes/No indicators.
  - Create `apps/admin/src/components/automations/canvas/add-step-node.tsx`: Keyboard-focusable '+' button with accessible label ("Add a step after <prev>").
  - Create `apps/admin/src/components/automations/canvas/step-type-menu.tsx`: Dropdown menu for adding steps, grouped into Actions and Flow.

- [x] **Task 4: Right-Hand Side Panel & Configuration Forms**
  - Create `apps/admin/src/components/automations/canvas/step-side-panel.tsx`:
    - Non-modal slide-over sheet, focus moved to heading on open, Escape closes and returns focus to source card.
    - Condition Builder: All / Any match, property filter, stage filter, plan filter, assignee filter.
    - Variable Picker: dropdown menu inserting `{first name}`, `{plan}`, `{prop:<key>}` etc. at textarea caret.
    - Forms for: Trigger, Send Email, Create Task, Assign Lead, Update Lead, Notify Staff, If/Else, Wait.
    - Delete button (with confirm dialog for if/else containing nested steps).

- [x] **Task 5: Automation Canvas Editor Container & State Management**
  - Create `apps/admin/src/components/automations/canvas/flow-canvas.tsx`:
    - React Flow canvas with controls (Fit View, Zoom in/out, Background pattern).
    - Local draft state with debounced autosave (`PUT /automations/:key/draft`) with revision check.
    - Header controls: Draft/Active status badge, Activate button (with confirmation modal and permission check for `lead.manage`), Discard Draft, Reset to Default, Switch On/Off, and View toggle (Canvas vs List).
    - Overlap warning banner if flows share trigger events.

- [x] **Task 6: Runs Tab Enhancement**
  - Update `apps/admin/src/components/automations/automation-runs.tsx`:
    - Full Runs tab supporting pagination (`before` cursor).
    - Expandable rows (`aria-expanded`) showing step-by-step execution timeline.
    - Plain-language status and reason formatting using `flow-words.ts`.
  - Update `apps/admin/src/components/automations/flow-page.tsx`:
    - Tab navigation between "Editor" and "Runs".
    - Seamless switching between Visual Canvas and List View.

- [x] **Task 7: Settings → Email "New Template" & Template Management**
  - Update `apps/admin/src/components/email/template-list.tsx`:
    - "New template" button opening creation modal.
    - List built-in and site-made templates with "Used by" flows badge.
    - Archive and Restore actions for site-made templates.
  - Update `apps/admin/src/components/email/template-editor.tsx`:
    - Support name input for site-made templates.
    - Fill-in variable insertion hints.

- [x] **Task 8: Component Tests, E2E Journey & Gate Checks**
  - Unit & component tests for canvas layout, nodes, side panel, keyboard navigation, Runs tab, and email templates.
  - Playwright E2E test in `apps/admin/e2e/leads.spec.ts`: create a custom flow on the canvas, add an if/else step, save, activate, switch on, move a lead, and verify run.
  - Gate: `pnpm run lint && pnpm run typecheck && pnpm run format`, test suites, and docs updates.

- [x] **Task 9: Documentation Updates**
  - Update `AGENTS.md`, `docs/HANDOFF.md`, `docs/PLAN.md`, and `docs/superpowers/phases/README.md`.

Implementation and review completed 2026-11-01; verification and the remaining
owner-approved release are recorded in [the review](../../review/phase-8-step-b.md).
Node/menu components are consolidated in `flow-canvas.tsx`; draft lifecycle state
lives in `flow-page.tsx`. No database migration or contract change was needed.
