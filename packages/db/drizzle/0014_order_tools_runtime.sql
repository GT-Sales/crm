-- Hand-written companion to 0013_order_tools (AGENTS.md rule 3): FORCE RLS
-- and the runtime grants on the six new tables, and the retention of the two
-- that grow with traffic. backup_reader needs no grant here: 0007's default
-- privileges make every new app table readable, and each table's read policy
-- comes from schema.ts in 0013. No data migration. Every statement is safe to
-- run twice.

ALTER TABLE "app"."idempotency_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."workspace_email_settings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."email_templates" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."email_template_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."automations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."automation_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- No DELETE anywhere: old idempotency keys and runs go through
-- prune_operational_rows() below, the rest go with their site.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."idempotency_keys" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."workspace_email_settings" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."email_templates" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automations" TO app_runtime;
--> statement-breakpoint

-- Append-only: a template's saved versions and an automation's run log are
-- never rewritten from the application.
GRANT SELECT, INSERT ON TABLE "app"."email_template_versions" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "app"."automation_runs" TO app_runtime;
--> statement-breakpoint

-- 0001's bounded pruning, plus idempotency keys after 7 days (a website
-- retries a submission within minutes, not days) and automation runs after
-- 90 days. Still the caller's own tenant only, at most 1000 rows per table
-- per call.
CREATE OR REPLACE FUNCTION app.prune_operational_rows(p_workspace_id uuid, p_now timestamptz)
RETURNS TABLE(table_name text, deleted integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	n integer;
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;

	-- Completed jobs after 30 days (their alerts go with them by cascade).
	DELETE FROM app.outbox_jobs j WHERE j.ctid IN (
		SELECT x.ctid FROM app.outbox_jobs x
		WHERE x.workspace_id = p_workspace_id AND x.status = 'completed'
			AND coalesce(x.completed_at, x.updated_at) < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_jobs'; deleted := n; RETURN NEXT;

	-- Resolved alerts after 30 days.
	DELETE FROM app.outbox_job_alerts a WHERE a.ctid IN (
		SELECT x.ctid FROM app.outbox_job_alerts x
		WHERE x.workspace_id = p_workspace_id AND x.resolved_at < p_now - interval '30 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'outbox_job_alerts'; deleted := n; RETURN NEXT;

	-- Applied email provider events after 180 days.
	DELETE FROM app.email_provider_events p WHERE p.ctid IN (
		SELECT x.ctid FROM app.email_provider_events x
		WHERE x.workspace_id = p_workspace_id AND x.applied_at < p_now - interval '180 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'email_provider_events'; deleted := n; RETURN NEXT;

	-- Idempotency keys after 7 days, pending or completed.
	DELETE FROM app.idempotency_keys k WHERE k.ctid IN (
		SELECT x.ctid FROM app.idempotency_keys x
		WHERE x.workspace_id = p_workspace_id AND x.created_at < p_now - interval '7 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'idempotency_keys'; deleted := n; RETURN NEXT;

	-- Automation runs after 90 days.
	DELETE FROM app.automation_runs r WHERE r.ctid IN (
		SELECT x.ctid FROM app.automation_runs x
		WHERE x.workspace_id = p_workspace_id AND x.created_at < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_runs'; deleted := n; RETURN NEXT;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.prune_operational_rows(uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.prune_operational_rows(uuid, timestamptz) TO app_runtime;
