import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';

const eslint = new ESLint();
for (const source of [
  "import { exec } from 'node:child_process'; void exec;",
  "import { writeFile } from 'node:fs/promises'; void writeFile;",
  "import { Script } from 'node:vm'; void Script;",
  "import { createRequire } from 'node:module'; void createRequire;",
  "import { request } from 'node:https'; void request;",
  "void import('node:fs');",
  "void fetch('https://example.invalid');",
  "void eval('1');",
  "void new Function('return 1');",
]) {
  test(`assistant modules reject execution and filesystem capability: ${source}`, async () => {
    const [result] = await eslint.lintText(source, {
      filePath: 'apps/backend/src/ai/security-probe.ts',
    });
    assert.ok(
      result?.messages.some((message) =>
        [
          'no-restricted-imports',
          'no-restricted-syntax',
          'no-restricted-globals',
          'no-eval',
          'no-new-func',
        ].includes(message.ruleId),
      ),
    );
  });
}

test('normal assistant modules can still use the SDK and signature helpers', async () => {
  const [result] = await eslint.lintText(
    "import { tool } from 'ai'; import { randomUUID } from 'node:crypto'; void tool; void randomUUID;",
    { filePath: 'apps/backend/src/ai/security-probe.ts' },
  );
  assert.equal(result?.errorCount, 0);
});
