import { defineConfig } from '@playwright/test';
import { basePlaywrightConfig } from '@gt-sales/config/playwright.base';

export default defineConfig({
  ...basePlaywrightConfig,
  testDir: './e2e',
  // The lead journeys need the backend harness and the e2e build; they run
  // from playwright.leads.config.ts (pnpm --filter admin test:e2e:leads).
  testIgnore: ['leads.spec.ts'],
  workers: 1,
  use: {
    ...basePlaywrightConfig.use,
    baseURL: 'http://127.0.0.1:3100',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
    {
      name: 'mobile',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    },
  ],
  webServer: {
    command: 'pnpm exec next start --hostname 127.0.0.1 --port 3100',
    url: 'http://127.0.0.1:3100/login',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
