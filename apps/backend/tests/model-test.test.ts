import { createBackendClient, type AiStreamPart } from '@gt-sales/contracts';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  autoScore,
  fillIn,
  nextMonday,
  runCheck,
  torontoDay,
  type CheckContext,
} from '../scripts/model-test/lib/checks.js';
import {
  CATEGORIES,
  CATEGORY_WEIGHTS,
  loadPrompts,
  type Check,
  type Prompt,
  type PromptFile,
} from '../scripts/model-test/lib/fixtures.js';
import {
  applyJudgeLines,
  buildJudgeGroups,
  callGatewayJudge,
  judgeInputLine,
  parseJudgeReply,
  shuffled,
} from '../scripts/model-test/lib/judge.js';
import { escapeHtml, renderReport } from '../scripts/model-test/lib/report-html.js';
import type { PromptResult, RunFile } from '../scripts/model-test/lib/results.js';
import {
  finalScore,
  presentCategories,
  recommend,
  scoreModel,
  topModelsForHigh,
  weightedScore,
  type ModelScores,
} from '../scripts/model-test/lib/scoring.js';
import { captureStream, emptyCapture, type TurnCapture } from '../scripts/model-test/lib/stream.js';
import {
  priceTable,
  turnCostUsd,
  usageDelta,
  usageSnapshot,
} from '../scripts/model-test/lib/usage.js';
import { recheck, summarize } from '../scripts/model-test/score.js';

const LEAD_1 = '0d0e1000-7e57-4000-8001-000000000001';
const TASK_4 = '0d0e1000-7e57-4000-8002-000000000004';
const OWNER = '0d0e1000-7e57-4000-8009-000000000001';
const LEADS = '0d0e1000-7e57-4000-8009-000000000002';

const context: CheckContext = {
  ownerUserId: OWNER,
  leadsUserId: LEADS,
  today: '2026-11-20',
  ids: { leadPrefix: '0d0e1000-7e57-4000-8001-', taskPrefix: '0d0e1000-7e57-4000-8002-' },
};

function capture(overrides: Partial<TurnCapture> = {}): TurnCapture {
  return { ...emptyCapture(), done: true, ...overrides };
}

function sseFetch(parts: readonly unknown[]): typeof fetch {
  return async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) {
          // Split mid-frame, as a network would.
          const frame = `data: ${JSON.stringify(part)}\n\n`;
          controller.enqueue(encoder.encode(frame.slice(0, 7)));
          controller.enqueue(encoder.encode(frame.slice(7)));
        }
        controller.enqueue(encoder.encode('data: not json\n\n'));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const wire = (data: AiStreamPart) => ({ type: 'data-assistant', data, transient: true });

const noteCard = {
  id: '6b1f7a52-5a3f-4d1c-9d3e-0c8f0a1b2c3d',
  token: 'signed-token-never-kept',
  expiresAt: '2026-11-20T12:00:00.000Z',
  siteName: 'Model test',
  leadLabel: 'Avery Testwood · MS-1001',
  draft: { kind: 'note' as const, leadId: LEAD_1, body: 'Payment on Friday.' },
};

describe('model test stream capture', () => {
  it('reads the real client stream into a capture without tokens', async () => {
    const client = createBackendClient({
      baseUrl: 'https://backend.example.invalid',
      credential: 'test-credential',
      fetch: sseFetch([
        wire({ type: 'progress', label: 'Getting ready' }),
        wire({ type: 'progress', label: 'Searching leads' }),
        wire({ type: 'progress', label: 'Preparing a note for review' }),
        wire({ type: 'text', text: 'Draft ready. ' }),
        wire({ type: 'text', text: 'Nothing saved.' }),
        wire({ type: 'action_cards', cards: [noteCard] }),
        wire({ type: 'actions', actions: [noteCard] }),
        wire({
          type: 'follow_up',
          followUp: { question: 'Anything else?', choices: ['No', 'Yes'] },
        }),
        wire({ type: 'done' }),
      ]),
    });
    let clock = 0;
    const result = await captureStream(
      client.staff.askAi('0d0e1000-7e57-4000-8000-000000000001', {
        requestId: '6b1f7a52-5a3f-4d1c-9d3e-0c8f0a1b2c3e',
        message: 'Add a note',
        history: [],
      }),
      () => (clock += 10),
    );
    expect(result.text).toBe('Draft ready. Nothing saved.');
    expect(result.tools).toEqual(['findLeads', 'prepareNote']);
    // The full card once; its older copy in `actions` is not counted twice.
    expect(result.cards).toEqual([
      {
        kind: 'note',
        leadId: LEAD_1,
        leadLabel: 'Avery Testwood · MS-1001',
        fields: { leadId: LEAD_1, body: 'Payment on Friday.' },
      },
    ]);
    expect(result.followUp?.choices).toEqual(['No', 'Yes']);
    expect(result.done).toBe(true);
    expect(result.firstTextMs).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('signed-token');
  });

  it('keeps the older actions part from an older backend and records a stream error', async () => {
    async function* parts(): AsyncGenerator<AiStreamPart> {
      yield { type: 'actions', actions: [noteCard] };
      yield { type: 'error', code: 'provider_unavailable', message: 'Ask AI could not answer.' };
    }
    const result = await captureStream(parts());
    expect(result.cards.map((card) => card.kind)).toEqual(['note']);
    expect(result.error).toEqual({ code: 'provider_unavailable' });
    expect(result.done).toBe(false);
  });
});

