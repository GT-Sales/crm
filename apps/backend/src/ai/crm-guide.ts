import { tool, type Tool } from 'ai';
import { z } from 'zod';

import { CRM_GUIDE_TOPICS, type CrmGuideTopic } from './crm-guide-topics.js';
import type { TurnBudget } from './limits.js';

/**
 * Ask AI's how-to guide for the CRM itself ("where do I archive a lead?").
 *
 * Loaded on demand, like a skill: the system prompt carries only the topic ids
 * and one-line summaries, and the model calls `getCrmGuide` for the one topic a
 * question needs. A question about the data never pays for the guide, and a
 * how-to question pays for one short topic instead of the whole manual.
 *
 * The text is fixed, reviewed product copy (crm-guide-topics.ts): it holds no
 * site data, so it needs no tenancy or permission check of its own, but every
 * call still counts against the turn's tool budget.
 */

/** The most topics one call may return, so a model cannot ask for the whole manual at once. */
export const CRM_GUIDE_MAX_TOPICS_PER_CALL = 2;

const TOPICS_BY_ID: ReadonlyMap<string, CrmGuideTopic> = new Map(
  CRM_GUIDE_TOPICS.map((topic) => [topic.id, topic]),
);

export const crmGuideInputSchema = z
  .object({
    topics: z.array(z.string().trim().min(1).max(40)).min(1).max(CRM_GUIDE_MAX_TOPICS_PER_CALL),
  })
  .strict();

/** The topic list for the system prompt: ids and summaries only, never the bodies. */
export function crmGuideIndex(): string {
  return CRM_GUIDE_TOPICS.map((topic) => `${topic.id}: ${topic.summary}`).join('\n');
}

/** The tool result: the asked topics' text, and the ids it did not know. */
export function readCrmGuide(input: unknown): string {
  const { topics } = crmGuideInputSchema.parse(input);
  const found: { id: string; text: string }[] = [];
  const unknown: string[] = [];
  for (const id of new Set(topics)) {
    const topic = TOPICS_BY_ID.get(id);
    if (topic) found.push({ id: topic.id, text: topic.body });
    else unknown.push(id);
  }
  return JSON.stringify({
    status: found.length > 0 ? 'ok' : 'not_found',
    topics: found,
    ...(unknown.length > 0
      ? { unknownTopics: unknown, hint: 'Use only topic ids from the guide index.' }
      : {}),
  });
}

/** One guide read, counted against the turn's tool budget like any other tool. */
export function runCrmGuide(budget: TurnBudget, input: unknown): string {
  if (!budget.reserveToolCall())
    return JSON.stringify({
      status: 'unavailable',
      message: 'This turn has already used its tool budget.',
    });
  return readCrmGuide(input);
}

export function createCrmGuideTool(budget: TurnBudget): Tool {
  return tool({
    description:
      'Read the CRM how-to guide: where things are and the steps to do them. Call it when the person asks how to use the CRM, where to find something, or what a screen does. Pass one or two topic ids from the guide index in your instructions; never answer a how-to question from memory.',
    inputSchema: crmGuideInputSchema,
    execute: async (input) => runCrmGuide(budget, input),
  });
}
