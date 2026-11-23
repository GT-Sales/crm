import { createHash } from 'node:crypto';
import { z } from 'zod';

import { answerText } from './checks.js';
import type { Category, Prompt, PromptFile } from './fixtures.js';
import { promptTurns } from './fixtures.js';
import type { JudgeScore, PromptResult, RunFile } from './results.js';
import { RUNNABLE_OUTCOMES } from './scoring.js';

/**
 * The blind judges. Every answer to one prompt (one effort level) is shown
 * together, anonymised as A, B, C … in an order shuffled per prompt, with the
 * seed's facts and the rubric; a judge answers strict JSON, 0–2 per
 * criterion. The same groups can be written to `judge-input.jsonl` for a
 * reviewer to judge offline and read back from `judge-output.jsonl`.
 */

export const DEFAULT_JUDGES = ['anthropic/claude-fable-5.2', 'openai/gpt-6.2-astra'] as const;
export const GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';

export interface Criterion {
  readonly key: string;
  readonly description: string;
}

const CORRECT: Criterion = {
  key: 'correctness',
  description:
    'Uses only facts that are in the site facts or the answer’s own CRM reads; nothing invented; right lead, order and numbers.',
};
const PLAIN: Criterion = {
  key: 'plain_language',
  description: 'Plain words a salesperson understands; no jargon, ids, field names or tool talk.',
};

export const RUBRICS: Readonly<Record<Category | 'safety', readonly Criterion[]>> = {
  email: [
    CORRECT,
    {
      key: 'tone',
      description:
        'Friendly, professional and fitting the situation (apologetic for a delay, warm for a follow-up).',
    },
    {
      key: 'clarity',
      description:
        'A clear subject, short paragraphs, one clear ask or next step for the customer.',
    },
    {
      key: 'completeness',
      description: 'Covers everything the request asked for, ready to send after a read.',
    },
  ],
  ux: [
    {
      key: 'answer_first',
      description: 'The short answer comes first, before any detail.',
    },
    {
      key: 'next_step',
      description: 'Ends with one suggested next step (not a list of many).',
    },
    {
      key: 'clarifying_question',
      description:
        'When the request is unclear, asks a single clear question instead of guessing; when it is clear, asks nothing unnecessary.',
    },
    PLAIN,
  ],
  reasoning: [
    CORRECT,
    {
      key: 'insight',
      description: 'Explains why, prioritises sensibly and spots what matters in the data.',
    },
    {
      key: 'actionability',
      description: 'Gives concrete next steps the team can take today.',
    },
    PLAIN,
  ],
  files: [
    CORRECT,
    { key: 'completeness', description: 'Uses the attached file fully and answers every part.' },
    PLAIN,
  ],
  memory: [
    CORRECT,
    {
      key: 'context',
      description: 'Carries the earlier messages forward correctly (who “them” and “it” are).',
    },
    PLAIN,
  ],
  task: [CORRECT, PLAIN],
  lookup: [CORRECT, PLAIN],
  automation: [CORRECT, PLAIN],
  safety: [CORRECT, PLAIN],
};

export interface JudgeAnswer {
  readonly label: string;
  readonly text: string;
}

export interface JudgeGroup {
  readonly groupId: string;
  readonly promptId: string;
  readonly category: Category | 'safety';
  readonly effort: 'normal' | 'high';
  readonly conversation: readonly string[];
  readonly facts: string;
  readonly uxStandard: string;
  readonly criteria: readonly Criterion[];
  readonly answers: readonly JudgeAnswer[];
}

/** Which result each anonymous label stands for, per group: kept away from the judges. */
export type JudgeKey = Record<string, Record<string, string>>;

/** A small seeded generator, so the shuffle is the same for the same seed and prompt. */
function seededRandom(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(seed);
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const here = out[index];
    const there = out[swap];
    if (here === undefined || there === undefined) continue;
    out[index] = there;
    out[swap] = here;
  }
  return out;
}

function label(index: number): string {
  return index < 26 ? String.fromCharCode(65 + index) : `A${index - 25}`;
}

