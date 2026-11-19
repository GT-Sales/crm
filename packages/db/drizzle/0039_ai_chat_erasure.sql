ALTER TABLE "app"."ai_messages" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
-- Audit B2 and C13: a customer's data restriction or erasure reaches Ask AI's
-- saved chats, and the chats of someone who left a site are deleted.
--
-- app.ai_messages is insert-only for the runtime role (0035) and the three
-- chat tables have an owner policy (0034) under FORCE RLS, so the scheduler's
-- machine actor sees no member's row. These SECURITY DEFINER functions do the
-- few things it needs, for the transaction's own site only, each bounded, as
-- app.erase_restricted_lead_data (0030) and app.sweep_unsent_ai_attachments
-- (0036) do. They run as the migration role (BYPASSRLS), with an empty
-- search_path.
--
-- 1. app.erase_restricted_lead_ai_turns: for leads of this site that are
--    already restricted, the turns that name them lose their text. A turn is
--    named when its answer's stored source cards link the lead (`lead-<id>`,
--    or an href ending in `/leads/<id>`), or when either side's text holds the
--    lead's server-assigned order number (`MS-<n>`, matched whole, case
--    insensitive). Both rows of the turn (paired by request id) keep their
--    place with empty text, no sources, no follow-up and `erased_at` set; a
--    text file's decoded text on the question goes too, and a title that came
--    from an erased first question (or holds the number) is replaced. Names
--    are never matched: a name is not unique, and a fuzzy match would remove
--    unrelated text.
-- 2. app.erased_ai_attachments / app.delete_erased_ai_attachments: the files
--    of erased turns, listed for the backend to delete their objects first,
--    then their rows.
-- 3. app.departed_ai_conversations / app.delete_departed_ai_conversations:
--    conversations of an actor who has no active membership on the site and
--    whose membership was revoked before the cutoff (or who has none), listed
--    with their files' objects, then deleted once those objects are gone.
CREATE OR REPLACE FUNCTION app.erase_restricted_lead_ai_turns(
	p_workspace_id uuid,
	p_lead_ids uuid[]
)
RETURNS TABLE(messages integer, conversations integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	v_leads text[];
	v_cards text[];
	v_refs text[];
	v_pattern text;
	v_erased uuid[];
	v_conversations uuid[];
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF p_lead_ids IS NULL OR pg_catalog.cardinality(p_lead_ids) > 1000 THEN
		RAISE EXCEPTION 'too_many_ids' USING ERRCODE = 'invalid_parameter_value';
	END IF;

	SELECT
		coalesce(pg_catalog.array_agg(l.id::text), '{}'),
		coalesce(pg_catalog.array_agg('lead-' || l.id::text), '{}'),
		coalesce(pg_catalog.array_agg(l.external_ref) FILTER (WHERE l.external_ref ~ '^MS-[0-9]{1,12}$'), '{}')
	INTO v_leads, v_cards, v_refs
	FROM app.leads l
	WHERE l.workspace_id = p_workspace_id
		AND l.id = ANY (p_lead_ids)
		AND l.customer_data_restricted_at IS NOT NULL;

	messages := 0;
	conversations := 0;
	IF pg_catalog.cardinality(v_leads) = 0 THEN
		RETURN NEXT;
		RETURN;
	END IF;
	-- Only `MS-` and digits reach the pattern, so nothing in it is a regex operator.
	IF pg_catalog.cardinality(v_refs) > 0 THEN
		v_pattern := '(^|[^[:alnum:]])(' || pg_catalog.array_to_string(v_refs, '|') || ')($|[^[:alnum:]])';
	END IF;

	WITH hit AS (
		SELECT m.id, m.conversation_id, m.request_id
		FROM app.ai_messages m
		WHERE m.workspace_id = p_workspace_id
			AND m.erased_at IS NULL
			AND (
				(m.role = 'assistant' AND EXISTS (
					SELECT 1 FROM pg_catalog.jsonb_array_elements(m.sources) s
					WHERE pg_catalog.jsonb_typeof(s) = 'object'
						AND ((s ->> 'id') = ANY (v_cards)
							OR pg_catalog.lower(pg_catalog.substring(s ->> 'href', '/leads/([0-9A-Fa-f-]{36})$')) = ANY (v_leads))
				))
				OR (v_pattern IS NOT NULL AND m.text ~* v_pattern)
			)
	), turn AS (
		SELECT x.id
		FROM app.ai_messages x
		JOIN hit h
			ON x.workspace_id = p_workspace_id
			AND x.conversation_id = h.conversation_id
			AND (x.id = h.id OR (h.request_id IS NOT NULL AND x.request_id = h.request_id))
	), erased AS (
		UPDATE app.ai_messages m
		SET text = '', sources = '[]'::jsonb, follow_up = NULL, erased_at = pg_catalog.clock_timestamp()
		WHERE m.workspace_id = p_workspace_id
			AND m.erased_at IS NULL
			AND m.id IN (SELECT t.id FROM turn t)
		RETURNING m.id, m.conversation_id
	)
	SELECT coalesce(pg_catalog.array_agg(e.id), '{}'), coalesce(pg_catalog.array_agg(DISTINCT e.conversation_id), '{}')
	INTO v_erased, v_conversations
	FROM erased e;

	messages := pg_catalog.cardinality(v_erased);
	conversations := pg_catalog.cardinality(v_conversations);
	IF messages = 0 THEN
		RETURN NEXT;
		RETURN;
	END IF;

	-- A text file's decoded text is the file's content: it goes now; the file
	-- itself (object, then row) is deleted by the backend's next cleanup.
	UPDATE app.ai_attachments a SET extracted_text = NULL
	WHERE a.workspace_id = p_workspace_id
		AND a.message_id = ANY (v_erased)
		AND a.extracted_text IS NOT NULL;

	-- A title is the first question's opening words unless renamed: replaced
	-- when that question was erased, or when it holds an erased number.
	UPDATE app.ai_conversations c
	SET title = 'Chat with a removed message', updated_at = pg_catalog.now()
	WHERE c.workspace_id = p_workspace_id
		AND c.id = ANY (v_conversations)
		AND (
			(v_pattern IS NOT NULL AND c.title ~* v_pattern)
			OR EXISTS (
				SELECT 1 FROM (
					SELECT f.id FROM app.ai_messages f
					WHERE f.workspace_id = p_workspace_id AND f.conversation_id = c.id AND f.role = 'user'
					ORDER BY f.created_at, f.id
					LIMIT 1
				) first_question
				WHERE first_question.id = ANY (v_erased)
			)
		);

	RETURN NEXT;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.erase_restricted_lead_ai_turns(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.erase_restricted_lead_ai_turns(uuid, uuid[]) TO app_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.erased_ai_attachments(
	p_workspace_id uuid,
	p_limit integer
)
RETURNS TABLE(id uuid, bucket text, object_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_column
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
	RETURN QUERY
	SELECT a.id, a.bucket, a.object_key
	FROM app.ai_attachments a
	JOIN app.ai_messages m
		ON m.workspace_id = a.workspace_id AND m.conversation_id = a.conversation_id AND m.id = a.message_id
	WHERE a.workspace_id = p_workspace_id AND m.erased_at IS NOT NULL
	ORDER BY a.created_at, a.id
	LIMIT p_limit;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.erased_ai_attachments(uuid, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.erased_ai_attachments(uuid, integer) TO app_runtime;
--> statement-breakpoint
-- Only a file of an erased turn, and only on this site: the backend calls it
-- with the ids whose objects it has deleted.
CREATE OR REPLACE FUNCTION app.delete_erased_ai_attachments(
	p_workspace_id uuid,
	p_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	v_count integer;
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF nullif(pg_catalog.current_setting('app.actor_id', true), '') IS NULL THEN
		RAISE EXCEPTION 'actor_context_missing' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) > 1000 THEN
		RAISE EXCEPTION 'too_many_ids' USING ERRCODE = 'invalid_parameter_value';
	END IF;
	DELETE FROM app.ai_attachments a
	USING app.ai_messages m
	WHERE a.workspace_id = p_workspace_id
		AND a.id = ANY (p_ids)
		AND m.workspace_id = a.workspace_id AND m.conversation_id = a.conversation_id AND m.id = a.message_id
		AND m.erased_at IS NOT NULL;
	GET DIAGNOSTICS v_count = ROW_COUNT;
	RETURN v_count;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delete_erased_ai_attachments(uuid, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delete_erased_ai_attachments(uuid, uuid[]) TO app_runtime;
--> statement-breakpoint
-- Conversations of an actor who has left the site: no active membership on it,
-- and either a revoked membership whose revocation is older than the cutoff or
-- no membership row at all; the conversation itself untouched since the
-- cutoff too. A cutoff less than a day ago is moved back to a day ago, so a
-- member removed by mistake and added back the same day never loses a chat.
-- One row per file (bucket and key set), or one row with null bucket and key
-- for a conversation without files; at most p_limit conversations.
CREATE OR REPLACE FUNCTION app.departed_ai_conversations(
	p_workspace_id uuid,
	p_before timestamptz,
	p_limit integer
)
RETURNS TABLE(conversation_id uuid, bucket text, object_key text)
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
	WITH departed AS (
		SELECT c.id
		FROM app.ai_conversations c
		WHERE c.workspace_id = p_workspace_id
			AND c.last_message_at < v_cutoff
			AND NOT EXISTS (
				SELECT 1 FROM app.memberships ms
				WHERE ms.workspace_id = p_workspace_id AND ms.user_id = c.actor_id
					AND (ms.status <> 'revoked' OR coalesce(ms.revoked_at, 'infinity'::timestamptz) >= v_cutoff)
			)
		ORDER BY c.last_message_at, c.id
		LIMIT p_limit
	)
	SELECT d.id, a.bucket, a.object_key
	FROM departed d
	LEFT JOIN app.ai_attachments a ON a.workspace_id = p_workspace_id AND a.conversation_id = d.id;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.departed_ai_conversations(uuid, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.departed_ai_conversations(uuid, timestamptz, integer) TO app_runtime;
--> statement-breakpoint
-- Deletes the listed conversations (messages and files by cascade) that are
-- still departed by the same rule, locked first; the backend passes only the
-- ones whose objects it has deleted.
CREATE OR REPLACE FUNCTION app.delete_departed_ai_conversations(
	p_workspace_id uuid,
	p_before timestamptz,
	p_ids uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
	v_cutoff timestamptz;
	v_count integer;
BEGIN
	IF p_workspace_id IS DISTINCT FROM nullif(pg_catalog.current_setting('app.workspace_id', true), '')::uuid THEN
		RAISE EXCEPTION 'workspace_context_mismatch' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF nullif(pg_catalog.current_setting('app.actor_id', true), '') IS NULL THEN
		RAISE EXCEPTION 'actor_context_missing' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF p_ids IS NULL OR pg_catalog.cardinality(p_ids) > 1000 THEN
		RAISE EXCEPTION 'too_many_ids' USING ERRCODE = 'invalid_parameter_value';
	END IF;
	v_cutoff := LEAST(coalesce(p_before, pg_catalog.now()), pg_catalog.now() - interval '1 day');
	DELETE FROM app.ai_conversations c
	WHERE c.id IN (
		SELECT l.id FROM app.ai_conversations l
		WHERE l.workspace_id = p_workspace_id
			AND l.id = ANY (p_ids)
			AND l.last_message_at < v_cutoff
			AND NOT EXISTS (
				SELECT 1 FROM app.memberships ms
				WHERE ms.workspace_id = p_workspace_id AND ms.user_id = l.actor_id
					AND (ms.status <> 'revoked' OR coalesce(ms.revoked_at, 'infinity'::timestamptz) >= v_cutoff)
			)
		FOR UPDATE
	)
		AND c.workspace_id = p_workspace_id;
	GET DIAGNOSTICS v_count = ROW_COUNT;
	RETURN v_count;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.delete_departed_ai_conversations(uuid, timestamptz, uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.delete_departed_ai_conversations(uuid, timestamptz, uuid[]) TO app_runtime;
--> statement-breakpoint
-- Leads restricted before this migration: their turns are erased now, a
-- thousand leads at a time per site, through the same function. Later
-- restrictions call it in their own transaction (retention/abandoned-leads.ts).
DO $catchup$
DECLARE
	v_site uuid;
	v_batch uuid[];
BEGIN
	FOR v_site IN SELECT DISTINCT c.workspace_id FROM app.ai_conversations c LOOP
		PERFORM pg_catalog.set_config('app.workspace_id', v_site::text, true);
		FOR v_batch IN
			SELECT pg_catalog.array_agg(r.id)
			FROM (
				SELECT l.id, (pg_catalog.row_number() OVER (ORDER BY l.id) - 1) / 1000 AS chunk
				FROM app.leads l
				WHERE l.workspace_id = v_site AND l.customer_data_restricted_at IS NOT NULL
			) r
			GROUP BY r.chunk
		LOOP
			PERFORM app.erase_restricted_lead_ai_turns(v_site, v_batch);
		END LOOP;
	END LOOP;
	PERFORM pg_catalog.set_config('app.workspace_id', '', true);
END;
$catchup$;
