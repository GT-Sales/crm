import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { baseTestConfig } from '@gt-sales/config/vitest.base';

export default defineConfig({
  plugins: [react()],
  test: {
    ...baseTestConfig,
    name: 'admin',
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
  },
});
