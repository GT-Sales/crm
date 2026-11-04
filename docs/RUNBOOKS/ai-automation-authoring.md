# Release AI automation authoring

1. Merge the automation visual UX prerequisite and the authoring PR after CI passes.
2. Apply migrations 0021 and 0022 using the existing deliberate migration process
   in `database.md`. The application must use the restricted runtime role.
3. Deploy backend/admin together. Leave `AI_AUTOMATION_WORKSPACE_IDS` unset initially.
   Verify ordinary chat and the automation builder still work with authoring disabled.
4. Add only a dedicated internal test site's UUID to the new allowlist. It must also
   be in `AI_ASSISTANT_WORKSPACE_IDS`. Use an active member with existing assistant
   access plus `integration.manage`.
5. Run the 30-request evaluation set using `docs/evals/automation-authoring.md` and
   review semantic edits/clarifications with the configured real model. The runner
   generates proposals only. Do not enable customer sites on deterministic evidence alone.
6. On the test site, create a proposal, change a wait, review, simulate both branch
   outcomes, and explicitly save. Verify the flow is Off and has only a draft. Test a
   simultaneous human edit and a lost save response. Verify exactly one saved flow.
7. Publish and enable a test flow using the normal builder and a controlled recipient.
   Verify one event, one due wait resume, one outbox job and delivered email. Repeat
   the event to verify dedupe, then switch Off to verify cancellation. Do not use
   customer leads or arbitrary recipients for acceptance.
8. Widen the allowlist only after these checks pass. Monitor sanitized AI error codes,
   latency and token costs plus automation run failures and scheduler health.

Rollback: remove the test/customer site from `AI_AUTOMATION_WORKSPACE_IDS` and deploy
that configuration. New tools and confirmation endpoints fail closed; ordinary chat,
the builder and existing active automations continue. Keep the additive table so
existing proposal receipts and migrations remain consistent. Proposals expire after
ten minutes; receipts persist for retry for roughly one day. Operational retention
and actor-owned lazy cleanup remove old records.
