import { readFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * The model test's prompt set (docs/evals/model-test/prompts-v1.json): the
 * 40 scored prompts in eight categories, the safety gate, and the facts of
 * the seeded "Model test" site the checks compare against.
 */

export const CATEGORIES = [
  'task',
  'lookup',
  'email',
  'ux',
  'reasoning',
  'automation',
  'files',
  'memory',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** The owner's agreed weights; they sum to 1. */
export const CATEGORY_WEIGHTS: Readonly<Record<Category, number>> = {
  task: 0.25,
  lookup: 0.15,
  email: 0.15,
  ux: 0.15,
  reasoning: 0.1,
  automation: 0.1,
  files: 0.05,
  memory: 0.05,
};

export const CATEGORY_LABELS: Readonly<Record<Category | 'safety', string>> = {
  task: 'Task accuracy',
  lookup: 'Data look-ups',
  email: 'Email writing',
  ux: 'UX',
  reasoning: 'Reasoning and insights',
  automation: 'Automation drafting',
  files: 'Files',
  memory: 'Multi-turn memory',
  safety: 'Safety gate',
};

const textList = z.array(z.string().min(1)).min(1);
const common = {
  /** A failed critical check makes the answer 0 whatever else passed. */
  critical: z.boolean().optional(),
  note: z.string().optional(),
};

/**
 * One automatic check of the final turn. Text comparisons ignore case. Values
 * may hold `{{…}}` fill-ins (`checks.ts`): the test accounts' ids and Toronto
 * calendar days relative to the turn.
 */
export const checkSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('includes_all'), values: textList, ...common }).strict(),
  z.object({ type: z.literal('includes_any'), values: textList, ...common }).strict(),
  z.object({ type: z.literal('excludes'), values: textList, ...common }).strict(),
  z.object({ type: z.literal('excludes_pattern'), pattern: z.string().min(1), ...common }).strict(),
  /** The answer states this number, in digits or (up to twenty) in words. */
  z.object({ type: z.literal('number'), value: z.int().nonnegative(), ...common }).strict(),
  /**
   * A prepared card of one of `kinds`, about `leadId` / `taskId` when given,
   * whose draft fields match: a value is a fill-in-able exact value (case
   * insensitive), a list of accepted values, or `{ pattern }` (a regex).
   */
  z
    .object({
      type: z.literal('card'),
      kinds: textList,
      leadId: z.string().optional(),
      taskId: z.string().optional(),
      fields: z
        .record(
          z.string(),
          z.union([
            z.string(),
            z.array(z.string()).min(1),
            z.object({ pattern: z.string().min(1) }).strict(),
          ]),
        )
        .optional(),
      ...common,
    })
    .strict(),
  /** No card of any kind and no automation draft. */
  z.object({ type: z.literal('no_card'), ...common }).strict(),
  /** A clarifying question: the stream's follow-up part, or a question in the answer. */
  z.object({ type: z.literal('follow_up'), ...common }).strict(),
  /** The answer declines (`can't`, `not able`, `don't have access`, …). */
  z.object({ type: z.literal('refusal'), ...common }).strict(),
  /** No CRM tool was used (only the "Getting ready"/"Thinking" progress). */
  z.object({ type: z.literal('no_tool_call'), ...common }).strict(),
  /** A tool whose progress label is one of these was used. */
  z.object({ type: z.literal('tool'), labels: textList, ...common }).strict(),
  /** An automation draft, whose trigger or a step is `kind` when given. */
  z.object({ type: z.literal('automation'), kind: z.string().optional(), ...common }).strict(),
  z.object({ type: z.literal('min_chars'), value: z.int().positive(), ...common }).strict(),
  /** The trimmed answer is not just this word (an injected instruction followed). */
  z.object({ type: z.literal('not_only'), value: z.string().min(1), ...common }).strict(),
]);
export type Check = z.infer<typeof checkSchema>;

export const turnSchema = z
  .object({
    text: z.string().min(1).max(4000),
    /** File names under docs/evals/model-test/fixtures/ attached to this message. */
    attachments: z.array(z.string().min(1)).max(4).optional(),
  })
  .strict();
export type PromptTurn = z.infer<typeof turnSchema>;

export const promptSchema = z
  .object({
    id: z.string().regex(/^[a-z]+-\d{2}$/),
    category: z.enum([...CATEGORIES, 'safety']),
    account: z.enum(['owner', 'leads']).default('owner'),
    /** A single message; or `turns` for a conversation (multi-turn memory). */
    text: z.string().min(1).max(4000).optional(),
    attachments: z.array(z.string().min(1)).max(4).optional(),
    turns: z.array(turnSchema).min(2).max(5).optional(),
    checks: z.array(checkSchema).min(1),
    /** Whether the blind judges score this answer's quality. */
    judge: z.boolean().default(false),
    /** Asked again at High effort on the top three models. */
    high: z.boolean().default(false),
    /** What a correct answer contains, from the seed; shown to the judges. */
    facts: z.string().optional(),
  })
  .strict()
  .refine((prompt) => (prompt.text === undefined) !== (prompt.turns === undefined), {
    message: 'a prompt has either text or turns',
  });
export type Prompt = z.infer<typeof promptSchema>;

export const promptFileSchema = z
  .object({
    version: z.int().positive(),
    site: z
      .object({
        id: z.uuid(),
        slug: z.literal('model-test'),
        name: z.string().min(1),
      })
      .strict(),
    /** The seed's fixed ids the checks name (`{{lead:<n>}}`, `{{task:<n>}}`). */
    ids: z
      .object({
        leadPrefix: z.string().regex(/^[0-9a-f-]+-$/),
        taskPrefix: z.string().regex(/^[0-9a-f-]+-$/),
      })
      .strict(),
    /** The read-only seed freshness check the runner makes before asking anything. */
    preflight: z
      .object({
        taskTitle: z.string().min(1),
        dueDaysFromToday: z.int(),
      })
      .strict(),
    /** The UX standard and rubric the judges score against. */
    uxStandard: z.string().min(1),
    prompts: z.array(promptSchema).min(1),
  })
  .strict()
  .superRefine((file, context) => {
    const ids = new Set<string>();
    for (const prompt of file.prompts) {
      if (ids.has(prompt.id)) {
        context.addIssue({ code: 'custom', message: `duplicate prompt id ${prompt.id}` });
      }
      ids.add(prompt.id);
    }
  });
export type PromptFile = z.infer<typeof promptFileSchema>;

/** A prompt's messages in order: its one `text`, or its `turns`. */
export function promptTurns(prompt: Prompt): PromptTurn[] {
  if (prompt.turns) return prompt.turns;
  return [
    {
      text: prompt.text ?? '',
      ...(prompt.attachments ? { attachments: prompt.attachments } : {}),
    },
  ];
}

export const DEFAULT_PROMPTS_PATH = new URL(
  '../../../../../docs/evals/model-test/prompts-v1.json',
  import.meta.url,
);
export const FIXTURES_DIR = new URL(
  '../../../../../docs/evals/model-test/fixtures/',
  import.meta.url,
);

export async function loadPrompts(path: URL | string = DEFAULT_PROMPTS_PATH): Promise<PromptFile> {
  return promptFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}
