/**
 * The Ask AI model comparison runner (docs/evals/model-test/README.md).
 *
 * Asks every prompt of docs/evals/model-test/prompts-v1.json on the dedicated
 * "Model test" site, once per model under test, as the site's test Owner (and
 * the Leads-role member for its one permission check), through the same chat
 * API the admin uses, and writes each answer to the results file as soon as
 * it has it. It never confirms or revises a card, never saves or switches on
 * an automation and never sends an email: the only writes it causes are Ask
 * AI's own (the saved conversation, deleted again afterwards, and the usage
 * row). Passwords and tokens stay in memory and are never printed.
 *
 *   pnpm --filter backend exec tsx scripts/model-test/run.ts
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  aiAssistantHistoryText,
  BackendError,
  createBackendClient,
  type AiAttachmentMediaType,
  type AiCapabilitiesResponse,
  type AiChatRequest,
  type AiHistoryMessage,
  type AiStreamPart,
  type BackendClient,
} from '@gt-sales/contracts';
import { z } from 'zod';

import { Account } from './lib/auth.js';
import { autoScore, runChecks, torontoDay, addDays, type CheckContext } from './lib/checks.js';
import {
  FIXTURES_DIR,
  loadPrompts,
  promptTurns,
  type Prompt,
  type PromptFile,
} from './lib/fixtures.js';
import {
  readRunFile,
  resultKey,
  RETRY_OUTCOMES,
  upsertResult,
  writeRunFile,
  type Effort,
  type Outcome,
  type PromptResult,
  type RunFile,
  type TurnRecord,
} from './lib/results.js';
import { topModelsForHigh } from './lib/scoring.js';
import { captureStream, emptyCapture, type TurnCapture } from './lib/stream.js';
import {
  priceTable,
  turnCostUsd,
  usageDelta,
  usageSnapshot,
  type PriceTable,
  type UsageSnapshot,
} from './lib/usage.js';

export const DEFAULT_MODELS = [
  'openai/gpt-6-luna',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'google/gemini-3.8-flash',
  'spacexai/grok-4.7',
  'deepseek/deepseek-v4.1-flash-1017-fast',
  'zai/glm-5.3-flash',
  'reflection/beam',
] as const;

const list = (value: string | undefined) =>
  value
    ?.split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const settingsSchema = z.object({
  backendUrl: z.url(),
  supabaseUrl: z.url(),
  supabaseKey: z.string().min(1),
  workspaceId: z.uuid(),
  ownerEmail: z.email(),
  ownerPassword: z.string().min(1),
  leadsEmail: z.email().optional(),
  leadsPassword: z.string().min(1).optional(),
  ack: z.literal('dedicated-test-site'),
  models: z.array(z.string().min(3)).min(1),
  cases: z.array(z.string()).optional(),
  spacingMs: z.int().min(0),
  output: z.string().min(1),
  phase: z.enum(['normal', 'high', 'all']),
  highModels: z.array(z.string()).optional(),
  keepConversations: z.boolean(),
  allowStaleSeed: z.boolean(),
  prompts: z.string().optional(),
});
type Settings = z.infer<typeof settingsSchema>;

function readSettings(env: NodeJS.ProcessEnv): Settings {
  const today = new Date().toISOString().slice(0, 10);
  const parsed = settingsSchema.safeParse({
    backendUrl: env['MODEL_TEST_BACKEND_URL'],
    supabaseUrl: env['MODEL_TEST_SUPABASE_URL'],
    supabaseKey: env['MODEL_TEST_SUPABASE_KEY'],
    workspaceId: env['MODEL_TEST_WORKSPACE_ID'],
    ownerEmail: env['MODEL_TEST_OWNER_EMAIL'],
    ownerPassword: env['MODEL_TEST_OWNER_PASSWORD'],
    leadsEmail: env['MODEL_TEST_LEADS_EMAIL'] || undefined,
    leadsPassword: env['MODEL_TEST_LEADS_PASSWORD'] || undefined,
    ack: env['MODEL_TEST_ACK'],
    models: list(env['MODEL_TEST_MODELS']) ?? [...DEFAULT_MODELS],
    cases: list(env['MODEL_TEST_CASE']),
    spacingMs: Number(env['MODEL_TEST_SPACING_MS'] ?? 7000),
    output:
      env['MODEL_TEST_OUTPUT'] ??
      fileURLToPath(new URL(`../../../../docs/evals/model-test/${today}.json`, import.meta.url)),
    phase: env['MODEL_TEST_PHASE'] ?? 'all',
    highModels: list(env['MODEL_TEST_HIGH_MODELS']),
    keepConversations: env['MODEL_TEST_KEEP_CONVERSATIONS'] === '1',
    allowStaleSeed: env['MODEL_TEST_ALLOW_STALE_SEED'] === '1',
    prompts: env['MODEL_TEST_PROMPTS'] || undefined,
  });
  if (!parsed.success) {
    // Names of the settings only: never a value (one of them is a password).
    const names = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(
      `Model test settings missing or invalid: ${names.join(', ')}. MODEL_TEST_ACK must be dedicated-test-site.`,
    );
  }
  return parsed.data;
}

/** Stops the run for today: a limit whose wait is longer than a pause. */
class StopRun extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'StopRun';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const MEDIA_TYPES: Readonly<Record<string, AiAttachmentMediaType>> = {
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

function kindOf(mediaType: AiAttachmentMediaType): string {
  if (mediaType === 'application/pdf') return 'pdf';
  return mediaType.startsWith('image/') ? 'image' : 'text';
}

class Runner {
  private lastRequestAt = 0;
  private readonly owner: Account;
  private readonly leads: Account | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly prompts: PromptFile,
    private readonly run: RunFile,
    private readonly capabilities: AiCapabilitiesResponse,
    private readonly prices: PriceTable,
    owner: Account,
    leads: Account | undefined,
  ) {
    this.owner = owner;
    this.leads = leads;
  }

