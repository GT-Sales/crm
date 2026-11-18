# Ask AI as a saved chat — design and decisions

Ask AI's stored conversations, the files a member attaches to a message and the
owner's usage page: what they are, who can read what and where that is
enforced, what is stored, and what leaves the system. The assistant's own
trust boundaries, tools, projections and turn limits are unchanged and are in
[ai-assistant.md](ai-assistant.md); confirmed cards are in
[ai-actions.md](ai-actions.md) and [interactive-ai.md](interactive-ai.md).
Operation is in `docs/RUNBOOKS/ai-assistant.md` §12; the migrations in
`docs/RUNBOOKS/database.md` (0034–0036).

## 1. What it is

Ask AI is a chat with a history. The full page (`/w/<site>/chat`) lists the
member's conversations on the left and shows one on the right; the header's
side panel shows the same current conversation for a quick question on any
screen and opens it as a full page. A conversation is created by its first
message, kept on the server, and reopened from any browser the member signs
in on. A member may attach images, PDFs and text files to a message and ask
about them in that chat. The owner sees, under Settings → AI usage, how many
turns and tokens each member used, which models served them, how turns ended
and why they failed, never what was asked.

All of it is additive: a backend that does not store conversations, or a
database without migrations 0034 and 0035, leaves Ask AI exactly as it is in
memory only (§8).

## 2. Owner decisions

1. **Private to the member.** A conversation and its files belong to the staff
   member who had them, on one site. Nobody else can read them: not another
   member, not the owner.
2. **Kept until deleted.** Conversations, their messages and their files are
   kept until the member deletes the conversation. Nothing prunes them.
3. **The owner sees usage only**: turns and tokens per member, from
   `app.ai_turns`, never content.
4. **Files are asked about in the chat** and belong to the conversation that
   carries them. They are never attached to a lead, never become a lead's
   document and are never in `app.files`.
5. **The subject scope is unchanged.** The same tools, system prompt rules and
   refusal of unrelated subjects; an attached file is material for a CRM
   question, not an instruction and not a widening of what Ask AI answers.

## 3. Trust boundaries and where they are enforced