/** The answer as the person saw it: the text, the follow-up and each card's draft in words. */
export function judgeText(result: PromptResult): string {
  const last = result.turns.at(-1);
  if (!last) return '(no answer)';
  const parts = [answerText(last.capture).trim() || '(no text)'];
  for (const card of last.capture.cards) {
    const fields = Object.entries(card.fields)
      .filter(([key]) => key !== 'leadId' && key !== 'taskId')
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join('\n');
    parts.push(
      `[Card for review: ${card.kind}${card.leadLabel ? ` about ${card.leadLabel}` : ''}]\n${fields}`,
    );
  }
  for (const draft of last.capture.automations) {
    parts.push(
      `[Automation draft for review: ${draft.name ?? 'unnamed'} — ${draft.kinds.join(' → ')}]`,
    );
  }
  if (last.capture.error)
    parts.push(`[The answer ended with an error: ${last.capture.error.code}]`);
  return parts.join('\n\n');
}

export function buildJudgeGroups(
  run: RunFile,
  prompts: PromptFile,
  seed: string,
): { groups: JudgeGroup[]; key: JudgeKey } {
  const groups: JudgeGroup[] = [];
  const key: JudgeKey = {};
  const byId = new Map<string, Prompt>(prompts.prompts.map((prompt) => [prompt.id, prompt]));
  const grouped = new Map<string, PromptResult[]>();
  for (const result of run.results) {
    const prompt = byId.get(result.promptId);
    if (!prompt?.judge || !RUNNABLE_OUTCOMES.has(result.outcome)) continue;
    const groupId = `${result.promptId}:${result.effort}`;
    grouped.set(groupId, [...(grouped.get(groupId) ?? []), result]);
  }
  for (const [groupId, results] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const first = results[0];
    const prompt = first ? byId.get(first.promptId) : undefined;
    if (!first || !prompt) continue;
    const order = shuffled(
      [...results].sort((a, b) => a.key.localeCompare(b.key)),
      `${seed}:${groupId}`,
    );
    const labels: Record<string, string> = {};
    key[groupId] = labels;
    const answers = order.map((result, index) => {
      const name = label(index);
      labels[name] = result.key;
      return { label: name, text: judgeText(result) };
    });
    groups.push({
      groupId,
      promptId: prompt.id,
      category: prompt.category,
      effort: first.effort,
      conversation: promptTurns(prompt).map((turn) =>
        turn.attachments ? `${turn.text} [attached: ${turn.attachments.join(', ')}]` : turn.text,
      ),
      facts: prompt.facts ?? 'See the conversation.',
      uxStandard: prompts.uxStandard,
      criteria: RUBRICS[prompt.category],
      answers,
    });
  }
  return { groups, key };
}

export const JUDGE_SYSTEM = [
  'You are a strict, blind evaluator of a CRM sales assistant’s answers.',
  'Several anonymous answers (A, B, …) to the same staff request are shown. Score each one on every criterion: 0 = poor or missing, 1 = partly, 2 = fully meets it.',
  'Judge only what is written. Do not reward length. Treat the site facts as the ground truth; an answer that states a different fact is incorrect.',
  'A card for review is a draft the person confirms; it is part of the answer (an email card holds the email itself).',
  'Answer with JSON only, no prose: {"scores":[{"label":"A","criteria":{"<criterion>":0|1|2,…},"note":"one sentence, at most 200 characters"}]} with one entry per answer.',
].join('\n');

export function judgeUserMessage(group: JudgeGroup): string {
  return [
    `Staff request${group.conversation.length > 1 ? ' (a conversation, judge the last answer)' : ''}:`,
    ...group.conversation.map((text, index) => `${index + 1}. ${text}`),
    '',
    `Site facts (ground truth): ${group.facts}`,
    '',
    `UX standard: ${group.uxStandard}`,
    '',
    'Criteria:',
    ...group.criteria.map((criterion) => `- ${criterion.key}: ${criterion.description}`),
    '',
    ...group.answers.flatMap((answer) => [`=== Answer ${answer.label} ===`, answer.text, '']),
  ].join('\n');
}

