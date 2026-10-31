# Intake check

What the intake check is, how to switch it on, and what to do when its alert
arrives: an email "GT Sales CRM: intake check failed" to the owner (and the
chat webhook, when one is set), or its all-clear "GT Sales CRM: intake check
passing again". The paste file is
[manual/intake-check-site.sql](manual/intake-check-site.sql); the variables
are in [ENV.md](../ENV.md#scheduler-outbox-document-cleanup-retention-intake-check).

## What it does

Every 15 minutes (`INTAKE_CHECK_INTERVAL_MS`) the backend's in-process
scheduler, on the one replica with `ENABLE_SCHEDULER=1`, pushes one test lead
through the same intake code a website's `POST /api/v1/website/leads` runs, on
a hidden test site, and removes it again. One run is four steps, in order:

1. **leftovers**: delete any lead on the test site older than 10 minutes
   (`INTAKE_CHECK_LEFTOVER_AGE_MS`), so a run that died half-way is cleaned
   up by the next one. A younger lead may be a concurrent run's, so it stays.
2. **create**: build the website's request (lead type `internet`, submitted,
   the fictional contact "Intake Check", `intake-check@example.invalid`,
   `403 555 0199`, a fixed fictional internet form, consent version
   `intake-check-v1`, no attribution, no order, no idempotency key), check it
   with the route's own schema and the lead-type registry's intake rules,
   then create it with `DatabaseLeadStore.createLead`, as the scheduler's
   machine identity.
3. **verify**: read the lead back on the test site: it must exist, be an
   `internet` lead, `submitted`, at the type's first stage (`new`). A lead that
   reads back wrong is still deleted.
4. **delete**: delete the lead (its timeline, tasks, draft grants and the
   rest go by cascade in the same transaction) and confirm no row is left.

Each run writes one log line, `{"event":"intake_check","status":"ok",…}` or
`{"event":"intake_check","status":"failed","step":"…","code":"…",…}`, with the
duration and, when there were any, the leftovers count. Never a value: no
name, email, phone or address.

The check only ever writes to the test site, queues no email (the site has no
sender and no automation rows), and never counts in a real site's numbers.

## Switching it on

1. **Create the test site** (owner, Supabase SQL Editor):
   [manual/intake-check-site.sql](manual/intake-check-site.sql) section A,
   then section B, then its four verification selects one at a time (each
   0). Copy the id section B shows.
2. **Give the scheduler the scope**: in Railway (service `crm`), add
   `synthetic:check` to the `scopes` of the scheduler entry that
   `JOB_RUNNER_SELECTOR` names in `MACHINE_REGISTRY_JSON`, for example
   `"scopes":["outbox:run","synthetic:check"]`. The test site need not be in
   that entry's `workspaceIds`.
3. **Set `INTAKE_CHECK_WORKSPACE_ID`** to the id from step 1 (Railway, service
   `crm`; backend only).
4. **Redeploy** (Railway applies variables with a redeploy).
5. **Watch two or three runs** in the deploy logs: the first comes about
   10 seconds after start, then one every 15 minutes, each
   `{"event":"intake_check","status":"ok",…}`.

If the scope is missing, the backend still starts and runs the outbox, the
document clean-up and retention, but logs `scheduler_scope_missing` once at
boot (route `scheduler`, request id `scheduler:intake_check`) and never runs
the check. An id that is not a uuid logs `intake_check_workspace_invalid`
the same way.

## What an alert means

The failure alert's detail is `<step>:<code>`:

| Detail                          | Meaning and what to do                                                                                                                                                                    |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create:sqlstate_23503`         | The test site row is gone or `INTAKE_CHECK_WORKSPACE_ID` names another id. Section A of the paste file; put the row back with section D, or correct the variable.                         |
| `create:intake_refused_<part>`  | The intake rules changed so the fixed test form no longer passes (`<part>` is `form`, `contact`, `submit`, `order` or `lead_type`). Check `apps/backend/src/leads/types.ts` and the form. |
| `create:intake_request_invalid` | The website request schema changed so the test request no longer parses (`createLeadRequestSchema`).                                                                                      |
| `*:persistence_unavailable`     | The database or the pooler is down or refusing connections. Websites cannot save leads either: check Supabase and the backend's health first.                                             |
| `verify:*`                      | The store wrote something unexpected (`lead_missing`, `wrong_type`, `not_submitted`, `wrong_stage`). Intake is broken in a way a website would not see; read the recent changes.          |
| `delete:delete_incomplete`      | The lead could not be removed. Nothing to do at once: the next run's leftovers step retries once it is 10 minutes old.                                                                    |
| `*:sqlstate_<code>`             | Another database error, by its SQLSTATE.                                                                                                                                                  |

While it keeps failing, the alert repeats at most once an hour
(`INTAKE_ALERT_REPEAT_MS`). On the first run that passes after one or more
failures, one all-clear arrives with the detail `failed_runs:<n>`, the number
of failed runs since the last all-clear. The state lives in memory on the
scheduler replica: a restart during an outage may repeat one failure alert. An
alert that cannot be sent is logged as `intake_check_alert_failed` and the
next run tries again.

**To silence it**, unset `INTAKE_CHECK_WORKSPACE_ID` and redeploy: the check
stops and nothing else changes.

## Running it by hand

`POST /api/internal/jobs/intake-check` runs one check and returns its result
(`{ "status": "ok", "durationMs": … }` or `{ "status": "failed", "step": …,
"code": …, "durationMs": … }`, always 200, with the `requestId`). It needs the
scheduler identity's secret as `Authorization: Bearer <CRON_SECRET>` (take it
from Railway; never paste it into chat or a document) and the scope
`synthetic:check`; the selector is the `X-Scheduler-Selector` header, else
`JOB_RUNNER_SELECTOR`. Without a valid `INTAKE_CHECK_WORKSPACE_ID` it answers
`404 intake_check_off` (only after authentication). A manual run never alerts
and never changes the scheduled task's alert state.

## The controlled failure

Part of the live check, only with the owner's agreement:

1. Paste file section C (the site row is removed; the variable stays as it
   is, because changing it restarts the backend and loses the alert state).
2. Within 15 minutes the failure alert arrives with `create:sqlstate_23503`.
3. Paste file section D (the same id back).
4. The next run passes and the all-clear `failed_runs:<n>` arrives.

Record what was seen in [HANDOFF §5.1](../HANDOFF.md#51-owner-before-anything-else).

## What stays behind

The contact row of `intake-check@example.invalid` stays (it is reused by every
run; `app_runtime` cannot delete contacts) and every run leaves one
`lead.created` audit row on the test site, about 96 a day. Nothing prunes
them yet (a follow-up in HANDOFF §5.3); section C of the paste file removes
the site's audit rows with the site.
