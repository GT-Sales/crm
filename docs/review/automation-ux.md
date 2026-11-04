# Automation visual UX review — 2026-11-04

Reviewed the existing engine, action, condition, version, scheduler, outbox and
editor paths while improving the flow builder. The research, references,
preserved behavior and applied decisions are in
[the design notes](../design/2026-11-04-automation-ux.md).

## Findings and fixes

- Empty Yes/No branches disappeared from read-only canvases because the add
  buttons were omitted and no terminal nodes existed. Both paths now retain
  source handles, directional connections, outcome labels and explicit endings.
  A regression covers both empty read-only branches and non-overlapping layout.
- The fixed canvas size could clip a branch when settings opened. The canvas
  now uses its real container and provides explicit Fit/Focus actions. Selecting
  a card brings it into view; reduced motion skips viewport animation.
- The old in-canvas menu could be clipped at the viewport edge. The shared
  portal menu handles collision placement, scrolling, keyboard navigation and
  Escape dismissal. Adding a step leaves focus in its settings rather than
  returning to the old insertion button.
- Draft/published/enabled state was easy to confuse. New status wording and
  activation review explain that activation preserves On/Off and waiting runs
  retain their original version. Setup navigation selects unfinished items.
- Runs appeared under Flow despite having a Runs tab. The two views are now
  separate, with keyboard tab navigation and a recorded step-outcome timeline.
- Opening a no-email sample test previously ran it immediately. Every test now
  waits for Run test. Staff-notification-only simulation no longer asks for a
  customer email address. Results distinguish simulated lead/staff actions,
  simulated waits, sample branch choices and queued customer test email.

No new execution-engine defect was confirmed. The backend was not rewritten:
actual stage/document/permission checks, tenant isolation, immutable versions,
loop/depth guards, cancellation and outbox dedupe remain the existing paths.

## Evidence

Initial focused checks passed 17 files / 155 tests across the automation
backend and editor. The full local suite passed 225 files / 2,707 tests, with
four backup-tool tests skipped because local pg_dump/age are absent. Final
editor checks include the later menu/focus and staff-simulation changes.

The engine tests exercise built-in/custom trigger firing, nested branch
selection, waits and resumes on their own version, concurrent ticks, stopped or
archived flows, permission loss, stage/document gates, hidden/sensitive fields,
loop protection and outbox behavior. Browser tests use the real admin/backend
and a disposable database with a fake email adapter. Earlier isolated subsets
needed the checkout-rescue journey's fixture state; complete journeys are run
in their intended order. Visual captures reset the sample flow's switch so the
same Off state can be compared to the baseline.

No live Site flow was changed, no real email sent and no hosted database write
made. Local and CI checks do not prove each production Site's provider/sender
and scheduler configuration; actual live execution remains an operational
check with a controlled lead/recipient.

Final checks passed 57 editor tests, all 35 authenticated browser journeys,
and 14 desktop/mobile shell journeys. The final visual regression additionally
checks every canvas node fits after Fit flow, selection focus, reduced-motion
styles, the phone list default and no horizontal overflow. Lint, workspace
typechecks, formatting and the admin production build also passed.
