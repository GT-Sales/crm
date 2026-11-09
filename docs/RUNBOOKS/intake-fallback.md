# CanadaWide intake fallback

**Why.** On 2026-11-09 the CRM backend was down for about 8 minutes. With the
CRM switched on, CanadaWide's lead routes answered every lead in that window
with 502 "We couldn't save your request. Please call us instead." and stored
nothing. The fallback keeps those leads.

**Status: prepared, not applied.** Code on CanadaWide branch
`claude/crm-intake-fallback`; the SQL below is not in production and the
cron job is not scheduled.

## How it works

1. **Website** (`lib/crm.ts`, `lib/intake-fallback.ts`, `app/api/leads`,
   `app/api/mobility-leads`). Each request numbers the lead itself
   (`crypto.randomUUID()`) and calls the CRM intake as before, now with
   `Idempotency-Key: cw-lead:<that id>`. If the CRM is unreachable, times
   out (10 s) or answers 5xx (or a 201 the website cannot read), the route
   inserts the same row the pre-CRM branch wrote into
   `public.internet_leads` / `public.mobility_leads`, under that id, through
   `public.canadawide_fallback_lead`, answers the customer with the normal
   success, sends the normal emails, and logs one line
   `{"event":"crm_intake_fallback","leadType":…,"crmStatus":…,"leadId":…}`
   (no customer data). A CRM **4xx** (validation, site key, bot check, rate
   limit) never falls back: that is the CRM refusing the lead. If the
   fallback insert fails too, the answer is the old 502.
2. **Why a function, not the old insert.** The anonymous insert policies on
   the two legacy tables were dropped on 2026-10-27
   ([manual/close-canadawide-lead-inserts.sql](manual/close-canadawide-lead-inserts.sql)):
   the publishable key is public, so anyone could insert past the site's
   checks. `public.canadawide_fallback_lead(p_key, p_lead_type, p_lead)`
   (CanadaWide repo, `supabase/migrations/20261109090000_crm_intake_fallback.sql`)
   is SECURITY DEFINER, executable by `anon` only, and inserts only when
   `p_key` hashes to the SHA-256 compiled into it. The key is
   `CRM_FALLBACK_KEY`, server-only on CanadaWide's Vercel project. No policy
   is reopened and the website holds no database credential.
3. **CRM** (`app.sync_canadawide_fallback()`,
   [manual/canadawide-intake-fallback.sql](manual/canadawide-intake-fallback.sql)),
   every 5 minutes by pg_cron. It imports each legacy row created between 3
   days and 2 minutes ago that the CRM does not have, with
   `canadawide-legacy-import.sql`'s row mapping and contact merge:
   - **Rows the CRM wrote are never touched.** Every intake lead reaches the
     legacy tables through the 0002 mirror under the CRM's own id, so it
     already has its `app.leads` row; the function only ever inserts
     (`on conflict do nothing`).
   - **No duplicates when the CRM saved the lead but the website timed out.**
     The CRM stores the SHA-256 of the website's idempotency key beside the
     lead it created (`app.idempotency_keys`, same transaction). A fallback
     row whose `sha256('cw-lead:' || id)` is there with a lead is the CRM's
     copy's twin and is skipped. Keys are pruned after 7 days, hence the
     window of at most 6 days (`p_days`, default 3). The 2-minute minimum age
     (`p_min_age`) lets an intake commit that outlived the website's timeout
     land first.
   - Writes per lead: the contact (by normalised email; name and phone only
     filled where empty), the lead (`submitted`, the legacy status as stage,
     consent version **`cw-intake-fallback`**, so these leads are easy to
     find) and one `lead.created` audit event, actor the "Old admin",
     label `intake fallback sync`. No timeline entry: it shows as New.
   - Idempotent: a second run imports nothing; overlapping runs skip
     (advisory lock). It returns the number imported.

### Emails and automations

