import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

import type { Category } from './fixtures.js';
import type { CheckResult } from './checks.js';
import type { TurnCapture } from './stream.js';

/**
 * One run's results file (docs/evals/model-test/<YYYY-MM-DD>.json): every
 * prompt × model × effort, appended as it completes so an interrupted run
 * resumes where it stopped. Synthetic data only: no token, password, email
 * address or provider body is ever written here.
 */

export type Effort = 'normal' | 'high';

/** How a prompt's run ended. `rate_limited` and `request_failed` are retried on resume. */
export type Outcome = 'completed' | 'stream_error' | 'request_failed' | 'rate_limited' | 'skipped';

export interface TurnRecord {
  readonly text: string;
  readonly durationMs: number;
  readonly capture: TurnCapture;
  readonly attachments?: readonly string[];
  /** Why an attachment could not be sent (uploads off, a kind not offered …). */
  readonly attachmentNote?: string;
}

export interface JudgeScore {
  readonly judge: string;
  /** 0–2 per criterion. */
  readonly criteria: Readonly<Record<string, number>>;
  readonly note: string;
}

export interface PromptResult {
  readonly key: string;
  readonly promptId: string;
  readonly category: Category | 'safety';
  readonly model: string;
  readonly effort: Effort;
  readonly account: 'owner' | 'leads';
  readonly askedAt: string;
  /** The Toronto calendar day it was asked on: the day the fill-ins resolve against. */
  readonly askedOn: string;
  readonly outcome: Outcome;
  /** A fixed code: the stream's error code or the API's error code. Never a message body. */
  readonly failureCode?: string;
  readonly note?: string;
  readonly turns: readonly TurnRecord[];
  /** Whole prompt, every turn, in milliseconds. */
  readonly durationMs: number;
  /** From the site's usage before and after; null when it could not be read. */
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly toolCalls: number | null;
    readonly turns: number;
  } | null;
  /** The model id(s) the usage recorded for these turns. */
  readonly modelsUsed: readonly string[];
  readonly costUsd: number | null;
  readonly checks: readonly CheckResult[];
  readonly autoScore: 0 | 1 | 2;
  /** Filled in by score.ts. */
  judges?: JudgeScore[];
  judgeMean?: number | null;
  finalScore?: 0 | 1 | 2;
}

export interface RunFile {
  version: 1;
  promptsVersion: number;
  startedAt: string;
  updatedAt: string;
  site: { id: string; slug: string; name: string };
  /** The backend's origin (a test site's address, no credential). */
  backend: string;
  models: string[];
  accounts: { owner: { userId: string }; leads?: { userId: string } };
  capabilities: {
    conversations: boolean;
    attachments: string[];
    efforts: string[];
    automationAuthoring: boolean;
  };
  prices: Record<string, { input: number | null; output: number | null }>;
  /** The models chosen for the High pass, and why. */
  highModels?: { models: string[]; basis: string };
  results: PromptResult[];
  /** Filled in by score.ts. */
  scoring?: unknown;
  notes: string[];
}

export function resultKey(promptId: string, model: string, effort: Effort): string {
  return `${promptId}|${model}|${effort}`;
}

/** Outcomes a resumed run asks again. */
export const RETRY_OUTCOMES: ReadonlySet<Outcome> = new Set(['rate_limited', 'request_failed']);

const runFileShape = z.looseObject({
  version: z.literal(1),
  promptsVersion: z.int().positive(),
  startedAt: z.string(),
  site: z.looseObject({ id: z.uuid(), slug: z.string() }),
  models: z.array(z.string()),
  results: z.array(
    z.looseObject({
      key: z.string(),
      promptId: z.string(),
      model: z.string(),
      effort: z.enum(['normal', 'high']),
      outcome: z.string(),
    }),
  ),
  notes: z.array(z.string()),
});

/** The shape check above, typed as the file the runner wrote. */
const runFileSchema = z.custom<RunFile>((value) => runFileShape.safeParse(value).success);

export async function readRunFile(path: string): Promise<RunFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (Reflect.get(Object(error), 'code') === 'ENOENT') return undefined;
    throw error;
  }
  return runFileSchema.parse(JSON.parse(raw));
}

/** Writes the file whole through a temporary file, so a stopped run never leaves half a file. */
export async function writeRunFile(path: string, run: RunFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  run.updatedAt = new Date().toISOString();
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

/** Replaces the result with the same key, or adds it. */
export function upsertResult(run: RunFile, result: PromptResult): void {
  const index = run.results.findIndex((existing) => existing.key === result.key);
  if (index === -1) run.results.push(result);
  else run.results[index] = result;
}
