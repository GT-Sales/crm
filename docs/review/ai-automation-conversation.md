# Automation chat conversation repair

Observed: after authoring was enabled, live chat requested the asking person's
staff UUID and failed after clarification. Production turn logs recorded failures
but did not preserve a bounded failure code, so they could not distinguish provider
failure from exhausted structured-tool generations.

Changes:

- Every automation catalog page includes the authenticated current member and a
  `me` reference, independently of search/pagination. Staff names remain visible
  for selecting someone else; internal IDs are not requested from the person.
- Model inputs omit optional schema bookkeeping and new-step IDs. The server
  normalizes them and resolves `me` or unique active staff names, then applies the
  unchanged strict business draft schema. Existing step IDs are preserved on edits.
- Ambiguous/unavailable member names return named choices, without substituting
  someone else. Caller/workspace still come only from authenticated scope.
- Clarification cards asking for UUIDs are refused with a correction instruction.
- At a normal model step limit, an already validated signed proposal can be shown
  without a final prose generation. After an explanation-only provider failure, an already validated card can also
  be delivered with an explicit notice and fresh access checks. Cancelled/timed-out
  turns and invalid or absent proposals retain the existing failure handling.
- Turn logs include only an allowlisted failure code, never raw provider messages,
  prompts, tokens or tool arguments.

Regression checks include minimal provider-generated assignment inputs through the
actual AI SDK and disposable database, self/name/ambiguous member resolution,
strict action/field/limit rejection, current-member catalog pagination and successful
proposal delivery at the step limit. Browser coverage asks to assign new SIM orders
to `me`, checks the visual review card and confirms no staff identifier is displayed.
The configured production model is retained; no provider or pricing change is made.

Local verification: the full suite passed 229 files / 2,749 tests with four
backup-tool skips. The final 101 focused SDK/HTTP tests passed and cover explanation recovery,
including permission revocation and invalid-card rejection. The browser scenarios
passed for assignment to the authenticated member and ordinary create/edit drafts.
Workspace typechecks, lint, formatting and production builds are checked before
commit; CI verifies the final combined patch before merging.