  private async client(account: 'owner' | 'leads'): Promise<BackendClient> {
    const source = account === 'owner' ? this.owner : this.leads;
    if (!source) throw new StopRun('leads_account_not_configured');
    const session = await source.current();
    return createBackendClient({
      baseUrl: this.settings.backendUrl,
      credential: session.accessToken,
      chatTimeoutMs: 120_000,
      chatHighTimeoutMs: 240_000,
    });
  }

  /** Waits so chat requests are at least the spacing apart (the per-actor and per-site limits). */
  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.settings.spacingMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private async snapshot(): Promise<UsageSnapshot | undefined> {
    try {
      const client = await this.client('owner');
      return usageSnapshot(await client.staff.getAiUsage(this.settings.workspaceId, { period: 7 }));
    } catch {
      return undefined;
    }
  }

  private async attach(
    client: BackendClient,
    names: readonly string[],
  ): Promise<{ ids: string[] } | { note: string }> {
    const offered = this.capabilities.attachments?.kinds ?? [];
    const ids: string[] = [];
    for (const name of names) {
      const extension = name.split('.').pop()?.toLowerCase() ?? '';
      const mediaType = MEDIA_TYPES[extension];
      if (!mediaType) return { note: `unsupported_fixture:${name}` };
      if (!offered.some((kind) => kind === kindOf(mediaType)))
        return { note: `attachment_kind_not_offered:${kindOf(mediaType)}` };
      const bytes = await readFile(new URL(name, FIXTURES_DIR));
      const intent = await client.staff.createAiAttachmentIntent(this.settings.workspaceId, {
        fileName: name,
        mediaType,
        byteSize: bytes.byteLength,
      });
      const put = await fetch(intent.url, {
        method: intent.method,
        headers: intent.headers,
        body: bytes,
        signal: AbortSignal.timeout(30_000),
      });
      if (!put.ok) return { note: `attachment_upload_http_${put.status}` };
      await client.staff.finalizeAiAttachment(this.settings.workspaceId, intent.uploadId, {
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
      });
      ids.push(intent.uploadId);
    }
    return { ids };
  }

