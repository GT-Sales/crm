import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Builds the admin into `.next-e2e` with the browser-test session seam and the
 * harness backend URL compiled in, then runs the lead journeys against the
 * real backend harness (playwright.leads.config.ts). The normal `.next` build
 * the shell journeys use is left alone.
 */
const pnpm = process.env.npm_execpath;
assert.ok(pnpm, 'Run through pnpm --filter admin test:e2e:leads.');
const env = {
  ...process.env,
  ADMIN_DIST_DIR: '.next-e2e',
  NEXT_PUBLIC_E2E_STAFF_BEARER: process.env.E2E_STAFF_BEARER ?? 'e2e-staff-session-owner',
  NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:4100',
};
delete env.NEXT_PUBLIC_SUPABASE_URL;
delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// `next build` points next-env.d.ts at the dist folder it built; the e2e
// build must not leave the committed file pointing at `.next-e2e`.
const nextEnv = readFileSync('next-env.d.ts', 'utf8');
for (const args of [
  ['exec', 'next', 'build'],
  ['exec', 'playwright', 'test', '-c', 'playwright.leads.config.ts', ...process.argv.slice(2)],
]) {
  const result = spawnSync(process.execPath, [pnpm, ...args], { env, stdio: 'inherit' });
  writeFileSync('next-env.d.ts', nextEnv);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