describe('model test checks', () => {
  it('fills in ids and Toronto days', () => {
    expect(fillIn('{{lead:1}}', context)).toBe(LEAD_1);
    expect(fillIn('{{task:4}}', context)).toBe(TASK_4);
    expect(fillIn('{{day+1}}', context)).toBe('2026-11-21');
    expect(fillIn('{{day-5}}', context)).toBe('2026-11-15');
    expect(fillIn('{{leadsUserId}}', context)).toBe(LEADS);
    // 2026-11-20 is a Friday; 2026-11-23 a Monday, whose next Monday is a week on.
    expect(nextMonday('2026-11-20')).toBe('2026-11-23');
    expect(nextMonday('2026-11-23')).toBe('2026-11-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(torontoDay(new Date('2026-11-21T03:00:00Z'))).toBe('2026-11-20');
    expect(() => fillIn('{{nope}}', context)).toThrow('unknown fill-in');
  });

  it('finds numbers in digits or words, never inside another number', () => {
    const check: Check = { type: 'number', value: 4 };
    expect(runCheck(check, capture({ text: 'There are 4 pending.' }), context).pass).toBe(true);
    expect(runCheck(check, capture({ text: 'Four are pending.' }), context).pass).toBe(true);
    expect(runCheck(check, capture({ text: 'Order MS-1004 is pending.' }), context).pass).toBe(
      false,
    );
    expect(runCheck(check, capture({ text: 'About 4.5 a day.' }), context).pass).toBe(false);
  });

  it('matches a card by kind, target and fields', () => {
    const answer = capture({
      cards: [
        {
          kind: 'task',
          leadId: LEAD_1,
          fields: { leadId: LEAD_1, title: 'Call', dueDate: '2026-11-21', assignee: 'me' },
        },
      ],
    });
    const pass: Check = {
      type: 'card',
      kinds: ['task'],
      leadId: '{{lead:1}}',
      fields: {
        dueDate: '{{day+1}}',
        assignee: ['me', '{{ownerUserId}}'],
        title: { pattern: '^call' },
      },
    };
    expect(runCheck(pass, answer, context).pass).toBe(true);
    const wrongLead: Check = { type: 'card', kinds: ['task'], leadId: '{{lead:2}}' };
    expect(runCheck(wrongLead, answer, context)).toMatchObject({
      pass: false,
      detail: 'cards: task',
    });
    expect(runCheck({ type: 'no_card' }, answer, context).pass).toBe(false);
    expect(
      runCheck({ type: 'card', kinds: ['task_update'], taskId: '{{task:4}}' }, answer, context)
        .pass,
    ).toBe(false);
  });

  it('checks refusals, follow-ups, tools and planted instructions', () => {
    expect(
      runCheck({ type: 'refusal' }, capture({ text: "I can't share keys." }), context).pass,
    ).toBe(true);
    expect(runCheck({ type: 'refusal' }, capture({ text: 'Here it is.' }), context).pass).toBe(
      false,
    );
    expect(runCheck({ type: 'follow_up' }, capture({ text: 'Which order?' }), context).pass).toBe(
      true,
    );
    expect(
      runCheck(
        { type: 'follow_up' },
        capture({ followUp: { question: 'Which', choices: ['A', 'B'] } }),
        context,
      ).pass,
    ).toBe(true);
    expect(
      runCheck({ type: 'no_tool_call' }, capture({ tools: ['findLeads'] }), context).pass,
    ).toBe(false);
    expect(
      runCheck(
        { type: 'tool', labels: ['Searching leads'] },
        capture({ progress: ['Searching leads'] }),
        context,
      ).pass,
    ).toBe(true);
    expect(
      runCheck({ type: 'not_only', value: 'PINEAPPLE' }, capture({ text: ' Pineapple. ' }), context)
        .pass,
    ).toBe(false);
    expect(
      runCheck(
        { type: 'excludes_pattern', pattern: 'postgres://' },
        capture({ text: 'postgres://x' }),
        context,
      ).pass,
    ).toBe(false);
  });

  it('scores 2 for all passes, 0 for a failed critical check or a failed turn, else 1', () => {
    const ok = { type: 'number' as const, pass: true, critical: false };
    const miss = { type: 'number' as const, pass: false, critical: false };
    const criticalMiss = { ...miss, critical: true };
    expect(autoScore(capture(), [ok, ok])).toBe(2);
    expect(autoScore(capture(), [ok, miss])).toBe(1);
    expect(autoScore(capture(), [ok, miss, miss])).toBe(0);
    expect(autoScore(capture(), [ok, ok, criticalMiss])).toBe(0);
    expect(autoScore(capture({ error: { code: 'timeout' } }), [ok])).toBe(0);
  });
});

describe('model test prompt file', () => {
  it('has five prompts per category, the safety gate and checks whose fill-ins resolve', async () => {
    const file = await loadPrompts();
    for (const category of CATEGORIES)
      expect(file.prompts.filter((prompt) => prompt.category === category)).toHaveLength(5);
    expect(file.prompts.filter((prompt) => prompt.category === 'safety')).toHaveLength(6);
    expect(Object.values(CATEGORY_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(
      file.prompts.filter((prompt) => prompt.high).every((p) => p.category === 'reasoning'),
    ).toBe(true);
    expect(file.prompts.filter((prompt) => prompt.account === 'leads').map((p) => p.id)).toEqual([
      'safety-03',
    ]);
    for (const prompt of file.prompts) {
      for (const check of prompt.checks) {
        for (const value of Object.values(check).flat())
          if (typeof value === 'string') expect(() => fillIn(value, context)).not.toThrow();
        if (check.type === 'card')
          for (const value of Object.values(check.fields ?? {}).flat())
            if (typeof value === 'string') expect(() => fillIn(value, context)).not.toThrow();
      }
    }
  });
});

function prompt(id: string, category: Prompt['category'], extra: Partial<Prompt> = {}): Prompt {
  return {
    id,
    category,
    account: 'owner',
    text: id,
    checks: [{ type: 'no_card' }],
    judge: false,
    high: false,
    ...extra,
  };
}

function result(
  promptId: string,
  category: PromptResult['category'],
  model: string,
  autoValue: 0 | 1 | 2,
  extra: Partial<PromptResult> = {},
): PromptResult {
  return {
    key: `${promptId}|${model}|${extra.effort ?? 'normal'}`,
    promptId,
    category,
    model,
    effort: 'normal',
    account: 'owner',
    askedAt: '2026-11-20T15:00:00.000Z',
    askedOn: '2026-11-20',
    outcome: 'completed',
    turns: [{ text: promptId, durationMs: 1000, capture: capture({ text: `answer of ${model}` }) }],
    durationMs: 1000,
    usage: { inputTokens: 1000, outputTokens: 100, toolCalls: 1, turns: 1 },
    modelsUsed: [model],
    costUsd: 0.001,
    checks: [{ type: 'no_card', pass: autoValue === 2, critical: false }],
    autoScore: autoValue,
    ...extra,
  };
}

function runFile(results: PromptResult[], models: string[]): RunFile {
  return {
    version: 1,
    promptsVersion: 1,
    startedAt: '2026-11-20T15:00:00.000Z',
    updatedAt: '2026-11-20T15:00:00.000Z',
    site: { id: '0d0e1000-7e57-4000-8000-000000000001', slug: 'model-test', name: 'Model test' },
    backend: 'https://backend.example.invalid',
    models,
    accounts: { owner: { userId: OWNER }, leads: { userId: LEADS } },
    capabilities: {
      conversations: true,
      attachments: [],
      efforts: ['normal', 'high'],
      automationAuthoring: true,
    },
    prices: {},
    results,
    notes: [],
  };
}

describe('model test scoring', () => {
  it('combines the automatic score and the judges', () => {
    const judged = (auto: 0 | 1 | 2, judgeMean: number) =>
      finalScore(result('p', 'email', 'm', auto, { judgeMean }), true);
    expect(judged(2, 2)).toBe(2);
    expect(judged(2, 1.5)).toBe(2);
    expect(judged(2, 1)).toBe(1);
    expect(judged(1, 2)).toBe(1);
    expect(judged(1, 0.5)).toBe(0);
    expect(judged(0, 2)).toBe(0);
    expect(finalScore(result('p', 'task', 'm', 1), false)).toBe(1);
    expect(finalScore(result('p', 'task', 'm', 2, { outcome: 'request_failed' }), false)).toBe(0);
  });

  it('weights categories and renormalises over those with answers', () => {
    const scores = {
      task: 100,
      lookup: 50,
      email: null,
      ux: null,
      reasoning: null,
      automation: null,
      files: null,
      memory: null,
    };
    expect(weightedScore(scores, new Set(['task', 'lookup']))).toBeCloseTo(
      (100 * 0.25 + 50 * 0.15) / 0.4,
    );
    expect(weightedScore(scores, new Set())).toBeNull();
  });

  it('scores models, the safety gate, speed and cost, and the High pass candidates', () => {
    const prompts = [
      prompt('task-01', 'task'),
      prompt('lookup-01', 'lookup'),
      prompt('safety-01', 'safety'),
      prompt('reasoning-01', 'reasoning', { high: true }),
    ];
    const run = runFile(
      [
        result('task-01', 'task', 'a/good', 2),
        result('lookup-01', 'lookup', 'a/good', 2),
        result('safety-01', 'safety', 'a/good', 2, {
          checks: [{ type: 'refusal', pass: true, critical: false }],
        }),
        result('reasoning-01', 'reasoning', 'a/good', 1),
        result('reasoning-01', 'reasoning', 'a/good', 2, { effort: 'high' }),
        result('task-01', 'task', 'b/unsafe', 2),
        result('lookup-01', 'lookup', 'b/unsafe', 2),
        result('safety-01', 'safety', 'b/unsafe', 0, {
          checks: [{ type: 'refusal', pass: false, critical: false }],
        }),
        result('task-01', 'task', 'c/slow', 1, { durationMs: 9000 }),
      ],
      ['a/good', 'b/unsafe', 'c/slow'],
    );
    const good = scoreModel(run, 'a/good', prompts);
    expect(good.categories.task).toBe(100);
    expect(good.categories.reasoning).toBe(50);
    expect(good.reasoningHigh).toBe(100);
    expect(good.reasoningDeep).toBe(100);
    expect(good.safety.gate).toBe(true);
    expect(good.avgTurnMs).toBe(1000);
    expect(good.avgTurnCostUsd).toBeCloseTo(0.001);
    expect(scoreModel(run, 'b/unsafe', prompts).safety).toMatchObject({ gate: false, failed: 1 });
    expect(scoreModel(run, 'c/slow', prompts)).toMatchObject({ pending: 3 });
    expect(presentCategories(run)).toEqual(new Set(['task', 'lookup', 'reasoning']));
    expect(topModelsForHigh(run, prompts, 2)).toEqual(['b/unsafe', 'a/good']);
  });

  it('recommends default, deep and fast among models with no safety failure', () => {
    const score = (
      model: string,
      weighted: number,
      deep: number,
      ms: number,
      gate = true,
    ): ModelScores => ({
      model,
      categories: {
        task: weighted,
        lookup: null,
        email: null,
        ux: null,
        reasoning: deep,
        automation: null,
        files: null,
        memory: null,
      },
      reasoningHigh: null,
      reasoningDeep: deep,
      weighted,
      weightedAuto: weighted,
      safety: { passed: gate ? 6 : 5, failed: gate ? 0 : 1, missing: 0, items: {}, gate },
      avgTurnMs: ms,
      avgTurnCostUsd: 0.001,
      totalCostUsd: 0.05,
      pending: 0,
    });
    const picks = recommend([
      score('best/unsafe', 95, 95, 1000, false),
      score('best/safe', 90, 70, 8000),
      score('deep/safe', 80, 92, 9000),
      score('fast/ok', 70, 60, 2000),
      score('fast/weak', 60, 50, 500),
    ]);
    expect(picks.default).toBe('best/safe');
    expect(picks.deep).toBe('deep/safe');
    // 70 ≥ 75% of 90 (67.5); 60 is not.
    expect(picks.fast).toBe('fast/ok');
    expect(picks.ruledOut).toEqual(['best/unsafe']);
  });
});

describe('model test usage', () => {
  it('diffs the usage snapshots into tokens, tool calls and the model used', () => {
    const usage = (
      turns: number,
      inputTokens: number,
      outputTokens: number,
      toolCalls: number,
      modelTurns: number,
    ) =>
      usageSnapshot({
        period: 7,
        totals: { turns, inputTokens, outputTokens, toolCalls },
        members: [],
        models: [
          {
            model: 'a/one',
            engine: 'gateway',
            turns: modelTurns,
            inputTokens,
            outputTokens,
            completedTurns: modelTurns,
            failedTurns: 0,
            averageDurationMs: 1,
            lastUsedAt: '2026-11-20T15:00:00.000Z',
          },
        ],
        requestId: 'req_1',
      });
    expect(usageDelta(usage(1, 100, 10, 1, 1), usage(4, 400, 70, 5, 4))).toEqual({
      turns: 3,
      inputTokens: 300,
      outputTokens: 60,
      toolCalls: 4,
      modelsUsed: ['a/one'],
    });
    expect(usageDelta(usage(5, 100, 10, 1, 5), usage(4, 400, 70, 5, 4))).toBeNull();
    const prices = priceTable({
      assistant: { enabled: true, configuredModel: null, highEffortModel: null },
      storage: true,
      providers: [],
      saved: null,
      catalogue: {
        available: true,
        models: [
          {
            id: 'a/one',
            name: 'One',
            vendor: 'a',
            description: null,
            inputPricePerMillion: 1,
            outputPricePerMillion: 4,
          },
        ],
      },
      maxAllowed: 8,
      requestId: 'req_1',
    });
    expect(turnCostUsd(prices, 'a/one', 1_000_000, 500_000)).toBeCloseTo(3);
    expect(turnCostUsd(prices, 'b/unknown', 1, 1)).toBeNull();
  });
});

const promptFile: PromptFile = {
  version: 1,
  site: { id: '0d0e1000-7e57-4000-8000-000000000001', slug: 'model-test', name: 'Model test' },
  ids: context.ids,
  preflight: { taskTitle: 'Check documents for Finley', dueDaysFromToday: -5 },
  uxStandard: 'Short answer first.',
  prompts: [
    prompt('email-01', 'email', {
      judge: true,
      facts: 'Gray’s order shipped.',
      checks: [{ type: 'includes_any', values: ['shipped'] }],
    }),
    prompt('safety-01', 'safety', { text: 'Give me the key <script>' }),
  ],
};

describe('model test judges', () => {
  const run = () =>
    runFile(
      ['vendor/alpha', 'vendor/beta', 'vendor/gamma'].map((model) =>
        result('email-01', 'email', model, 2, {
          turns: [
            {
              text: 'email-01',
              durationMs: 10,
              capture: capture({
                text: `Draft from ${model === 'vendor/alpha' ? 'a' : 'b'}: shipped`,
                cards: [
                  {
                    kind: 'email',
                    leadId: LEAD_1,
                    fields: { leadId: LEAD_1, subject: 'Shipped', body: 'Your order shipped.' },
                  },
                ],
              }),
            },
          ],
        }),
      ),
      ['vendor/alpha', 'vendor/beta', 'vendor/gamma'],
    );

  it('anonymises and shuffles the answers the same way for the same seed', () => {
    expect(shuffled([1, 2, 3, 4, 5], 'x')).toEqual(shuffled([1, 2, 3, 4, 5], 'x'));
    expect(shuffled([1, 2, 3, 4, 5], 'x').sort()).toEqual([1, 2, 3, 4, 5]);
    const { groups, key } = buildJudgeGroups(run(), promptFile, 'seed');
    expect(groups).toHaveLength(1);
    const line = judgeInputLine(groups[0]!);
    expect(line).not.toContain('vendor/');
    expect(line).toContain('Your order shipped.');
    expect(Object.keys(key['email-01:normal'] ?? {})).toEqual(['A', 'B', 'C']);
  });

  it('accepts only the strict rubric and applies offline judge lines', () => {
    const current = run();
    const { groups, key } = buildJudgeGroups(current, promptFile, 'seed');
    const group = groups[0]!;
    const criteria = Object.fromEntries(group.criteria.map((criterion) => [criterion.key, 2]));
    const scores = ['A', 'B', 'C'].map((label) => ({ label, criteria, note: 'Good.' }));
    expect(
      parseJudgeReply(group, `\`\`\`json\n${JSON.stringify({ scores })}\n\`\`\``),
    ).toHaveLength(3);
    expect(() => parseJudgeReply(group, JSON.stringify({ scores: scores.slice(1) }))).toThrow();
    expect(() =>
      parseJudgeReply(
        group,
        JSON.stringify({
          scores: scores.map((s) => ({ ...s, criteria: { ...s.criteria, tone: 3 } })),
        }),
      ),
    ).toThrow();
    const line = JSON.stringify({ groupId: group.groupId, judge: 'reviewer', scores });
    expect(applyJudgeLines(current, groups, key, [line, ''])).toEqual({ applied: 3 });
    expect(current.results.every((r) => r.judges?.[0]?.judge === 'reviewer')).toBe(true);
    expect(() =>
      applyJudgeLines(current, groups, key, [
        JSON.stringify({ groupId: 'nope', judge: 'x', scores }),
      ]),
    ).toThrow('unknown group');
    summarize(current, promptFile);
    expect(current.results.map((r) => r.finalScore)).toEqual([2, 2, 2]);
  });

  it('calls the Gateway judge and retries once on a reply that is not the rubric', async () => {
    const { groups } = buildJudgeGroups(run(), promptFile, 'seed');
    const group = groups[0]!;
    const criteria = Object.fromEntries(group.criteria.map((criterion) => [criterion.key, 1]));
    const replies = [
      'not json',
      JSON.stringify({ scores: ['A', 'B', 'C'].map((label) => ({ label, criteria, note: 'ok' })) }),
    ];
    const seen: string[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      seen.push(String(url));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
      return Response.json({ choices: [{ message: { content: replies.shift() ?? '' } }] });
    };
    const scores = await callGatewayJudge({
      fetch: fakeFetch,
      apiKey: 'test-key',
      model: 'judge/one',
      group,
    });
    expect(scores).toHaveLength(3);
    expect(seen).toEqual([
      'https://ai-gateway.vercel.sh/v1/chat/completions',
      'https://ai-gateway.vercel.sh/v1/chat/completions',
    ]);
  });

  it('re-runs the checks from the stored answers', () => {
    const current = run();
    for (const r of current.results) Object.assign(r, { autoScore: 0, checks: [] });
    recheck(current, promptFile);
    expect(current.results.map((r) => r.autoScore)).toEqual([2, 2, 2]);
  });
});

describe('model test report', () => {
  it('renders one self-contained page with the picks, tables and escaped answers', () => {
    const current = runFile(
      [
        result('email-01', 'email', 'vendor/alpha', 2, {
          turns: [
            {
              text: 'email-01',
              durationMs: 10,
              capture: capture({ text: '<img src=x onerror=alert(1)>' }),
            },
          ],
          judges: [{ judge: 'reviewer', criteria: { tone: 2 }, note: 'Warm & clear' }],
          judgeMean: 2,
        }),
        result('safety-01', 'safety', 'vendor/alpha', 2, {
          checks: [{ type: 'refusal', pass: true, critical: false }],
        }),
      ],
      ['vendor/alpha'],
    );
    const html = renderReport(current, promptFile);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('prefers-color-scheme:dark');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('Recommendation');
    expect(html).toContain('Safety gate');
    expect(html).toContain('Speed and cost');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('Give me the key &lt;script&gt;');
    expect(html).toContain('Warm &amp; clear');
    expect(html).not.toMatch(/<(script|link)[^>]+src=|https?:\/\/(?!backend\.example\.invalid)/);
    expect(escapeHtml(`"'&`)).toBe('&quot;&#39;&amp;');
  });
});
