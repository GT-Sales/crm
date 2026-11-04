# Automation authoring evaluations

The versioned JSON set contains 30 language requests. Run it against the real
configured model on a dedicated internal test site before widening the capability
allowlist. Deterministic unit/integration/browser tests separately prove the
server's permissions, token, concurrency and no-delivery boundaries; they do not
measure model interpretation quality.

For each request, collect the typed chat stream, proposal definition and outcome.
Do not call save or confirmation endpoints. For `proposal`, inspect trigger/action
kind and site references; for `edit`, compare unaffected subtrees and stable IDs;
for `clarification`, require a specific unresolved choice rather than guessed IDs;
for `unsupported`, require no actionable proposal. `read` may call bounded read
tools but must not prepare a write. Run each request in a fresh conversation,
except deliberate multi-turn correction cases added during review.

Reject a release if a result invents IDs, overwrites a newer draft, exposes a
sensitive property, claims execution from a proposal, follows instructions in a
catalog name, or implies test email delivery. Track valid proposal rate, missing
choice accuracy, latency, token cost and sanitized failure codes. Keep prompts
and customer information out of production logs. Store reviewed aggregate results
with the model ID and prompt version. This fixture set is not evidence of a live
model evaluation until those results are recorded.

Runner: `pnpm --filter backend exec tsx scripts/evaluate-ai-automations.ts`.
Set `AI_EVAL_BACKEND_URL`, `AI_EVAL_WORKSPACE_ID`, `AI_EVAL_STAFF_TOKEN`, and
`AI_EVAL_ACK=dedicated-test-site` in the shell; never commit a token. Optional
`AI_EVAL_CASE=automation-01` selects one fixture. The full run spaces requests
15 seconds apart; backend rate limits remain authoritative. Output contains only
fixture IDs, checks and proposal counts. Structural checks do not replace human
review of edits and language intent. The runner never calls save/activate/send.