  /** One chat request, retried after a short limit wait; a long one stops the run. */
  private async ask(
    client: BackendClient,
    body: AiChatRequest,
  ): Promise<{ capture: TurnCapture; durationMs: number; signature?: string }> {
    for (let attempt = 0; ; attempt += 1) {
      await this.pace();
      const started = Date.now();
      let signature: string | undefined;
      try {
        const stream = client.staff.askAi(this.settings.workspaceId, {
          ...body,
          requestId: randomUUID(),
        });
        async function* sniff(): AsyncGenerator<AiStreamPart> {
          for await (const part of stream) {
            if (part.type === 'done' && part.signature) signature = part.signature;
            yield part;
          }
        }
        const capture = await captureStream(sniff());
        return {
          capture,
          durationMs: Date.now() - started,
          ...(signature ? { signature } : {}),
        };
      } catch (error) {
        if (error instanceof BackendError && error.status === 429) {
          const wait = error.retryAfterSeconds ?? 60;
          if (wait <= 120 && attempt < 3) {
            log({ event: 'rate_limited_wait', seconds: wait + 1 });
            await sleep((wait + 1) * 1000);
            continue;
          }
          throw new StopRun(
            `rate_limited:${String(error.details?.['reason'] ?? 'limit')}:${wait}s`,
          );
        }
        throw error;
      }
    }
  }

  async runPrompt(prompt: Prompt, model: string, effort: Effort): Promise<PromptResult> {
    const askedAt = new Date();
    const key = resultKey(prompt.id, model, effort);
    const client = await this.client(prompt.account);
    const before = await this.snapshot();
    const stored = this.capabilities.conversations === true;
    const conversationId = stored ? randomUUID() : undefined;
    const history: AiHistoryMessage[] = [];
    const turns: TurnRecord[] = [];
    let outcome: Outcome = 'completed';
    let failureCode: string | undefined;
    let note: string | undefined;

    try {
      for (const [index, turn] of promptTurns(prompt).entries()) {
        let attachmentIds: string[] | undefined;
        if (turn.attachments?.length) {
          const attached = stored
            ? await this.attach(client, turn.attachments)
            : { note: 'conversations_not_stored' };
          if ('note' in attached) {
            outcome = 'skipped';
            note = attached.note;
            turns.push({
              text: turn.text,
              durationMs: 0,
              capture: emptyCapture(),
              attachments: turn.attachments,
              attachmentNote: attached.note,
            });
            break;
          }
          attachmentIds = attached.ids;
        }
        const body: AiChatRequest = {
          requestId: randomUUID(),
          message: turn.text,
          history: stored ? [] : [...history],
          ...(conversationId ? { conversationId } : {}),
          ...(conversationId && index === 0 ? { newConversation: true } : {}),
          ...(attachmentIds ? { attachmentIds } : {}),
          ...(effort === 'high' ? { effort: 'high' as const } : {}),
          ...(this.capabilities.models ? { model } : {}),
          ...(this.capabilities.cardActions ? { wide: true as const } : {}),
        };
        const answer = await this.ask(client, body);
        turns.push({
          text: turn.text,
          durationMs: answer.durationMs,
          capture: answer.capture,
          ...(turn.attachments ? { attachments: turn.attachments } : {}),
        });
        if (answer.capture.error || !answer.capture.done) {
          outcome = 'stream_error';
          failureCode = answer.capture.error?.code ?? 'stream_incomplete';
          break;
        }
        history.push({ role: 'user', text: turn.text });
        history.push({
          role: 'assistant',
          text: aiAssistantHistoryText({
            text: answer.capture.text || ' ',
            ...(answer.capture.followUp ? { followUp: answer.capture.followUp } : {}),
          }),
          ...(answer.signature ? { signature: answer.signature } : {}),
        });
      }
    } catch (error) {
      if (error instanceof StopRun) throw error;
      outcome = 'request_failed';
      failureCode = error instanceof BackendError ? error.code : 'request_failed';
      if (error instanceof BackendError && error.details?.['reason'])
        failureCode = `${error.code}:${String(error.details['reason'])}`;
    } finally {
      if (conversationId && !this.settings.keepConversations) {
        await client.staff
          .deleteAiConversation(this.settings.workspaceId, conversationId)
          .catch(() => undefined);
      }
    }

    const after = await this.snapshot();
    const delta = before && after ? usageDelta(before, after) : null;
    const servedBy = delta?.modelsUsed[0] ?? model;
    const context: CheckContext = {
      ownerUserId: this.run.accounts.owner.userId,
      leadsUserId: this.run.accounts.leads?.userId ?? '00000000-0000-4000-8000-000000000000',
      today: torontoDay(askedAt),
      ids: this.prompts.ids,
    };
    const final = turns.at(-1)?.capture ?? emptyCapture();
    const checks = outcome === 'completed' ? runChecks(prompt, final, context) : [];
    return {
      key,
      promptId: prompt.id,
      category: prompt.category,
      model,
      effort,
      account: prompt.account,
      askedAt: askedAt.toISOString(),
      askedOn: context.today,
      outcome,
      ...(failureCode ? { failureCode } : {}),
      ...(note ? { note } : {}),
      turns,
      durationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
      usage: delta
        ? {
            inputTokens: delta.inputTokens,
            outputTokens: delta.outputTokens,
            toolCalls: delta.toolCalls,
            turns: delta.turns,
          }
        : null,
      modelsUsed: delta?.modelsUsed ?? [],
      costUsd: delta
        ? turnCostUsd(this.prices, servedBy, delta.inputTokens, delta.outputTokens)
        : null,
      checks,
      autoScore: outcome === 'completed' ? autoScore(final, checks) : 0,
    };
  }

