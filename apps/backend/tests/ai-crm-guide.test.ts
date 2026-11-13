import { describe, expect, it } from 'vitest';

import {
  CRM_GUIDE_MAX_TOPICS_PER_CALL,
  createCrmGuideTool,
  crmGuideIndex,
  readCrmGuide,
  runCrmGuide,
} from '../src/ai/crm-guide.js';
import { CRM_GUIDE_TOPICS } from '../src/ai/crm-guide-topics.js';
import { TurnBudget } from '../src/ai/limits.js';
import { buildSystemPrompt } from '../src/ai/prompt.js';
import { assertAssistantToolPolicy } from '../src/ai/tool-policy.js';

describe('the CRM guide', () => {
  it('has unique, short kebab-case ids, one-line summaries and short bodies', () => {
    const ids = CRM_GUIDE_TOPICS.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const topic of CRM_GUIDE_TOPICS) {
      expect(topic.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(topic.id.length).toBeLessThanOrEqual(40);
      expect(topic.summary.length).toBeLessThanOrEqual(90);
      expect(topic.summary).not.toContain('\n');
      expect(topic.body.length).toBeLessThanOrEqual(1200);
    }
  });

  it('puts only ids and summaries in the system prompt, never a topic body', () => {
    const prompt = buildSystemPrompt({
      siteName: 'Example',
      leadTypes: ['sim_order'],
      today: '2026-11-13',
      timeZone: 'America/Toronto',
    });
    expect(prompt).toContain(crmGuideIndex());
    for (const topic of CRM_GUIDE_TOPICS) {
      expect(prompt).toContain(`${topic.id}: ${topic.summary}`);
      expect(prompt).not.toContain(topic.body);
    }
  });

  it('returns the asked topics and names the ones it does not know', () => {
    const result = JSON.parse(readCrmGuide({ topics: ['leads-archive', 'no-such-topic'] }));
    expect(result.status).toBe('ok');
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0].id).toBe('leads-archive');
    expect(result.topics[0].text).toContain('Archive');
    expect(result.unknownTopics).toEqual(['no-such-topic']);
    expect(JSON.parse(readCrmGuide({ topics: ['nope'] })).status).toBe('not_found');
  });

  it('refuses more than two topics in one call', () => {
    const ids = CRM_GUIDE_TOPICS.slice(0, CRM_GUIDE_MAX_TOPICS_PER_CALL + 1).map((t) => t.id);
    expect(() => readCrmGuide({ topics: ids })).toThrow();
  });

  it('counts each read against the turn’s tool budget', () => {
    const budget = new TurnBudget();
    let reads = 0;
    for (let i = 0; i < 50; i += 1) {
      const result = JSON.parse(runCrmGuide(budget, { topics: ['navigation'] }));
      if (result.status === 'ok') reads += 1;
      else expect(result.status).toBe('unavailable');
    }
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(50);
  });

  it('is an allowed assistant tool', () => {
    expect(() =>
      assertAssistantToolPolicy({ getCrmGuide: createCrmGuideTool(new TurnBudget()) }),
    ).not.toThrow();
  });
});
