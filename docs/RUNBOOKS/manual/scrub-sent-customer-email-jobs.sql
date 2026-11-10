-- One-off: remove the address and the rendered words from customer mails that
-- were sent before the backend started doing it itself (audit L-3). Since that
-- change, a `lead_customer_email` job keeps only { leadId, template,
-- templateVersion } once it is completed; jobs completed earlier still hold the
-- recipient's address and the full mail. Run in Supabase -> SQL Editor as
-- postgres, section by section; it changes no other job type and no job that
-- is pending, failed or uncertain (those keep their mail so Retry and the
-- manual delivery check can use it). Not applied by any deploy.
--
-- With OPERATIONAL_RETENTION_ENABLED=1 the daily task deletes completed outbox
-- jobs after 30 days anyway; this clears what is already there now.

-- A. COUNT BEGIN
select count(*) as to_scrub
from app.outbox_jobs
where job_type = 'lead_customer_email'
  and status = 'completed'
  and payload ? 'toAddress';
-- A. COUNT END

-- B. SCRUB BEGIN
-- Safe to run twice: a scrubbed payload no longer has toAddress.
update app.outbox_jobs
set payload = jsonb_strip_nulls(jsonb_build_object(
      'leadId', payload -> 'leadId',
      'template', payload -> 'template',
      'templateVersion', payload -> 'templateVersion')),
    updated_at = now()
where job_type = 'lead_customer_email'
  and status = 'completed'
  and payload ? 'toAddress';
-- B. SCRUB END

-- C. VERIFY BEGIN
-- Expect 0.
select count(*) as still_readable
from app.outbox_jobs
where job_type = 'lead_customer_email'
  and status = 'completed'
  and payload ? 'toAddress';
-- C. VERIFY END
