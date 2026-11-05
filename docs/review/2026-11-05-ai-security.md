# AI database and code capability boundaries

Requested scope: the staff AI must not change database structure, modify the
codebase, or execute SQL injected through prompts or CRM data.

This is a direct source and permission review, with executable regression checks.
The Codex Security automated scan runner and its supporting reference resources
were unavailable in this session; this is not a completed automated scan report.

## Existing boundaries verified

- The server constructs tools; chat messages and request bodies cannot supply
  functions, database clients, credentials, actor/workspace scope or provider tools.
- Model tools expose bounded CRM reads and temporary proposal preparation, not raw
  SQL, shell commands, filesystem access, GitHub, deployments or confirmation.
  Lead changes, customer email and automation saves require actor-bound signed
  confirmation and fresh permissions. Automation definitions use typed actions,
  not scripts or SQL. The application's own tools are separate from developer
  connectors used to maintain this repository.
- SQL values are bound with Drizzle; the tenant context's literal optimization
  validates UUIDs, and property/operator choices come from code/catalog schemas.
  The constant timeout SQL was not a demonstrated injection flaw; it now uses
  bound `set_config` for consistency.
- Production `app_runtime` is not superuser and has no CREATEDB, CREATEROLE,
  replication or BYPASSRLS. It has no inherited roles, no database CREATE grant,
  no CREATE on app/public/auth/storage, and no ownership allowing alteration of
  their relations or functions. These were read-only catalog checks, not live DDL
  attempts. The database role was not changed.
- No exploitable arbitrary SQL/code execution path was demonstrated in this
  scope. The changes below add protections against future capability expansion.

## Hardening

1. The production model adapter checks an explicit 17-name tool allowlist before
   contacting the provider. Unrecognized tools, dynamic/provider-executed tools,
   inherited tool catalogues and tools without local handlers fail closed. The
   SDK also refuses tool calls the provider invents outside that catalogue.
2. AI record reads and site-context reads now use Postgres read-only transactions.
   The shared source report is read-only too; simulation already was. Intentional
   proposal/confirmation writes continue through their existing domain stores.
   This does not grant the model a SQL interface or expand CRM write permissions.
3. ESLint rejects execution/filesystem/network primitives, dynamic imports, eval
   and function construction in assistant modules. This is a development guard,
   complementing the runtime boundary, not an untrusted-code sandbox.
4. Runtime application files and dependencies are root-owned, readable and
   non-writable by uid 1000. Nested environment files and temporary Next builds
   are excluded from the image context. The image contains no `.git` directory.
5. Prompt version 8 explicitly refuses schema administration, raw SQL execution,
   commands, file/code changes, Git operations and deployments. Prompt refusal is
   guidance; the restrictions above do not depend on model compliance.

## Evidence and limits

- Offline SDK tests cover malicious tool registration and provider-invented SQL
  and shell calls; forbidden handlers never execute.
- Real disposable Postgres tests exercise SQL-like searches as literal data,
  rejected model-controlled SQL/scope arguments, read-only transaction writes
  (`25006`), and runtime CREATE/ALTER/DROP/TRUNCATE denials (`42501`). DDL probes
  always roll back, including if an unexpected grant allows the statement.
- Tooling tests exercise the import/execution restrictions and preserve ordinary
  SDK/crypto imports. Existing authorization, tenant isolation, signed-card and
  retry tests remain applicable.
- The runtime-stage permission probe uses the exact Dockerfile runtime
  instructions with a small fixture containing the backend bundle. It confirmed
  uid 1000, readable code, denied source/new-file writes and chmod, with `/tmp`
  still writable. The full local dependency-installing image build exceeded the
  execution workspace's disk limit; it is not represented as a successful full
  image build. The actual release still requires Railway build/deploy success.
- No customer records, automations or email deliveries were changed by the
  security tests. Tests use synthetic data and a disposable local database.

Rollback is a normal code deployment; no migration, database-role mutation,
provider/model change or new secret is involved.

Local final checks: 230 test files passed (2,793 tests; four backup-tool skips),
57 tooling tests passed, and eight selected real-backend browser journeys passed.
Workspace typechecking, lint, formatting, production builds and diff checks passed.
