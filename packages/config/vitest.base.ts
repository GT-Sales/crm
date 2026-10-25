import type { UserWorkspaceConfig } from 'vitest/config';

/**
 * Shared per-project Vitest defaults. `passWithNoTests` (needed because
 * several packages have no test files yet) is a root-only option in Vitest
 * 5 — set once in the repo-root vitest.config.ts instead of here.
 */
export const baseTestConfig = {
  restoreMocks: true,
  clearMocks: true,
} satisfies UserWorkspaceConfig['test'];
