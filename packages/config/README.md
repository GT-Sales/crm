# @canadian-plans/config

Shared, non-published tooling configuration: strict TypeScript base
(`tsconfig.base.json`), ESLint flat-config building blocks (`eslint.js`,
including the `@canadian-plans/db` import-boundary rule), Prettier config,
and Vitest/Playwright defaults.

## Single responsibility

Own the repo's linting, type-checking, formatting, and test-runner
conventions in one place so no app or package hand-rolls its own.

## Must never import

- `@canadian-plans/db`, `@canadian-plans/adapters`, `@canadian-plans/types`,
  `@canadian-plans/contracts`, `@canadian-plans/ui` — this package sits
  below all of them and must stay dependency-free of workspace code.
- Any provider SDK or secret.

## Boundary enforcement and verification

`boundaries.js` supplies the `canadian-plans/data-boundary` rule for JavaScript and TypeScript. DB package imports (including relative paths), common direct database SDKs and frontend imports of backend/provider code fail lint. Static imports, re-exports, require and dynamic imports are checked. Nonliteral module paths are rejected because their destination cannot be reviewed statically.

Only backend, the DB package and exact offline files in `offlineDbFiles` may import database code. The offline list is currently empty. This is a development guardrail, not runtime authorization or a substitute for reviewing new dependencies/aliases and network calls.

Supabase Auth is not installed. Future session-only clients may use `@supabase/auth-js` or immediately select `.auth` / destructure only `{ auth }` from a named `createClient`, `createBrowserClient` or `createServerClient` import. Full clients, factory escapes, namespace imports and DB/Storage SDKs are forbidden outside the DB allowlist. Do not weaken the boundary to add authentication.

`tsconfig.json` checks this package's TypeScript presets and `src/index.ts` under the same strict base. `pnpm run test:tooling` runs regression cases through the real ESLint configuration and verifies affected-build dependency propagation.