- **Customer and staff emails go out once, from the website**, at the time
  of the request, on the fallback path as on the normal one
  (`sendCustomerConfirmation` / `sendLeadNotification`, and for mobility the
  ID step's confirmation). The import sends nothing, so nothing is sent twice.
- **CRM automation flows do not run for an imported fallback lead**
  (`lead_submitted`, `stage_entered` and their timers fire only inside the
  intake's own transaction, in TypeScript). That matters only if the owner
  has switched on flows for CanadaWide, for example the built-in
  `order_received` (which covers `internet` and `mobility`): a fallback lead
  then gets no CRM "Order received" email, no auto-assignment and no flow
  task. The customer already had the website's confirmation. If such flows
  are on, staff can find fallback leads by consent version
  `cw-intake-fallback` and act on them by hand. Making the import fire
  flows would need the backend to do it (a scheduler task calling the
  engine), not SQL; not built.

### The mobility ID step

A fallback mobility lead is a `mobility_leads` row under the website's id,
and step 1 returns that id, so the customer goes on to the ID step:

- **`CRM_ID_STEP` off** (today): the ID step writes Supabase directly
  (`mobility-ids` bucket, `mobility_id_uploads`, whose foreign key the
  fallback row satisfies), exactly as for any lead. The ID is in the old
  admin; like every legacy ID, it is not imported into the CRM.
- **`CRM_ID_STEP=on`**: the CRM only knows the lead once this job has
  imported it (CRM back + up to ~7 minutes). Until then the ID step answers
  502 "We couldn't save your application. Please call us instead."; the
  customer's details are already saved, so staff call them. After the import
  the CRM's identity routes accept the lead (it is under 24 hours old). In
  the rare timed-out-but-saved case the CRM holds the lead under its own id,
  not the one the customer has, so the ID step for that customer keeps
  failing and staff collect the ID by phone; the CRM's lead is complete
  otherwise.

## Switching it on

In order; nothing here is applied yet.

1. **Key.** `KEY=$(openssl rand -hex 32); printf %s "$KEY" | sha256sum`.
2. **Gate function.** In CanadaWide's
   `supabase/migrations/20261109090000_crm_intake_fallback.sql`, replace
   `__CRM_FALLBACK_KEY_SHA256__` with the hash, and run it in the Supabase
   SQL editor as `postgres`. Check: `select has_function_privilege('anon',
'public.canadawide_fallback_lead(text,text,jsonb)', 'execute');` is true
   and the same for `authenticated` is false. Do not commit the hash-filled
   copy.
3. **Sync function.** Run
   [manual/canadawide-intake-fallback.sql](manual/canadawide-intake-fallback.sql)
   as `postgres` (SQL editor, or the Supabase MCP `apply_migration` named
   `canadawide_intake_fallback` so the tracker records it). Then once, by
   hand: `select app.sync_canadawide_fallback();` returns `0` while there is
   nothing to import.
4. **Schedule** (needs pg_cron, already on for `gcs-legacy-sync`):

   ```sql
   select cron.schedule('cw-intake-fallback-sync', '*/5 * * * *', 'select app.sync_canadawide_fallback()');
   ```

   Runs show in `cron.job_run_details` (`return_message` `1 row`).

5. **Website.** Set `CRM_FALLBACK_KEY=$KEY` in CanadaWide's Vercel project
   (Production), merge the branch, redeploy. Without the key the routes
   behave exactly as before (502 on an outage).
6. **Rehearse** (optional, staging or a test lead): with a wrong
   `CRM_API_URL` on a preview deployment, submit a lead; it answers success,
   logs `crm_intake_fallback`, and the lead appears in the CRM within 5–7
   minutes with consent version `cw-intake-fallback`.

**Turning it off:** unset `CRM_FALLBACK_KEY` (website), then
`select cron.unschedule('cw-intake-fallback-sync');`. To revoke the key
without a redeploy, re-create the function with another hash (old key then
answers `forbidden`).

**Watching it:** a fallback leaves `crm_intake_fallback` in the website's
Vercel logs, and the CRM shows

```sql
select l.id, l.lead_type, l.created_at from app.leads l
join app.workspaces w on w.id = l.workspace_id
where w.slug = 'canadawide' and l.consent_version = 'cw-intake-fallback'
order by l.created_at desc;
```

Rows still waiting (should be empty a few minutes after the CRM is back):

```sql
select 'internet' as t, i.id, i.created_at from public.internet_leads i
where i.created_at > now() - interval '3 days' and not exists (select 1 from app.leads l where l.id = i.id)
union all
select 'mobility', m.id, m.created_at from public.mobility_leads m
where m.created_at > now() - interval '3 days' and not exists (select 1 from app.leads l where l.id = m.id);
```

(a row here that the CRM saved under its own id, the timed-out case, stays
listed by design; its twin carries the same email and phone.)

## Interplay

- The historical import (`canadawide-legacy-import.sql`) still works: a
  fallback lead is already in `app.leads` under its id, so a re-run treats it
  like an intake lead (no "opened" entry; stage and trash carried over only
  while nobody worked it in the CRM).
- When the 0002 mirror and the legacy tables are retired, this job and the
  gate function go with them (the fallback then needs another store).

The rehearsal is `apps/backend/tests/canadawide-intake-fallback.integration.test.ts`:
two fallback rows are imported once with their payload, contact and audit
event; a lead from the intake (mirrored), a fallback copy whose key the CRM
holds, a row younger than 2 minutes and one older than the window are left
alone; a second run returns 0 and changes nothing; the young row is picked up
once it ages; a window over 6 days is refused.
