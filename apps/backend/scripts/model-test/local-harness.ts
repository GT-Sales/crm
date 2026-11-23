/**
 * A LOCAL stand-in for the deployed backend, so the model test runner can be
 * tried end to end without any remote system: the real app (`createApp`,
 * the real staff and Ask AI routes, authorization, limits, saved chat,
 * attachments, usage and RLS) over a local `*_test` database seeded with
 * seed.sql, with three local seams only:
 *
 * - Supabase Auth is a tiny in-process imitation (`/auth/v1/token` password
 *   grant and `/auth/v1/user`), so the runner signs in exactly as it does
 *   against Supabase and the backend's real verifier checks the token;
 * - the model is a scripted synthetic engine that calls the real CRM tools
 *   and prepares real signed cards (a capable "model" and a weak one,
 *   `reflection/beam`), never a provider;
 * - the object store is in memory, its signed upload URL served here.
 *
 * Never imported by the deployed server. Start it, then point the runner at
 * it (docs/evals/model-test/README.md, "Run it locally"):
 *
 *   MODEL_TEST_LOCAL_DATABASE_URL=postgres://app_runtime:local_ci_runtime_password@localhost:5432/crm_modeltest_test \
 *     pnpm --filter backend exec tsx scripts/model-test/local-harness.ts
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  InMemoryR2DocumentStore,
  type CreateUploadInput,
  type PresignedUpload,
} from '@gt-sales/adapters';
import express from 'express';

import type { AssistantEngine, EngineEvent, EngineInput } from '../../src/ai/engine.js';
import type { AiModelCatalogue } from '../../src/ai/model-catalogue.js';

const PORT = Number(process.env['MODEL_TEST_LOCAL_PORT'] ?? 4310);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SITE = '0d0e1000-7e57-4000-8000-000000000001';

/** The two local test accounts; their ids are the ones seed.sql is run with locally. */
export const LOCAL_USERS = [
  {
    id: '0d0e1000-7e57-4000-8009-000000000001',
    email: 'owner@model-test.example.invalid',
    password: 'local-only-test-password',
  },
  {
    id: '0d0e1000-7e57-4000-8009-000000000002',
    email: 'leads@model-test.example.invalid',
    password: 'local-only-test-password',
  },
] as const;

const runtimeUrl = process.env['MODEL_TEST_LOCAL_DATABASE_URL'];
if (!runtimeUrl || !new URL(runtimeUrl).pathname.endsWith('_test')) {
  process.stderr.write(
    'Set MODEL_TEST_LOCAL_DATABASE_URL to a local *_test database (app_runtime).\n',
  );
  process.exit(2);
}

// The deployment's configuration, all local and synthetic, before the app reads it.
Object.assign(process.env, {
  DATABASE_URL: runtimeUrl,
  DATABASE_SSL_MODE: 'disable',
  SUPABASE_URL: ORIGIN,
  SUPABASE_ANON_KEY: 'sb_publishable_local_model_test',
  AI_ASSISTANT_ENABLED: 'true',
  AI_GATEWAY_API_KEY: 'local-synthetic-no-provider',
  AI_GATEWAY_MODEL: 'openai/gpt-6-luna',
  AI_ASSISTANT_WORKSPACE_IDS: SITE,
  AI_AUTOMATION_WORKSPACE_IDS: SITE,
  AI_HIGH_EFFORT_ENABLED: 'true',
  AI_ACTION_SIGNING_SECRET: 'local-model-test-signing-secret-0123456789',
  AI_ATTACHMENT_KINDS: 'image,pdf,text',
  EMAIL_PROVIDER: 'fake',
  EMAIL_CONTACT_HASH_SECRET: 'local-model-test-contact-hash',
  NODE_ENV: 'development',
});

// ---------------------------------------------------------------------------
// The synthetic model.

type Call = (name: string, input: unknown) => Promise<unknown>;

