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
   kept until the member deletes the conversation, with two exceptions that
   follow the owner's rule on misuse (audit B2 and C13, §13): a customer's
   data restriction empties the turns that name that customer, and the
   conversations of someone who has left the site for 30 days are deleted.
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
| Erasure and departed members (0039)       | The same pattern, five functions (§13): `app.erase_restricted_lead_ai_turns` acts only on leads of the site that are already restricted; the file and conversation cleanups need an actor, take at most 1000 rows, re-check their rule when they delete, and never take a chat whose member left less than a day ago. The runtime role still holds no UPDATE or DELETE on `app.ai_messages`.             |
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
them. `prune_operational_rows` does not touch them. Migration 0039 adds
`ai_messages.erased_at`, set on both rows of a turn emptied by a customer's
erasure (§13). No key links a
conversation to `memberships`; the departed-member cleanup (§13) reads the
membership by the conversation's actor.

## 5. A stored turn

A chat request that carries `conversationId` goes through the unchanged
access check, feature switch, rate limits and replay claim
(`routes/ai-assistant.ts`). Then, before the first stream frame, so every
refusal is an ordinary JSON error:

1. The saved chat must be available (§8), else `503 ai_unavailable`; files
   named in `attachmentIds` need attachments available, else
   `503 attachments_unavailable`.
