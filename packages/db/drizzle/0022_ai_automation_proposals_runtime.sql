-- Actor-owned temporary proposals. Runtime can only change its own rows under RLS.
ALTER TABLE app.ai_automation_proposals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON app.ai_automation_proposals TO app_runtime;

--> statement-breakpoint
-- Preserve the existing tenant guard and pruning windows, adding temporary AI drafts.
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

	-- Automation runs 90 days after they finish; a waiting run is never
	-- pruned. Their step runs and their resumed or cancelled waits go with
	-- them by cascade.
	DELETE FROM app.automation_runs r WHERE r.ctid IN (
		SELECT x.ctid FROM app.automation_runs x
		WHERE x.workspace_id = p_workspace_id AND x.status <> 'waiting'
			AND coalesce(x.finished_at, x.created_at) < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_runs'; deleted := n; RETURN NEXT;

	-- Fired and void automation timers 90 days after they ended.
	DELETE FROM app.automation_timers t WHERE t.ctid IN (
		SELECT x.ctid FROM app.automation_timers x
		WHERE x.workspace_id = p_workspace_id AND x.status IN ('fired', 'void')
			AND x.updated_at < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'automation_timers'; deleted := n; RETURN NEXT;

	-- Tracking challenges 24 hours after they expire, consumed or not.
	DELETE FROM app.tracking_challenges c WHERE c.ctid IN (
		SELECT x.ctid FROM app.tracking_challenges x
		WHERE x.workspace_id = p_workspace_id AND x.expires_at < p_now - interval '1 day'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'tracking_challenges'; deleted := n; RETURN NEXT;
  -- AI proposals and save receipts expire from storage after one day.
  DELETE FROM app.ai_automation_proposals p WHERE p.ctid IN (
    SELECT x.ctid FROM app.ai_automation_proposals x
    WHERE x.workspace_id = p_workspace_id AND x.created_at < p_now - interval '1 day'
    LIMIT 1000);
  GET DIAGNOSTICS n = ROW_COUNT;
  table_name := 'ai_automation_proposals'; deleted := n; RETURN NEXT;
END;
$function$;
