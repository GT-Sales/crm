import { defineConfig } from 'vitest/config';

import { baseTestConfig } from '@gt-sales/config/vitest.base';

export default defineConfig({
  test: {
    ...baseTestConfig,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Several suites re-run a migration's runtime file (ALTER TABLE … FORCE
    // ROW LEVEL SECURITY takes an ACCESS EXCLUSIVE lock) on the shared test
    // database. Run alongside another suite deleting a lead, that deadlocked
    // CI on main once (40P01). These files run one at a time, after every
    // other project has finished.
    fileParallelism: false,
    sequence: { groupOrder: 1 },
  },
});
