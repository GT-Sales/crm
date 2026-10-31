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

1. **leftovers**: first make sure the site really is the test site: a site
   with any member, role or site key is refused (`intake_check_site_not_test`)
   and nothing at all is written. Then delete the check's own leads on it
   (lead type `internet` with the synthetic email
   `intake-check@example.invalid`) older than 10 minutes
   (`INTAKE_CHECK_LEFTOVER_AGE_MS`), so a run that died half-way is cleaned
   up by the next one. A younger one may be a concurrent run's, so it stays;
   any other lead is never touched.
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

A whole run gives up after 60 seconds (`INTAKE_CHECK_TIMEOUT_MS`) and fails
with code `timeout` at the step it was in, so a hung database call cannot
stop the check (and its alert) for good.

Each run writes one log line, `{"event":"intake_check","status":"ok",…}` or
`{"event":"intake_check","status":"failed","step":"…","code":"…",…}`, with the
duration and, when there were any, the leftovers count. Never a value: no
name, email, phone or address.

The check writes only to the site `INTAKE_CHECK_WORKSPACE_ID` names, and only
once it has confirmed that site has no members, roles or site keys, which
every real site has. On the test site it queues no email (the site has no
sender and no automation rows) and never counts in a real site's numbers. A
wrong id is not harmless by design, it is refused: an id that names a real
site raises the alert `leftovers:intake_check_site_not_test` on the first run
and nothing is written there; check the id anyway before saving it (step 3).

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
3. **Confirm the id, then set `INTAKE_CHECK_WORKSPACE_ID`**: run section A
   of the paste file again and check that the id you copied is the one row
   it shows, with slug `intake-check` (and no other site's id), then save it
   in Railway (service `crm`; backend only).
4. **Redeploy** (Railway applies variables with a redeploy).
5. **Watch two or three runs** in the deploy logs: the first comes 10 to
   15 seconds after start, then one every 15 minutes, each
   `{"event":"intake_check","status":"ok",…}`.

If the scope is missing, the backend still starts and runs the outbox, the
document clean-up and retention, but logs `scheduler_scope_missing` once at
boot (route `scheduler`, request id `scheduler:intake_check`) and never runs
the check. An id that is not a uuid logs `intake_check_workspace_invalid`
the same way.

## What an alert means

The failure alert's detail is `<step>:<code>`:

| Detail                                 | Meaning and what to do                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leftovers:intake_check_site_not_test` | `INTAKE_CHECK_WORKSPACE_ID` names a real site (it has members, roles or site keys). Nothing was written there, but unset the variable at once and redeploy, then set the test site's id from section A. |
| `create:sqlstate_23503`                | The id names no site at all: the test site row is gone, or the variable holds an id of no site. Section A of the paste file; put the row back with section D, or correct the variable.                  |
| `*:timeout`                            | The run did not finish in 60 seconds: the database or the pooler is hanging. The next run tries again; whatever the stuck run left is its leftover.                                                     |
| `create:intake_refused_<part>`         | The intake rules changed so the fixed test form no longer passes (`<part>` is `form`, `contact`, `submit`, `order` or `lead_type`). Check `apps/backend/src/leads/types.ts` and the form.               |
| `create:intake_request_invalid`        | The website request schema changed so the test request no longer parses (`createLeadRequestSchema`).                                                                                                    |
| `*:persistence_unavailable`            | The database or the pooler is down or refusing connections. Websites cannot save leads either: check Supabase and the backend's health first.                                                           |
| `verify:*`                             | The store wrote something unexpected (`lead_missing`, `wrong_type`, `not_submitted`, `wrong_stage`). Intake is broken in a way a website would not see; read the recent changes.                        |
| `delete:delete_incomplete`             | The lead could not be removed. Nothing to do at once: the next run's leftovers step retries once it is 10 minutes old.                                                                                  |
| `*:sqlstate_<code>`                    | Another database error, by its SQLSTATE.                                                                                                                                                                |

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
