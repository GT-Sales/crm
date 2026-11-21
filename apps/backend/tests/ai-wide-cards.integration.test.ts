import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AI_CARD_KINDS,
  AI_CARD_LIMITS,
  aiActionCardSchema,
  aiActionProposalSchema,
  aiCapabilitiesResponseSchema,
  aiCardDraftSchema,
  aiWirePartSchema,
  type AiActionCard,
  type AiStreamPart,
  type CreatePlanRequest,
  type Plan,
} from '@gt-sales/contracts';
import {
  createDatabaseClient,
  type DatabaseClient,
  type RateLimitInput,
  type RateLimitResult,
} from '@gt-sales/db';
import { z } from 'zod';

import { signAiAction, type SignedAiAction } from '../src/ai/actions.js';
import { DatabaseAiCardStore, leadEditVersion } from '../src/ai/card-store.js';
import { DatabaseAiChatSchemaProbe } from '../src/ai/chat-schema.js';
import type { AiAssistantConfig } from '../src/ai/config.js';
import { DatabaseAiConversationStore } from '../src/ai/conversation-store.js';
import type { AssistantEngine, EngineInput } from '../src/ai/engine.js';
import { DatabaseAiReadService } from '../src/ai/read-service.js';
import { DatabaseAiSiteContextStore } from '../src/ai/site-context.js';
import { createApp } from '../src/app.js';
import { DatabaseFlowStore } from '../src/automations/flow-store.js';
import { DatabaseEmailSettingsStore } from '../src/email/settings-store.js';
import { customerEmailEnvironmentFromEnv } from '../src/email/senders.js';
import { DatabaseLeadStore } from '../src/leads/store.js';
import { DatabaseLeadWorkStore } from '../src/leads/work-store.js';
import { todayInToronto } from '../src/leads/stage-move.js';
import { DatabasePlanStore } from '../src/plans/store.js';
import { DatabasePropertyStore } from '../src/properties/store.js';
import type { ReportStore } from '../src/reports/store.js';
import type { StaffStore } from '../src/staff/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';
import { disposableTestDatabaseUrl, seedBuiltInFlow } from './support/flows.js';
import { TEST_RUNTIME_PASSWORD } from '@gt-sales/db/test-helpers';

const migrationUrl = disposableTestDatabaseUrl();
const databaseTest = migrationUrl ? describe : describe.skip;

const SITE = '1c000000-0000-4000-8000-000000003901';
const OTHER_SITE = '1c000000-0000-4000-8000-000000003902';
const OWNER = '2c000000-0000-4000-8000-000000003901';
const LEADS = '2c000000-0000-4000-8000-000000003902';
const FINANCE = '2c000000-0000-4000-8000-000000003903';
const REVOKED = '2c000000-0000-4000-8000-000000003904';
const DENIED = '2c000000-0000-4000-8000-000000003905';
const KEY = 'synthetic-wide-card-signing-key';
const MAIL_SECRET = 'ci-wide-card-contact-hash-secret';
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

type Access = Pick<StaffAccessSnapshot, 'roles' | 'permissions' | 'status'>;
const ACCESS: Record<string, Record<string, Access>> = {
  [SITE]: {
    [OWNER]: { roles: ['owner'], permissions: [], status: 'active' },
    [LEADS]: { roles: ['leads'], permissions: [], status: 'active' },
    [FINANCE]: { roles: ['finance'], permissions: [], status: 'active' },
    [REVOKED]: { roles: ['leads'], permissions: [], status: 'revoked' },
    // The owner role with an individual deny of the integration permission.
    [DENIED]: {
      roles: ['owner'],
      permissions: [{ name: 'integration_management', effect: 'deny' }],
      status: 'active',
    },
  },
  [OTHER_SITE]: { [OWNER]: { roles: ['owner'], permissions: [], status: 'active' } },
};

const staffStore: StaffStore = {
  bootstrapStaff: async () => [],
  loadStaffAccess: async (actorId, workspaceId) => {
    const access = ACCESS[workspaceId]?.[actorId];
    return access ? { membershipId: actorId, ...access } : undefined;
  },
  inviteStaff: async () => {
    throw new Error('unused');
  },
  revokeStaff: async () => 'not_found',
  listAssignableMembers: async (workspaceId) =>
    workspaceId === SITE
      ? [
          { membershipId: OWNER, actorId: OWNER, displayName: 'Owner', roles: [], isSelf: false },
          {
            membershipId: LEADS,
            actorId: LEADS,
            displayName: 'Lee Leads',
            roles: [],
            isSelf: false,
          },
        ]
      : [{ membershipId: OWNER, actorId: OWNER, displayName: 'Owner', roles: [], isSelf: false }],
  setDisplayName: async () => 0,
};

const unusedCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

const reports: ReportStore = {
  sourceReport: async () => ({
    totals: { received: 0, submitted: 0, madeIt: 0 },
    rows: [],
    withSourceData: 0,
  }),
};

const config: AiAssistantConfig = {
  enabled: true,
  apiKey: KEY,
  signingKey: KEY,
  modelId: 'test/model',
  workspaceIds: new Set([SITE, OTHER_SITE]),
  automationWorkspaceIds: new Set([SITE]),
};

/** The shared limiter as the database runs it (fixed windows, counted per key), or broken. */
const limiter = {
  counts: new Map<string, number>(),
  broken: false,
  async hit(input: RateLimitInput): Promise<RateLimitResult> {
    if (limiter.broken) throw new Error('limiter unreachable');
    const count = (limiter.counts.get(input.bucketKey) ?? 0) + 1;
    limiter.counts.set(input.bucketKey, count);
    return count <= input.maxCount
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: 3600 };
  },
};

/** The clock the route reads: moved forward to expire a card. */
const clock = { offsetMs: 0, now: () => new Date(Date.now() + clock.offsetMs) };

const scriptSchema = z.array(z.object({ tool: z.string(), input: z.unknown() }));

/** A scripted model: each question lists the tool calls it makes, through the route's own executor. */
function scriptedEngine(
  results: { name: string; result: string }[],
  offered: string[][],
  systems: string[] = [],
): AssistantEngine {
  return {
    kind: 'fake',
    async *stream(input: EngineInput) {
      offered.push(Object.keys(input.tools ?? {}));
      systems.push(input.system);
      // With a lead open, the message starts with its labelled data block; the steps follow it.
      const message = input.messages.at(-1)?.text ?? '';
      const end = '[End of open record]';
      const question = message.includes(end)
        ? message.slice(message.indexOf(end) + end.length)
        : message;
      const steps = scriptSchema.parse(JSON.parse(question.slice(question.indexOf('['))));
      for (const call of steps) {
        if (!input.executeTool) throw new Error('executor missing');
        try {
          results.push({ name: call.tool, result: await input.executeTool(call.tool, call.input) });
        } catch {
          // A real engine refuses an input that does not fit the tool's schema.
          results.push({ name: call.tool, result: 'invalid_input' });
        }
      }
      yield { type: 'text', text: 'Ready for your review.' };
      yield { type: 'finish', outputTokens: 4 };
    },
  };
}

