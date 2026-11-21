-- Issue #84: every website key is limited to the lead types it may send
-- (0043 added `service_credentials.lead_types`). This fills the column for
-- the keys that exist, so nothing a site sends today is refused once the
-- backend starts checking (owner decision, 21 Nov 2026):
--
--   * a key of a site that holds leads gets the lead types that site holds,
--     whatever their status (drafts, submitted, archived, imported);
--   * a key of a site with no lead yet gets every lead type registered today
--     (`leadTypeCatalog` in packages/contracts/src/lead-types.ts), so a site
--     about to go live is not refused its first lead.
--
-- Revoked keys are filled too (it changes nothing for them). Only rows still
-- null are touched, so running it again changes nothing and a list an owner
-- has since corrected is kept. No grant changes: `app_runtime` already holds
-- SELECT, INSERT, UPDATE and DELETE on the table (0001), and its row policy
-- and FORCE ROW LEVEL SECURITY are unchanged.
UPDATE app.service_credentials AS credential
SET lead_types = coalesce(
	(
		SELECT pg_catalog.array_agg(DISTINCT lead.lead_type ORDER BY lead.lead_type)
		FROM app.leads AS lead
		WHERE lead.workspace_id = credential.workspace_id
	),
	ARRAY['sim_order', 'internet', 'mobility', 'partner_application', 'contact_message']::text[]
)
WHERE credential.lead_types IS NULL;
