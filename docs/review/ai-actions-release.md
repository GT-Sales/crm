# AI actions release review — 2026-11-04

Review baseline: `ed38332e6afc513d1e2bee459ae5205c2b58d4da` (main).
Reviewed feature head: `2ac0406c40ed145c5432cd92799b2e9bf7143826` (PR #23),
plus the task/note foundation and supporting authorization, reads, rendering,
streaming, work-store and email delivery paths. This is a scoped manual code
and regression review, not a guarantee that all vulnerabilities are absent.
The security plugin's supporting preflight resources were unavailable; no
completed plugin scan or SARIF report is claimed.

## Trust boundaries and findings

The model and customer-authored CRM fields are untrusted. Staff identity comes
from the verified session; Site and live permissions come from the backend.
The model can prepare cards but has no reference to the write store. Browser
confirmation submits a signed actor/Site/content/expiry-bound token. Editing
requires that token and cannot change its lead or action kind. Email recipients
and senders come from the Site/lead, not model or browser address arguments.
Tenant transactions, lead locks and stable creation IDs protect persistence.

One reproducible functional defect was found and fixed: parallel proposal
calls checked the three-card ceiling before asynchronous access/lead reads.
Six calls could all pass, producing six cards and failing the stream's max-three
contract. A new test failed with six cards before the correction. A second
ceiling check after the last await now bounds the synchronous append section.
The first three eligible distinct proposals survive; extra calls are refused.

No additional exploitable security defect was confirmed in the reviewed paths.
The review checked:

- Signed-token tampering, expiry, key rotation, actor/Site mismatch, strict
  inputs and live membership/role/feature checks for note, task and email.
- Revision rejection for changed lead/kind, extra recipient input, expired or
  forged tokens and access revoked while the email preview was being read.
- Foreign-Site, archived and restricted leads; changed email recipient/sender;
  tenant-scoped queries and the existing runtime RLS boundary.
- Concurrent confirmations, lost receipts, unchanged-token retries, one audit
  per creation, and preservation of later task edits/completion on replay.
- HTML escaping in cards and mail, inactive model Markdown links/images,
  server-built source links, bounded tools and sanitized error reporting.
- Draft metadata and tokens excluded from model tool results/history; browser
  state cleared on Site/actor changes and authorization refusals.
- Email outbox dedupe, eligibility/suppression checks, stable delivery message
  IDs, and a receipt that says queued rather than claiming delivery.
- Guided choices as ordinary user messages, with bounded question history;
  failed/stopped turns do not expose actionable cards.

The expanded route matrix tests all three confirmation kinds rather than
assuming email inherits the note tests. Nine additional revision refusal cases
exercise the endpoint with real HTTP requests and assert no email queue call.

## Verification and limits

Focused action and HTTP suites: 69 tests passed, including the regression.
Full validation results are recorded below after the release checks complete.
Local integration tests use disposable Postgres and the restricted runtime role.
Browser/provider tests use the deterministic model, test sessions and fake email
adapter. No real customer email is sent. Live model quality and actual provider
configuration/delivery are outside this code review; follow the AI runbook's
controlled-recipient smoke test. No migration or configuration change is needed.

Release review validation: all 225 test files passed, 2,690 tests passed and
four local backup-tool tests skipped (`pg_dump`/`age` unavailable locally;
GitHub CI installs them). Typecheck, lint, formatting and the backend production
build passed. PR #23's preceding CI run also passed both browser suites and the
production dependency audit. Fresh PR and main CI are required for this fix;
results are available in the PR checks and main Actions history.