  async pass(prompts: readonly Prompt[], models: readonly string[], effort: Effort): Promise<void> {
    for (const model of models) {
      for (const prompt of prompts) {
        const key = resultKey(prompt.id, model, effort);
        const existing = this.run.results.find((result) => result.key === key);
        if (existing && !RETRY_OUTCOMES.has(existing.outcome)) continue;
        const result = await this.runPrompt(prompt, model, effort);
        upsertResult(this.run, result);
        await writeRunFile(this.settings.output, this.run);
        log({
          prompt: prompt.id,
          model,
          effort,
          outcome: result.outcome,
          ...(result.failureCode ? { code: result.failureCode } : {}),
          ms: result.durationMs,
          auto: result.autoScore,
        });
      }
    }
  }
}

async function preflightSeed(client: BackendClient, settings: Settings, prompts: PromptFile) {
  const tasks = await client.staff.listTasks(settings.workspaceId, {
    assignee: 'all',
    status: 'active',
    plain: 'include',
    pageSize: 200,
  });
  const task = tasks.tasks.find((candidate) => candidate.title === prompts.preflight.taskTitle);
  const expected = addDays(torontoDay(new Date()), prompts.preflight.dueDaysFromToday);
  const actual = task?.dueAt ? torontoDay(new Date(task.dueAt)) : undefined;
  if (actual !== expected) {
    const message = `The seed is not from today (task "${prompts.preflight.taskTitle}" due ${actual ?? 'missing'}, expected ${expected}). Re-run apps/backend/scripts/model-test/seed.sql today.`;
    if (!settings.allowStaleSeed) throw new Error(message);
    log({ event: 'stale_seed_allowed', expected, actual: actual ?? null });
  }
}

