# Automation system review

## Scope

Reviewed the contracts, route authorization, draft/version store, live engine,
condition evaluation, action dispatch, timer creation, scheduler claims and wait
resume paths. Reused the preceding editor/browser review and reran automation,
flow-store and contract regression suites. This is a code and local regression
review, not certification of production configuration or an exhaustive security audit.

## Confirmed fixes

The sample evaluator looked up properties globally rather than resolving them for
the sample lead type. It now uses the live evaluator's property resolver, preventing
an unavailable field from selecting a sample branch. A regression checks both an
unsupported lead type and a supported one.

Sample text equality used JavaScript strict equality while live SQL ignores case
and surrounding spaces for text-like properties. Sample equality now follows that
behavior. A regression compares sample and actual database evaluation.

## Reviewed safeguards

Routes authorize before resolving flow keys. Draft saves and activation use locked
rows and expected revisions. Activation validates current site references and lead
management permission. Waiting runs retain their original version; timers check
current flow state and event validity. Claims use SKIP LOCKED; writes and outbox
jobs share transaction boundaries. Existing tests exercise concurrent ticks,
replay/dedupe, cancelled waits, immutable versions, permission loss, stage/document
constraints, condition groups, tenant boundaries and loop limits.

No additional live-engine defect was confirmed in this pass. Scheduler waits are
processed before timers within a 200-item site batch; sustained wait backlog may
delay timers. This is documented behavior, and fairness/load testing belongs in
operational capacity work rather than changing scheduling semantics here.

## Remaining limits

Sample testing is not a complete production simulator: it generates a sample,
simulates mutations/waits and can enqueue real customer test emails. It does not
prove every branch, real stage/document readiness, or provider delivery. Before AI
testing is exposed, introduce explicit no-delivery scenarios and broader condition
parity coverage as described in the AI authoring plan. Production scheduler and
sender health require a controlled test site/recipient; neither was exercised here.

## Next implementation

See [AI automation authoring plan](../design/2026-11-04-ai-automation-authoring.md)
for the phased design, contracts, permissions, confirmation, concurrency, simulation,
evaluations and rollout criteria. AI authoring itself is planned, not implemented.

## Verification

Automation, flow-store, editor and contract selection: 21 files / 222 tests passed
against the disposable local Postgres database. Workspace typechecking and lint
were run; changed files received a final formatting and backend typecheck pass.
The previous UX review separately records the browser journeys; those were not
rerun for this backend sample-condition change.
