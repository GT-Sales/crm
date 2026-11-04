# Automation builder: research and visual editing

## Scope and baseline

A Site owner needs to understand a flow, set its trigger/actions, inspect both
branches, test a sample and deliberately activate/enable the flow. This pass
covers the flow page, canvas, step settings and run reader. It retains the CRM's
monochrome theme, routes, permission checks, immutable versions, autosave/revision
handling, step/branch limits, all existing step kinds and the accessible list
editor. No dependency, schema, migration or environment change is required.

Baseline: main `d37769b`, captured locally before edits using the seeded
Verified follow-up flow. Its canvas used fixed dimensions, could clip a branch
when the settings panel opened, repeated Yes/No labels and showed run history
under the editor even though a separate Runs tab existed. In read-only mode,
empty branches had neither add buttons nor terminal nodes, so those paths
vanished from the diagram.

## References actually inspected

| Source                                                                       | Observed pattern                                                                                          | Applied decision                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Attio](https://mobbin.com/screens/2efbb21f-b637-4513-8f65-b25dd410fe0e)     | Vertical trigger/action cards, selected card with adjacent settings, Editor/Runs tabs, unpublished notice | Keep a vertical CRM diagram, separate editing from run history and explain draft/live state |
| [Pipedrive](https://mobbin.com/screens/39d4cb2a-dd3b-4127-a548-081aaf61f6c7) | Condition-met/not-met paths with explicit flag endings and side settings                                  | Label both branch outcomes and keep visible endings, even on empty read-only paths          |
| [Flodesk](https://mobbin.com/screens/1f312ce8-b694-4ffb-8087-e9cbcbe30ee7)   | Setup/design/publish progression; Yes/No branches and an explicit exit                                    | Add Trigger/Actions/Review setup navigation and visible path endings                        |
| [Zapier](https://mobbin.com/screens/28ca5c8b-7579-470d-bbf2-089e2bb6c60d)    | Directional connectors and explicit path outcome labels; draft/run controls                               | Directional arrows and descriptive branch labels; distinguish publishing from running       |
| [n8n](https://mobbin.com/screens/6e673e49-cd73-4316-9b8e-88eed4d5e984)       | Separate Editor/Executions tabs and a manual execute control                                              | Separate the recorded run reader from editing, with an explicit test action                 |

The chosen structure is the vertical, adjacent-settings direction shown by Attio
and Pipedrive. The horizontal n8n canvas, third-party logos, palettes and generic
external-app integrations were not copied. Icons, wording, phone default and
motion timing are implementation judgments for this CRM, not usability outcomes
proved by the reference images.

Product documentation was checked separately:

- [Zapier editor](https://help.zapier.com/hc/en-us/articles/16722578092429-Use-the-editor-to-build-and-view-your-Zap-workflows): draft/published state, fit controls and setup issues.
- [HubSpot workflow creation](https://knowledge.hubspot.com/workflows/create-workflows): trigger, action and publish setup; overview navigation for larger flows.
- [n8n execution types](https://docs.n8n.io/build/understand-workflows/understand-executions/types-of-executions.md): explicit manual execution and the distinction from production runs.

## Changes and boundaries

1. The canvas fits its actual container, uses separate Yes/No source handles,
   directional connectors and explicit endings on every terminal path. Type
   icons identify actions, conditions and waits. Fit flow and Focus selected
   have visible labels; selection moves to the current card rather than leaving
   it clipped behind settings. A minimap appears only for larger flows.
2. Trigger/Actions/Review navigation shows configuration readiness, takes staff
   to unfinished steps and opens the existing activation review. The page states
   whether the flow is a draft, on, off or archived. Activation still publishes
   a version and preserves the On/Off switch; it does not silently enable a flow.
   The review explains existing waiting runs keep their original version.
3. Flow and Runs are separate keyboard-operable tabs. Recorded step outcomes
   form a timeline with waiting/failure/finished cues. The test dialog starts
   only when Run test is pressed and distinguishes simulated changes/waits,
   sample branch decisions and queued test email. It does not claim delivery or
   that the simulation proves live stage/document requirements will pass.

Motion is limited to short card/settings entry and viewport movement. Reduced
motion skips both. Mobile defaults to the list editor until the person explicitly
chooses a view; all canvas controls remain available. The settings panel remains
reachable and scrollable on narrow or short screens.

## Verification

Functional checks run against disposable local Postgres with the real restricted
runtime role and fake mail adapter. They cover actual trigger firing, branching,
wait/resume, version changes, duplicate/concurrent ticks, cancellation, permission
loss, stage/document rules and outbox behavior. No live Site flow is enabled or
modified and no real customer mail is sent for this review. Passing code tests
is not a claim that every production Site's sender, provider and scheduler
configuration has been exercised.