export function judgeOutputSchema(group: Pick<JudgeGroup, 'criteria' | 'answers'>) {
  const criteria = Object.fromEntries(
    group.criteria.map((criterion) => [criterion.key, z.int().min(0).max(2)]),
  );
  const labels = group.answers.map((answer) => answer.label);
  return z
    .object({
      scores: z
        .array(
          z
            .object({
              label: z.string(),
              criteria: z.object(criteria).strict(),
              note: z.string().max(400),
            })
            .strict(),
        )
        .length(labels.length),
    })
    .strict()
    .refine(
      (value) =>
        new Set(value.scores.map((score) => score.label)).size === labels.length &&
        value.scores.every((score) => labels.includes(score.label)),
      { message: 'one score per answer label' },
    );
}

/** Reads a judge's reply: JSON, optionally in a code fence. Throws when it is not the rubric. */
export function parseJudgeReply(
  group: Pick<JudgeGroup, 'criteria' | 'answers'>,
  reply: string,
): { label: string; criteria: Record<string, number>; note: string }[] {
  const trimmed = reply
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return judgeOutputSchema(group).parse(JSON.parse(trimmed)).scores;
}

/** One judge over the Gateway's OpenAI-compatible chat endpoint; one retry on a bad reply. */
export async function callGatewayJudge(options: {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly model: string;
  readonly group: JudgeGroup;
}): Promise<{ label: string; criteria: Record<string, number>; note: string }[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await doFetch(`${options.baseUrl ?? GATEWAY_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: judgeUserMessage(options.group) },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) {
      // The status only: a provider body could echo the prompt.
      lastError = new Error(`judge_http_${response.status}`);
      continue;
    }
    const body = z
      .object({
        choices: z
          .array(z.object({ message: z.object({ content: z.string().nullable() }) }))
          .min(1),
      })
      .safeParse(await response.json());
    try {
      if (!body.success) throw new Error('judge_reply_shape');
      return parseJudgeReply(options.group, body.data.choices[0]?.message.content ?? '');
    } catch (error) {
      lastError = error instanceof z.ZodError ? new Error('judge_reply_not_rubric') : error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('judge_failed');
}

/** One line of `judge-input.jsonl`: everything a reviewer needs, nothing that names a model. */
export function judgeInputLine(group: JudgeGroup): string {
  return JSON.stringify({
    groupId: group.groupId,
    promptId: group.promptId,
    category: group.category,
    instructions: JUDGE_SYSTEM,
    message: judgeUserMessage(group),
    criteria: group.criteria,
    labels: group.answers.map((answer) => answer.label),
    expectedOutput: {
      groupId: group.groupId,
      judge: '<your judge name>',
      scores: [
        { label: 'A', criteria: { [group.criteria[0]?.key ?? 'correctness']: 2 }, note: '…' },
      ],
    },
  });
}

const judgeOutputLineSchema = z
  .object({
    groupId: z.string().min(1),
    judge: z.string().min(1).max(80),
    scores: z.array(z.unknown()),
  })
  .strict();

/**
 * Merges judge scores into the results: from the Gateway or from the lines
 * of a `judge-output.jsonl`. A line whose group, labels or criteria do not
 * match is refused with its line number, never half-applied.
 */
export function applyJudgeLines(
  run: RunFile,
  groups: readonly JudgeGroup[],
  key: JudgeKey,
  lines: readonly string[],
): { applied: number } {
  const byGroup = new Map(groups.map((group) => [group.groupId, group]));
  const updates: { resultKey: string; score: JudgeScore }[] = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    const parsed = judgeOutputLineSchema.parse(JSON.parse(line));
    const group = byGroup.get(parsed.groupId);
    const labels = key[parsed.groupId];
    if (!group || !labels) throw new Error(`judge-output line ${index + 1}: unknown group`);
    const scores = parseJudgeReply(group, JSON.stringify({ scores: parsed.scores }));
    for (const score of scores) {
      const resultKey = labels[score.label];
      if (!resultKey) throw new Error(`judge-output line ${index + 1}: unknown label`);
      updates.push({
        resultKey,
        score: { judge: parsed.judge, criteria: score.criteria, note: score.note },
      });
    }
  });
  for (const update of updates) {
    const result = run.results.find((candidate) => candidate.key === update.resultKey);
    if (!result) continue;
    result.judges = [
      ...(result.judges ?? []).filter((judge) => judge.judge !== update.score.judge),
      update.score,
    ];
  }
  return { applied: updates.length };
}
