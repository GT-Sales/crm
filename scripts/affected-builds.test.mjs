import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { affectedApps, changedFiles, readProjects } from './affected-builds.mjs';

const script = fileURLToPath(new URL('./affected-builds.mjs', import.meta.url));
const vercelExit = (env) =>
  spawnSync(process.execPath, [script, '--vercel', 'admin'], {
    env: { ...process.env, VERCEL_GIT_PREVIOUS_SHA: 'HEAD', ...env },
    encoding: 'utf8',
  }).status;
test('Vercel redeploy of the same commit is skipped by default', () =>
  assert.equal(vercelExit({ VERCEL_FORCE_BUILD: '' }), 0));
test('VERCEL_FORCE_BUILD=1 builds the same commit again', () =>
  assert.equal(vercelExit({ VERCEL_FORCE_BUILD: '1' }), 1));

const projects = readProjects();
const names = (changes) =>
  affectedApps(projects, changes)
    .map((app) => app.name)
    .sort();
const everyApp = ['admin', 'backend'];
test('admin-only changes do not build backend', () =>
  assert.deepEqual(names(['apps/admin/src/app/page.tsx']), ['admin']));
test('backend-only changes do not build admin', () =>
  assert.deepEqual(names(['apps/backend/src/app.ts']), ['backend']));
test('shared UI builds only its frontend consumer', () =>
  assert.deepEqual(names(['packages/ui/src/index.ts']), ['admin']));
test('shared contracts build all consumers', () =>
  assert.deepEqual(names(['packages/contracts/src/index.ts']), everyApp));
test('DB change only builds backend', () =>
  assert.deepEqual(names(['packages/db/src/index.ts']), ['backend']));
test('toolchain changes build every consumer', () =>
  assert.deepEqual(names(['packages/config/tsconfig.base.json']), everyApp));
test('root configuration builds all apps', () =>
  assert.deepEqual(names(['package.json']), everyApp));
test('documentation-only changes skip builds', () =>
  assert.deepEqual(names(['docs/PLAN.md', 'README.md']), []));
test('missing git baseline fails safe', () =>
  assert.deepEqual(names(changedFiles('missing-ref-for-test')), everyApp));
test('no baseline builds all on first deployment', () => assert.deepEqual(names(null), everyApp));
test('dependency propagation is transitive', () => {
  const graph = [
    { name: 'web', directory: 'apps/web', dependencies: ['client'] },
    { name: 'client', directory: 'packages/client', dependencies: ['types'] },
    { name: 'types', directory: 'packages/types', dependencies: [] },
  ];
  assert.deepEqual(
    affectedApps(graph, ['packages/types/src/index.ts']).map((app) => app.name),
    ['web'],
  );
});
