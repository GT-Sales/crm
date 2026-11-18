# Ask AI as a saved chat — the specification every agent works from

Repository: /home/user/crm. Read /home/user/crm/AGENTS.md first, then
docs/design/ai-assistant.md (the trust boundaries of Ask AI as it is today) and
docs/RUNBOOKS/ai-assistant.md. This file is the agreed design. If something
here turns out to be impossible or wrong against the code, do not improvise a
different design: implement what you safely can, and report the conflict.

## 1. What the owner asked for (decisions already taken, do not reopen)

1. Ask AI becomes a saved chat that feels like Claude or ChatGPT: a full page
   with a conversation list on the left and the chat on the right.
2. The existing side panel (the header's Ask AI overlay, 440 px sheet) STAYS for
   quick questions on any screen. It gets an "Open full page" control. Panel and
   page show the SAME saved conversations.
3. Conversations are stored on the server, PRIVATE to the staff member who had
   them, per site. Nobody else can read them: not other members, not the owner.
   They are kept until the member deletes them.
4. The owner can see USAGE per member (turns and tokens), never content.
5. A member can attach images and documents to a message and ask about them in
   that chat. Files belong to the conversation and go when it is deleted. They
   are never attached to a lead.
6. Scope stays CRM ONLY: the same tools, the same system prompt rules, the same
   refusal of unrelated subjects. An uploaded file is material to answer a CRM
   question about (for example "what does this customer's letter ask for?").
   Do not widen the assistant into a general chatbot.

## 2. What must not change

- Every existing trust boundary in docs/design/ai-assistant.md §2: the actor is
  the verified session, the site is the route id plus a live membership read,
  access is `decideAiAccess`, tools re-authorize before every call and once
  before the answer is released, tool results go through the projections, the
  model never sees email, phone, address, SIN, document content from the CRM
  or signed URLs.
- The tool set and tool policy (`ai/tools.ts`, `ai/tool-policy.ts`), the action
  cards and their signed confirm/revise flow, automation authoring, the rate
  limits, the replay claim, the turn timeout, cancellation, `ai_turns` logging.
- Deploy order is not controlled: the admin (Vercel) and the backend (Railway)
  deploy separately. An OLD admin must keep working against the NEW backend and
  the NEW admin must degrade cleanly against an OLD backend. So every change to
  the wire is ADDITIVE and OPTIONAL. The existing request shape (`history` sent
  by the browser, signed answers) keeps working exactly as today.
- Repo rules: only the backend talks to Postgres (rule 1); every tenant table
  has `workspace_id`, RLS enabled and FORCED, grants in a hand-written custom
  migration (rules 2 and 3); no PII in logs or audit (rule 7); integration tests
  re-runnable (rule 9); no new dependency without a strong reason.

## 3. Data model (new tables in schema `app`)

All three are OWNER-ONLY tables: use the existing `ownerPolicy(name,
workspaceId, actorId)` helper in packages/db/src/schema.ts (the same one
`saved_views` and `ai_automation_proposals` use), which pins BOTH the site and
the actor in USING and WITH CHECK. Add `backupReadPolicy` as the neighbours do.
Follow exactly how `ai_automation_proposals` / `saved_views` were added: a
generated migration (`pnpm --filter @gt-sales/db db:generate`), then a custom
migration (`drizzle-kit generate --custom`) with the grants to `app_runtime` and
FORCE ROW LEVEL SECURITY, mirroring the custom migration that followed those
tables. Never edit an existing migration. Next free numbers follow 0033.

`ai_conversations`

- `id uuid pk` (chosen by the client, see §5), `workspace_id uuid not null`
  (fk workspaces, cascade), `actor_id uuid not null` (the member; same value the
  session's `actorId` has), `title text not null` (1 to 120 chars),
  `created_at`, `updated_at`, `last_message_at timestamptz not null`.
- unique `(workspace_id, id)`; index `(workspace_id, actor_id, last_message_at desc)`.

`ai_messages`

- `id uuid pk`, `workspace_id`, `conversation_id`, `actor_id`,
  composite fk `(workspace_id, conversation_id)` → `ai_conversations
(workspace_id, id)` ON DELETE CASCADE.
- `role text` check in ('user','assistant').
- `text text not null` (may be empty for an assistant turn that failed before
  any text); length check ≤ 20000.
- `outcome text` : for role 'user' always 'completed'; for 'assistant' one of
  'completed','failed','cancelled','access_lost' (same words as
  `ai_turns.outcome`).
- `error_code text null` (≤ 60, the stream error code of a failed turn).
- `sources jsonb not null default '[]'` (the `sources` part of the answer, as
  sent on the wire), `follow_up jsonb null` (the `follow_up` part).
- `expired_drafts integer not null default 0` : how many action cards and
  automation proposals this answer carried. The cards themselves are NOT stored
  (their signed tokens are short-lived by design); a reloaded conversation shows
  the text and a quiet line that the drafts are no longer available.
- `request_id uuid null` (the turn's client request id, for idempotency: unique
  `(workspace_id, conversation_id, request_id, role)` where request_id is not null).
- `created_at timestamptz not null default clock_timestamp()`.
- index `(workspace_id, conversation_id, created_at, id)`.

`ai_attachments`

- `id uuid pk`, `workspace_id`, `actor_id`, `conversation_id uuid null`,
  `message_id uuid null` (both null until the message that carries the file is
  sent; then set together; composite fk to the conversation ON DELETE CASCADE).
- `kind text` check in ('image','pdf','text'), `media_type text`, `file_name
text` (sanitized, 1 to 200), `byte_size integer`, `sha256 text`,
  `bucket text`, `object_key text` (server-generated random key, never derived
  from the file name), `status text` check in ('pending','ready').
- `extracted_text text null` (for kind 'text' only: the decoded text, bounded),
  `created_at`.
- index `(workspace_id, actor_id, created_at)` and `(workspace_id, message_id)`.

Deleting a conversation deletes its messages and attachment rows in one
transaction and removes the stored objects after commit (best effort; a failed
object delete is logged by code only and left for the sweep). A daily sweep
(inside the existing `document_cleanup` or `data_retention` scheduler task,
whichever already deletes objects) removes attachments that are still unsent
(`message_id is null`) after 24 hours, rows and objects.

Add `input_tokens integer not null default 0` to `app.ai_turns` (extend its
counts check) and record it from the model's usage, beside `output_tokens`.

## 4. Limits (product constants, in packages/contracts beside AI_ASSISTANT_LIMITS)

`AI_CHAT_LIMITS`:

- `maxConversationMessages: 200` (stored messages per conversation; at the
  limit the chat answers `conversation_full` and the UI says to start a new
  chat).
- `maxTitleChars: 120`, `conversationPageSize: 30`.
- `maxAttachmentsPerMessage: 4`.
- `maxImageBytes: 5 * 1024 * 1024`, `maxPdfBytes: 10 * 1024 * 1024`,
  `maxTextFileBytes: 512 * 1024`, `maxExtractedTextChars: 20_000` per text file.
- `maxAttachmentsPerTurnContext: 6` and `maxAttachmentBytesPerTurn: 15 MiB`:
  files sent to the model in one turn, the new message's first, then the most
  recent earlier ones within the replayed history, until either limit.
- `uploadsPerActorPerHour: 40`.
- Accepted types: images `image/png`, `image/jpeg`, `image/webp`; documents
  `application/pdf`; text `text/plain`, `text/csv`, `text/markdown`. The type is
  decided by the file's MAGIC BYTES on the server (and for text, by a strict
  UTF-8 decode with no NUL bytes), never by the name or the browser's claim.

History replay from the store uses the existing `maxHistoryMessages` (12) and
`maxConversationChars` (16000): whole completed turns, newest kept.

## 5. Wire (packages/contracts) — additive and optional

Chat request `aiChatRequestSchema` gains two OPTIONAL fields, schema stays
`.strict()`:

- `conversationId: z.uuid().optional()`
- `attachmentIds: z.array(z.uuid()).max(4).optional()`

Rules the backend enforces:

- No `conversationId`: today's behaviour, byte for byte (browser history,
  signatures, nothing stored). `attachmentIds` without `conversationId` is
  `invalid_request`.
