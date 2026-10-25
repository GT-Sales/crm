import { defineConfig } from 'vitest/config';

// Runs every app/package's own vitest.config.ts as a project. Several
// packages (types, db, adapters, ui) have no test files yet — passWithNoTests
// is a root-only option in Vitest 5, so it lives here rather than in each
// project's own config.
export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: ['apps/*', 'packages/*', 'jobs'],
  },
});
