-- Hand-written companion to 0019_automation_flows (AGENTS.md rule 3): FORCE
-- RLS and the runtime grants on the four new automation tables, UPDATE of
-- five columns of app.automation_runs (a run moves from waiting to its end),
-- the circular FK from a flow to its live version, the guard that keeps an
-- activated version fixed, the six built-in default definitions and names, the
-- notification address function, the conversion of the phase 4 rows into
-- flows (merge phase 8, spec §6) and, last, the retention of runs and timers.
-- backup_reader needs no grant here: 0007's default privileges make every new
-- app table readable, and each table's read policy comes from schema.ts in
-- 0019. Every statement is safe to run twice.

ALTER TABLE "app"."automation_versions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."automation_step_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."automation_waits" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "app"."automation_timers" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- No DELETE anywhere: finished runs and old timers go through
-- prune_operational_rows() below, step runs and waits with their run, and
-- everything with its site. Step runs are append-only.
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automation_versions" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "app"."automation_step_runs" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automation_waits" TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "app"."automation_timers" TO app_runtime;
--> statement-breakpoint
-- Loosens phase 4's append-only run log, column by column: a run moves from
-- waiting to its end (status, reason, detail, updated_at, finished_at); its
-- key, lead, job, outcome, occurrence, version and chain never change. The
-- REVOKE first drops any table-wide UPDATE so only these columns remain.
REVOKE UPDATE ON TABLE "app"."automation_runs" FROM app_runtime;
--> statement-breakpoint
GRANT UPDATE (status, reason, detail, updated_at, finished_at) ON TABLE "app"."automation_runs" TO app_runtime;
--> statement-breakpoint

-- A flow's live version. The two tables reference each other, so the FK is
-- added here rather than generated from schema.ts.
DO $do$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_catalog.pg_constraint
		WHERE conname = 'automations_active_version_fk'
			AND conrelid = 'app.automations'::regclass
	) THEN
		ALTER TABLE app.automations
			ADD CONSTRAINT automations_active_version_fk
			FOREIGN KEY (workspace_id, active_version_id)
			REFERENCES app.automation_versions (workspace_id, id);
	END IF;
END
$do$;
--> statement-breakpoint

-- An activated version never changes under a run waiting on it. A version's
-- identity (site, flow, number, schema version, author) never changes. A
-- draft may be rewritten and becomes active or discarded; an active version
-- may only be retired; a retired or discarded one is final. Once activated,
-- who activated it and when stay as they were. Anything else raises
-- automation_version_immutable (SQLSTATE 23514), whatever the code asks.
CREATE OR REPLACE FUNCTION app.guard_automation_version_definition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
	IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
		OR NEW.automation_id IS DISTINCT FROM OLD.automation_id
		OR NEW.version IS DISTINCT FROM OLD.version
		OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
		OR NEW.created_by IS DISTINCT FROM OLD.created_by
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'automation_version_immutable' USING ERRCODE = '23514';
	END IF;
	IF OLD.status = 'draft' THEN
		IF NEW.status NOT IN ('draft', 'active', 'discarded') THEN
			RAISE EXCEPTION 'automation_version_immutable' USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;
	IF NEW.definition IS DISTINCT FROM OLD.definition
		OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
		OR NEW.activated_by IS DISTINCT FROM OLD.activated_by
		OR (NEW.status IS DISTINCT FROM OLD.status
			AND NOT (OLD.status = 'active' AND NEW.status = 'retired'))
		OR (OLD.status IN ('retired', 'discarded')
			AND NEW.retired_at IS DISTINCT FROM OLD.retired_at) THEN
		RAISE EXCEPTION 'automation_version_immutable' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER automation_versions_definition_guard
	BEFORE UPDATE ON app.automation_versions
	FOR EACH ROW EXECUTE FUNCTION app.guard_automation_version_definition();
--> statement-breakpoint

