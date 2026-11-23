/**
 * Scores a model test results file: re-runs the automatic checks over the
 * stored answers, adds the blind judges' scores and writes the per-model
 * scores and the recommendation back into the same file.
 *
 *   pnpm --filter backend exec tsx scripts/model-test/score.ts --results <file> [--judge gateway|offline|import|none]
 *
 * --judge gateway  the two judges over the AI Gateway (AI_GATEWAY_API_KEY), the default when the key is set
 * --judge offline  writes judge-input.jsonl (anonymised answers, rubric) and the label key, scores without judges
 * --judge import   reads judge-output.jsonl produced elsewhere, with the label key from the offline step
 * --judge none     automatic checks only
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { z } from 'zod';

import { autoScore, runChecks, type CheckContext } from './lib/checks.js';
import { loadPrompts, type PromptFile } from './lib/fixtures.js';
import {
  applyJudgeLines,
  buildJudgeGroups,
  callGatewayJudge,
  DEFAULT_JUDGES,
  judgeInputLine,
  type JudgeKey,
} from './lib/judge.js';
import { readRunFile, writeRunFile, type RunFile } from './lib/results.js';
import { finalScore, judgeMean, presentCategories, recommend, scoreModel } from './lib/scoring.js';

/** Re-runs every completed answer's checks against the current prompt file. */
export function recheck(run: RunFile, prompts: PromptFile): void {
  const byId = new Map(prompts.prompts.map((prompt) => [prompt.id, prompt]));
  for (const result of run.results) {
    const prompt = byId.get(result.promptId);
    const capture = result.turns.at(-1)?.capture;
    if (!prompt || !capture || result.outcome !== 'completed') continue;
    const context: CheckContext = {
      ownerUserId: run.accounts.owner.userId,
      leadsUserId: run.accounts.leads?.userId ?? '00000000-0000-4000-8000-000000000000',
      today: result.askedOn,
      ids: prompts.ids,
    };
    const checks = runChecks(prompt, capture, context);
    Object.assign(result, { checks, autoScore: autoScore(capture, checks) });
  }
}

/** Fills each answer's judge mean and final score, and the file's scoring section. */
export function summarize(run: RunFile, prompts: PromptFile): string | null {
  const byId = new Map(prompts.prompts.map((prompt) => [prompt.id, prompt]));
  for (const result of run.results) {
    result.judgeMean = judgeMean(result);
    result.finalScore = finalScore(result, byId.get(result.promptId)?.judge ?? false);
  }
  const present = presentCategories(run);
  const models = run.models.map((model) => scoreModel(run, model, prompts.prompts, present));
  const recommendation = recommend(models);
  run.scoring = {
    computedAt: new Date().toISOString(),
    categories: [...present],
    models,
    recommendation,
    formula:
      'final = A without judges; with judges 0 if A = 0, else C = (A + J) / 2 → 2 if C ≥ 1.75, 1 if C ≥ 1, else 0. Category = mean final / 2. Weighted = categories at 25/15/15/15/10/10/5/5, renormalised over categories with answers.',
  };
  return recommendation.default;
}

const judgeKeySchema = z.record(z.string(), z.record(z.string(), z.string()));

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      results: { type: 'string' },
      prompts: { type: 'string' },
      judge: { type: 'string' },
      judges: { type: 'string' },
      'judge-input': { type: 'string' },
      'judge-output': { type: 'string' },
      'judge-key': { type: 'string' },
      seed: { type: 'string' },
    },
  });
  if (!values.results) throw new Error('--results <file> is required');
  const run = await readRunFile(values.results);
  if (!run) throw new Error('The results file does not exist');
  const prompts = await loadPrompts(values.prompts);
  if (prompts.version !== run.promptsVersion)
    throw new Error('The results were made with another prompt version');

  const base = values.results.replace(/\.json$/, '');
  const inputPath = values['judge-input'] ?? join(dirname(values.results), 'judge-input.jsonl');
  const outputPath = values['judge-output'] ?? join(dirname(values.results), 'judge-output.jsonl');
  const keyPath = values['judge-key'] ?? `${base}.judge-key.json`;
  const apiKey = process.env['AI_GATEWAY_API_KEY'];
  const mode = values.judge ?? (apiKey ? 'gateway' : 'none');
  const judges = (values.judges ?? process.env['MODEL_TEST_JUDGES'] ?? DEFAULT_JUDGES.join(','))
    .split(',')
    .map((judge) => judge.trim())
    .filter(Boolean);

  recheck(run, prompts);
  const { groups, key } = buildJudgeGroups(run, prompts, values.seed ?? run.startedAt);

  if (mode === 'offline') {
    await writeFile(inputPath, groups.map(judgeInputLine).join('\n') + '\n', 'utf8');
    await writeFile(keyPath, `${JSON.stringify(key, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `Wrote ${groups.length} judge groups to ${inputPath} and the label key to ${keyPath} (keep the key from the reviewer). Import their judge-output.jsonl with --judge import.\n`,
    );
  } else if (mode === 'import') {
    const savedKey: JudgeKey = judgeKeySchema.parse(JSON.parse(await readFile(keyPath, 'utf8')));
    const lines = (await readFile(outputPath, 'utf8')).split('\n');
    const { applied } = applyJudgeLines(run, groups, savedKey, lines);
    process.stdout.write(`Applied ${applied} judge scores from ${outputPath}.\n`);
  } else if (mode === 'gateway') {
    if (!apiKey) throw new Error('--judge gateway needs AI_GATEWAY_API_KEY');
    await writeFile(keyPath, `${JSON.stringify(key, null, 2)}\n`, 'utf8');
    const lines: string[] = [];
    for (const judge of judges) {
      for (const group of groups) {
        try {
          const scores = await callGatewayJudge({ apiKey, model: judge, group });
          lines.push(JSON.stringify({ groupId: group.groupId, judge, scores }));
        } catch (error) {
          process.stdout.write(
            `${JSON.stringify({ judge, group: group.groupId, error: error instanceof Error ? error.message : 'judge_failed' })}\n`,
          );
        }
      }
    }
    await writeFile(outputPath, lines.join('\n') + '\n', 'utf8');
    const { applied } = applyJudgeLines(run, groups, key, lines);
    process.stdout.write(`Applied ${applied} judge scores from ${judges.join(', ')}.\n`);
  } else if (mode !== 'none') {
    throw new Error('--judge is one of gateway, offline, import, none');
  }

  const pick = summarize(run, prompts);
  await writeRunFile(values.results, run);
  process.stdout.write(`Scored ${run.results.length} answers. Default pick: ${pick ?? 'none'}.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Scoring failed'}\n`);
    process.exitCode = 1;
  });
}