- With `conversationId`: `history` MUST be empty (else `invalid_request`); the
  server loads the history from the store. If the member has no conversation
  with that id on this site, the server CREATES it (id as given, title = the
  first 60 characters of the message, single line, trimmed; "New chat" when
  the message is only attachments is not possible since `message` is required).
  The id is client-generated so the first message needs no extra round trip. An
  id that exists but belongs to someone else is invisible under RLS, so the
  insert meets the primary key: answer `404 conversation_not_found` (never
  reveal that it exists).
- The user's message row is written BEFORE the model is called (with the turn's
  `request_id`), together with linking its attachments (which must be this
  member's, this site's, `ready`, and not yet linked to another message; any
  other state is `invalid_request`). The assistant's row is written when the
  turn ends, whatever the outcome, in the same place `ai_turns` is recorded,
  with the text that was actually streamed, the sources, the follow-up, the
  outcome and the number of cards. A storage failure there is reported and
  never fails the turn that already streamed.
- New stream part, sent once right after the user's row is written and only
  for a stored conversation:
  `{ type: 'conversation', conversationId, userMessageId, title, created: boolean }`
  and the `done` part gains optional `messageId` (the assistant row's id).
  Add both to `aiStreamPartSchema`. The new admin must tolerate their absence.

New JSON endpoints, all under the staff router at
`/api/v1/staff/workspaces/:workspaceId/ai/…`, all guarded like `capabilities`
(session, live membership, `decideAiAccess`, feature enabled for the site), all
`cache-control: no-store`, all registered in
`packages/contracts/src/endpoints.ts` with typed client methods in `client.ts`
and thin wrappers in `apps/admin/src/lib/api.ts`:

| Method | Path                                     | Body / query                                               | Answer                                                                                                                                                                                         |
| ------ | ---------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/ai/conversations`                      | `?cursor=&limit=&q=` (q matches the title, ILIKE, escaped) | `{ conversations: [{ id, title, createdAt, updatedAt, lastMessageAt }], nextCursor? }` newest first, keyset cursor on `(last_message_at, id)`                                                  |
| GET    | `/ai/conversations/:conversationId`      |                                                            | `{ conversation, messages: [{ id, role, text, outcome, errorCode?, sources, followUp?, expiredDrafts, createdAt, attachments: [{ id, kind, mediaType, fileName, byteSize }] }] }` oldest first |
| PATCH  | `/ai/conversations/:conversationId`      | `{ title }`                                                | the conversation                                                                                                                                                                               |
| DELETE | `/ai/conversations/:conversationId`      |                                                            | 204                                                                                                                                                                                            |
| POST   | `/ai/attachments/intents`                | `{ fileName, mediaType, byteSize }`                        | an upload target, see §6                                                                                                                                                                       |
| POST   | `/ai/attachments/:attachmentId/finalize` |                                                            | `{ attachment: { id, kind, mediaType, fileName, byteSize } }`                                                                                                                                  |
| DELETE | `/ai/attachments/:attachmentId`          | only while unsent                                          | 204                                                                                                                                                                                            |
| GET    | `/ai/attachments/:attachmentId/link`     |                                                            | `{ url, expiresAt }` a short-lived signed download link for the member's own file                                                                                                              |
| GET    | `/ai/usage`                              | `?period=7                                                 | 30                                                                                                                                                                                             | 90` | owner only, see §8 |

Capabilities (`aiCapabilitiesResponseSchema`) gains optional:

- `conversations: boolean` — the backend stores conversations (true on a new
  backend; absent on an old one, and then the new admin behaves as today:
  memory-only panel, no full page, no list).
- `attachments: { kinds: ('image'|'pdf'|'text')[], accept: string[],
maxPerMessage, maxImageBytes, maxPdfBytes, maxTextFileBytes }` — absent or
  empty `kinds` means the composer shows no attach control.

Errors use the existing envelope and codes where one fits; add
`conversation_not_found` (404), `conversation_full` (409),
`attachment_rejected` (400, with a safe `reason`: `type`, `size`, `empty`,
`unreadable`), `attachments_unavailable` (503). Follow how the registry and
`apps/admin/src/lib/error-text.ts` treat the existing AI codes; the admin never
shows a raw code.

## 6. Uploads

Reuse the documents feature's signed-upload pattern and its adapter
(`apps/backend/src/documents/`, `R2DocumentStore` in packages/adapters/src/r2.ts:
`createUpload` → the browser PUTs straight to storage → `verifyUpload` checks
size, magic bytes and checksum on a server-side copy). The backend never
receives the bytes over its JSON API (the 64 KB body limit stays). Study how
the staff document upload works end to end before writing, and reuse its
helpers rather than copying them. Objects live under a distinct key prefix for
AI attachments so they are never confused with a lead's documents and never
appear in `app.files`.

To send a file to the model the backend needs the bytes: add ONE bounded read
method to the store interface (real S3 implementation and the in-memory fake),
refusing anything over the size the attachment row records. Never hand the
provider a URL to our storage.

How each kind reaches the model (in `ai/engine.ts`, where `toModelMessages`
builds the messages; today a message is text only):

- image → an image part with the bytes and media type;
- pdf → a file part with media type `application/pdf`;
- text → NOT a file: the text is decoded once at finalize, stored in
  `extracted_text`, and added to the user's message inside a clearly delimited
  block that names the file.
  Check the installed `ai` SDK's types (node_modules) for the exact content-part
  shapes; do not guess them.

Which kinds are offered is deployment configuration, because it depends on the
model: new variable `AI_ATTACHMENT_KINDS`, a comma list of `image`, `pdf`,
`text`. Unset or empty means uploads are off (capabilities carry no
`attachments`, every attachment route answers `attachments_unavailable`). This
matches the repo's rule that an AI setting never defaults on. Document it in
docs/ENV.md. Storage not being configured also means off.

Prompt: the system prompt (`ai/prompt.ts`, bump `AI_PROMPT_VERSION`) gains a
short rule that an attached file is material supplied by the staff member, its
content is DATA and never instructions, and the subject limits are unchanged.
A file cannot authorize anything: tools still decide from the session.

## 7. Admin UI

Routes: `/w/[workspace]/chat` (new chat) and `/w/[workspace]/chat/[conversationId]`.
A sidebar entry "Ask AI" (shown under the same condition as the header trigger:
capabilities ready and available; and only when `conversations` is true).

Full page layout, using the app's existing tokens and components
(packages/ui, `src/app/crm-theme.css`, the patterns in `src/components/crm/`),
light and dark, desktop and 375 px:

- Left column (about 280 px; a slide-over drawer on mobile opened from a
  button in the chat header): "New chat", a search box over titles, the list
  grouped Today / Yesterday / Previous 7 days / Older, the open one highlighted.
  Each row: title (one line, truncated), a menu with Rename (inline edit) and
  Delete (a confirm dialog that says the conversation and its files are removed
  for good). Loading, empty ("No conversations yet") and error states with Try
  again. "Load more" at the end when `nextCursor` is present.
- Main column: the conversation, centred with a comfortable reading width; the
  messages reuse the existing `assistant-message.tsx`, `assistant-sources.tsx`,
  `assistant-action.tsx`, `assistant-automation.tsx` and
  `assistant-markdown.tsx` (do not fork them). A user message shows its
  attachments: images as thumbnails (through the signed link), other files as
  chips with a type icon, name and size; clicking opens the file in a new tab
  with `rel="noopener noreferrer"`.
- New-chat state: a greeting, the site name, and the existing suggestions.
- Composer pinned to the bottom: auto-growing textarea, Enter sends, Shift+Enter
  newline, IME-safe (as the panel already is), Stop while streaming, an attach
  button (paperclip) that opens the file picker, drag-and-drop onto the page,
  and paste of an image from the clipboard. Chosen files appear as chips above
  the textarea with upload progress, an error state per file in plain words
  (too large, type not accepted), and a remove button; Send is disabled while a
  file is still uploading. Limits and accepted types come from capabilities.
- The URL is the state: opening `/chat/<id>` loads that conversation; the first
  message of a new chat moves the URL to `/chat/<id>` without a remount or a
  flash (the id is generated in the browser before sending).
- An answer that was stopped or failed is shown as such after a reload too
  (from `outcome`), with Retry on the last one.

Side panel: backed by the same store. Its header gets "Open full page" (to
`/chat/<current id>` or `/chat`) beside New chat and Close. Its lead context
(`context.leadId`) keeps working. Opening the panel shows the member's current
conversation (the one last used in this browser tab), not the whole list.

Provider (`assistant-provider.tsx`): it stays the single owner of assistant
state (capabilities, the abort controller, the generation counter that makes
late stream parts harmless, the credential/site lifecycle). It gains the active
conversation id, loading a stored conversation, and the conversation list. With
`conversations` absent in capabilities it behaves exactly as today. Nothing is
written to localStorage/sessionStorage/IndexedDB: the server is the store.

## 8. Usage for the owner

`GET /ai/usage?period=7|30|90`: guarded by the owner-level action that guards
Settings → Team member management today (find it in
`apps/backend/src/staff/authorization.ts`; do not invent a new role). Answer:
`{ period, totals: { turns, inputTokens, outputTokens }, members: [{ actorId,
displayName, turns, inputTokens, outputTokens, lastUsedAt }] }`, from
`app.ai_turns` (tenant-scoped, so readable by the owner's transaction; it
holds counts only). `ai_turns` rows are pruned after 90 days, hence the
periods. `ai_turns` has a tenant policy, not an owner policy: this read is the
ONLY cross-member read in the feature, and it returns numbers only.

Admin: Settings → "AI usage" (a card in the settings index and a page at
`/w/[workspace]/settings/ai-usage`), visible to the same people the Team page
is: period switch (7 / 30 / 90 days), totals, a table per member sorted by
tokens. A line states that conversations are private and only usage is shown.

## 9. Tests that must exist

Backend integration (real Postgres, re-runnable):

- Privacy: member B of the same site cannot list, read, rename, delete or post
  into member A's conversation (404, never 403), cannot link or read A's
  attachment; the OWNER cannot either; the same member on another site cannot.
  Assert at the store level under `withTenantTx` as another actor too (RLS,
  not only route code).
- A chat with `conversationId` creates the conversation, stores both rows,
  replays stored history on the next turn (assert what the engine received),
  and a failed, cancelled and access-lost turn each store the right outcome.
- No `conversationId` behaves exactly as before (the existing tests keep
  passing untouched).
- Idempotency: the same `requestId` twice stores one user row.
- Attachments: wrong magic bytes, oversize, empty, a file of another member,
  a file already sent, more than 4, kinds switched off; text extraction bounds;
  what the engine receives for image, pdf and text (use the fake engine and the
  in-memory store).
- Deleting a conversation removes rows and asks the store to delete objects;
  the sweep removes unsent attachments older than a day.
- Usage: owner sees per-member sums; a non-owner is refused; token sums match.
- Rule 3: the tables have FORCE RLS and the grants (follow the existing test
  that checks this for every table, e.g. in packages/db/tests).

Admin unit tests (vitest + testing-library, the style of
`assistant-panel.test.tsx`): list grouping and states, rename and delete,
loading a stored conversation, sending with attachments, upload errors, old
backend (no `conversations`) keeps today's panel. One browser journey in
`apps/admin/e2e/` modelled on `ai-assistant.spec.ts` (synthetic engine over
the real backend): new chat → answer → reload → the conversation is there and
reopens → rename → delete; at 375 px and desktop.

## 10. Docs to update when the code is done

AGENTS.md ("Where things live" and the vocabulary: conversation, attachment,
usage), docs/HANDOFF.md (§2.3 backend surfaces, §2.4 tables, §3.2 the new
migrations as "merged, not applied" and `AI_ATTACHMENT_KINDS` as an owner
step), docs/ENV.md, docs/design/ai-assistant.md (decision 2 said history lives
in React memory only; §6 fields; a new section for stored conversations and
attachments and what leaves the system), docs/RUNBOOKS/ai-assistant.md and
docs/RUNBOOKS/database.md (how to apply the new migrations, as the neighbours
are described).

## 11. The foundation AS BUILT (authoritative wherever it differs from §3 to §5)

Migrations `0034_ai_conversations` (generated) and `0035_ai_conversations_runtime`
(FORCE RLS and grants) exist; the schema is in packages/db/src/schema.ts
(`aiConversations`, `aiMessages`, `aiAttachments`, `aiTurns.inputTokens`). The
contract is in packages/contracts/src/ai-assistant.ts and the new
packages/contracts/src/ai-conversations.ts; READ THOSE FILES, they are the
contract. Differences from the sections above that you must respect:

- The foreign keys from messages and attachments to a conversation carry
  `actor_id`: `(workspace_id, actor_id, conversation_id)` →
  `ai_conversations (workspace_id, actor_id, id)`. An insert naming a
  colleague's conversation fails with SQLSTATE 23503; an id someone else
  already holds fails on the primary key with 23505. Both must answer
  `404 conversation_not_found`.
- `app_runtime` has SELECT and INSERT only on `ai_messages` (no UPDATE, no
  DELETE): a message row is written once, complete. Messages go only through
  the conversation's cascade. So the assistant's row is INSERTED when the turn
  ends; it is never created early and updated.
- `ai_attachments.sha256` is null while `pending` and required once `ready`;
  a linked attachment must be `ready`; `conversation_id` and `message_id` are
  null together; an attachment also has a cascading fk to its message.
- `AI_CHAT_LIMITS` also has `maxStoredMessageChars: 20_000` (clip a stored
  answer to it) and `maxFileNameChars: 200`.
- The chat request schema itself refuses (as `invalid_request`):
  `conversationId` with a non-empty `history`; `attachmentIds` without
  `conversationId` (even an empty array); a duplicate attachment id.
- Stream: every known part is `.strict()`, so an OLD admin drops a known part
  that carries an extra key. Therefore send the `conversation` part and
  `done.messageId` ONLY when the request carried `conversationId`.
- The two DELETE endpoints answer 200 with `{ conversationId | attachmentId,
requestId }`, not 204 (every DELETE in this API has a body).
- Upload: `createAiAttachmentIntentResponseSchema` is the documents
  `createUploadIntentResponseSchema` (`{ uploadId, url, method: 'PUT', headers,
expiresAt, requestId }`, `uploadId` being the attachment id). Finalize takes a
  body `{ checksumSha256 }` (lower-case hex SHA-256 of the bytes, computed in
  the browser with `crypto.subtle`). The intent's `mediaType` is an enum of the
  seven accepted types; browsers often report no type for `.md` and `.csv`, so
  the UI maps by extension before asking. Per-kind size is the backend's
  `attachment_rejected` with `details.reason: 'size'`.
- The conversation list cursor is `"<microseconds since epoch>.<uuid>"`
  (`formatAiConversationCursor` / `parseAiConversationCursor`). Build the
  microseconds IN SQL (`(extract(epoch from last_message_at) * 1000000)::bigint::text`),
  never through a JS Date, which keeps only milliseconds.
- Stored message `errorCode` is a code pattern, not the enum.
- Client methods (on `client.staff`) and same-named wrappers in
  apps/admin/src/lib/api.ts: `listAiConversations`, `getAiConversation`,
  `renameAiConversation(token, ws, id, title)`, `deleteAiConversation`,
  `createAiAttachmentIntent`, `finalizeAiAttachment(token, ws, id, checksumSha256)`,
  `deleteAiAttachment`, `getAiAttachmentLink`, `getAiUsage`.
- Error codes added: `conversation_not_found`, `conversation_full`,
  `attachment_rejected` (`details.reason`: `type | size | empty | unreadable`),
  `attachments_unavailable`. Their sentences are already in
  apps/admin/src/lib/error-text.ts; the backend's message map
  (apps/backend `domain-errors.ts`) still needs its entries.
- The storage adapter's `verifyUpload` recognises only PDF, JPEG and PNG
  signatures today: WebP and text detection must be added for attachments.
- No repository test checks the registry against mounted routes, so nothing
  fails until the routes exist; the routes still must match the registry.
- Removing a member from a site does NOT delete their conversations (no fk to
  memberships); they simply become unreachable. Leave it so.