-- The six built-ins' version-1 definitions, a literal copy of contracts'
-- builtInFlowDefinition(key) (tied to it by
-- apps/backend/tests/automation-sql-contracts.integration.test.ts); null for
-- any other key.
CREATE OR REPLACE FUNCTION app.builtin_flow_definition(p_key text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE p_key
    WHEN 'order_received' THEN '{"schemaVersion": 1, "trigger": {"kind": "lead_submitted", "leadTypes": ["sim_order", "internet", "mobility"], "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "order_received"}]}'::jsonb
    WHEN 'sim_order_information_needed' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "on_hold", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "information_needed"}]}'::jsonb
    WHEN 'sim_order_dispatched' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "delivered", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "dispatched"}]}'::jsonb
    WHEN 'sim_order_activated' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "activated", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "activated"}]}'::jsonb
    WHEN 'sim_order_cancelled' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "sim_order", "stage": "cancelled", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "cancelled"}]}'::jsonb
    WHEN 'mobility_activated' THEN '{"schemaVersion": 1, "trigger": {"kind": "stage_entered", "leadType": "mobility", "stage": "activated", "when": null}, "steps": [{"id": "main", "kind": "send_email", "template": "activated"}]}'::jsonb
  END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.builtin_flow_definition(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.builtin_flow_definition(text) TO app_runtime;
--> statement-breakpoint

-- The six built-ins' default names, a literal copy of contracts'
-- builtInFlowName(key) (their labels; tied to it by the same test); null for
-- any other key.
CREATE OR REPLACE FUNCTION app.builtin_flow_name(p_key text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $function$
  SELECT CASE p_key
    WHEN 'order_received' THEN 'When an order is submitted on the website → send the Order received email'
    WHEN 'sim_order_information_needed' THEN 'When a SIM order moves to On hold → send the Information needed email'
    WHEN 'sim_order_dispatched' THEN 'When a SIM order moves to Delivered → send the Dispatched email'
    WHEN 'sim_order_activated' THEN 'When a SIM order moves to Activated → send the Activated email'
    WHEN 'sim_order_cancelled' THEN 'When a SIM order moves to Cancelled → send the Cancelled email'
    WHEN 'mobility_activated' THEN 'When a mobility order moves to Activated → send the Activated email'
  END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.builtin_flow_name(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.builtin_flow_name(text) TO app_runtime;
--> statement-breakpoint

-- Where a flow's staff notification goes (spec ruling R9): the verified
-- sign-in address, written on every active staff membership of the signed-in
-- actor (app.actor_id) whose address is missing or different. Sign-in runs in
-- an actor-only transaction, where the tenant policy on memberships sees no
-- row, hence SECURITY DEFINER. An address the CHECK would refuse writes
-- nothing. Returns the rows changed.
CREATE OR REPLACE FUNCTION app.record_staff_notification_email(p_verified_email text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	v_actor uuid := nullif(pg_catalog.current_setting('app.actor_id', true), '')::uuid;
	v_email text := pg_catalog.lower(pg_catalog.btrim(p_verified_email));
	n integer;
BEGIN
	IF v_actor IS NULL THEN
		RAISE EXCEPTION 'verified actor context is required' USING ERRCODE = '42501';
	END IF;
	IF v_email IS NULL OR pg_catalog.char_length(v_email) NOT BETWEEN 1 AND 254
		OR v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
		RETURN 0;
	END IF;
	UPDATE app.memberships
	SET notification_email = v_email
	WHERE user_id = v_actor
		AND membership_type = 'staff'
		AND status = 'active'
		AND notification_email IS DISTINCT FROM v_email;
	GET DIAGNOSTICS n = ROW_COUNT;
	RETURN n;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.record_staff_notification_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.record_staff_notification_email(text) TO app_runtime;
--> statement-breakpoint

-- The conversion (spec §6): each existing rule row becomes a built-in flow
-- with its label as its name and version 1 active, and each phase 4 run is
-- tied to it. Each statement touches only rows it has not converted yet.
UPDATE app.automations
SET name = app.builtin_flow_name(key)
WHERE origin = 'builtin' AND name IS NULL AND app.builtin_flow_name(key) IS NOT NULL;
--> statement-breakpoint
INSERT INTO app.automation_versions
	(workspace_id, automation_id, version, status, schema_version, definition, created_by,
	 activated_by, activated_at)
SELECT a.workspace_id, a.id, 1, 'active', 1, app.builtin_flow_definition(a.key), a.updated_by,
	NULL, now()
FROM app.automations a
WHERE a.origin = 'builtin'
	AND a.active_version_id IS NULL
	AND app.builtin_flow_definition(a.key) IS NOT NULL
	AND NOT EXISTS (
		SELECT 1 FROM app.automation_versions v
		WHERE v.workspace_id = a.workspace_id AND v.automation_id = a.id
	);
--> statement-breakpoint
UPDATE app.automations a
SET active_version_id = v.id
FROM app.automation_versions v
WHERE a.active_version_id IS NULL
	AND v.workspace_id = a.workspace_id
	AND v.automation_id = a.id
	AND v.status = 'active';
--> statement-breakpoint
UPDATE app.automation_runs r
SET automation_id = a.id
FROM app.automations a
WHERE r.automation_id IS NULL
	AND a.workspace_id = r.workspace_id
	AND a.key = r.automation_key;
--> statement-breakpoint
UPDATE app.automation_runs r
SET status = CASE r.outcome WHEN 'queued' THEN 'completed' ELSE 'skipped' END,
	finished_at = r.created_at
WHERE r.outcome IS NOT NULL AND r.finished_at IS NULL;
--> statement-breakpoint
UPDATE app.automation_runs r
SET version_id = a.active_version_id
FROM app.automations a
WHERE r.outcome IS NOT NULL
	AND r.version_id IS NULL
	AND a.workspace_id = r.workspace_id
	AND a.id = r.automation_id
	AND a.active_version_id IS NOT NULL;
--> statement-breakpoint
-- A queued run's occurrence is the third part of its job's dedupe key
-- (<lead>:<key>:<occurrence>), where the job is still there; one run per
-- occurrence at most, as the new unique index requires.
UPDATE app.automation_runs r
SET occurrence = s.occurrence
FROM (
	SELECT DISTINCT ON (x.workspace_id, x.automation_key, x.lead_id, split_part(j.dedupe_key, ':', 3))
		x.id, split_part(j.dedupe_key, ':', 3) AS occurrence
	FROM app.automation_runs x
	JOIN app.outbox_jobs j ON j.workspace_id = x.workspace_id AND j.id = x.job_id
	WHERE x.outcome = 'queued'
		AND x.occurrence IS NULL
		AND split_part(j.dedupe_key, ':', 3) <> ''
		AND char_length(split_part(j.dedupe_key, ':', 3)) <= 200
	ORDER BY x.workspace_id, x.automation_key, x.lead_id, split_part(j.dedupe_key, ':', 3), x.created_at, x.id
) s
WHERE r.id = s.id
	AND NOT EXISTS (
		SELECT 1 FROM app.automation_runs o
		WHERE o.workspace_id = r.workspace_id
			AND o.automation_key = r.automation_key
			AND o.lead_id = r.lead_id
			AND o.occurrence = s.occurrence
	);
--> statement-breakpoint

-- 0018's pruning, except that automation runs go 90 days after they finish
-- (a waiting run is never pruned) and fired or void timers 90 days after
-- they ended. Still the caller's own tenant only, at most 1000 rows per table
-- per call. This replacement is the statement the owner pastes by hand
-- (docs/RUNBOOKS/database.md), OWNER PASTE.
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
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.prune_operational_rows(uuid, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.prune_operational_rows(uuid, timestamptz) TO app_runtime;
