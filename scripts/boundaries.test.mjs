import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
const boundary = 'canadian-plans/data-boundary';
const cases = [
  ['static DB import', "export { withTenantTx } from '@gt-sales/db';"],
  ['DB subpath', "import '@gt-sales/db/schema';"],
  ['dynamic DB import', "void import('@gt-sales/db');"],
  ['relative DB import', "import '../../../packages/db/src/index';"],
  ['CommonJS DB import', "require('@gt-sales/db');"],
  ['DB type import', "export type DB = typeof import('@gt-sales/db');"],
  ['postgres driver', "import 'postgres';"],
  ['pg driver', "import 'pg';"],
  ['Drizzle driver', "import 'drizzle-orm/postgres-js';"],
  ['Prisma driver', "import '@prisma/client';"],
  ['SQLite driver', "import 'node:sqlite';"],
  ['server adapter', "import '@gt-sales/adapters';"],
  ['relative backend import', "import '../../backend/src/app';"],
  [
    'Supabase DB call',
    "import { createClient } from '@supabase/supabase-js'; createClient('url', 'key').from('orders');",
  ],
  [
    'Supabase Storage call',
    "import { createClient } from '@supabase/supabase-js'; createClient('url', 'key').storage.from('files');",
  ],
  [
    'aliased Supabase client escape',
    "import { createClient as make } from '@supabase/supabase-js'; export const client = make('url', 'key');",
  ],
  [
    'Supabase factory escape',
    "import { createClient } from '@supabase/supabase-js'; export const make = createClient;",
  ],
  [
    'Supabase rest destructuring',
    "import { createClient } from '@supabase/supabase-js'; export const { auth, ...db } = createClient('url', 'key');",
  ],
  ['dynamic Supabase import', "void import('@supabase/ssr');"],
  ['direct Storage SDK', "import '@supabase/storage-js';"],
  ['computed module path', "const moduleName = 'postgres'; void import(moduleName);"],
];

for (const [name, source] of cases) {
  test(`admin rejects ${name}`, async () => {
    const results = await eslint.lintText(source, { filePath: 'apps/admin/src/boundary-demo.ts' });
    assert.ok(
      results.some((r) => r.messages.some((m) => m.ruleId === boundary)),
      name,
    );
  });
}

for (const filePath of [
  'apps/admin/src/demo.js',
  'apps/admin/src/demo.ts',
  'packages/contracts/src/demo.ts',
  'jobs/demo.ts',
  'scripts/demo.ts',
]) {
  test(`${filePath} has no implicit DB exemption`, async () => {
    const results = await eslint.lintText("import '@gt-sales/db';", { filePath });
    assert.ok(results.some((r) => r.messages.some((m) => m.ruleId === boundary)));
  });
}

for (const filePath of ['apps/backend/src/demo.ts', 'packages/db/src/demo.ts']) {
  test(`${filePath} may import DB`, async () => {
    const results = await eslint.lintText("import '@gt-sales/db';", { filePath });
    assert.equal(results[0]?.errorCount, 0);
  });
}

for (const source of [
  "import { createClient } from '@supabase/supabase-js'; export const { auth } = createClient('url', 'key');",
  "import { createBrowserClient as make } from '@supabase/ssr'; export const auth = make('url', 'key').auth;",
  "import '@supabase/auth-js';",
  "export const value = { label: 'safe' } as const;",
]) {
  test(`allowed session/type pattern: ${source}`, async () => {
    const results = await eslint.lintText(source, { filePath: 'apps/admin/src/demo.ts' });
    assert.equal(results[0]?.errorCount, 0, JSON.stringify(results[0]?.messages));
  });
}

for (const [source, rule] of [
  ['export type Unsafe = any;', '@typescript-eslint/no-explicit-any'],
  [
    "export const unsafe = JSON.parse('{}') as { id: string };",
    '@typescript-eslint/consistent-type-assertions',
  ],
]) {
  test(`${rule} is active`, async () => {
    const results = await eslint.lintText(source, { filePath: 'apps/admin/src/demo.ts' });
    assert.ok(results.some((r) => r.messages.some((m) => m.ruleId === rule)));
  });
}