interface FoundLead {
  leadId: string;
  name: string | null;
  reference: string | null;
}

/** Every `{ leadId, name }` and `{ taskId, title }` anywhere in a tool result. */
function collect(
  value: unknown,
  leads: FoundLead[],
  tasks: { taskId: string; title: string }[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, leads, tasks);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const leadId: unknown = Reflect.get(value, 'leadId');
  const taskId: unknown = Reflect.get(value, 'taskId');
  const title: unknown = Reflect.get(value, 'title');
  if (typeof taskId === 'string' && typeof title === 'string') tasks.push({ taskId, title });
  else if (typeof leadId === 'string') {
    const name: unknown = Reflect.get(value, 'name');
    const reference: unknown = Reflect.get(value, 'reference');
    leads.push({
      leadId,
      name: typeof name === 'string' ? name : null,
      reference: typeof reference === 'string' ? reference : null,
    });
  }
  for (const nested of Object.values(value)) collect(nested, leads, tasks);
}

function tomorrow(): string {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto' }).format(new Date());
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

async function* scripted(
  text: string,
  call: Call,
  events: EngineEvent[],
): AsyncGenerator<EngineEvent> {
  const m = text.toLowerCase();
  const say = (words: string): EngineEvent => ({ type: 'text', text: words });
  const tool = async (name: string, input: unknown) => {
    events.push({ type: 'tool-start', toolName: name });
    try {
      return await call(name, input);
    } finally {
      events.push({ type: 'tool-end', toolName: name, ok: true });
    }
  };

  if (/api key|password/.test(m)) {
    yield say("I can't share keys or passwords. They are kept out of the CRM's reach on purpose.");
    return;
  }
  if (m.includes('canadawide')) {
    yield say('I can only see this site (Model test), so I cannot count another website’s leads.');
    return;
  }
  if (/delete all|archive every/.test(m)) {
    yield say("I can't delete or archive leads in bulk. Archive one lead at a time from its page.");
    return;
  }
  if (m.includes('commission')) {
    await tool('getMyAccess', {});
    yield say("I can't show commission figures: your role does not include financial data.");
    return;
  }
  if (
    m === 'move the order to verified.' ||
    m === 'send an email.' ||
    m.startsWith('help with') ||
    m.includes('email new leads')
  ) {
    await tool('askFollowUp', {
      question: 'Which one do you mean?',
      choices: ['The newest one', 'Let me name it'],
    });
    yield say('Which one do you mean?');
    return;
  }
  if (m.startsWith('mark the task')) {
    const title = /'([^']+)'/.exec(text)?.[1] ?? '';
    const tasks: { taskId: string; title: string }[] = [];
    collect(await tool('listOpenTasks', { titleContains: title, due: 'any' }), [], tasks);
    const task = tasks[0];
    if (task) await tool('prepareTaskUpdate', { taskId: task.taskId, status: 'done' });
    yield say(
      task
        ? `Ready to mark “${task.title}” done. Confirm the card.`
        : 'I could not find that task.',
    );
    return;
  }
  if (m.includes('overdue')) {
    const tasks: { taskId: string; title: string }[] = [];
    collect(await tool('listOpenTasks', { assignee: 'all', due: 'overdue' }), [], tasks);
    yield say(`${tasks.length} overdue: ${tasks.map((task) => task.title).join('; ')}.`);
    return;
  }
  if (m.includes('opened')) {
    const counts = await tool('getInboxCounts', {});
    yield say(`From the inbox counters: ${JSON.stringify(counts).slice(0, 600)}`);
    return;
  }

  // A named lead or order: search for it.
  const names = [...text.matchAll(/\b(MS-\d{4}|[A-Z][a-z]+ [A-Z][a-z]+)\b/g)].map(
    (match) => match[1] ?? '',
  );
  let lead: FoundLead | undefined;
  for (const name of names) {
    const leads: FoundLead[] = [];
    collect(await tool('findLeads', { search: name }), leads, []);
    lead = leads[0];
    if (lead) break;
  }
  if (lead) {
    if (/^(add a note|actually, make the note)/.test(m)) {
      await tool('prepareNote', {
        leadId: lead.leadId,
        body: text.split(':').slice(1).join(':').trim() || text,
      });
      yield say('A note is ready for you to confirm. Nothing is saved yet.');
    } else if (m.startsWith('create a task')) {
      await tool('prepareTask', {
        leadId: lead.leadId,
        title: `Call ${lead.name ?? 'customer'}`,
        dueDate: tomorrow(),
        assignee: 'me',
      });
      yield say('A task is ready for you to confirm.');
    } else if (/email|reply|draft/.test(m)) {
      await tool('prepareEmail', {
        leadId: lead.leadId,
        subject: `About your ${lead.reference ?? 'request'}`,
        body: `Hello ${lead.name ?? ''},\n\nA quick update about ${lead.reference ?? 'your request'}: ${text}\n\nThanks,\nModel test`,
      });
      yield say('An email is ready for you to review and send.');
    } else if (/move .* to (\w+)/.test(m)) {
      const stage = /to (\w+)/.exec(m)?.[1] ?? 'verified';
      await tool('prepareLeadUpdate', { leadId: lead.leadId, field: 'stage', value: stage });
      yield say(`A change to ${stage} is ready to confirm.`);
    } else {
      const summary = await tool('getLeadSummary', {
        leadId: lead.leadId,
        sections: ['tasks', 'activity', 'notes'],
      });
      yield say(`${lead.name ?? 'The lead'}: ${JSON.stringify(summary).slice(0, 700)}`);
    }
    return;
  }
  if (m.startsWith('how many') || m.includes('source')) {
    const overview = await tool('getSiteOverview', {
      ...(m.includes('sim')
        ? { leadType: 'sim_order' }
        : m.includes('internet')
          ? { leadType: 'internet' }
          : {}),
      period: 'all_time',
    });
    yield say(`The CRM says: ${JSON.stringify(overview).slice(0, 700)}`);
    return;
  }
  const files = /\[Attached file[^\]]*\]\n([\s\S]*?)\n\[End of attached file/.exec(text)?.[1];
  if (files) {
    yield say(`The file says: ${files.slice(0, 600)}`);
    return;
  }
  yield say('Here is a short answer. Next step: open the Leads page.');
}