databaseTest('Ask AI: wider cards (WRITES)', () => {
  let admin: ReturnType<typeof postgres>;
  let database: DatabaseClient;
  let work: DatabaseLeadWorkStore;
  let reads: DatabaseAiReadService;
  let server: Server;
  let base: string;
  let freePlan: Plan;
  let otherPlan: Plan;
  let gatedPlan: Plan;
  const results: { name: string; result: string }[] = [];
  const offered: string[][] = [];
  const systems: string[] = [];
  const mailEnvironment = customerEmailEnvironmentFromEnv({
    EMAIL_PROVIDER: 'fake',
    NODE_ENV: 'test',
    EMAIL_CONTACT_HASH_SECRET: MAIL_SECRET,
  });

  const post = (path: string, body: unknown, actor = OWNER, site = SITE) =>
    fetch(`${base}/api/v1/staff/workspaces/${site}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${actor}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  /**
   * One question, as a newer admin asks it (`wide: true`, T12) unless `wide`
   * is false; `context` is the lead open on the page.
   */
  async function ask(
    steps: { tool: string; input: unknown }[],
    actor = OWNER,
    site = SITE,
    options: { wide?: boolean; context?: string } = {},
  ): Promise<AiStreamPart[]> {
    results.length = 0;
    const response = await post(
      '/ai/chat',
      {
        requestId: randomUUID(),
        message: JSON.stringify(steps),
        history: [],
        ...(options.wide === false ? {} : { wide: true }),
        ...(options.context ? { context: { leadId: options.context } } : {}),
      },
      actor,
      site,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    return text
      .split('\n\n')
      .map((frame) =>
        frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n'),
      )
      .filter((payload) => payload.length > 0 && payload !== '[DONE]')
      .map((payload) => aiWirePartSchema.parse(JSON.parse(payload)).data);
  }

  const cardsOf = (parts: AiStreamPart[]): AiActionCard[] =>
    parts.flatMap((part) => (part.type === 'action_cards' ? part.cards : []));
  const legacyOf = (parts: AiStreamPart[]) =>
    parts.flatMap((part) => (part.type === 'actions' ? part.actions : []));

  async function oneCard(steps: { tool: string; input: unknown }[], actor = OWNER) {
    const parts = await ask(steps, actor);
    const [card] = cardsOf(parts);
    if (!card) throw new Error(`expected a card, got ${JSON.stringify(results)}`);
    return { card, parts };
  }

  const confirm = (card: { token: string }, extra: object = {}, actor = OWNER, site = SITE) =>
    post('/ai/actions/confirm', { token: card.token, ...extra }, actor, site);

  async function errorOf(response: Response) {
    const body: { error?: { code?: string; details?: Record<string, unknown> } } =
      await response.json();
    return { status: response.status, code: body.error?.code, details: body.error?.details };
  }

  /** A lead of the site, written as the import writes one. */
  async function insertLead(
    input: {
      stage?: string;
      leadType?: string;
      status?: string;
      name?: string;
      email?: string;
      reference?: string | null;
      order?: object;
      form?: Record<string, unknown>;
      custom?: Record<string, unknown>;
      archived?: boolean;
      restricted?: boolean;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await admin`
      insert into app.leads (
        id, workspace_id, lead_type, status, stage, consent_version, attribution, payload,
        order_details, custom_values, full_name, email, phone, external_ref, deleted_at,
        customer_data_restricted_at
      ) values (
        ${id}, ${SITE}, ${input.leadType ?? 'sim_order'}, ${input.status ?? 'submitted'},
        ${input.stage ?? 'verified'}, 'ci', '{}'::jsonb,
        ${admin.json(JSON.parse(JSON.stringify({ schemaVersion: 1, payload: input.form ?? {} })))},
        ${admin.json(JSON.parse(JSON.stringify(input.order ?? {})))},
        ${admin.json(JSON.parse(JSON.stringify(input.custom ?? {})))},
        ${input.name ?? 'Robin Example'}, ${input.email ?? `${id}@example.test`}, '+1 403 555 0100',
        ${input.reference === undefined ? null : input.reference},
        ${input.archived ? new Date() : null}, ${input.restricted ? new Date() : null}
      )
    `;
    return id;
  }

  const orderOn = (plan: Plan) => ({
    planId: plan.id,
    plan: {
      planId: plan.id,
      name: plan.name,
      priceMinor: plan.priceMinor,
      currency: 'CAD',
      billingPeriod: plan.billingPeriod,
      paymentRequired: plan.paymentRequired,
      requiredDocuments: plan.requiredDocuments,
      properties: {},
      frozenAt: new Date().toISOString(),
    },
    quantity: 1,
    paymentStatus: 'not_needed',
    carrierCommission: 'not_yet',
  });

  const leadRow = async (leadId: string) => {
    const [row] = await admin<
      {
        stage: string;
        orderDetails: Record<string, unknown>;
        customValues: Record<string, unknown>;
        payload: { payload: Record<string, unknown> };
        archived: boolean;
      }[]
    >`
      select stage, order_details as "orderDetails", custom_values as "customValues", payload,
        deleted_at is not null as archived
      from app.leads where id = ${leadId}
    `;
    if (!row) throw new Error('lead gone');
    return row;
  };

  const audits = (entityId: string, action: string) =>
    admin<{ id: string; after: Record<string, unknown> }[]>`
      select id, after from app.audit_events
      where workspace_id = ${SITE} and entity_id = ${entityId} and action = ${action}
    `;

  const sign = (draft: unknown, extra: Partial<SignedAiAction> = {}, actor = OWNER) =>
    signAiAction(
      {
        id: randomUUID(),
        workspaceId: SITE,
        actorId: actor,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        draft: aiCardDraftSchema.parse(draft),
        ...extra,
      },
      KEY,
    );

  beforeAll(async () => {
    if (!migrationUrl) throw new Error('TEST_MIGRATION_DATABASE_URL is required');
    admin = postgres(migrationUrl, { max: 1, prepare: false, ssl: false, onnotice: () => {} });
    await admin.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(745284914)`;
      await tx.unsafe(`ALTER ROLE app_runtime PASSWORD '${TEST_RUNTIME_PASSWORD}'`);
    });
    for (const site of [SITE, OTHER_SITE]) {
      await admin`delete from app.audit_events where workspace_id = ${site}`;
      await admin`delete from app.workspaces where id = ${site}`;
    }
    await admin`
      insert into app.workspaces (id, slug, name)
      values (${SITE}, 'ci-ai-wide', 'CI AI Wide'), (${OTHER_SITE}, 'ci-ai-wide-b', 'CI AI Wide B')
    `;
    await admin`
      insert into app.memberships (workspace_id, user_id, membership_type, status, accepted_at, display_name)
      values (${SITE}, ${OWNER}, 'staff', 'active', now(), 'Owner'),
             (${SITE}, ${LEADS}, 'staff', 'active', now(), 'Lee Leads'),
             (${SITE}, ${FINANCE}, 'staff', 'active', now(), 'Finance'),
             (${SITE}, ${DENIED}, 'staff', 'active', now(), 'Denied'),
             (${OTHER_SITE}, ${OWNER}, 'staff', 'active', now(), 'Owner')
    `;
    await admin`
      insert into app.workspace_email_settings (workspace_id, from_name, from_address, site_url, updated_by)
      values (${SITE}, 'Wide Site', 'orders@wide.example', 'https://wide.example', ${OWNER})
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position)
      values (${SITE}, 'lead', 'custom_colour', 'custom', 'Colour', 'text', 1)
    `;
    await admin`
      insert into app.properties (workspace_id, object, key, origin, label, kind, position, sensitive)
      values (${SITE}, 'lead', 'custom_secret', 'custom', 'Secret word', 'text', 2, true)
    `;
    const runtimeUrl = new URL(migrationUrl);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = TEST_RUNTIME_PASSWORD;
    database = createDatabaseClient({
      connectionString: runtimeUrl.toString(),
      maxConnections: 4,
      ssl: false,
    });
    const planStore = new DatabasePlanStore(database);
    const ctx = { workspaceId: SITE, actorId: OWNER, requestId: randomUUID() };
    const planOf = async (
      name: string,
      requiredDocuments: CreatePlanRequest['requiredDocuments'],
    ) => {
      const created = await planStore.create(ctx, {
        leadType: 'sim_order',
        name,
        priceMinor: 2500,
        billingPeriod: 'month',
        paymentRequired: false,
        requiredDocuments,
        active: true,
        customValues: {},
      });
      if (created.kind !== 'created') throw new Error('plan');
      return created.plan;
    };
    freePlan = await planOf('Free plan', []);
    otherPlan = await planOf('Bigger plan', []);
    gatedPlan = await planOf('Passport plan', ['passport']);
    // The built-in Dispatched flow is on: a move to Delivered sends its mail.
    await seedBuiltInFlow(admin, {
      workspaceId: SITE,
      key: 'sim_order_dispatched',
      enabled: true,
      actorId: OWNER,
    });
    work = new DatabaseLeadWorkStore(database, mailEnvironment);
    reads = new DatabaseAiReadService(database);
    const app = createApp({
      staff: {
        sessionVerifier: {
          verify: async (token) => ({ actorId: token, verifiedEmail: `${token}@example.test` }),
        },
        store: staffStore,
        credentialStore: unusedCredentialStore,
        leadStore: new DatabaseLeadStore(database),
        leadWorkStore: work,
        reportStore: reports,
        propertyStore: new DatabasePropertyStore(database),
        flowStore: new DatabaseFlowStore(database),
        ai: {
          config,
          siteContext: new DatabaseAiSiteContextStore(database),
          reads,
          engine: scriptedEngine(results, offered, systems),
          rateLimit: (input) => limiter.hit(input),
          cards: new DatabaseAiCardStore(database, mailEnvironment),
          // The saved chat, for the turns that replay an earlier one (T11).
          chat: {
            schema: new DatabaseAiChatSchemaProbe(database),
            conversations: new DatabaseAiConversationStore(database),
          },
          now: clock.now,
        },
      },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP server');
    base = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    limiter.counts.clear();
    limiter.broken = false;
    clock.offsetMs = 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await database?.close();
    await admin?.end();
  });

  describe('capabilities and the action table (C1)', () => {
    const capabilities = async (actor: string, site = SITE) =>
      aiCapabilitiesResponseSchema.parse(
        await (
          await fetch(`${base}/api/v1/staff/workspaces/${site}/ai/capabilities`, {
            headers: { authorization: `Bearer ${actor}` },
          })
        ).json(),
      );

    it('lists every kind a member may use, keeping the older lists as they were', async () => {
      const owner = await capabilities(OWNER);
      expect(owner.cardActions).toEqual([...AI_CARD_KINDS]);
      expect(owner.actions).toEqual(['task', 'note', 'email', 'lead_update']);
      expect(owner.taskActions).toEqual(['plain_task', 'task_update']);
      // Leads: no integration.manage, so no automation switch.
      expect((await capabilities(LEADS)).cardActions).toEqual(
        AI_CARD_KINDS.filter((kind) => kind !== 'automation_off'),
      );
      // An individual deny takes the automation switch away from an owner.
      expect((await capabilities(DENIED)).cardActions).not.toContain('automation_off');
      // A site outside the automation allowlist offers no automation switch.
      expect((await capabilities(OWNER, OTHER_SITE)).cardActions).not.toContain('automation_off');
      const finance = await capabilities(FINANCE);
      expect(finance.cardActions).toBeUndefined();
      expect(finance.actions).toEqual([]);
    });

    it('offers the new kinds only to an admin that says it can show them (T12)', async () => {
      offered.length = 0;
      await ask([], OWNER, SITE, { wide: false });
      await ask([], OWNER, SITE);
      const [older, newer] = offered;
      const newKinds = ['prepareLeadEdit', 'getLeadEditOptions', 'prepareTemplateEmail'];
      for (const name of [...newKinds, 'prepareArchive', 'prepareAutomationOff'])
        expect(older).not.toContain(name);
      // The older kinds are offered to both, unchanged.
      for (const name of ['prepareNote', 'prepareTask', 'prepareEmail', 'prepareLeadUpdate'])
        expect(older).toContain(name);
      expect(newer).toEqual(expect.arrayContaining([...newKinds, 'prepareArchive']));
      // A card the older admin could not show is not prepared for it either.
      const leadId = await insertLead({ stage: 'pending' });
      const parts = await ask(
        [
          {
            tool: 'prepareTask',
            input: { leadId, title: 'For Lee', dueDate: null, assignee: LEADS },
          },
          { tool: 'prepareTask', input: { leadId, title: 'Mine', dueDate: null, assignee: 'me' } },
        ],
        OWNER,
        SITE,
        { wide: false },
      );
      expect(JSON.parse(results[0]?.result ?? '{}')).toMatchObject({ status: 'not_available' });
      expect(legacyOf(parts).map((card) => card.draft.kind)).toEqual(['task']);
      expect(cardsOf(parts)).toHaveLength(1);
    });

    it('offers the model only the tools of the kinds the member may use', async () => {
      offered.length = 0;
      await ask([], OWNER);
      await ask([], LEADS);
      await ask([], FINANCE);
      const [owner, leads, finance] = offered;
      expect(owner).toEqual(
        expect.arrayContaining(['prepareLeadEdit', 'prepareArchive', 'prepareAutomationOff']),
      );
      expect(leads).toContain('prepareLeadEdit');
      expect(leads).not.toContain('prepareAutomationOff');
      expect(finance).not.toContain('prepareLeadEdit');
      expect(finance).not.toContain('prepareNote');
    });
  });

  describe('stage move with dispatch details (L6a, O3)', () => {
    it('moves to Delivered with the courier in one card, shows the mail it sends, and saves once', async () => {
      const leadId = await insertLead({ order: orderOn(freePlan), reference: 'MS-9001' });
      const { card, parts } = await oneCard([
        {
          tool: 'prepareLeadEdit',
          input: {
            leadId,
            stage: 'delivered',
            order: { courier: 'Canada Post', trackingNumber: 'TRK-1' },
          },
        },
      ]);
      // A new kind is not in the older part, which an older admin reads.
      expect(legacyOf(parts)).toEqual([]);
      // The dispatch date the move defaults to is written into the signed draft (T2).
      expect(card.draft).toEqual({
        kind: 'lead_edit',
        leadId,
        changes: {
          stage: 'delivered',
          order: {
            courier: 'Canada Post',
            trackingNumber: 'TRK-1',
            dispatchedAt: todayInToronto(new Date()),
          },
        },
      });
      expect(card.leadEditContext?.rows).toEqual(
        expect.arrayContaining([
          { key: 'stage', label: 'Stage', before: 'Verified', after: 'Delivered' },
          expect.objectContaining({ key: 'order.courier', before: null, after: 'Canada Post' }),
        ]),
      );
      expect(card.leadEditContext?.inputs.map((entry) => entry.field)).toEqual([
        'courier',
        'trackingNumber',
        'dispatchedAt',
      ]);
      expect(card.sideEffects?.join(' ')).toMatch(/sends the “Dispatched” email to the customer/);
      // B5: the label leads with the reference and names the type and the day it came.
      expect(card.leadLabel).toMatch(
        /^MS-9001 · Robin Example \(SIM order, created \d{4}-\d{2}-\d{2}\)$/,
      );
      expect((await leadRow(leadId)).stage).toBe('verified');

      const saved = await confirm(card);
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ kind: 'lead_edit', recordId: leadId });
      const row = await leadRow(leadId);
      expect(row.stage).toBe('delivered');
      expect(row.orderDetails).toMatchObject({ courier: 'Canada Post', trackingNumber: 'TRK-1' });
      // A replay returns the receipt and saves nothing again.
      expect((await confirm(card)).status).toBe(200);
      expect(await audits(leadId, 'ai.lead_edited')).toHaveLength(1);
      const moves = await admin<{ data: Record<string, unknown> }[]>`
        select data from app.lead_activities where lead_id = ${leadId} and kind = 'status_change'
      `;
      expect(moves).toHaveLength(1);
      expect(moves[0]?.data).toMatchObject({ to: 'delivered', viaAi: true });
    });

    it('carries an empty courier for the person to type, and saves once they revise the card', async () => {
      const leadId = await insertLead({ order: orderOn(freePlan) });
      const { card } = await oneCard([
        { tool: 'prepareLeadEdit', input: { leadId, stage: 'delivered' } },
      ]);
      expect(card.leadEditContext?.needs).toBe('dispatch_details');
      expect(card.leadEditContext?.inputs[0]).toMatchObject({ field: 'courier', required: true });
      expect(JSON.parse(results[0]?.result ?? '{}').message).toMatch(/courier on the card/);
      // Confirmed as it is, the move is refused as a staff edit is.
      expect(await errorOf(await confirm(card))).toMatchObject({
        status: 400,
        code: 'dispatch_details_required',
      });
      const revised = await post('/ai/actions/revise', {
        token: card.token,
        draft: {
          kind: 'lead_edit',
          leadId,
          changes: { stage: 'delivered', order: { courier: 'Purolator' } },
        },
        wide: true,
      });
      expect(revised.status).toBe(200);
      const next = aiActionCardSchema.parse(await revised.json());
      expect(next.leadEditContext?.needs).toBeUndefined();
      expect((await confirm(next)).status).toBe(200);
      expect((await leadRow(leadId)).orderDetails).toMatchObject({ courier: 'Purolator' });
      // The first version is another version of a saved draft.
      expect(await errorOf(await confirm(card))).toMatchObject({
        status: 409,
        details: { reason: 'superseded' },
      });
    });

    it('takes an activation number only from the person, never from the model', async () => {
      const leadId = await insertLead({ stage: 'delivered', order: orderOn(freePlan) });
      await ask([
        {
          tool: 'prepareLeadEdit',
          input: { leadId, stage: 'activated', order: { activationNumber: '+1 778 555 0199' } },
        },
      ]);
      expect(results[0]?.result).toBe('invalid_input');
      const { card } = await oneCard([
        { tool: 'prepareLeadEdit', input: { leadId, stage: 'activated' } },
      ]);
      expect(card.leadEditContext?.inputs.map((entry) => entry.field)).toEqual([
        'activatedAt',
        'activationNumber',
        'activationAccount',
      ]);
      const revised = aiActionCardSchema.parse(
        await (
          await post('/ai/actions/revise', {
            token: card.token,
            draft: {
              kind: 'lead_edit',
              leadId,
              changes: { stage: 'activated', order: { activationNumber: '+1 778 555 0199' } },
            },
            wide: true,
          })
        ).json(),
      );
      expect((await confirm(revised)).status).toBe(200);
      expect((await leadRow(leadId)).orderDetails).toMatchObject({
        activationNumber: '+1 778 555 0199',
      });
    });

    it('refuses a move whose documents are missing, naming them and linking the lead page', async () => {
      const leadId = await insertLead({ order: orderOn(gatedPlan) });
      const parts = await ask([
        {
          tool: 'prepareLeadEdit',
          input: { leadId, stage: 'delivered', order: { courier: 'Canada Post' } },
        },
      ]);
      expect(cardsOf(parts)).toEqual([]);
      const result = JSON.parse(results[0]?.result ?? '{}');
      expect(result).toMatchObject({ status: 'needs_lead_page', missingDocuments: ['passport'] });
      expect(result.message).toMatch(/passport/);
      const sources = parts.flatMap((part) => (part.type === 'sources' ? part.sources : []));
      expect(sources.map((source) => source.href)).toContain(`/w/ci-ai-wide/leads/${leadId}`);
      // A card can never carry an override, and a forged move is still gated.
      expect(
        aiCardDraftSchema.safeParse({
          kind: 'lead_edit',
          leadId,
          changes: { stage: 'delivered', documentsOverrideReason: 'trust me' },
        }).success,
      ).toBe(false);
      const preview = await new DatabaseAiCardStore(database).previewLeadEdit({
        workspaceId: SITE,
        actorId: OWNER,
        leadId,
        changes: { order: { courier: 'Canada Post' } },
        catalog: await new DatabasePropertyStore(database).catalog({
          workspaceId: SITE,
          actorId: OWNER,
          requestId: randomUUID(),
        }),
      });
      if (preview.status !== 'ready') throw new Error('expected a preview');
      const token = sign(
        {
          kind: 'lead_edit',
          leadId,
          changes: { stage: 'delivered', order: { courier: 'Canada Post' } },
        },
        { leadEditVersion: preview.version },
      );
      expect(await errorOf(await confirm({ token }))).toMatchObject({
        status: 409,
        code: 'conflict',
      });
      expect((await leadRow(leadId)).stage).toBe('verified');
    });

    it('refuses a card whose lead or side effects changed since it was prepared', async () => {
      const leadId = await insertLead({ order: orderOn(freePlan) });
      const step = [
        {
          tool: 'prepareLeadEdit',
          input: { leadId, stage: 'delivered', order: { courier: 'Canada Post' } },
        },
      ];
      const { card } = await oneCard(step);
      await work.updateLead({
        workspaceId: SITE,
        actorId: OWNER,
        requestId: randomUUID(),
        leadId,
        order: { trackingNumber: 'CHANGED' },
        catalog: await new DatabasePropertyStore(database).catalog({
          workspaceId: SITE,
          actorId: OWNER,
          requestId: randomUUID(),
        }),
      });
      expect(await errorOf(await confirm(card))).toMatchObject({
        status: 409,
        details: { reason: 'changed' },
      });
      // Prepared again, then the Dispatched flow is switched off: the card no longer says what happens.
      const { card: again } = await oneCard(step);
      await admin`
        update app.automations set enabled = false
        where workspace_id = ${SITE} and key = 'sim_order_dispatched'
      `;
      try {
        expect(await errorOf(await confirm(again))).toMatchObject({
          status: 409,
          details: { reason: 'changed' },
        });
        expect((await leadRow(leadId)).stage).toBe('verified');
      } finally {
        await admin`
          update app.automations set enabled = true
          where workspace_id = ${SITE} and key = 'sim_order_dispatched'
        `;
      }
    });

    it('shows what an older stage card sets off (B3), and refuses it once that changes', async () => {
      await seedBuiltInFlow(admin, {
        workspaceId: SITE,
        key: 'sim_order_cancelled',
        enabled: true,
        actorId: OWNER,
      });
      const leadId = await insertLead({ order: orderOn(freePlan) });
      const step = [
        { tool: 'prepareLeadUpdate', input: { leadId, field: 'stage', value: 'cancelled' } },
      ];
      const { card, parts } = await oneCard(step);
      expect(card.sideEffects?.join(' ')).toMatch(/sends the “Cancelled” email to the customer/);
      // An older admin still gets the card, in its older shape.
      expect(legacyOf(parts)).toHaveLength(1);
      expect(Object.keys(legacyOf(parts)[0] ?? {})).not.toContain('sideEffects');
      await admin`
        update app.automations set enabled = false
        where workspace_id = ${SITE} and key = 'sim_order_cancelled'
      `;
      expect(await errorOf(await confirm(card))).toMatchObject({
        status: 409,
        details: { reason: 'changed' },
      });
      expect((await leadRow(leadId)).stage).toBe('verified');
      const { card: fresh } = await oneCard(step);
      expect(fresh.sideEffects).toEqual(['No automation runs for this move.']);
      expect((await confirm(fresh)).status).toBe(200);
      expect((await leadRow(leadId)).stage).toBe('cancelled');
    });

    it('moves the stage and changes the plan in one card, and confirms it (R1)', async () => {
      const leadId = await insertLead({ order: orderOn(freePlan) });
      const { card } = await oneCard([
        {
          tool: 'prepareLeadEdit',
          input: {
            leadId,
            stage: 'delivered',
            order: { courier: 'Canada Post', planId: otherPlan.id },
          },
        },
      ]);
      expect(card.sideEffects?.join(' ')).toMatch(/sends the “Dispatched” email/);
      expect(card.sideEffects?.join(' ')).toMatch(/Re-freezes the plan/);
      const saved = await confirm(card);
      expect(saved.status).toBe(200);
      const row = await leadRow(leadId);
      expect(row.stage).toBe('delivered');
      expect(row.orderDetails).toMatchObject({
        planId: otherPlan.id,
        plan: { name: 'Bigger plan' },
      });
      // Each alone confirms too, and the plan's effect is checked like the move's.
      const planOnly = await insertLead({ stage: 'pending', order: orderOn(freePlan) });
      const { card: plan } = await oneCard([
        { tool: 'prepareLeadEdit', input: { leadId: planOnly, order: { planId: otherPlan.id } } },
      ]);
      await admin`update app.plans set name = 'Bigger plan, renamed' where id = ${otherPlan.id}`;
      try {
        expect(await errorOf(await confirm(plan))).toMatchObject({
          status: 409,
          details: { reason: 'changed' },
        });
      } finally {
        await admin`update app.plans set name = 'Bigger plan' where id = ${otherPlan.id}`;
      }
      expect((await confirm(plan)).status).toBe(200);
      const stageOnly = await insertLead({ order: orderOn(freePlan) });
      const { card: move } = await oneCard([
        {
          tool: 'prepareLeadEdit',
          input: { leadId: stageOnly, stage: 'delivered', order: { courier: 'UPS' } },
        },
      ]);
      expect((await confirm(move)).status).toBe(200);
    });

    it('shows exactly what Confirm saves: the default date as today, and no unchanged detail (T2)', async () => {
      const today = todayInToronto(new Date());
      const leadId = await insertLead({ order: orderOn(freePlan) });
      const { card } = await oneCard([
        {
          tool: 'prepareLeadEdit',
          input: {
            leadId,
            stage: 'delivered',
            order: { courier: 'Canada Post', trackingNumber: 'TRK123' },
          },
        },
      ]);
      const rows = card.leadEditContext?.rows ?? [];
      expect(rows.map((row) => row.key)).toEqual([
        'stage',
        'order.courier',
        'order.trackingNumber',
        'order.dispatchedAt',
      ]);
      expect(rows.find((row) => row.key === 'order.dispatchedAt')).toMatchObject({
        before: null,
        after: expect.stringMatching(/ \(today\)$/),
      });
      // Nothing reads "Not set → Cleared": every row either changes or is required.
      expect(rows.filter((row) => row.before === null && row.after === null)).toEqual([]);
      // The date the card shows is the date it signs and saves.
      expect(card.draft).toMatchObject({ changes: { order: { dispatchedAt: today } } });
      expect((await confirm(card)).status).toBe(200);
      expect((await leadRow(leadId)).orderDetails).toMatchObject({ dispatchedAt: today });

      const activation = await insertLead({ stage: 'delivered', order: orderOn(freePlan) });
      const { card: activated } = await oneCard([
        { tool: 'prepareLeadEdit', input: { leadId: activation, stage: 'activated' } },
      ]);
      expect(activated.leadEditContext?.rows.map((row) => row.key)).toEqual([
        'stage',
        'order.activatedAt',
      ]);
      // The person can still type the number and account on the card.
      expect(activated.leadEditContext?.inputs.map((entry) => entry.field)).toEqual([
        'activatedAt',
        'activationNumber',
        'activationAccount',
      ]);
      // A courier still to be typed is shown as required, not as a change to nothing.
      const noCourier = await insertLead({ order: orderOn(freePlan) });
      const { card: needs } = await oneCard([
        { tool: 'prepareLeadEdit', input: { leadId: noCourier, stage: 'delivered' } },
      ]);
      expect(needs.leadEditContext?.rows.map((row) => row.key)).toEqual(['stage', 'order.courier']);
    });

    it('says a move submits an unfinished checkout', async () => {
      const leadId = await insertLead({
        stage: 'incomplete',
        status: 'incomplete',
        order: { planId: freePlan.id, quantity: 1 },
      });
      const { card } = await oneCard([
        { tool: 'prepareLeadEdit', input: { leadId, stage: 'pending' } },
      ]);
      expect(card.sideEffects?.[0]).toMatch(/Submits the customer’s unfinished checkout/);
    });
  });

  describe('lead details (O1, O2, L6e, L6f)', () => {
    it('changes plan, quantity, payment, a form field and a custom value in one card, against the site’s catalogue', async () => {
      const leadId = await insertLead({
        stage: 'pending',
        order: orderOn(freePlan),
        form: { simNumber: '+1 604 555 0100' },
        custom: { custom_colour: 'crimson-71' },
      });
      const { card } = await oneCard([
        {
          tool: 'prepareLeadEdit',
          input: {
            leadId,
            order: { planId: otherPlan.id, quantity: 2, paymentStatus: 'paid' },
            form: { simNumber: '+1 604 555 0111' },
            customValues: { custom_colour: 'blue' },
          },
        },
      ]);
      // The current values reach the card, never the model.
      const told = results.map((entry) => entry.result).join(' ');
      expect(told).not.toContain('555 0100');
      expect(told).not.toContain('crimson-71');
      expect(card.leadEditContext?.rows).toEqual(
        expect.arrayContaining([
          { key: 'order.planId', label: 'Plan', before: 'Free plan', after: 'Bigger plan' },
          expect.objectContaining({
            key: 'custom.custom_colour',
            before: 'crimson-71',
            after: 'blue',
          }),
          expect.objectContaining({ key: 'form.simNumber', before: '+1 604 555 0100' }),
        ]),
      );
      expect(card.sideEffects?.join(' ')).toMatch(/Re-freezes the plan/);
      expect((await confirm(card)).status).toBe(200);
      const row = await leadRow(leadId);
      expect(row.orderDetails).toMatchObject({
        planId: otherPlan.id,
        quantity: 2,
        paymentStatus: 'paid',
        plan: { name: 'Bigger plan' },
      });
      expect(row.customValues).toEqual({ custom_colour: 'blue' });
      expect(row.payload.payload['simNumber']).toBe('+1 604 555 0111');
      const [receipt] = await audits(leadId, 'ai.lead_edited');
      expect(receipt?.after).toEqual({
        parts: ['customValues', 'form', 'order'],
        aiCardId: card.id,
      });
    });

    it('refuses an unknown custom key and a plan of another kind, and an archived or restricted lead', async () => {
      const leadId = await insertLead({ stage: 'pending', order: orderOn(freePlan) });
      const parts = await ask([
        { tool: 'prepareLeadEdit', input: { leadId, order: { planId: randomUUID() } } },
        { tool: 'prepareLeadEdit', input: { leadId, customValues: { custom_unknown: 'x' } } },
      ]);
      expect(JSON.parse(results[0]?.result ?? '{}').reason).toBe('invalid_field');
      // The site's catalogue decides custom keys.
      expect(JSON.parse(results[1]?.result ?? '{}')).toMatchObject({
        reason: 'invalid_field',
        field: 'custom.custom_unknown',
      });
      expect(cardsOf(parts)).toEqual([]);
      // A forged card with an unknown key, at the lead's true version, is refused at
      // Confirm by the site's catalogue, as the lead page refuses it.
      const changes = { customValues: { custom_unknown: 'x' } };
      const [state] = await admin<
        {
          stage: string;
          status: string;
          payload: unknown;
          customValues: unknown;
          orderDetails: unknown;
        }[]
      >`
        select stage, status, payload, custom_values as "customValues",
          order_details as "orderDetails"
        from app.leads where id = ${leadId}
      `;
      if (!state) throw new Error('lead');
      const forgedPreview = sign(
        { kind: 'lead_edit', leadId, changes },
        { leadEditVersion: leadEditVersion(state, changes) },
      );
      expect(await errorOf(await confirm({ token: forgedPreview }))).toMatchObject({
        status: 400,
        code: 'validation_error',
        details: { field: 'custom_unknown' },
      });
      for (const lead of [{ archived: true }, { restricted: true }]) {
        const id = await insertLead({ stage: 'pending', ...lead });
        const refused = await ask([
          { tool: 'prepareLeadEdit', input: { leadId: id, order: { quantity: 3 } } },
        ]);
        expect(cardsOf(refused)).toEqual([]);
        expect(JSON.parse(results[0]?.result ?? '{}').status).toBe('not_available');
      }
      const archived = await insertLead({ stage: 'pending', archived: true });
      const token = sign(
        { kind: 'lead_edit', leadId: archived, changes: { order: { quantity: 3 } } },
        { leadEditVersion: 'a'.repeat(64) },
      );
      expect(await errorOf(await confirm({ token }))).toMatchObject({
        status: 409,
        code: 'lead_trashed',
      });
      const restricted = await insertLead({ stage: 'pending', restricted: true });
      const restrictedToken = sign(
        { kind: 'lead_edit', leadId: restricted, changes: { order: { quantity: 3 } } },
        { leadEditVersion: 'a'.repeat(64) },
      );
      expect((await confirm({ token: restrictedToken })).status).toBe(404);
    });
  });

  describe('tasks widened (T1–T3)', () => {
    it('assigns a task to another active member, and refuses one who is not', async () => {
      const leadId = await insertLead({ stage: 'pending' });
      const parts = await ask([
        {
          tool: 'prepareTask',
          input: { leadId, title: 'Call for Lee', dueDate: tomorrow, assignee: LEADS },
        },
        {
          tool: 'prepareTask',
          input: { leadId, title: 'Call for nobody', dueDate: null, assignee: randomUUID() },
        },
      ]);
      const [card] = cardsOf(parts);
      if (!card) throw new Error('expected a card');
      expect(card.assigneeChoices).toEqual(
        expect.arrayContaining([{ value: LEADS, label: 'Lee Leads' }]),
      );
      // Assigned to someone else, it is not a card an older admin can show.
      expect(legacyOf(parts)).toEqual([]);
      expect(JSON.parse(results[1]?.result ?? '{}').status).toBe('not_available');
      const saved = await confirm(card);
      expect(saved.status).toBe(200);
      const [task] = await admin<{ assignedActorId: string }[]>`
        select assigned_actor_id as "assignedActorId" from app.lead_tasks
        where id = ${(await saved.json()).recordId}
      `;
      expect(task?.assignedActorId).toBe(LEADS);
      // A forged card naming a non-member is refused by the store's own check.
      const forged = sign({
        kind: 'task',
        leadId,
        title: 'Forged',
        dueDate: null,
        assignee: FINANCE.replace(/3$/, '9'),
      });
      expect(await errorOf(await confirm({ token: forged }))).toMatchObject({
        status: 409,
        code: 'assignee_not_found',
      });
    });

    it('edits a task’s title, due date and assignee, keeping the stale check', async () => {
      const created = await work.createPlainTask({
        workspaceId: SITE,
        actorId: OWNER,
        requestId: randomUUID(),
        title: 'Order stock',
        assignedActorId: OWNER,
      });
      if (created.status !== 'saved') throw new Error('task');
      const taskId = created.task.id;
      const { card, parts } = await oneCard([
        {
          tool: 'prepareTaskUpdate',
          input: { taskId, title: 'Order 50 SIMs', dueDate: tomorrow, assignee: LEADS },
        },
      ]);
      expect(legacyOf(parts)).toEqual([]);
      expect(card.taskEditContext).toEqual({ dueDate: null, assigneeLabel: 'You' });
      expect((await confirm(card)).status).toBe(200);
      const [task] = await admin<{ title: string; assignedActorId: string; status: string }[]>`
        select title, assigned_actor_id as "assignedActorId", status from app.lead_tasks
        where id = ${taskId}
      `;
      expect(task).toEqual({ title: 'Order 50 SIMs', assignedActorId: LEADS, status: 'open' });
      expect((await confirm(card)).status).toBe(200);
      expect(await audits(taskId, 'ai.task_updated')).toHaveLength(1);
      const { card: stale } = await oneCard([
        { tool: 'prepareTaskUpdate', input: { taskId, title: 'Again' } },
      ]);
      await work.updateTask({
        workspaceId: SITE,
        actorId: OWNER,
        requestId: randomUUID(),
        taskId,
        title: 'Renamed by hand',
      });
      expect(await errorOf(await confirm(stale))).toMatchObject({ status: 409, code: 'conflict' });
    });
  });

  describe('template email (M1)', () => {
    it('shows the rendered mail, sends it once under its own key, and refuses it once it would differ', async () => {
      const leadId = await insertLead({
        stage: 'pending',
        email: 'wide.customer@example.test',
        form: { simNumber: '+1 778 555 0142' },
      });
      const { card } = await oneCard([
        { tool: 'prepareTemplateEmail', input: { leadId, template: 'sim_number_ready' } },
      ]);
      expect(card.emailContext).toEqual({
        toAddress: 'wide.customer@example.test',
        fromAddress: 'orders@wide.example',
      });
      expect(card.templateEmailContext?.text).toContain('+1 778 555 0142');
      expect(card.sideEffects?.[0]).toMatch(/Sends the “SIM number ready” email/);
      // Never the address or the number to the model.
      expect(results[0]?.result).not.toContain('wide.customer');
      expect(results[0]?.result).not.toContain('0142');
      const saved = await confirm(card);
      expect(saved.status).toBe(200);
      const receipt = await saved.json();
      expect((await (await confirm(card)).json()).recordId).toBe(receipt.recordId);
      const jobs = await admin<{ dedupeKey: string }[]>`
        select dedupe_key as "dedupeKey" from app.outbox_jobs
        where workspace_id = ${SITE} and payload ->> 'leadId' = ${leadId}
      `;
      expect(jobs).toEqual([{ dedupeKey: `ai_template_email:${card.id}` }]);

      // The number changes under the card: the mail shown is not the mail it would send.
      const { card: changed } = await oneCard([
        { tool: 'prepareTemplateEmail', input: { leadId, template: 'sim_number_ready' } },
      ]);
      await admin`
        update app.leads set payload = jsonb_set(payload, '{payload,simNumber}', '"+1 778 555 0999"')
        where id = ${leadId}
      `;
      expect(await errorOf(await confirm(changed))).toMatchObject({
        status: 409,
        code: 'conflict',
      });
      // The template is saved again under the card: refused too.
      const { card: versioned } = await oneCard([
        { tool: 'prepareTemplateEmail', input: { leadId, template: 'sim_number_ready' } },
      ]);
      const saveTemplate = await new DatabaseEmailSettingsStore(database).putTemplate(
        { workspaceId: SITE, actorId: OWNER, requestId: randomUUID() },
        'sim_number_ready',
        { expectedVersion: 0, subject: 'Your number', body: 'Your number is {SIM number}.' },
      );
      expect(saveTemplate.kind).toBe('saved');
      expect(await errorOf(await confirm(versioned))).toMatchObject({
        status: 409,
        code: 'conflict',
      });
    });

    it('says which part of a template email changed when Send is refused (T7)', async () => {
      const leadId = await insertLead({
        stage: 'pending',
        email: 'stale.customer@example.test',
        form: { simNumber: '+1 778 555 0160' },
      });
      const prepare = async () =>
        (
          await oneCard([
            { tool: 'prepareTemplateEmail', input: { leadId, template: 'sim_number_ready' } },
          ])
        ).card;
      const text = await prepare();
      await admin`
        update app.leads set payload = jsonb_set(payload, '{payload,simNumber}', '"+1 778 555 0161"')
        where id = ${leadId}
      `;
      expect(await errorOf(await confirm(text))).toMatchObject({
        status: 409,
        code: 'conflict',
        details: { reason: 'text_changed' },
      });
      const recipient = await prepare();
      await admin`update app.leads set email = 'moved.customer@example.test' where id = ${leadId}`;
      expect(await errorOf(await confirm(recipient))).toMatchObject({
        status: 409,
        details: { reason: 'recipient_changed' },
      });
      const template = await prepare();
      const current = (
        await new DatabaseEmailSettingsStore(database).listTemplates({
          workspaceId: SITE,
          actorId: OWNER,
        })
      ).find((entry) => entry.key === 'sim_number_ready');
      const saved = await new DatabaseEmailSettingsStore(database).putTemplate(
        { workspaceId: SITE, actorId: OWNER, requestId: randomUUID() },
        'sim_number_ready',
        {
          expectedVersion: current?.version ?? 0,
          subject: 'Your number, again',
          body: 'Your number is {SIM number}.',
        },
      );
      expect(saved.kind).toBe('saved');
      expect(await errorOf(await confirm(template))).toMatchObject({
        status: 409,
        details: { reason: 'template_changed' },
      });
      // A written email whose recipient changed says so too.
      const { card: written } = await oneCard([
        { tool: 'prepareEmail', input: { leadId, subject: 'Hello', body: 'Hello there.' } },
      ]);
      await admin`update app.leads set email = 'third.customer@example.test' where id = ${leadId}`;
      expect(await errorOf(await confirm(written))).toMatchObject({
        status: 409,
        details: { reason: 'recipient_changed' },
      });
    });

    it('names the fill-ins a lead lacks instead of preparing a card', async () => {
      const leadId = await insertLead({ stage: 'pending' });
      const parts = await ask([
        { tool: 'prepareTemplateEmail', input: { leadId, template: 'sim_number_ready' } },
      ]);
      expect(cardsOf(parts)).toEqual([]);
      const result = JSON.parse(results[0]?.result ?? '{}');
      expect(result).toMatchObject({ reason: 'missing_fill_ins', missing: ['SIM number'] });
      expect(result.message).toMatch(/SIM number/);
    });
  });

  describe('archive and restore (L7)', () => {
    it('archives one lead with its side effects shown, saves once, and restores it', async () => {
      const leadId = await insertLead({ stage: 'pending' });
      const { card } = await oneCard([
        { tool: 'prepareArchive', input: { leadId, archived: true } },
      ]);
      expect(card.sideEffects?.[0]).toMatch(
        /Waiting automation runs and timers for this lead are cancelled\. Restoring the lead does not bring them back\./,
      );
      expect((await confirm(card)).status).toBe(200);
      expect((await confirm(card)).status).toBe(200);
      expect((await leadRow(leadId)).archived).toBe(true);
      expect(await audits(leadId, 'lead.trashed')).toEqual([
        expect.objectContaining({ after: expect.objectContaining({ aiCardId: card.id }) }),
      ]);
      const [entry] = await admin<{ data: Record<string, unknown> }[]>`
        select data from app.lead_activities where lead_id = ${leadId} and data ->> 'event' = 'trashed'
      `;
      expect(entry?.data).toEqual({ event: 'trashed', viaAi: true });
      const again = await ask([{ tool: 'prepareArchive', input: { leadId, archived: true } }]);
      expect(cardsOf(again)).toEqual([]);
      const { card: restore } = await oneCard([
        { tool: 'prepareArchive', input: { leadId, archived: false } },
      ]);
      expect((await confirm(restore)).status).toBe(200);
      expect((await leadRow(leadId)).archived).toBe(false);
    });

    it('refuses an archive card once someone else archived the lead', async () => {
      const leadId = await insertLead({ stage: 'pending' });
      const { card } = await oneCard([
        { tool: 'prepareArchive', input: { leadId, archived: true } },
      ]);
      await work.setArchived({
        workspaceId: SITE,
        actorId: LEADS,
        requestId: randomUUID(),
        leadId,
        archived: true,
      });
      expect(await errorOf(await confirm(card))).toMatchObject({
        status: 409,
        details: { reason: 'changed' },
      });
    });
  });

  describe('automation switch-off (A10 off)', () => {
    it('switches a flow off for an owner, once, and only off', async () => {
      await seedBuiltInFlow(admin, {
        workspaceId: SITE,
        key: 'order_received',
        enabled: true,
        actorId: OWNER,
      });
      const { card } = await oneCard([
        { tool: 'prepareAutomationOff', input: { automationKey: 'order_received' } },
      ]);
      expect(card.automationOffContext?.name).toBeTruthy();
      expect(card.sideEffects?.[0]).toMatch(/waiting runs are cancelled/);
      expect(card.leadHref).toBe('/w/ci-ai-wide/automations/order_received');
      // Leads (no integration.manage) and an owner with an individual deny may not confirm it.
      expect((await confirm(card, {}, LEADS)).status).toBe(400);
      for (const actor of [LEADS, DENIED]) {
        const forged = sign(
          { kind: 'automation_off', automationKey: 'order_received' },
          { automationRevision: card.automationOffContext?.revision ?? 0 },
          actor,
        );
        expect((await confirm({ token: forged }, {}, actor)).status).toBe(403);
      }
      const saved = await confirm(card);
      expect(saved.status).toBe(200);
      expect((await confirm(card)).status).toBe(200);
      const [flow] = await admin<{ enabled: boolean; id: string }[]>`
        select enabled, id from app.automations where workspace_id = ${SITE} and key = 'order_received'
      `;
      expect(flow?.enabled).toBe(false);
      const toggled = await admin<{ after: Record<string, unknown> }[]>`
        select after from app.audit_events
        where workspace_id = ${SITE} and entity_id = ${flow?.id ?? ''} and action = 'automation.toggled'
      `;
      expect(toggled).toEqual([
        { after: expect.objectContaining({ enabled: false, aiActionId: card.id }) },
      ]);
      // There is no switch-on card: the draft schema has no such kind.
      expect(
        aiCardDraftSchema.safeParse({ kind: 'automation_on', automationKey: 'order_received' })
          .success,
      ).toBe(false);
      // Off already: nothing to prepare.
      const off = await ask([
        { tool: 'prepareAutomationOff', input: { automationKey: 'order_received' } },
      ]);
      expect(cardsOf(off)).toEqual([]);
    });

    it('refuses a switch-off card whose flow changed, or that someone else already switched off', async () => {
      await seedBuiltInFlow(admin, {
        workspaceId: SITE,
        key: 'sim_order_activated',
        enabled: true,
        actorId: OWNER,
      });
      const { card } = await oneCard([
        { tool: 'prepareAutomationOff', input: { automationKey: 'sim_order_activated' } },
      ]);
      await admin`
        update app.automations set revision = revision + 1
        where workspace_id = ${SITE} and key = 'sim_order_activated'
      `;
      expect(await errorOf(await confirm(card))).toMatchObject({
        status: 409,
        details: { reason: 'changed' },
      });
      const { card: second } = await oneCard([
        { tool: 'prepareAutomationOff', input: { automationKey: 'sim_order_activated' } },
      ]);
      await admin`
        update app.automations set enabled = false
        where workspace_id = ${SITE} and key = 'sim_order_activated'
      `;
      expect(await errorOf(await confirm(second))).toMatchObject({
        status: 409,
        details: { reason: 'changed' },
      });
    });
  });

  describe('mentions of other customers (B1)', () => {
    it('warns on an email naming another lead read in the turn, and saves only with the tick', async () => {
      const target = await insertLead({ stage: 'pending', name: 'Pat Target' });
      const other = await insertLead({
        stage: 'pending',
        name: 'Zara Quill',
        reference: 'MS-7777',
      });
      const parts = await ask([
        { tool: 'getLeadSummary', input: { leadId: other } },
        {
          tool: 'prepareEmail',
          input: {
            leadId: target,
            subject: 'Your order',
            body: 'Hello Pat, our newest orders are Zara Quill (MS-7777).',
          },
        },
        { tool: 'prepareNote', input: { leadId: target, body: 'Spoke to Pat about the visa.' } },
      ]);
      const [email, note] = cardsOf(parts);
      if (!email || !note) throw new Error('expected two cards');
      expect(email.mentions).toEqual(['MS-7777', 'Zara Quill']);
      expect(email.acknowledgementRequired).toBe(true);
      expect(note.mentions).toBeUndefined();
      // An older admin cannot send the tick, so it is not shown the card at all.
      expect(legacyOf(parts).map((card) => card.draft.kind)).toEqual(['note']);
      expect(await errorOf(await confirm(email))).toMatchObject({
        status: 409,
        details: { reason: 'acknowledgement_required' },
      });
      // A revision checks its own text against the same leads.
      const clean = aiActionCardSchema.parse(
        await (
          await post('/ai/actions/revise', {
            token: email.token,
            draft: { kind: 'email', leadId: target, subject: 'Your order', body: 'Hello Pat.' },
            wide: true,
          })
        ).json(),
      );
      expect(clean.acknowledgementRequired).toBeUndefined();
      const still = aiActionCardSchema.parse(
        await (
          await post('/ai/actions/revise', {
            token: email.token,
            draft: { kind: 'email', leadId: target, subject: 'Re Zara Quill', body: 'Hello.' },
            wide: true,
          })
        ).json(),
      );
      expect(still.mentions).toEqual(['Zara Quill']);
      expect((await confirm(still, { acknowledged: true })).status).toBe(200);
    });
  });

  describe('a revision keeps the mention check (R2)', () => {
    const revise = async (card: AiActionCard, draft: unknown = card.draft) =>
      post('/ai/actions/revise', { token: card.token, draft, wide: true });

    it('checks a revision against every lead the first card was, past the 30th', async () => {
      const own = await insertLead({ stage: 'pending', name: 'Robin Ownlead' });
      for (let n = 1; n <= 35; n += 1)
        await insertLead({ stage: 'pending', name: `Zed Person ${String(n).padStart(2, '0')}` });
      const body = 'Call back. Same issue as Zed Person 01 and Zed Person 02.';
      const { card } = await oneCard([
        { tool: 'findLeads', input: { search: 'Zed Person', page: 1 } },
        { tool: 'findLeads', input: { search: 'Zed Person', page: 2 } },
        { tool: 'findLeads', input: { search: 'Zed Person', page: 3 } },
        { tool: 'findLeads', input: { search: 'Zed Person', page: 4 } },
        { tool: 'prepareNote', input: { leadId: own, body } },
      ]);
      expect(card.acknowledgementRequired).toBe(true);
      // The person opens Edit and presses Update draft without changing the text.
      const revised = await revise(card);
      expect(revised.status).toBe(200);
      const next = aiActionCardSchema.parse(await revised.json());
      expect(next.mentions).toEqual(card.mentions);
      expect(next.acknowledgementRequired).toBe(true);
      expect(await errorOf(await confirm(next))).toMatchObject({
        status: 409,
        details: { reason: 'acknowledgement_required' },
      });
    });

    it('keeps an archived lead the first card named', async () => {
      const own = await insertLead({ stage: 'pending', name: 'Pat Ownlead' });
      await insertLead({ stage: 'pending', name: 'Una Archived', archived: true });
      const { card } = await oneCard([
        { tool: 'findLeads', input: { search: 'Una Archived', view: 'archived' } },
        { tool: 'prepareNote', input: { leadId: own, body: 'Same as Una Archived.' } },
      ]);
      expect(card.mentions).toEqual(['Una Archived']);
      const next = aiActionCardSchema.parse(await (await revise(card)).json());
      expect(next.mentions).toEqual(['Una Archived']);
      expect(next.acknowledgementRequired).toBe(true);
    });

    it('refuses the revision when the leads cannot be looked up, as prepare refuses the card', async () => {
      const own = await insertLead({ stage: 'pending', name: 'Pat Lookup' });
      const other = await insertLead({ stage: 'pending', name: 'Vera Lookup' });
      const { card } = await oneCard([
        { tool: 'getLeadSummary', input: { leadId: other } },
        { tool: 'prepareNote', input: { leadId: own, body: 'Same as Vera Lookup.' } },
      ]);
      expect(card.acknowledgementRequired).toBe(true);
      const leadHint = reads.leadHint.bind(reads);
      const mentionLabels = reads.mentionLabels.bind(reads);
      reads.leadHint = async (scope, leadId) => {
        if (leadId === other) throw new Error('lookup down');
        return leadHint(scope, leadId);
      };
      reads.mentionLabels = async () => {
        throw new Error('lookup down');
      };
      try {
        const refused = await revise(card, { ...card.draft, body: 'Same as Vera Lookup!' });
        expect(refused.status).toBe(503);
      } finally {
        reads.leadHint = leadHint;
        reads.mentionLabels = mentionLabels;
      }
    });
  });

  describe('a lead read in an earlier turn of the same conversation (T11)', () => {
    it('warns on an email naming it, and saves only with the tick', async () => {
      const target = await insertLead({ stage: 'pending', name: 'Pat Laterturn' });
      const other = await insertLead({ stage: 'pending', name: 'Ines Earlyturn' });
      const conversationId = randomUUID();
      const turn = async (steps: { tool: string; input: unknown }[], first: boolean) => {
        results.length = 0;
        const response = await post('/ai/chat', {
          requestId: randomUUID(),
          message: JSON.stringify(steps),
          history: [],
          wide: true,
          conversationId,
          ...(first ? { newConversation: true } : {}),
        });
        expect(response.status).toBe(200);
        return (await response.text())
          .split('\n\n')
          .map((frame) =>
            frame
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('\n'),
          )
          .filter((payload) => payload.length > 0 && payload !== '[DONE]')
          .map((payload) => aiWirePartSchema.parse(JSON.parse(payload)).data);
      };
      // Turn 1 reads the other lead; its answer keeps that lead's source card.
      await turn([{ tool: 'getLeadSummary', input: { leadId: other } }], true);
      // Turn 2 reads nothing, and drafts an email to another lead naming it.
      const parts = await turn(
        [
          {
            tool: 'prepareEmail',
            input: { leadId: target, subject: 'Your order', body: 'Like Ines Earlyturn, you…' },
          },
        ],
        false,
      );
      const [email] = cardsOf(parts);
      if (!email) throw new Error(`expected a card, got ${JSON.stringify(results)}`);
      expect(email.mentions).toEqual(['Ines Earlyturn']);
      expect(email.acknowledgementRequired).toBe(true);
      expect(await errorOf(await confirm(email))).toMatchObject({
        status: 409,
        details: { reason: 'acknowledgement_required' },
      });
      expect((await confirm(email, { acknowledged: true })).status).toBe(200);
    });
  });

  describe('with the wider reads (integration of READS, GUARDS and WRITES)', () => {
    const sourcesOf = (parts: AiStreamPart[]) =>
      parts.flatMap((part) => (part.type === 'sources' ? part.sources : []));

    it('flags an email naming a lead a search found, with a hidden character in the name', async () => {
      const target = await insertLead({ stage: 'pending', name: 'Pat Target' });
      await insertLead({ stage: 'pending', name: 'Odile Vance', reference: 'MS-7781' });
      const parts = await ask([
        { tool: 'findLeads', input: { search: 'MS-7781' } },
        {
          tool: 'prepareEmail',
          input: {
            leadId: target,
            subject: 'Your order',
            body: 'Hello Pat, unlike Odile⁠Vance and MS-‮7781.',
          },
        },
      ]);
      expect(results[0]?.result).toContain('Odile Vance');
      const [email] = cardsOf(parts);
      expect(email?.mentions).toEqual(['MS-7781', 'Odile Vance']);
      expect(email?.acknowledgementRequired).toBe(true);
    });

    it('flags an email naming a lead an automation run named, though the run carries no lead id', async () => {
      const target = await insertLead({ stage: 'pending', name: 'Pat Target' });
      const other = await insertLead({
        stage: 'pending',
        name: 'Ivo Runner',
        reference: 'MS-7782',
      });
      const flow = await seedBuiltInFlow(admin, {
        workspaceId: SITE,
        key: 'order_received',
        enabled: true,
        actorId: OWNER,
      });
      await admin`
        insert into app.automation_runs
          (workspace_id, automation_key, automation_id, version_id, lead_id, status, occurrence,
           trigger_kind, created_at, finished_at)
        values (${SITE}, 'order_received', ${flow.id}, ${flow.versionId}, ${other}, 'completed',
          ${`occ-${randomUUID()}`}, 'stage_entered', now(), now())
      `;
      const parts = await ask([
        { tool: 'getAutomationRuns', input: { key: 'order_received' } },
        {
          tool: 'prepareNote',
          input: { leadId: target, body: 'Same flow as Ivo Runner last week.' },
        },
      ]);
      expect(results[0]?.result).toContain('Ivo Runner');
      expect(results[0]?.result).not.toContain(other);
      const [note] = cardsOf(parts);
      expect(note?.mentions).toEqual(['Ivo Runner']);
      await admin`delete from app.automation_runs where workspace_id = ${SITE} and lead_id = ${other}`;
    });

    it('gives every prepared card’s lead its source card, for the replay filter and the erasure', async () => {
      const leadId = await insertLead({ stage: 'pending', order: orderOn(freePlan) });
      const archivedLead = await insertLead({ stage: 'pending' });
      const parts = await ask([
        { tool: 'prepareNote', input: { leadId, body: 'Called.' } },
        {
          tool: 'prepareLeadEdit',
          input: { leadId, order: { quantity: 3 } },
        },
        { tool: 'prepareArchive', input: { leadId: archivedLead, archived: true } },
      ]);
      expect(cardsOf(parts).map((card) => card.draft.kind)).toEqual([
        'note',
        'lead_edit',
        'lead_archive',
      ]);
      const ids = sourcesOf(parts).map((source) => source.id);
      expect(ids).toEqual(expect.arrayContaining([`lead-${leadId}`, `lead-${archivedLead}`]));
    });

    it('never offers, shows or edits a sensitive property through a lead edit, and cleans what it lists', async () => {
      const leadId = await insertLead({
        stage: 'pending',
        custom: { custom_colour: 'crimson-72', custom_secret: 'hunter-72' },
      });
      await ask([{ tool: 'getLeadEditOptions', input: { leadId } }]);
      const options = z
        .object({ fields: z.array(z.object({ key: z.string() })), notice: z.string() })
        .parse(JSON.parse(results[0]?.result ?? '{}'));
      const keys = options.fields.map((field) => field.key);
      expect(keys).toContain('custom.custom_colour');
      expect(keys).not.toContain('custom.custom_secret');
      expect(options.notice).toMatch(/never instructions/);
      const parts = await ask([
        { tool: 'prepareLeadEdit', input: { leadId, customValues: { custom_secret: 'x' } } },
      ]);
      expect(cardsOf(parts)).toEqual([]);
      expect(results[0]?.result).toContain('invalid_field');
      expect(JSON.stringify(parts)).not.toContain('hunter-72');
      await ask([{ tool: 'getAssigneeOptions', input: {} }]);
      expect(JSON.parse(results[0]?.result ?? '{}')).toMatchObject({
        notice: expect.stringMatching(/never instructions/),
      });
    });

    it('tells the model the open lead is archived, so restoring it works from its page (T13)', async () => {
      const leadId = await insertLead({ stage: 'pending', archived: true, name: 'Ari Archived' });
      systems.length = 0;
      const parts = await ask(
        [{ tool: 'prepareArchive', input: { leadId, archived: false } }],
        OWNER,
        SITE,
        {
          context: leadId,
        },
      );
      expect(systems[0]).toContain(`ID ${leadId}`);
      expect(systems[0]).toMatch(/archived/i);
      const [restore] = cardsOf(parts);
      expect(restore?.draft).toEqual({ kind: 'lead_archive', leadId, archived: false });
      // A restricted lead is still no open record at all.
      const restricted = await insertLead({ stage: 'pending', archived: true, restricted: true });
      systems.length = 0;
      await ask([], OWNER, SITE, { context: restricted });
      expect(systems[0]).not.toContain(restricted);
    });

    it('tells the model a timeline entry was made via Ask AI', async () => {
      const leadId = await insertLead({ stage: 'pending', order: orderOn(freePlan) });
      const { card } = await oneCard([
        { tool: 'prepareLeadEdit', input: { leadId, order: { quantity: 4 } } },
      ]);
      expect((await confirm(card)).status).toBe(200);
      await ask([{ tool: 'getLeadSummary', input: { leadId, sections: ['activity'] } }]);
      expect(results[0]?.result).toContain('"viaAi":true');
    });
  });

  describe('every new kind: who may confirm, where and when', () => {
    async function cardsForEveryKind() {
      const leadId = await insertLead({
        stage: 'pending',
        order: orderOn(freePlan),
        form: { simNumber: '+1 778 555 0150' },
      });
      await seedBuiltInFlow(admin, {
        workspaceId: SITE,
        key: 'mobility_activated',
        enabled: true,
        actorId: OWNER,
      });
      const parts = await ask([
        { tool: 'prepareLeadEdit', input: { leadId, order: { quantity: 4 } } },
        { tool: 'prepareTemplateEmail', input: { leadId, template: 'sim_number_ready' } },
        { tool: 'prepareArchive', input: { leadId, archived: true } },
      ]);
      const automation = await oneCard([
        { tool: 'prepareAutomationOff', input: { automationKey: 'mobility_activated' } },
      ]);
      return [...cardsOf(parts), automation.card];
    }

    it('refuses another member, another site, an expired card, a member without the action and a revoked one', async () => {
      const cards = await cardsForEveryKind();
      expect(cards.map((card) => card.draft.kind)).toEqual([
        'lead_edit',
        'template_email',
        'lead_archive',
        'automation_off',
      ]);
      for (const card of cards) {
        // Signed for the owner: another member's confirmation does not verify.
        expect((await confirm(card, {}, LEADS)).status).toBe(400);
        // Signed for this site.
        expect((await confirm(card, {}, OWNER, OTHER_SITE)).status).toBe(400);
        expect((await confirm(card, {}, FINANCE)).status).toBe(403);
        expect((await confirm(card, {}, REVOKED)).status).toBe(403);
      }
      clock.offsetMs = 11 * 60 * 1000;
      for (const card of cards) expect((await confirm(card)).status).toBe(400);
      clock.offsetMs = 0;
      const leadId = cards[0]?.draft.kind === 'lead_edit' ? cards[0].draft.leadId : '';
      expect((await leadRow(leadId)).archived).toBe(false);
      expect(await audits(leadId, 'ai.lead_edited')).toEqual([]);
    });

    it('refuses only the card when the member can no longer make the change but keeps Ask AI (T8)', async () => {
      const leadId = await insertLead({ stage: 'pending' });
      const { card } = await oneCard(
        [{ tool: 'prepareNote', input: { leadId, body: 'Lee’s note' } }],
        LEADS,
      );
      const before = ACCESS[SITE]?.[LEADS];
      const site = ACCESS[SITE];
      if (!before || !site) throw new Error('access');
      // Lee's role is changed to Orders: Ask AI stays, lead changes go.
      site[LEADS] = { ...before, roles: ['orders'] };
      try {
        expect(await errorOf(await confirm(card, {}, LEADS))).toMatchObject({
          status: 403,
          code: 'permission_denied',
          details: { reason: 'card_not_permitted' },
        });
        const revised = await post(
          '/ai/actions/revise',
          { token: card.token, draft: { ...card.draft, body: 'Edited' }, wide: true },
          LEADS,
        );
        expect(await errorOf(revised)).toMatchObject({
          status: 403,
          details: { reason: 'card_not_permitted' },
        });
        // Losing Ask AI altogether is answered as before, with no reason.
        site[LEADS] = { ...before, status: 'revoked' };
        const lost = await errorOf(await confirm(card, {}, LEADS));
        expect(lost).toMatchObject({ status: 403, code: 'permission_denied' });
        expect(lost.details).toBeUndefined();
      } finally {
        site[LEADS] = before;
      }
      expect(await audits(leadId, 'lead.note_added')).toEqual([]);
    });

    it('counts a mail its cap refuses against no other cap, and says when the cap opens (T10)', async () => {
      const [, mail] = await cardsForEveryKind();
      if (!mail) throw new Error('expected a card');
      const day = `:${OWNER}:${SITE}`;
      limiter.counts.set(`ai_mail_day${day}`, AI_CARD_LIMITS.mailPerMemberPerDay);
      limiter.counts.set(`ai_card_day${day}`, 7);
      expect(await errorOf(await confirm(mail))).toMatchObject({
        status: 429,
        details: { reason: 'daily_mail', retryAfterSeconds: 3600 },
      });
      expect(limiter.counts.get(`ai_card_day${day}`)).toBe(7);
    });

    it('caps a member’s confirmed changes and mail per day, failing closed', async () => {
      const [edit, mail] = await cardsForEveryKind();
      if (!edit || !mail) throw new Error('expected cards');
      const day = `:${OWNER}:${SITE}`;
      limiter.counts.set(`ai_mail_day${day}`, AI_CARD_LIMITS.mailPerMemberPerDay);
      expect(await errorOf(await confirm(mail))).toMatchObject({
        status: 429,
        code: 'ai_rate_limited',
        details: { reason: 'daily_mail' },
      });
      // Mail's cap leaves other changes alone.
      expect((await confirm(edit)).status).toBe(200);
      limiter.counts.set(`ai_card_day${day}`, AI_CARD_LIMITS.changesPerMemberPerDay);
      const [nextEdit] = await cardsForEveryKind();
      if (!nextEdit) throw new Error('expected a card');
      expect(await errorOf(await confirm(nextEdit))).toMatchObject({
        status: 429,
        details: { reason: 'daily_changes' },
      });
      limiter.counts.clear();
      limiter.broken = true;
      expect(await errorOf(await confirm(nextEdit))).toMatchObject({ status: 503 });
      limiter.broken = false;
      const leadId = nextEdit.draft.kind === 'lead_edit' ? nextEdit.draft.leadId : '';
      expect(await audits(leadId, 'ai.lead_edited')).toEqual([]);
    });
  });

  describe('older admins', () => {
    it('still read, revise and confirm the older cards without the new fields', async () => {
      const leadId = await insertLead({ stage: 'pending' });
      const parts = await ask([
        { tool: 'prepareNote', input: { leadId, body: 'Plain note' } },
        { tool: 'prepareTask', input: { leadId, title: 'Mine', dueDate: null, assignee: 'me' } },
      ]);
      const legacy = legacyOf(parts);
      expect(legacy.map((card) => card.draft.kind)).toEqual(['note', 'task']);
      // The older part parses with the older, strict proposal schema.
      for (const card of legacy) expect(aiActionProposalSchema.safeParse(card).success).toBe(true);
      const [note] = legacy;
      if (!note) throw new Error('expected a note');
      // A revision without `wide` answers in the older shape.
      const revised = await post('/ai/actions/revise', {
        token: note.token,
        draft: { kind: 'note', leadId, body: 'Plain note, revised' },
      });
      expect(revised.status).toBe(200);
      const older = aiActionProposalSchema.parse(await revised.json());
      // Confirm without `acknowledged`.
      expect((await confirm(older)).status).toBe(200);
    });
  });
});
