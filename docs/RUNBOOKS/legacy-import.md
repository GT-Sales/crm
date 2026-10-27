# CanadaWide historical import

`packages/db/sql/canadawide-legacy-import.sql` copies CanadaWide's old admin
data, `public.internet_leads` and `public.mobility_leads`, into the CRM's
`canadawide` site. Each legacy row becomes an `app.leads` row **under its own
id** (the id the old admin, the 0002 mirror and `mobility_id_uploads` already
use), with:

| Legacy                                             | CRM                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `status`                                           | `stage` (the same keys; `status` is `submitted`)                                                                         |
| name, email, phone                                 | the lead's contact fields, and a contact found or created by `lower(btrim(email))`                                       |
| plan, address, date of birth, provider, consent…   | `payload` as `{ schemaVersion: 1, payload }`, the shape CanadaWide's intake sends                                        |
| `deleted_at`                                       | `deleted_at` (the CRM trash)                                                                                             |
| `notes` (+ `notes_updated_at`)                     | a `note` timeline entry, actor `LEGACY_IMPORT_ACTOR_ID` (shown as "Old admin"), dated `notes_updated_at`                 |
| `reminder_at`, `reminder_note`, `reminder_done_at` | a task: title from the note (or "Follow up"), due at noon UTC that day, `done` with `reminder_done_at` as its completion |
| `consent_version`                                  | `cw-legacy-import` (the old tables never recorded one)                                                                   |
| `mobility_id_uploads` (licence photos, SINs)       | **not imported**: they wait for Storage S3 keys and the SIN-sealing key (PLAN.md §5.9)                                   |

## Running it

As the project's `postgres` role, in one go (the script is one transaction
plus a reconciliation query):

- Supabase dashboard → SQL editor: paste the file, run; or
- the Supabase MCP `execute_sql` with the file's contents; or
- `psql "$MIGRATION_DATABASE_URL" -f packages/db/sql/canadawide-legacy-import.sql`.

The last result row reconciles: `legacy_rows_missing` must be `0`, and
`crm_internet` / `crm_mobility` must equal `legacy_internet` /
`legacy_mobility`.

## Re-running it

Run it again **right before staff move to the CRM**, and whenever new leads
reach the legacy tables before the CanadaWide switch (HANDOFF.md §5.1 step 1):
until then CanadaWide still writes there directly, and the old admin is still
where staff change statuses and notes. Every run is safe to repeat:

- a lead is inserted once; later runs carry the old admin's stage and trash
  over, **except onto a lead someone already worked in the CRM** (any timeline
  entry by a real person), where the CRM wins;
- an existing contact's name and phone are only filled where empty;
- an edited note becomes a second timeline entry; the first is never
  rewritten;
- a reminder's task is refreshed while the CRM has not touched it (its
  `updated_at` still equals `created_at`), and cancelled when the old admin
  clears the reminder.

The ids of notes and tasks are derived from the legacy ids (`md5`, shaped as a
version-4 UUID so the contracts accept them), which is how a re-run finds what
an earlier one wrote.

## History

| Date       | Run                                                                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-27 | First production run: 669 internet + 39 mobility leads (0 missing), 623 contacts, 279 notes, 28 tasks (12 done, 16 open), 129 in the trash; stages and trash matched the legacy rows one for one. A second run left every count and a fingerprint of all leads and tasks unchanged. |

The rehearsal is `apps/backend/tests/canadawide-legacy-import.integration.test.ts`
(replica legacy tables in `tests/support/legacy-canadawide.ts`, shared with the
mirror suite under an advisory lock).