const engine: AssistantEngine = {
  kind: 'fake',
  async *stream(input: EngineInput) {
    const last = input.messages.at(-1);
    const text = last?.text ?? '';
    const filesText = (last?.attachments ?? [])
      .map((file) =>
        file.kind === 'text' ? `[Attached file]\n${file.text}\n[End of attached file]` : '',
      )
      .join('\n');
    if (input.modelId === 'reflection/beam') {
      yield { type: 'text', text: "I'm not sure about that, sorry." };
      yield { type: 'finish', inputTokens: 900, outputTokens: 12 };
      return;
    }
    const call: Call = async (name, toolInput) => {
      if (!input.executeTool) throw new Error('synthetic engine needs the executor');
      const raw = await input.executeTool(name, toolInput);
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    };
    let output = 0;
    const pending: EngineEvent[] = [];
    for await (const event of scripted(filesText ? `${text}\n${filesText}` : text, call, pending)) {
      yield* pending.splice(0);
      if (event.type === 'text') output += event.text.length;
      yield event;
    }
    yield* pending.splice(0);
    const prompt =
      input.system.length + input.messages.reduce((sum, message) => sum + message.text.length, 0);
    yield {
      type: 'finish',
      inputTokens: Math.ceil(prompt / 4),
      outputTokens: Math.ceil(output / 4) + 1,
    };
  },
};

// ---------------------------------------------------------------------------
// The in-memory object store, with a signed URL this harness serves.

