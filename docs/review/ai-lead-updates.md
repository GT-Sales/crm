# Reviewed AI lead updates — verification

The implementation adds explicit confirmation for stage, staff assignment,
customer-name and phone changes. Scope and architecture are described in
[the design](../design/ai-lead-updates.md).

The database regression exercises concurrent confirmation, one receipt per
signed ID, stale-version refusal, late retries preserving a later staff edit,
foreign-Site isolation, restricted leads, active-member checks, invalid stages
and a permitted stage move. The full work-store integration file passes 21 tests.
HTTP tests cover draft preparation without a write, exact signed value/version
on confirmation, and the existing token/permission refusal matrix extended to
lead updates. Browser component tests exercise current/proposed values and
editing through the revision endpoint. Production logic uses the existing
applyLeadUpdate path and rolls back refused changes, retaining its stage,
document and automation checks.

The two new authenticated browser journeys use a real local admin, backend and
disposable database at phone and desktop widths. They edit a phone draft,
confirm it, lose the successful HTTP receipt and retry the same card, then
verify the lead shows the edited value. Initial test runs exposed text-query
ambiguity in the combined current/proposed block; each value now has a separate
text element. A unit test also initially used a matcher absent from this test
setup; that assertion now uses the repository's standard matcher.

All provider calls in these tests use the fake model; no production records,
real email or Gateway spend are involved. Real-model interpretation of a staff
request remains a live evaluation. No new migration, dependency or environment
variable is required. Release follows review and CI.

Final local validation: 225 test files passed, 2,705 tests passed and four
backup-tool tests skipped because pg_dump/age are unavailable locally. The
final focused HTTP/component run passed 107 tests. Both new authenticated
browser journeys passed. Typecheck, lint, formatting, OpenAPI regeneration
(78 paths), backend build and normal admin production build passed. GitHub CI
runs the full browser suites and installs the backup tools.
