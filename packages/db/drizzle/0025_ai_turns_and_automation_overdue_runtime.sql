-- Ask AI turn records (CHAT-6): runtime may add and read a site's own rows,
-- never change or delete them; retention removes them after 90 days.
ALTER TABLE app.ai_turns FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
GRANT SELECT, INSERT ON app.ai_turns TO app_runtime;

--> statement-breakpoint
-- Preserve the existing tenant guard and pruning windows, adding AI turn records.
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

	-- Ask AI turn records after 90 days.
	DELETE FROM app.ai_turns t WHERE t.ctid IN (
		SELECT x.ctid FROM app.ai_turns x
		WHERE x.workspace_id = p_workspace_id AND x.created_at < p_now - interval '90 days'
		LIMIT 1000);
	GET DIAGNOSTICS n = ROW_COUNT;
	table_name := 'ai_turns'; deleted := n; RETURN NEXT;
END;
$function$;

--> statement-breakpoint
-- ENG-4: every site with automation work that should already have run. The
-- scheduler works only the sites its machine entry lists; a site missing
-- there would leave its waits and timers pending forever. This answers, across
-- sites, which sites have pending work due before p_before: ids and counts
-- only, never a lead or a flow. Any verified actor may ask (the scheduler runs
-- it as its machine actor before any tenant context).
CREATE OR REPLACE FUNCTION app.automation_overdue_sites(p_before timestamptz)
RETURNS TABLE(workspace_id uuid, waits integer, timers integer, oldest timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
	IF nullif(pg_catalog.current_setting('app.actor_id', true), '') IS NULL THEN
		RAISE EXCEPTION 'actor_context_missing' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN QUERY
	SELECT due.workspace_id,
		(count(*) FILTER (WHERE due.kind = 'wait'))::integer,
		(count(*) FILTER (WHERE due.kind = 'timer'))::integer,
		min(due.at)
	FROM (
		SELECT w.workspace_id, 'wait'::text AS kind, w.resume_at AS at
		FROM app.automation_waits w
		WHERE w.status = 'pending' AND w.resume_at < p_before
		UNION ALL
		SELECT t.workspace_id, 'timer'::text, t.due_at
		FROM app.automation_timers t
		WHERE t.status = 'pending' AND t.due_at < p_before
	) due
	GROUP BY due.workspace_id
	ORDER BY min(due.at), due.workspace_id;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_overdue_sites(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_overdue_sites(timestamptz) TO app_runtime;
