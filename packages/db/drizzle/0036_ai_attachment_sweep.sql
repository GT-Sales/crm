-- Ask AI's saved chat: the daily sweep of attachments that were never sent.
--
-- A member uploads a file before sending the message that carries it; a file
-- left unsent (the tab closed, the message abandoned) is removed a day later,
-- its row here and its stored object by the backend. app.ai_attachments has
-- an owner policy (0034), so the scheduler's machine actor sees no member's
-- row and cannot delete one with its own grants. This function does it for
-- the transaction's own site only, and returns the bucket and key of every
-- row it removed so the backend deletes the objects after the commit (a
-- blind delete here would leave them behind, which is why 0035 left
-- prune_operational_rows alone).
--
-- Guards, as prune_operational_rows and automation_overdue_sites have them:
-- the site must be the transaction's own (app.workspace_id), an actor must be
-- set, the batch is bounded, and a file younger than a day is never removed,
-- whatever cutoff the caller passes. A file a turn is linking right now is
-- locked by that turn and skipped, and a sent file (message_id set) is never
-- touched: it goes only with its conversation.
CREATE OR REPLACE FUNCTION app.sweep_unsent_ai_attachments(
	p_workspace_id uuid,
	p_before timestamptz,
	p_limit integer
)
RETURNS TABLE(bucket text, object_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_column
DECLARE
	v_cutoff timestamptz;
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF nullif(pg_catalog.current_setting('app.actor_id', true), '') IS NULL THEN
		RAISE EXCEPTION 'actor_context_missing' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
		RAISE EXCEPTION 'limit_out_of_range' USING ERRCODE = 'invalid_parameter_value';
	END IF;
	v_cutoff := LEAST(coalesce(p_before, pg_catalog.now()), pg_catalog.now() - interval '1 day');

	RETURN QUERY
	WITH doomed AS (
		SELECT x.ctid AS row_ctid
		FROM app.ai_attachments x
		WHERE x.workspace_id = p_workspace_id
			AND x.message_id IS NULL
			AND x.created_at < v_cutoff
		ORDER BY x.created_at
		LIMIT p_limit
		FOR UPDATE SKIP LOCKED
	), gone AS (
		DELETE FROM app.ai_attachments a
		WHERE a.ctid IN (SELECT d.row_ctid FROM doomed d)
			AND a.workspace_id = p_workspace_id
			AND a.message_id IS NULL
		RETURNING a.bucket, a.object_key
	)
	SELECT g.bucket, g.object_key FROM gone g;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.sweep_unsent_ai_attachments(uuid, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.sweep_unsent_ai_attachments(uuid, timestamptz, integer) TO app_runtime;