| Boundary                                  | Enforced in                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may use the saved chat at all         | Every conversation and attachment route runs the capabilities guard: verified session, live membership read, `decideAiAccess`, then `AI_ASSISTANT_ENABLED` and the site allowlist (`guard` in `routes/ai-conversations.ts`). A member whose assistant access was removed gets 403 on all of them, their own conversations included.                                                                      |
| A row is the member's, on this site       | The three tables' **owner policy** (`ownerPolicy` in `packages/db/src/schema.ts`): `USING` and `WITH CHECK` pin both `workspace_id = app.workspace_id` and `actor_id = app.actor_id`, under FORCE RLS. The owner's transaction sees only the owner's rows.                                                                                                                                               |
| A message or file joins only its own chat | **Member-carrying foreign keys**: `ai_messages (workspace_id, actor_id, conversation_id)` and `ai_attachments (workspace_id, actor_id, conversation_id)` reference `ai_conversations (workspace_id, actor_id, id)`, so a row naming a colleague's conversation fails with SQLSTATE 23503; an attachment's message key is `(workspace_id, conversation_id, message_id)`.                                  |
| The boundary never rests on row security  | **Explicit filters**: every statement in `ai/conversation-store.ts` and `ai/attachment-store.ts` names `workspace_id` and `actor_id` itself, inside `withTenantTx` as the member.                                                                                                                                                                                                                        |
| Someone else's id reads as no id          | **404, never 403**: a conversation that is not the caller's is `conversation_not_found` and a file `file_not_found`, exactly as an unknown id. A browser-chosen id that a colleague already holds is invisible under the policy; the insert does nothing (`on conflict (id) do nothing`), the read finds nothing, and the answer is 404. A key violation that races past the reads is mapped to 404 too. |
| The one read across members               | `GET …/ai/usage`, guarded by `staff.remove` (the Team page's member management, owner only, no permission grants it). It reads `app.ai_turns` (tenant policy; counts and failure codes only) and never a conversation (`ai/usage-store.ts`); beside it, the deployment's configuration names (switch, model id, Gateway hosts, upload kinds), never a key or a URL.                                      |
| The machine sweep                         | The scheduler's actor sees no member's row; it reaches unsent files only through `app.sweep_unsent_ai_attachments` (0036): SECURITY DEFINER, empty `search_path`, the transaction's own site only, an actor required, at most 1000 rows, never a file younger than a day, never a sent file.                                                                                                             |
| Outside the runtime role                  | The policies bind `app_runtime`. The database's `postgres` role (BYPASSRLS, the SQL editor) and the `backup_reader` login (its read policy, for the encrypted nightly backup) can read every row; no product screen or route uses them.                                                                                                                                                                  |
| An attached file's content                | Data, never instructions (`ai/prompt.ts`, prompt version 12). Tools still decide from the signed-in member alone; a file cannot authorize anything.                                                                                                                                                                                                                                                      |

Every route answers `cache-control: no-store`.

## 4. Data model

Migration `0034_ai_conversations` (generated) creates the tables, their checks,
indexes, owner policies and backup read policies and adds
`ai_turns.input_tokens`; `0035_ai_conversations_runtime` forces row security
and grants; `0036_ai_attachment_sweep` adds the sweep function. Schema:
`aiConversations`, `aiMessages`, `aiAttachments` and `aiTurns.inputTokens` in
`packages/db/src/schema.ts`.

| Table              | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Never holds                                                                         | `app_runtime`                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `ai_conversations` | `id` (chosen by the browser), `workspace_id` (cascade from the site), `actor_id`, `title` (1–120 characters, one line, no control characters), `created_at`, `updated_at`, `last_message_at`. Unique `(workspace_id, actor_id, id)`; index `(workspace_id, actor_id, last_message_at desc, id desc)` for the list.                                                                                                                                                                                                                                                                                                                                                                                  | Message text                                                                        | SELECT, INSERT, UPDATE, DELETE                                                                                   |
| `ai_messages`      | `role` (`user`, `assistant`), `text` (at most 20,000 characters; may be empty for an answer), `outcome` (a question is always `completed`; an answer `completed`, `failed`, `cancelled` or `access_lost`), `error_code` (an answer's code, `^[a-z][a-z0-9_]{0,59}$`), `sources` (the answer's source cards as sent, a JSON array of at most 128 KiB), `follow_up` (at most 16 KiB), `expired_drafts` (0–100: how many cards and automation proposals the answer carried), `request_id`, `created_at` (`clock_timestamp()`), and (0037) `effort` (`normal` or `high` on both rows of a turn; null for rows written before 0037). Partial unique `(workspace_id, conversation_id, request_id, role)`. | Action cards, automation proposals or their signed tokens; tool results; file bytes | SELECT, INSERT (no UPDATE, no DELETE: a message is written once and goes only with its conversation, by cascade) |
| `ai_attachments`   | `kind` and `media_type` (checked together), `file_name` (sanitized, 1–200 characters, no control characters, `/` or `\`), `byte_size` (within its kind's limit), `sha256` (null while `pending`, required once `ready`), `bucket`, `object_key` (server-generated), `status`, `extracted_text` (a ready text file's decoded text, at most 20,000 characters), `conversation_id` and `message_id` (null together until the message that carries it is stored; only a ready file can be linked), `created_at`. Cascades from its conversation and from its message.                                                                                                                                   | An image's or PDF's bytes; a lead id; a row in `app.files`                          | SELECT, INSERT, UPDATE, DELETE                                                                                   |
| `ai_turns`         | One row of counts per turn, as before, plus `input_tokens integer not null default 0`, inside `ai_turns_counts_check`, and (0037) `effort text not null default 'normal'`, `normal` or `high`, beside the `model` that served the turn. Pruned after 90 days by `prune_operational_rows`.                                                                                                                                                                                                                                                                                                                                                                                                           | Text of any kind                                                                    | SELECT, INSERT (unchanged)                                                                                       |

All three tables have FORCE RLS, the owner policy for `app_runtime` and a
`<table>_backup_reader_read` policy, so the nightly database backup includes
them. `prune_operational_rows` does not touch them. Nothing links a
conversation to `memberships`.

## 5. A stored turn

A chat request that carries `conversationId` goes through the unchanged
access check, feature switch, rate limits and replay claim
(`routes/ai-assistant.ts`). Then, before the first stream frame, so every
refusal is an ordinary JSON error:

1. The saved chat must be available (§8), else `503 ai_unavailable`; files
   named in `attachmentIds` need attachments available, else
   `503 attachments_unavailable`.
2. `beginTurn` (`ai/conversation-store.ts`), one transaction: create the
   conversation under the browser's id on its first message (title: the
   message's first 60 characters on one line, trimmed; `New chat` if nothing
   is left) or load it, locked; refuse it when the two rows of this turn would
   pass 200 messages (`409 conversation_full`); lock and check this message's
   files (each the member's, `ready` and not yet sent, else
   `400 invalid_request`); insert the member's message with the request id
   (a second insert for the same id is `409 conflict`); link the files; move
   `last_message_at`. Nothing is written unless all of it is. Someone else's
   or an unknown id is `404 conversation_not_found`.
3. The stream sends a `conversation` part right after the first `progress`
   part, and the model is called with the replayed history (§6).

The answer's row is inserted once, when the turn ends, in the same `finally`
that records `ai_turns`:

| Turn ended                                                        | Stored answer                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Completed (a draft recovered after a failed explanation included) | `completed`: the text as streamed, the sources, the follow-up, the number of cards and proposals                         |
| Provider or internal failure                                      | `failed`: the text streamed before it, the stream's error code                                                           |
| Whole-turn timeout                                                | `failed` with `timeout`                                                                                                  |
| The member left, Stop, or the backend shutting down               | `cancelled`: the text streamed before it                                                                                 |
| Access lost during the turn                                       | `access_lost`: empty text, no sources, no follow-up, 0 drafts; what was streamed is not kept                             |
| Stopped or timed out while `beginTurn` ran                        | The question is kept with an empty `cancelled` (or `failed`, `timeout`) answer; the request answers `503 ai_unavailable` |

Stored text is clipped to 20,000 characters, and U+0000 is removed from stored
text, titles and JSON (Postgres text cannot hold it; the model received it as
typed). The answer's id is chosen when the turn starts, so `done.messageId`
names it. A failed answer write is reported to the error tracker by a fixed
code (`ai_answer_store_failed`) and never changes what the member already
received. Cards are never stored: their signed tokens expire after ten
minutes, so a reloaded answer shows its text and a line that its drafts are no
longer available.

## 6. History replay

A stored conversation replays its own store, not the browser's history (the
request's `history` must be empty). `history` in `ai/conversation-store.ts`
reads the 48 newest questions before this one, each joined to **its own**
answer by the request id both rows carry (two tabs can interleave a
conversation in time), and keeps only whole turns whose answer is `completed`:
a stopped, failed or access-lost answer is dropped with its question. A turn
whose question or answer is empty (an answer that was only a card) is skipped.
An answer is replayed as `aiAssistantHistoryText` builds it (follow-up first,
clipped to 4,000 characters) and a question clipped to 4,000 characters. The
newest turns are kept within `maxHistoryMessages` (12) and
`maxConversationChars` (16,000, counting the new message). These rows were
written by this server, so no signature is needed; the browser's
memory-only path still replays only signed answers (CHAT-2).

## 7. Attachments

**Kinds.** `image` (`image/png`, `image/jpeg`, `image/webp`, at most 5 MiB),
`pdf` (`application/pdf`, 10 MiB) and `text` (`text/plain`, `text/csv`,
`text/markdown`, 512 KiB), at most 4 per message. Which kinds are offered is
deployment configuration, `AI_ATTACHMENT_KINDS` (docs/ENV.md), because it
depends on what the model accepts; unset, nothing is offered. The documents
object store must be configured too (`R2_*`; the same bucket, `R2_BUCKET`):
without it uploads are off whatever the variable says.

**Upload → verify → ready** (`ai/attachments.ts`, on the documents feature's
pattern and adapter):

1. `POST …/ai/attachments/intents` with the browser's claim (name, media type,
   size). The claim picks the kind's limit and the upload's content type only;
   a kind that is off is `attachment_rejected` `type`, an oversize claim
   `size`. A pending row is created under a server-generated key and the
   answer is a signed PUT valid 5 minutes. 40 intents per member per site per
   hour (`ai_upload:` keys in the shared limiter; a limiter that cannot be
   reached refuses with `attachments_unavailable`).
2. The browser PUTs the bytes straight to storage. The backend never receives
   them over its JSON API, whose 64 KiB limit stays.
3. `POST …/finalize` with the SHA-256 the browser computed. The backend copies
   the upload to a key of this attempt's own, then checks that copy: size
   (the claimed size exactly, within the kind's limit), checksum and type from
   the bytes (magic numbers for images and PDFs, the detected image type kept;
   for text no binary signature, strict UTF-8, no NUL, something besides white
   space, the text clipped to 20,000 characters and stored). The row becomes
   `ready` by a compare-and-set on `pending`; a concurrent finalize that lost
   deletes its copy and answers the winner's file. A refusal deletes the copy,
   the upload and the row and answers `attachment_rejected` with `type`,
   `size`, `empty` or `unreadable`. A file already ready is returned without
   touching storage, so a later PUT to the still-valid URL never replaces the
   bytes that are served.

Objects live in the documents bucket under the site's prefix:
`workspaces/<site>/ai-attachments/<uuid>-<16 hex>/` holds the browser's
staging object `upload` and the verified copy `f-<16 hex>`. Keys and download
names never derive from the file name, which is only displayed.

**To the model** (`toModelMessages` in `ai/engine.ts`): an image or a PDF is a
file part with its bytes and verified media type, never a URL; a text file is
a delimited block added to the member's message, naming the file, whose opening
and closing lines carry a code drawn at random for each model call, so a file
cannot close its own block. A turn sends at most 6 files and 15 MiB: the new
message's first, then the most recent earlier ones in the replayed history,
until the first file that does not fit. A file past those limits, of a kind
switched off since, or that cannot be read is named to the model as not
available in this turn. Images and PDFs are read from storage per turn,
bounded by the size their row records, and never logged or kept.

**Memory budget.** A process-wide 48 MiB of attachment bytes may be held for
the model at once (`ai/attachment-budget.ts`; with the SDK's base64 copies
about 112 MiB at the peak). A turn takes its share at once or sends its images
and PDFs as not available; it never queues. Text files do not count.

**Links.** `GET …/ai/attachments/:id/link` signs a 2-minute GET for the
member's own ready file: an image inline as its verified type (for the
thumbnail), a PDF inline as `application/pdf`, a text file as a download with
`application/octet-stream`. Nothing is served as HTML. The download name is
`attachment-<12 characters of the id>.<extension>`.

**Deletion.** Deleting a conversation removes its files' objects first and
the rows (conversation, messages and files, by cascade) only once every object
is gone; a file a turn adds meanwhile is caught by a locked check and taken in
the next round (three rounds). A failed object delete leaves everything as it
was and answers a retryable 503. An unsent file can be deleted on its own: it
is first made unsendable (back to `pending`), then its objects go, then its
row; a sent file answers `409 conflict` (`attachment_sent`) and goes only with
its conversation.

**The sweep.** Unsent files more than a day old are removed by the scheduler's
hourly `document_cleanup` task, per site, through the 0036 function: rows
first (up to five batches of 200), then their objects, each delete tried up to
three times; a remaining failure logs `ai_attachment_object_delete_failed`
with the site and a count. The sweep runs whenever object storage is
configured, even with every kind switched off, and is skipped (never failed)
until 0036 is applied.

## 8. Wire and versions

The admin (Vercel) and the backend (Railway) deploy separately, so every wire
change is additive and optional (`packages/contracts/src/ai-assistant.ts`,
`ai-conversations.ts`):

- **Request**: `conversationId` (a uuid the browser generates for a new chat)
  and `attachmentIds` (at most 4). The schema itself refuses
  `conversationId` with a non-empty `history`, `attachmentIds` without
  `conversationId` (even empty) and a repeated file, as `invalid_request`.
- **Capabilities**: `conversations: true` when this backend stores
  conversations for the site, and `attachments` (`kinds`, the picker's
  `accept` list, `maxPerMessage` and the three size limits) when uploads are
  on. Absent means off.
- **Stream**: a `conversation` part (`conversationId`, `userMessageId`,
  `title`, `created`) and `done.messageId`, both sent only when the request
  carried `conversationId`: every known part is strict, so an older admin
  would drop a known part carrying a key it does not know.
- **Routes** (staff router, `/api/v1/staff/workspaces/:workspaceId/ai/…`,
  registered in `packages/contracts/src/endpoints.ts`): `GET conversations`
  (`cursor`, `limit` ≤ 30, `q` over titles; newest first; the cursor is
  `<microseconds>.<id>`, built in SQL), `GET`, `PATCH` (title) and `DELETE
conversations/:conversationId`, `POST attachments/intents`, `POST
attachments/:attachmentId/finalize`, `DELETE attachments/:attachmentId`,
  `GET attachments/:attachmentId/link`, `GET usage?period=7|30|90`. Deletes
  answer 200 with the id, as every DELETE of this API does.
- **Errors**: `conversation_not_found` (404), `conversation_full` (409),
  `attachment_rejected` (400, `details.reason`), `attachments_unavailable`
  (503), and `file_not_found` (404) for a file.
- **Effort levels** (docs/design/ai-assistant.md §8): the request's optional
  `effort` (`normal` or `high`; absent is `normal`), capabilities' optional
  `efforts` (the levels the site offers at that moment), a stored message's optional
  `effort`, and in the usage answer `totals.highEffortTurns`, each member's and
  model's `highEffortTurns` and `assistant.highEffort` (`enabled`, `model`).
  The request stays strict, so the admin sends `effort` only as `high` and only
  when capabilities list it: a Normal request is byte for byte what it was, and
  an older backend never receives the key. `high` where it is not offered is
  `400 invalid_request` with `details.reason: 'effort_unavailable'`; High's own
  rate limit is `429 ai_rate_limited` with `details.reason: 'high_effort'`.

| Admin \ backend | Older backend                                                                                                   | This backend                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Older admin     | —                                                                                                               | Sends no `conversationId`: the turn is the memory-only one, byte for byte, and nothing is stored. It ignores the two capability fields and never receives the new parts. |
| This admin      | Capabilities carry no `conversations`: the memory-only panel, no full page, no menu entry, no `conversationId`. | The saved chat, once the database is ready.                                                                                                                              |

Effort levels follow the same rule: an older admin never sends `effort` and
strips `efforts`, the stored `effort` and the usage page's High fields, so its
turns are Normal; this admin against an older backend gets no `efforts`, shows
no effort control and sends no `effort`; against this backend it offers High
when `efforts` lists it, and reads the High fields only when they are sent.

**The database's readiness** (`ai/chat-schema.ts`). Migrations are applied by
hand after the deploy, so the backend asks the catalogue, never the journal:
`conversations` needs the three tables and every grant of 0035, each privilege
asked on its own; `inputTokens` the 0034 column; `attachmentSweep` the 0036
function and its grant; `effort` the two 0037 columns. Until `conversations` holds, capabilities claim
neither `conversations` nor `attachments`, the conversation routes answer
`503 ai_unavailable`, the attachment routes `503 attachments_unavailable`, and
a chat naming a conversation `503 ai_unavailable`. Without `inputTokens` a
turn's `ai_turns` row is written without the column; without `effort` a turn's
rows are written without their `effort` columns (High turns still run, and a
stored message is read through `to_jsonb`, so its level is simply absent). A
state with all four is
cached for the life of the process; any other is asked again after 5 minutes,
so the saved chat switches itself on within 5 minutes of 0034 and 0035 being
applied, with no redeploy, and the levels are recorded within 5 minutes of 0037. The usage page needs none of this beyond the deploy: before 0034 every
turn counts 0 input tokens, and before 0037 none counts as High.

**The usage answer** (`ai/usage-store.ts`, one tenant transaction). The
period is the last 7, 30 or 90 calendar days in `America/Toronto`, today
included: from midnight in Toronto `period − 1` days ago to the end of today.
Every number counts exactly those turns, so the daily series adds up to the
totals. Four statements, each bounded on `created_at` so they read the
`(workspace_id, created_at)` index range: one per member (`members`, display
name only while an active member); one `group by grouping sets ((), (engine,
model))` for `totals` (turns, completed, failed, cancelled, tokens, tool
calls, the mean duration of completed turns) and `models` (at most 50, most
turns first; `model` null when the turn recorded none, engine `fake` on a
test deployment; a High model is its own row), each with its High turns; a `generate_series` over the Toronto days left-joined to
the day's counts for `daily` (every day present, empty days as zeros); and
the failed turns grouped by `failure_code` for `failures` (at most 20, most
frequent first, `unknown` for a turn that recorded none). `assistant` comes
from the sources `ai/capabilities` reads: `config.enabled` and the site
allowlist (`enabled`), `config.modelId` (`configuredModel`; null when unset,
and while the switch is off the model is not read), `config.providers`, and
`aiChatAvailability` (the schema probe; the attachment service's kinds) and
`highEffort` (`config.highEffort` and the site allowlist; the model that serves
High). Every
field beyond `period`, `totals`' three counts, `members` and `requestId` is
optional in the contract, so an older admin strips them and this admin shows
an older backend's answer as the page it was.

## 9. What leaves the system

As part of a turn, to the AI provider through the Gateway: everything
ai-assistant.md §6 lists, plus, in a stored conversation, the replayed stored
history (§6) and the files attached to those messages within the per-turn
limits (§7): image and PDF bytes, and a text file's decoded text. A file a
member uploads may hold anything, customer details included; it is sent
because the member attached it. The CRM's own documents, signed URLs and
contact fields are still never sent.

Kept by the CRM: the conversation text, titles, source cards and follow-ups in
`app.ai_messages` and `app.ai_conversations` (in the nightly database backup,
encrypted), the files in the documents bucket (not in the backup, §12), counts
in `app.ai_turns`. Logs and the error tracker carry codes, ids and counts,
never a title, a message, a file name or a byte.

## 10. Admin screens

| Where                                                                                    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/app/w/[workspace]/chat/`                                                 | `layout.tsx` draws the screen, so `/chat` (a new chat) and `/chat/<id>` keep it mounted while the address changes; the two pages render nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `components/ai/chat-screen.tsx`                                                          | The page: the list column (a left drawer on a phone), the thread, the composer, dropping files onto the chat. The first message of a new chat moves the address to `/chat/<id>` (the id is made in the browser).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `conversation-list.tsx`, `conversation-groups.ts`                                        | New chat, a title search, groups Today / Yesterday / Previous 7 days / Older in the viewer's time zone, rename in place, delete after a dialog saying the conversation and its files are removed for good, Load more.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chat-thread.tsx`, `assistant-message.tsx`                                               | The conversation at a reading width; a new chat greets with the site's name and the suggested questions. A stored stopped or failed answer reads as such after a reload; Retry on the last one asks again below it. An answer whose drafts expired says so.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `chat-composer.tsx`, `attachment-chip.tsx`, `attachment-files.ts`, `attachment-links.ts` | Enter sends, Shift+Enter is a new line, IME-safe; Stop; the paperclip, drop and image paste where the site offers files; a chip per file with progress or a plain-words refusal; Send waits for uploads. The browser checks type and size before asking, hashes the bytes and PUTs them with progress. Thumbnails and file links come from signed links fetched while on screen and kept in memory.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `assistant-panel.tsx`                                                                    | The side panel: the current conversation, New chat, Open full page and Close; no list and no attach control. The header trigger is hidden on the chat page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `assistant-provider.tsx`, `assistant-shared.ts`, `chat-nav.ts`, `chat-links.ts`          | One state owner for panel and page. The sidebar and Ctrl/Cmd K list "Ask AI" (after Mail) only when Ask AI is available and the backend stores conversations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `app/w/[workspace]/settings/ai-usage/`, `components/ai-usage/ai-usage-screen.tsx`        | Settings → AI usage, listed for the owner only (`settings-navigation.tsx`), over 7, 30 or 90 Toronto days: the Assistant card (on or off for the site, the model id, allowed hosts, saved conversations, upload kinds; `assistant`), the totals tiles (`totals`; failure rate, average answer time), Turns per day and Tokens per day (`daily`, labelled from the day strings, never through the viewer's zone; `usage-daily.tsx`), Models (`models`, the configured one marked Current, `fake` as "Test engine"), Why turns failed (`failures`, each code in plain words in `failure-reasons.ts`, an unknown one as "Another reason" with the code beside it) and People (`members`, most tokens first). A section whose field the backend did not send is left out. It says conversations are private and only usage is shown. |
| `apps/admin/src/lib/csp.ts`                                                              | `connect-src` includes the project's Storage origin (`<ref>.storage.supabase.co`, from `NEXT_PUBLIC_SUPABASE_URL`) for the upload PUT.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

The effort control (`effort-control.tsx`) sits beside Send in both composers
when capabilities offer High: a two-option radio group, Normal and High, in
the usage page's segmented style; choosing High shows "High effort. Takes
longer. For harder questions." The choice is the provider's, for the tab, and
never changes by itself; `buildAiChatRequest` adds `effort: 'high'` only when
it is High and offered, and Retry asks a question again at its own level. A
High answer's progress line reads _Thinking…_ from the server's progress part,
and the answer carries a _High effort_ tag beside Copy and Retry, also from the
stored `effort` after a reload. High's own rate limit reads "You have used
High effort a lot in the last hour. Ask at Normal effort, or try again in N
minutes."; a site that stopped offering High says so, its capabilities are
fetched again (the control goes), and the question is asked again, at Normal,
only on Retry. Settings → AI usage shows _High effort_ (On with its model, or
Off) on the Assistant card, a _High effort turns_ tile and a _High_ column in
Models and People when the backend sends them.

Nothing is written to `localStorage`, `sessionStorage` or IndexedDB; the
server is the store.

## 11. Limits (`AI_CHAT_LIMITS`)

| Limit                          | Value   | Meaning                                                                                      |
| ------------------------------ | ------- | -------------------------------------------------------------------------------------------- |
| `maxConversationMessages`      | 200     | Stored messages per conversation (each side of a turn counts once); then `conversation_full` |
| `maxStoredMessageChars`        | 20,000  | One stored message, in characters; a longer answer is clipped                                |
| `maxTitleChars`                | 120     | A title, one line                                                                            |
| `conversationPageSize`         | 30      | Conversations per page of the list                                                           |
| `maxAttachmentsPerMessage`     | 4       | Files on one message                                                                         |
| `maxImageBytes`                | 5 MiB   | One image                                                                                    |
| `maxPdfBytes`                  | 10 MiB  | One PDF                                                                                      |
| `maxTextFileBytes`             | 512 KiB | One text file                                                                                |
| `maxExtractedTextChars`        | 20,000  | A text file's decoded text, kept and sent                                                    |
| `maxFileNameChars`             | 200     | A file name once sanitized (the browser may send 255)                                        |
| `maxAttachmentsPerTurnContext` | 6       | Files sent to the model in one turn                                                          |
| `maxAttachmentBytesPerTurn`    | 15 MiB  | Bytes of those files in one turn                                                             |
| `uploadsPerActorPerHour`       | 40      | Upload intents per member per site in a fixed hour                                           |

Fixed in code beside them: the signed PUT 5 minutes and the link 2 minutes
(`ai/attachments.ts`), unsent files swept after a day (`ai/attachment-store.ts`),
the 48 MiB memory budget (`ai/attachment-budget.ts`), the 5-minute readiness
recheck (`ai/chat-schema.ts`). Replayed history keeps `AI_ASSISTANT_LIMITS`'s
12 messages and 16,000 characters.

## 12. Known limits

- **Attachment objects are not in any backup.** The nightly backup copies the
  objects `app.files` and `app.file_revisions` reference; it dumps the three
  tables, so a restore brings back conversations, messages and file rows but
  not the files, which are then sent as not available and their links fail.
- **A finalize interrupted by a process exit** can leave this attempt's copy of
  the upload in storage with no row naming it; nothing removes it.
- **Removing a member does not delete their conversations.** Nothing links them
  to the membership; they stay stored and no screen reaches them.
- **A customer's data erasure does not rewrite stored conversations.** An
  answer that named a customer, or a file about them, stays until the member
  deletes the conversation.
- **Retry in a stored conversation asks again below the old answer**: no
  message is edited or deleted on its own, and the retried question goes
  without its files.
- **A failed answer write** leaves the question without an answer after a
  reload; the member received the answer, and `done.messageId` names a row that
  does not exist.
- **Image and PDF input has not been tried against a real provider.** Whether
  the deployment's model accepts them must be checked in the Gateway catalogue
  before `AI_ATTACHMENT_KINDS` offers them.

Tests: `apps/backend/tests/ai-saved-chat.test.ts` and
`ai-saved-chat.integration.test.ts` (privacy against another member and the
owner at the route and the store, stored outcomes, replay, idempotency,
attachments, deletion, usage), `packages/db/tests/ai-chat.integration.test.ts`
and `ai-attachment-sweep.integration.test.ts` (policies, grants, the sweep
function), `apps/admin/src/components/ai/chat-screen.test.tsx` and the browser
journey `apps/admin/e2e/ai-chat.spec.ts`.
