/**
 * Writes the model test report: one self-contained HTML page from a results
 * file (scored or not).
 *
 *   pnpm --filter backend exec tsx scripts/model-test/report.ts --results <file> --out <file.html>
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { loadPrompts } from './lib/fixtures.js';
import { renderReport } from './lib/report-html.js';
import { readRunFile } from './lib/results.js';
import { judgeMean } from './lib/scoring.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      results: { type: 'string' },
      prompts: { type: 'string' },
      out: { type: 'string' },
    },
  });
  if (!values.results || !values.out)
    throw new Error('--results <file> and --out <file.html> are required');
  const run = await readRunFile(values.results);
  if (!run) throw new Error('The results file does not exist');
  const prompts = await loadPrompts(values.prompts);
  for (const result of run.results) result.judgeMean ??= judgeMean(result);
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, renderReport(run, prompts), 'utf8');
  process.stdout.write(`Wrote ${values.out}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Report failed'}\n`);
    process.exitCode = 1;
  });
}
