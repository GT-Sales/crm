import type { PlaywrightTestConfig } from '@playwright/test';

/**
 * Shared Playwright defaults for every frontend. No specs exist yet — each
 * frontend imports this and adds `testDir`/`baseURL`/`webServer` once its
 * first e2e journey is built (see BUILD_TASKS.md).
 */
export const basePlaywrightConfig: PlaywrightTestConfig = {
  retries: process.env['CI'] ? 2 : 0,
  forbidOnly: Boolean(process.env['CI']),
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
};
