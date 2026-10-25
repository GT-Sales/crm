import { baseConfig, reactConfig } from './packages/config/eslint.js';
import { boundaryConfig } from './packages/config/boundaries.js';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.next-e2e/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.tsbuildinfo',
    ],
  },
  ...baseConfig,
  reactConfig,
  boundaryConfig,
];