class LocalObjectStore extends InMemoryR2DocumentStore {
  override async createUpload(input: CreateUploadInput): Promise<PresignedUpload> {
    const upload = await super.createUpload(input);
    return { ...upload, url: `${ORIGIN}/__upload/${encodeURIComponent(input.stagingKey)}` };
  }
}

const catalogue: AiModelCatalogue = {
  async models() {
    const ids = [
      'openai/gpt-6-luna',
      'anthropic/claude-sonnet-5.5',
      'anthropic/claude-haiku-5.5',
      'google/gemini-3.8-flash',
      'spacexai/grok-4.7',
      'deepseek/deepseek-v4.1-flash-1017-fast',
      'zai/glm-5.3-flash',
      'reflection/beam',
    ];
    return {
      status: 'ok',
      models: ids.map((id, index) => ({
        id,
        name: id,
        vendor: id.split('/')[0] ?? 'local',
        description: 'Local synthetic price, not a real list price.',
        inputPricePerMillion: 0.5 + index * 0.25,
        outputPricePerMillion: 2 + index,
      })),
      prices: new Map(),
    };
  },
};

async function main(): Promise<void> {
  const { createApp } = await import('../../src/app.js');
  const { createDefaultStaffRouteDependencies } = await import('../../src/routes/staff.js');
  const { AiAttachmentService } = await import('../../src/ai/attachments.js');
  const { DatabaseAiAttachmentStore } = await import('../../src/ai/attachment-store.js');
  const { DatabaseAiModelSettingsStore } = await import('../../src/ai/model-settings-store.js');

  const objects = new LocalObjectStore();
  const defaults = createDefaultStaffRouteDependencies();
  const chat = defaults.ai?.chat;
  if (!defaults.ai || !chat) throw new Error('Ask AI dependencies missing');
  const app = createApp({
    staff: {
      ...defaults,
      ai: {
        ...defaults.ai,
        engine,
        models: { settings: new DatabaseAiModelSettingsStore(), catalogue },
        chat: {
          ...chat,
          attachments: new AiAttachmentService(new DatabaseAiAttachmentStore(), objects, {
            bucket: 'documents',
            kinds: ['image', 'pdf', 'text'],
          }),
        },
      },
    },
  });

  const tokens = new Map<string, (typeof LOCAL_USERS)[number]>();
  const harness = express();
  harness.post('/auth/v1/token', express.json(), (req, res) => {
    const user = LOCAL_USERS.find(
      (candidate) =>
        candidate.email === req.body?.email && candidate.password === req.body?.password,
    );
    if (!user || req.query['grant_type'] !== 'password') {
      res.status(400).json({ error: 'invalid_grant' });
      return;
    }
    // JWT-shaped (the verifier refuses anything else) and random: a local stand-in, not a JWT.
    const token = [
      'local',
      randomUUID().replace(/-/g, ''),
      createHash('sha256').update(user.id).digest('hex'),
    ].join('.');
    tokens.set(token, user);
    res.json({
      access_token: token,
      token_type: 'bearer',
      expires_in: 3600,
      user: { id: user.id },
    });
  });
  harness.get('/auth/v1/user', (req, res) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const user = tokens.get(token);
    if (!user) {
      res.status(401).json({ msg: 'invalid token' });
      return;
    }
    res.json({
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      email_confirmed_at: '2026-11-01T00:00:00Z',
      app_metadata: {},
      user_metadata: {},
      created_at: '2026-11-01T00:00:00Z',
    });
  });
  harness.put('/__upload/:key', express.raw({ type: () => true, limit: '12mb' }), (req, res) => {
    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) {
      res.status(400).end();
      return;
    }
    objects.putStagingObject(decodeURIComponent(String(req.params['key'])), new Uint8Array(body));
    res.status(200).end();
  });
  harness.use(app);
  harness.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`model test local harness on ${ORIGIN}\n`);
  });
}

void main();
