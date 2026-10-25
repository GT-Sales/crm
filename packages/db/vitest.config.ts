import { defineConfig } from 'vitest/config';

import { baseTestConfig } from '@gt-sales/config/vitest.base';

export default defineConfig({
  test: {
    ...baseTestConfig,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