async function main(): Promise<void> {
  const settings = readSettings(process.env);
  const prompts = await loadPrompts(settings.prompts ?? undefined);
  const selected = prompts.prompts.filter(
    (prompt) => !settings.cases || settings.cases.includes(prompt.id),
  );
  if (selected.length === 0) throw new Error('No prompt matches MODEL_TEST_CASE');

  const owner = new Account({
    supabaseUrl: settings.supabaseUrl,
    publishableKey: settings.supabaseKey,
    email: settings.ownerEmail,
    password: settings.ownerPassword,
  });
  const needsLeads = selected.some((prompt) => prompt.account === 'leads');
  const leads =
    settings.leadsEmail && settings.leadsPassword
      ? new Account({
          supabaseUrl: settings.supabaseUrl,
          publishableKey: settings.supabaseKey,
          email: settings.leadsEmail,
          password: settings.leadsPassword,
        })
      : undefined;
  if (needsLeads && !leads)
    throw new Error(
      'MODEL_TEST_LEADS_EMAIL and MODEL_TEST_LEADS_PASSWORD are needed for safety-03',
    );

  const ownerSession = await owner.current();
  const leadsSession = leads ? await leads.current() : undefined;
  const client = createBackendClient({
    baseUrl: settings.backendUrl,
    credential: ownerSession.accessToken,
  });
  const capabilities = await client.staff.aiCapabilities(settings.workspaceId);
  // Second guard beside MODEL_TEST_ACK: only the seeded test site, by id and slug.
  if (capabilities.site.slug !== prompts.site.slug || capabilities.site.id !== prompts.site.id)
    throw new Error(
      'MODEL_TEST_WORKSPACE_ID is not the seeded Model test site; nothing was asked.',
    );
  if (!capabilities.available)
    throw new Error(
      `Ask AI is not available on the test site (${capabilities.reason ?? 'unknown'}); add it to AI_ASSISTANT_WORKSPACE_IDS.`,
    );
  await preflightSeed(client, settings, prompts);

  const offered = new Set(capabilities.models?.map((model) => model.id) ?? []);
  const models = settings.models.filter((model) => offered.has(model));
  const missing = settings.models.filter((model) => !offered.has(model));
  if (models.length === 0)
    throw new Error(
      'None of the models under test is allowed on the test site (Settings → AI models).',
    );

  let prices: PriceTable = {};
  try {
    prices = priceTable(await client.staff.getAiModelSettings(settings.workspaceId));
  } catch {
    prices = {};
  }

  const existing = await readRunFile(settings.output);
  const run: RunFile = existing ?? {
    version: 1,
    promptsVersion: prompts.version,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    site: capabilities.site,
    backend: new URL(settings.backendUrl).origin,
    models,
    accounts: {
      owner: { userId: ownerSession.userId },
      ...(leadsSession ? { leads: { userId: leadsSession.userId } } : {}),
    },
    capabilities: {
      conversations: capabilities.conversations === true,
      attachments: [...(capabilities.attachments?.kinds ?? [])],
      efforts: [...(capabilities.efforts ?? ['normal'])],
      automationAuthoring: capabilities.automationAuthoring === true,
    },
    prices,
    results: [],
    notes: [],
  };
  if (existing && existing.promptsVersion !== prompts.version)
    throw new Error(
      'The results file was made with another prompt version; choose a new MODEL_TEST_OUTPUT.',
    );
  for (const model of models) if (!run.models.includes(model)) run.models.push(model);
  run.prices = { ...run.prices, ...prices };
  if (missing.length)
    run.notes = [
      ...new Set([...run.notes, `Not allowed on the test site, not asked: ${missing.join(', ')}.`]),
    ];
  if (!capabilities.automationAuthoring)
    run.notes = [
      ...new Set([
        ...run.notes,
        'Automation authoring is off for the test site (AI_AUTOMATION_WORKSPACE_IDS): the automation prompts cannot pass.',
      ]),
    ];
  await writeRunFile(settings.output, run);
  log({ event: 'start', models, prompts: selected.length, output: settings.output });

  const runner = new Runner(settings, prompts, run, capabilities, prices, owner, leads);
  try {
    if (settings.phase !== 'high') await runner.pass(selected, models, 'normal');
    if (settings.phase !== 'normal') {
      const highPrompts = selected.filter((prompt) => prompt.high);
      if (!capabilities.efforts?.includes('high')) {
        run.notes = [
          ...new Set([...run.notes, 'High effort is not offered on the test site: no High pass.']),
        ];
      } else if (highPrompts.length > 0) {
        const chosen =
          settings.highModels?.filter((model) => models.includes(model)) ??
          topModelsForHigh(run, prompts.prompts, 3);
        run.highModels = {
          models: chosen,
          basis: settings.highModels
            ? 'chosen with MODEL_TEST_HIGH_MODELS'
            : 'top three by the automatic weighted score at Normal effort',
        };
        await writeRunFile(settings.output, run);
        await runner.pass(highPrompts, chosen, 'high');
      }
    }
  } catch (error) {
    if (error instanceof StopRun) {
      await writeRunFile(settings.output, run);
      log({
        event: 'stopped',
        reason: error.reason,
        resume: 'run again with the same MODEL_TEST_OUTPUT',
      });
      process.exitCode = 3;
      return;
    }
    throw error;
  }
  await writeRunFile(settings.output, run);
  log({ event: 'finished', results: run.results.length, output: settings.output });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error: unknown) => {
    // A fixed message only; never a token, a password or a provider body.
    process.stderr.write(
      `${error instanceof BackendError ? `Backend refused: ${error.code} (HTTP ${error.status})` : error instanceof Error ? error.message : 'Model test failed'}\n`,
    );
    process.exitCode = 1;
  });
}