2. `beginTurn` (`ai/conversation-store.ts`), one transaction: create the
   conversation under the browser's id when the request says
   `newConversation: true` (the first message of a chat the browser made;
   title: the message's first 60 characters on one line, whole graphemes, a
   joined emoji kept whole; `New chat` if nothing is left), going on in it if
   that id is already the member's (a retried first message), or else load
   it, locked; refuse a conversation this message created when the member
   would then have more than 500 on the site (`409
conversation_limit_reached`, `details.limit`); refuse it when the two rows of this turn would
   pass 200 messages (`409 conversation_full`); lock and check this message's
   files (each the member's, `ready` and not yet sent, else
   `400 invalid_request`); insert the member's message with the request id
   (a second insert for the same id is `409 conflict`); link the files; move
   `last_message_at`. Nothing is written unless all of it is. Someone else's
   id, or an unknown one without `newConversation`, is
   `404 conversation_not_found`, so a question asked into a conversation
   deleted in another tab never brings it back.
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
minutes, so a reloaded answer shows its text and a line that it prepared a
draft, that drafts are not kept in the conversation, and that a confirmed one
was saved on the lead (with the lead's link when its sources name one).
A conversation read while its last answer is still being written (a reload
mid-answer) shows that turn as stopped, with Retry, and is read once more two
seconds later.

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
memory-only path still replays only signed answers (CHAT-2), and a
deployment without a signing key is off (`not_configured`, audit B6), so
there is no unsigned path.

A turn whose answer's source cards link a lead that is now restricted, or
that no longer exists, is never replayed (audit B2). The check reads the lead
itself, so it holds before the erasure has emptied the turn and before 0039
is applied; an emptied turn has no text and is skipped as above.

A new message that is exactly (trimmed) one of the follow-up choices an
earlier replayed answer offered reaches the model marked as a picked option
(`selectedChoiceText` in `routes/ai-assistant.ts`: "The person picked this
option from the choices you offered earlier in this chat; it is your
wording, not a new request from them"), so a click is never mistaken for the
person's own words (audit B8). A message typed with the same words is marked
the same way, which is true of what it says. The stored question keeps the
plain text, and the memory-only panel sends a clicked choice as typed text
(the browser's history carries the follow-up only inside the signed answer
text).

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

**Daily budget** (audit B7). The files chosen for a turn, earlier messages'
included, are charged to the member's budget on the site, 300 MiB a UTC day
(`attachmentBytesPerActorPerDay`), in whole MiB rounded up over the turn,
through the shared limiter (`ai_file_bytes:<member>:<site>`, one hit per MiB;
`chargeDailyAttachmentBytes` in `ai/limits.ts`). Spent, every file of the
turn is named to the model as not available, the turn still runs, and the
stream's `notice` part (`attachment_budget_spent`) has the admin say
"Today's file limit for Ask AI is used up. Files will be read again
tomorrow." A limiter that cannot be reached also sends no file (fail closed),
without the line, and reports `ai_attachment_budget_unavailable`. A refused
turn's units still count. Which files a turn chooses is unchanged.

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
until 0036 is applied. Beside it, in the same task, the cleanup of erased
turns' files and of departed members' conversations (§13).

## 8. Wire and versions

The admin (Vercel) and the backend (Railway) deploy separately, so every wire
change is additive and optional (`packages/contracts/src/ai-assistant.ts`,
`ai-conversations.ts`):

- **Request**: `conversationId` (a uuid the browser generates for a new chat),
  `newConversation` (true on that chat's first message until the server has
  acknowledged it) and `attachmentIds` (at most 4). The schema itself refuses
  `conversationId` with a non-empty `history`, `newConversation` or
  `attachmentIds` without `conversationId` (even empty) and a repeated file,
  as `invalid_request`.
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
- **Stream**: a `notice` part (`code: 'attachment_budget_spent'`, audit B7),
  sent only by a stored turn whose files the daily budget refused; an older
  admin drops it. A stored message's optional `erased: true` (audit B2); an
  older admin strips it and shows an empty row.
- **Follow-up choices** (audit B8): the model's `askFollowUp` input is
  `aiFollowUpToolInputSchema`, 2–5 choices of at most 80 characters
  (`AI_FOLLOW_UP_LIMITS`); a longer choice or a sixth is refused at the tool,
  so no follow-up is offered unless the model asks again within them. The
  wire's `aiFollowUpSchema` (200 characters) is unchanged, so what an older
  backend stored or streams still reads.
- **Errors**: `conversation_not_found` (404), `conversation_full` (409),
  `conversation_limit_reached` (409, `details.limit`),
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
function and its grant; `effort` the two 0037 columns; `chatErasure` the 0039
column and each of its five functions' grant. Until `conversations` holds, capabilities claim
neither `conversations` nor `attachments`, the conversation routes answer
`503 ai_unavailable`, the attachment routes `503 attachments_unavailable`, and
a chat naming a conversation `503 ai_unavailable`. Without `inputTokens` a
turn's `ai_turns` row is written without the column; without `effort` a turn's
rows are written without their `effort` columns (High turns still run, and a
stored message is read through `to_jsonb`, so its level is simply absent);
without `chatErasure` the cleanup of §13 is skipped (a stored message's
`erased_at` is read through `to_jsonb` too). A
state with all five is
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
| `components/ai/chat-screen.tsx`                                                          | The page: the list column (a left drawer on a phone), the thread, the composer, dropping files onto the chat. The first message of a new chat moves the address to `/chat/<id>` (the id is made in the browser); a first message stopped before the server named its conversation is looked up once, so the address, heading and list follow the stored one. Ask AI that cannot be used says why: the sign-in expired, the access changed (the local conversation state is cleared) or the CRM could not say, each with Try again. A question asked into a conversation deleted elsewhere shows the not-available state.                                                                                                                                                                                                         |
| `conversation-list.tsx`, `conversation-groups.ts`                                        | New chat, a title search, groups Today / Yesterday / Previous 7 days / Older in the viewer's time zone, rename in place, delete after a dialog saying the conversation and its files are removed for good, Load more.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chat-thread.tsx`, `assistant-message.tsx`                                               | The conversation at a reading width; a new chat greets with the site's name and the suggested questions. A stored stopped or failed answer reads as such after a reload; Retry on the last one asks again below it. An answer that prepared drafts says they are not kept and a confirmed one was saved on the lead. A conversation at 200 messages offers a new chat and takes no more.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `chat-composer.tsx`, `attachment-chip.tsx`, `attachment-files.ts`, `attachment-links.ts` | Enter sends, Shift+Enter is a new line, IME-safe; Stop (the second click of a double-click on Send, within 600 ms of the send, is ignored; a single click or a key press never is); a pasted text past 4,000 characters is cut with a note; the paperclip, drop and image paste where the site offers files; a chip per file with progress or a plain-words refusal; Send waits for uploads. The browser checks type and size before asking, hashes the bytes and PUTs them with progress. Thumbnails and file links come from signed links fetched while on screen and kept in memory.                                                                                                                                                                                                                                          |
| `assistant-panel.tsx`                                                                    | The side panel: the current conversation, New chat, Open chat in full page and Close; no list and no attach control. The header trigger is hidden on the chat page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
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
stored `effort` after a reload. High's own rate limit (the member's hour is
asked first and refuses alone, so a member past it never counts against the
site's day) reads "High effort has reached its limit for now. Ask at Normal
effort, or try again in N minutes."; a site that stopped offering High says so, its capabilities are
fetched again (the control goes), and the question is asked again, at Normal,
only on Retry. Settings → AI usage shows _High effort_ (On with its model, or
Off) on the Assistant card, a _High effort turns_ tile and a _High_ column in
Models and People when the backend sends them.

`assistant-message.tsx` also draws the guards' lines: an erased turn as
"This message was removed because the customer's data was erased." in place
of its answer, its question left out (§13); "Today's file limit for Ask AI is
used up. Files will be read again tomorrow." above an answer whose stream
carried the `notice` part (§7); and, for `conversation_limit_reached`, "You
have 500 saved chats on this site, the most Ask AI keeps. Delete old chats to
start a new one.", with no Retry.

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

Also in `AI_CHAT_LIMITS` (audit B7): `attachmentBytesPerActorPerDay`, 300
MiB of file bytes sent to the model per member per site in a UTC day (§7),
charged in `attachmentBudgetUnitBytes` (1 MiB); `maxConversationsPerActor`,
500 stored conversations per member per site, then
`conversation_limit_reached`. Beside them `AI_FOLLOW_UP_LIMITS` (audit B8):
a follow-up choice at most 80 characters, at most 5 choices (§8).

Fixed in code beside them: the signed PUT 5 minutes and the link 2 minutes
(`ai/attachments.ts`), unsent files swept after a day (`ai/attachment-store.ts`),
the 48 MiB memory budget (`ai/attachment-budget.ts`), the 5-minute readiness
recheck (`ai/chat-schema.ts`), a departed member's conversations deleted after
30 days (`AI_DEPARTED_MEMBER_CHAT_DAYS` in `ai/attachment-store.ts`). Replayed history keeps `AI_ASSISTANT_LIMITS`'s
12 messages and 16,000 characters.

## 12. Known limits

- **Attachment objects are not in any backup.** The nightly backup copies the
  objects `app.files` and `app.file_revisions` reference; it dumps the three
  tables, so a restore brings back conversations, messages and file rows but
  not the files, which are then sent as not available and their links fail.
- **A finalize interrupted by a process exit** can leave this attempt's copy of
  the upload in storage with no row naming it; nothing removes it.
- **A customer's erasure finds only what it can match exactly.** It empties
  the turns whose answer's source cards link the lead and those whose text
  holds the lead's order number (`MS-<n>`). An answer can name a customer
  without either (a name, a phone number typed in a question, a file whose
  content is about them but whose turn links no lead): that text stays until
  the member deletes the conversation. Names are not matched, on purpose: a
  name is not unique, and a fuzzy match would remove unrelated text. A
  website-chosen reference (not `MS-<n>`) is not matched either.
- **Erasure runs where restriction runs.** Today the one path that restricts
  a lead is the abandoned-draft erasure (`retention/abandoned-leads.ts`); a
  lead restricted by hand in the database is caught by the replay check (never
  sent to the model) but its turns are emptied only by the 0039 catch-up or a
  later restriction run that passes it.
- **Before 0039 is applied** a turn about a restricted lead is never replayed,
  but its text stays stored and the member still sees it.
- **An erased turn's files** can no longer be opened at once, but their
  objects and rows go with the next hourly `document_cleanup` (objects
  first); one whose object cannot be deleted stays until a later run manages.
  The cleanups need object storage configured, as the unsent-file sweep does.
- **A departed member's conversations** are deleted 30 days after the
  membership was revoked and the conversation was last used. A member added
  back after that finds none. One whose object cannot be deleted is kept and
  tried again next hour. A member added back in the moment between the
  objects' delete and the rows' keeps the conversation without its files.
- **The daily file-budget line** is in the live answer only; a reloaded
  answer does not say that its files were left out. The 500-conversation
  limit is checked when a conversation is created, so two first messages at
  once can pass it by one.
- **Retry in a stored conversation asks again below the old answer**: no
  message is edited or deleted on its own, and the retried question goes
  without its files.
- **A failed answer write** leaves the question without an answer after a
  reload; the member received the answer, and `done.messageId` names a row that
  does not exist.
- **Image and PDF input has not been tried against a real provider.** Whether
  the deployment's model accepts them must be checked in the Gateway catalogue
  before `AI_ATTACHMENT_KINDS` offers them.

Tests: `apps/backend/tests/ai-chat-erasure.integration.test.ts` and
`packages/db/tests/ai-chat-erasure.integration.test.ts` (§13),
`apps/backend/tests/ai-fail-closed.test.ts` (every limiter and probe fails
closed), `apps/backend/tests/ai-guards.test.ts`,
`apps/admin/src/components/ai/guards.test.tsx`,
`apps/backend/tests/ai-saved-chat.test.ts` and
`ai-saved-chat.integration.test.ts` (privacy against another member and the
owner at the route and the store, stored outcomes, replay, idempotency,
attachments, deletion, usage), `packages/db/tests/ai-chat.integration.test.ts`
and `ai-attachment-sweep.integration.test.ts` (policies, grants, the sweep
function), `apps/admin/src/components/ai/chat-screen.test.tsx` and the browser
journey `apps/admin/e2e/ai-chat.spec.ts`.

## 13. A customer's erasure and members who leave

Audit B2 and C13, migration 0039 (docs/RUNBOOKS/database.md).

**A customer's erasure.** When a lead is restricted (today, the
abandoned-draft erasure in the scheduler's `data_retention`), the same
transaction runs `app.erase_restricted_lead_ai_turns` for those leads,
across every member's conversations on that site and on no other. A turn is
named by the lead when its answer's stored source cards link it (`lead-<id>`,
or an href ending in `/leads/<id>`) or when the question's or the answer's
text holds the lead's server-assigned order number (`MS-<n>`, a whole word,
case-insensitive). Both rows of the turn, paired by request id, keep their
place with empty text, no sources, no follow-up and `erased_at` set, the way
a restricted lead's notes keep their place without their text; the
question's text files lose their decoded text at once; a title that came
from an erased first question, or holds the number, becomes "Chat with a
removed message". The admin shows the turn as "This message was removed
because the customer's data was erased." Such a turn is never replayed (§6),
and its files are never linked again (`GET …/link` answers `file_not_found`);
the next hourly `document_cleanup` deletes their objects, then their rows
(`app.erased_ai_attachments`, `app.delete_erased_ai_attachments`). The
migration itself runs the erasure once for every lead restricted before it.

**Members who leave.** A conversation whose member has had no active
membership on the site for `AI_DEPARTED_MEMBER_CHAT_DAYS` (30) days (their
membership revoked that long ago, or no membership row at all) and which was
last used that long ago is deleted by `document_cleanup`: its files' objects
first, then, only when every object is gone, the conversation with its
messages and file rows (`app.departed_ai_conversations`,
`app.delete_departed_ai_conversations`, which checks the rule again under a
row lock). Added back within the period (the invitation reactivates the same
membership), the member keeps their chats. Nobody can open a departed
member's chats meanwhile: they are private to the member, and every route
asks for a live membership.

Both cleanups run per site beside the unsent-file sweep, as the scheduler's
machine actor, at most five batches a run, counted under `aiChats` in the
task's summary, skipped until the schema probe sees 0039 (`chatErasure`); one
site's failure is logged (`ai_chat_cleanup_failed`) and never stops the
others.
