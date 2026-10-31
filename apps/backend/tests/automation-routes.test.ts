import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_AUTOMATION_KEYS,
  apiErrorResponseSchema,
  builtInFlowDefinition,
  builtInFlowName,
  flowCatalogResponseSchema,
  flowDetailResponseSchema,
  flowListResponseSchema,
  flowRunResponseSchema,
  flowToggleResponseSchema,
  flowVersionResponseSchema,
  listFlowRunsResponseSchema,
  type AutomationKey,
  type FlowDefinition,
  type FlowRun,
  type StaffWorkspace,
} from '@gt-sales/contracts';
import type { StaffRoleName } from '@gt-sales/types';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { FlowDetail, FlowStore, StoredFlow } from '../src/automations/flow-store.js';
import type { CustomerEmailEnvironment } from '../src/email/senders.js';
import type { LeadStore } from '../src/leads/store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000e61';
const WORKSPACE = '10000000-0000-4000-8000-000000000e61';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000e61';
const LEAD = '40000000-0000-4000-8000-000000000e61';
const RUN = '50000000-0000-4000-8000-000000000e61';
const NOW = new Date('2026-10-30T12:00:00.000Z');

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'getcanadasim',
  name: 'Get Canada Sim',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

class TokenVerifier implements StaffSessionVerifier {
  readonly sessions = new Map<string, VerifiedStaffSession>([
    ['token', { actorId: ACTOR, verifiedEmail: 'owner@example.test' }],
  ]);
  async verify(accessToken: string) {
    return this.sessions.get(accessToken);
  }
}

class MemoryStaffStore implements StaffStore {
  access: StaffAccessSnapshot = {
    membershipId: MEMBERSHIP,
    status: 'active',
    roles: ['owner'],
    permissions: [],
  };
  setDisplayName = vi.fn(async () => 1);
  async bootstrapStaff() {
    return [workspace];
  }
  async loadStaffAccess(actorId: string, workspaceId: string) {
    return actorId === ACTOR && workspaceId === WORKSPACE ? this.access : undefined;
  }
  async inviteStaff(): Promise<string> {
    throw new Error('unused');
  }
  async revokeStaff() {
    return 'not_found' as const;
  }
  async listAssignableMembers() {
    return [];
  }
}

const unusedLeadStore: LeadStore = {
  readLead: async () => ({ status: 'grant_invalid' }),
  createLead: () => {
    throw new Error('unused');
  },
  updateLead: () => {
    throw new Error('unused');
  },
  listLeads: () => {
    throw new Error('unused');
  },
};

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

const emailEnvironment: CustomerEmailEnvironment = {
  providerReady: true,
  contactHash: () => {
    throw new Error('unused');
  },
};

const FLOW = 'flow_abcdefghij012345';
const RUN_VERSION_AT = new Date('2026-10-29T12:00:00.000Z');

const emailOnly: FlowDefinition = {
  schemaVersion: 1,
  trigger: { kind: 'stage_entered', leadType: 'sim_order', stage: 'verified', when: null },
  steps: [{ id: 's_mail', kind: 'send_email', template: 'activated' }],
};

function storedFlow(key: AutomationKey, overrides: Partial<StoredFlow> = {}): StoredFlow {
  const builtIn = BUILT_IN_AUTOMATION_KEYS.find((entry) => entry === key);
  return {
    id: '60000000-0000-4000-8000-000000000e61',
    key,
    origin: builtIn ? 'builtin' : 'custom',
    name: builtIn ? builtInFlowName(builtIn) : 'Verified follow-up',
    description: null,
    enabled: false,
    archived: false,
    revision: 2,
    activeVersion: {
      id: '70000000-0000-4000-8000-000000000e61',
      version: 1,
      definition: builtIn ? builtInFlowDefinition(builtIn) : emailOnly,
      activatedAt: RUN_VERSION_AT,
      activatedBy: builtIn ? null : ACTOR,
    },
    draft: null,
    lastRunAt: null,
    runCount: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function detailOf(flow: StoredFlow): FlowDetail {
  return {
    flow,
    needsAttention: null,
    draft: null,
    active: flow.activeVersion
      ? { version: flow.activeVersion.version, definition: emailOnly }
      : null,
    versions: [
      {
        version: 1,
        status: 'active',
        activatedAt: RUN_VERSION_AT.toISOString(),
        activatedBy: ACTOR,
      },
    ],
  };
}

const run = (leadName: string | null): FlowRun => ({
  id: RUN,
  leadId: LEAD,
  leadName,
  status: 'completed',
  reason: null,
  detail: null,
  triggerKind: 'stage_entered',
  version: 1,
  startedAt: NOW.toISOString(),
  finishedAt: NOW.toISOString(),
  resumeAt: null,
  legacy: false,
  steps: [],
});

function memoryFlowStore() {
  const ok = async (_ctx: unknown, key: AutomationKey) => ({
    status: 'ok' as const,
    value: storedFlow(key),
  });
  return {
    list: vi.fn<FlowStore['list']>(async () => ({
      flows: [
        ...BUILT_IN_AUTOMATION_KEYS.map((key) =>
          storedFlow(key, { enabled: key === 'order_received' }),
        ),
        storedFlow(FLOW),
      ],
      needsAttention: new Map([
        [FLOW, { path: 'trigger.stage', code: 'stage_unavailable' as const, ref: 'paid' }],
      ]),
      warnings: [],
      nextBefore: null,
    })),
    get: vi.fn<FlowStore['get']>(async (_ctx, key) => storedFlow(key)),
    create: vi.fn<FlowStore['create']>(async () => ({ status: 'ok', value: storedFlow(FLOW) })),
    updateDetails: vi.fn<FlowStore['updateDetails']>(ok),
    setEnabled: vi.fn<FlowStore['setEnabled']>(async (_ctx, key, enabled) => ({
      status: 'ok',
      value: storedFlow(key, { enabled }),
    })),
    archive: vi.fn<FlowStore['archive']>(ok),
    restore: vi.fn<FlowStore['restore']>(ok),
    listRuns: vi.fn<FlowStore['listRuns']>(async (_ctx, _key, options) => ({
      runs: [run(options.includeLeadNames ? 'Ada Lovelace' : null)],
      nextBefore: null,
    })),
    getRun: vi.fn<FlowStore['getRun']>(async (_ctx, _key, runId, options) =>
      runId === RUN ? run(options.includeLeadNames ? 'Ada Lovelace' : null) : undefined,
    ),
    saveDraft: vi.fn<FlowStore['saveDraft']>(async (_ctx, key) => ({
      status: 'ok',
      value: { flow: storedFlow(key), issues: [] },
    })),
    discardDraft: vi.fn<FlowStore['discardDraft']>(ok),
    activate: vi.fn<FlowStore['activate']>(ok),
    reset: vi.fn<FlowStore['reset']>(ok),
    getVersion: vi.fn<FlowStore['getVersion']>(async (_ctx, _key, version) =>
      version === 1
        ? {
            version: 1,
            status: 'active',
            definition: { as: 'stored' },
            activatedAt: RUN_VERSION_AT,
            activatedBy: ACTOR,
            createdAt: NOW,
          }
        : undefined,
    ),
    versions: vi.fn<FlowStore['versions']>(async () => []),
    catalog: vi.fn<FlowStore['catalog']>(async () => ({
      leadTypes: [],
      templates: [],
      members: [],
      plans: [],
      properties: [],
      taskVariables: [],
    })),
    detail: vi.fn<FlowStore['detail']>(async (_ctx, key) =>
      key === 'flow_zzzzzzzzzzzzzzzz' ? undefined : detailOf(storedFlow(key)),
    ),
  } satisfies FlowStore;
}

let server: Server;
let baseUrl: string;
let staff: MemoryStaffStore;
let flows: ReturnType<typeof memoryFlowStore>;
let senderReady: boolean;
const available = vi.fn();

function appWith(customerEmail: boolean) {
  return createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store: staff,
      credentialStore: noopCredentialStore,
      leadStore: unusedLeadStore,
      flowStore: flows,
      ...(customerEmail ? { customerEmail: { environment: emailEnvironment, available } } : {}),
    },
  });
}

beforeEach(async () => {
  staff = new MemoryStaffStore();
  flows = memoryFlowStore();
  senderReady = true;
  available.mockReset();
  available.mockImplementation(async () => senderReady);
  server = appWith(true).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const automationsUrl = (suffix = '') =>
  `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/automations${suffix}`;

function call(url: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.token === undefined ? { authorization: 'Bearer token' } : {}),
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function errorOf(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

const asRole = (role: StaffRoleName) => {
  staff.access = { ...staff.access, roles: [role], permissions: [] };
};

const ownerScope = { workspaceId: WORKSPACE, actorId: ACTOR };
const writeScope = { ...ownerScope, requestId: expect.any(String) };

/** Every flow-changing route, with a body it accepts. */
const changes: { method: string; suffix: string; body?: unknown; store: keyof FlowStore }[] = [
  {
    method: 'PATCH',
    suffix: `/${FLOW}`,
    body: { expectedRevision: 2, name: 'New' },
    store: 'updateDetails',
  },
  { method: 'PUT', suffix: `/${FLOW}`, body: { enabled: true }, store: 'setEnabled' },
  {
    method: 'PUT',
    suffix: `/${FLOW}/draft`,
    body: { expectedRevision: 2, definition: { schemaVersion: 1, trigger: null, steps: [] } },
    store: 'saveDraft',
  },
  { method: 'POST', suffix: `/${FLOW}/draft/discard`, store: 'discardDraft' },
  { method: 'POST', suffix: `/${FLOW}/activate`, body: { expectedRevision: 2 }, store: 'activate' },
  { method: 'POST', suffix: '/order_received/reset', store: 'reset' },
  { method: 'POST', suffix: `/${FLOW}/archive`, store: 'archive' },
  { method: 'POST', suffix: `/${FLOW}/restore`, store: 'restore' },
];

describe('staff automation flow routes', () => {
  it('GET /automations: every role that reads the site sees the flows, chips and limit', async () => {
    for (const role of ['viewer', 'leads', 'orders', 'finance', 'owner'] as const) {
      asRole(role);
      const response = await call(automationsUrl());
      expect(response.status, role).toBe(200);
      const body = flowListResponseSchema.parse(await response.json());
      expect(body.automations.map(({ key }) => key)).toEqual([...BUILT_IN_AUTOMATION_KEYS, FLOW]);
      expect(body.canManage, role).toBe(role === 'owner');
      expect(body).toMatchObject({ hasSender: true, limit: 50, nextBefore: null, warnings: [] });
      expect(body.automations[0]).toMatchObject({
        key: 'order_received',
        origin: 'builtin',
        enabled: true,
        activeVersion: 1,
        trigger: builtInFlowDefinition('order_received').trigger,
        needsAttention: null,
      });
      expect(body.automations[6]?.needsAttention).toEqual({
        path: 'trigger.stage',
        code: 'stage_unavailable',
        ref: 'paid',
      });
    }
    expect(flows.list).toHaveBeenLastCalledWith(
      { ...ownerScope, requestId: expect.any(String) },
      { archived: false },
    );
  });

  it('GET /automations: archived=1 and before pass through; a bad query is 400', async () => {
    await call(automationsUrl(`?archived=1&before=${FLOW}`));
    expect(flows.list).toHaveBeenLastCalledWith(writeScope, { archived: true, before: FLOW });
    for (const query of ['?archived=yes', '?before=order_received', '?other=1']) {
      const response = await call(automationsUrl(query));
      expect(response.status, query).toBe(400);
    }
  });

  it('GET /automations: hasSender follows the customer email dependency; none without mail', async () => {
    senderReady = false;
    const response = await call(automationsUrl());
    expect(flowListResponseSchema.parse(await response.json()).hasSender).toBe(false);
    expect(available).toHaveBeenCalledWith(writeScope);

    const bare = appWith(false).listen(0);
    try {
      await new Promise<void>((resolve) => bare.once('listening', resolve));
      const address = bare.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP server');
      const answer = await call(
        `http://127.0.0.1:${address.port}/api/v1/staff/workspaces/${WORKSPACE}/automations`,
      );
      expect(flowListResponseSchema.parse(await answer.json()).hasSender).toBe(false);
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });

  it('GET /automations: refuses a revoked member, a bad site id and a missing session', async () => {
    staff.access = { ...staff.access, status: 'revoked' };
    expect((await call(automationsUrl())).status).toBe(403);
    expect(flows.list).not.toHaveBeenCalled();
    expect((await call(`${baseUrl}/api/v1/staff/workspaces/nope/automations`)).status).toBe(400);
    expect((await call(automationsUrl(), { token: 'none' })).status).toBe(401);
  });

  it('a viewer reads every flow route but changes none', async () => {
    asRole('viewer');
    for (const [suffix, schema] of [
      ['/catalog', flowCatalogResponseSchema],
      [`/${FLOW}`, flowDetailResponseSchema],
      [`/${FLOW}/versions/1`, flowVersionResponseSchema],
      [`/${FLOW}/runs`, listFlowRunsResponseSchema],
      [`/${FLOW}/runs/${RUN}`, flowRunResponseSchema],
    ] as const) {
      const response = await call(automationsUrl(suffix));
      expect(response.status, suffix).toBe(200);
      const json: unknown = await response.json();
      expect(() => schema.parse(json), suffix).not.toThrow();
    }
    const create = await call(automationsUrl(), { method: 'POST', body: { name: 'Mine' } });
    expect(create.status).toBe(403);
    for (const change of changes) {
      const response = await call(automationsUrl(change.suffix), {
        method: change.method,
        body: change.body,
      });
      expect(response.status, `${change.method} ${change.suffix}`).toBe(403);
      expect((await errorOf(response)).code).toBe('permission_denied');
    }
    for (const change of changes) expect(flows[change.store]).not.toHaveBeenCalled();
    expect(flows.create).not.toHaveBeenCalled();
  });

  it('each read answers its contracts shape', async () => {
    const detail = await call(automationsUrl(`/${FLOW}`));
    const parsed = flowDetailResponseSchema.parse(await detail.json());
    expect(parsed).toMatchObject({ revision: 2, canManage: true, active: { version: 1 } });
    expect(flows.detail).toHaveBeenLastCalledWith(writeScope, FLOW);

    const catalog = await call(automationsUrl('/catalog'));
    expect(flowCatalogResponseSchema.parse(await catalog.json()).taskVariables).toEqual([]);
    // The catalogue is not mistaken for a key.
    expect(flows.detail).toHaveBeenCalledTimes(1);
    expect(flows.catalog).toHaveBeenCalledTimes(1);

    const version = await call(automationsUrl(`/${FLOW}/versions/1`));
    expect(flowVersionResponseSchema.parse(await version.json()).version).toMatchObject({
      version: 1,
      definition: { as: 'stored' },
    });
    const missing = await call(automationsUrl(`/${FLOW}/versions/2`));
    expect(missing.status).toBe(404);
    expect((await errorOf(missing)).code).toBe('automation_version_not_found');
    expect((await call(automationsUrl(`/${FLOW}/versions/zero`))).status).toBe(400);

    const one = await call(automationsUrl(`/${FLOW}/runs/${RUN}`));
    expect(flowRunResponseSchema.parse(await one.json()).run.id).toBe(RUN);
    const noRun = await call(automationsUrl(`/${FLOW}/runs/${LEAD}`));
    expect(noRun.status).toBe(404);
    expect((await errorOf(noRun)).code).toBe('automation_run_not_found');

    const gone = await call(automationsUrl('/flow_zzzzzzzzzzzzzzzz'));
    expect(gone.status).toBe(404);
    expect((await errorOf(gone)).code).toBe('automation_not_found');
  });

  it('an unknown key is 404 only after the permission', async () => {
    asRole('viewer');
    const refused = await call(automationsUrl('/nope/draft'), {
      method: 'PUT',
      body: { expectedRevision: 0, definition: { schemaVersion: 1, trigger: null, steps: [] } },
    });
    expect(refused.status).toBe(403);
    // A reader gets 404 for a key that cannot exist.
    const unknownRead = await call(automationsUrl('/nope'));
    expect(unknownRead.status).toBe(404);
    expect((await errorOf(unknownRead)).code).toBe('automation_not_found');

    asRole('owner');
    for (const change of changes) {
      const response = await call(
        automationsUrl(change.suffix.replace(FLOW, 'nope').replace('order_received', 'nope')),
        { method: change.method, body: change.body },
      );
      expect(response.status, change.suffix).toBe(404);
      expect((await errorOf(response)).code).toBe('automation_not_found');
    }
    for (const change of changes) expect(flows[change.store]).not.toHaveBeenCalled();
  });

  it('a bad body is 400 before anything else', async () => {
    for (const [method, suffix, body] of [
      ['POST', '', { name: '' }],
      ['POST', '', { name: 'x'.repeat(81) }],
      ['POST', '', { name: 'Mine', extra: true }],
      ['PUT', `/${FLOW}`, { enabled: 'yes' }],
      ['PATCH', `/${FLOW}`, { name: 'No revision' }],
      ['PUT', `/${FLOW}/draft`, { expectedRevision: 0, definition: { schemaVersion: 2 } }],
      ['POST', `/${FLOW}/activate`, {}],
    ] as const) {
      const response = await call(automationsUrl(suffix), { method, body });
      expect(response.status, `${method} ${suffix}`).toBe(400);
      expect((await errorOf(response)).code).toBe('invalid_request');
    }
  });

  it('the owner makes every change, each answered with the flow page', async () => {
    const created = await call(automationsUrl(), {
      method: 'POST',
      body: { name: '  Verified follow-up ' },
    });
    expect(created.status).toBe(201);
    expect(flowDetailResponseSchema.parse(await created.json()).automation.key).toBe(FLOW);
    expect(flows.create).toHaveBeenCalledWith(writeScope, { name: 'Verified follow-up' });

    for (const change of changes) {
      const response = await call(automationsUrl(change.suffix), {
        method: change.method,
        body: change.body,
      });
      expect(response.status, `${change.method} ${change.suffix}`).toBe(200);
      const json: unknown = await response.json();
      if (change.store === 'setEnabled') {
        expect(flowToggleResponseSchema.parse(json).automation.key).toBe(FLOW);
      } else {
        expect(flowDetailResponseSchema.parse(json).revision).toBe(2);
      }
      expect(flows[change.store]).toHaveBeenCalledTimes(1);
    }
    expect(flows.activate).toHaveBeenCalledWith(writeScope, FLOW, {
      expectedRevision: 2,
      mayChangeLeads: true,
    });
    expect(flows.setEnabled).toHaveBeenCalledWith(writeScope, FLOW, true);
  });

  it('integration management without lead.manage activates an email-only flow, not a lead-changing one', async () => {
    staff.access = {
      ...staff.access,
      roles: ['viewer'],
      permissions: [{ name: 'integration_management', effect: 'allow' }],
    };
    const emailOnlyResponse = await call(automationsUrl(`/${FLOW}/activate`), {
      method: 'POST',
      body: { expectedRevision: 2 },
    });
    expect(emailOnlyResponse.status).toBe(200);
    expect(flows.activate).toHaveBeenLastCalledWith(writeScope, FLOW, {
      expectedRevision: 2,
      mayChangeLeads: false,
    });

    flows.activate.mockResolvedValueOnce({ status: 'needs_lead_manage' });
    const refused = await call(automationsUrl(`/${FLOW}/activate`), {
      method: 'POST',
      body: { expectedRevision: 2 },
    });
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).code).toBe('activation_needs_lead_manage');

    // With the Leads role as well, the store is told the caller may change leads.
    staff.access = {
      ...staff.access,
      roles: ['leads'],
      permissions: [{ name: 'integration_management', effect: 'allow' }],
    };
    await call(automationsUrl(`/${FLOW}/activate`), {
      method: 'POST',
      body: { expectedRevision: 2 },
    });
    expect(flows.activate).toHaveBeenLastCalledWith(writeScope, FLOW, {
      expectedRevision: 2,
      mayChangeLeads: true,
    });
  });

  it('every store refusal has its code', async () => {
    const cases = [
      [{ status: 'not_found' }, 404, 'automation_not_found'],
      [{ status: 'revision_conflict' }, 409, 'revision_conflict'],
      [{ status: 'no_active_version' }, 409, 'no_active_version'],
      [{ status: 'not_builtin' }, 409, 'automation_not_builtin'],
      [{ status: 'builtin' }, 409, 'automation_builtin'],
      [{ status: 'archived' }, 409, 'automation_archived'],
      [{ status: 'limit_reached' }, 409, 'automation_limit_reached'],
    ] as const;
    for (const [outcome, status, code] of cases) {
      flows.reset.mockResolvedValueOnce(outcome);
      const response = await call(automationsUrl('/order_received/reset'), { method: 'POST' });
      expect(response.status, code).toBe(status);
      expect((await errorOf(response)).code).toBe(code);
    }
    flows.create.mockResolvedValueOnce({ status: 'limit_reached' });
    const limit = await call(automationsUrl(), { method: 'POST', body: { name: 'One more' } });
    expect(limit.status).toBe(409);
    expect((await errorOf(limit)).code).toBe('automation_limit_reached');

    const issue = { path: 'steps.0.template', code: 'template_unavailable', ref: 'tpl_x' } as const;
    flows.activate.mockResolvedValueOnce({ status: 'invalid', issues: [issue] });
    const siteIssues = await call(automationsUrl(`/${FLOW}/activate`), {
      method: 'POST',
      body: { expectedRevision: 2 },
    });
    expect(siteIssues.status).toBe(400);
    const siteError = await errorOf(siteIssues);
    expect(siteError.code).toBe('flow_invalid');
    expect(siteError.details).toEqual({ issues: [issue] });

    flows.saveDraft.mockResolvedValueOnce({ status: 'invalid', issues: ['stage_unavailable'] });
    const structure = await call(automationsUrl(`/${FLOW}/draft`), {
      method: 'PUT',
      body: { expectedRevision: 2, definition: { schemaVersion: 1, trigger: null, steps: [] } },
    });
    expect(structure.status).toBe(400);
    expect((await errorOf(structure)).details).toEqual({ problems: ['stage_unavailable'] });
  });

  it('runs: before passes through and lead names only for roles that see contacts', async () => {
    const expectations = [
      ['viewer', null],
      ['partners', null],
      ['content', null],
      ['leads', 'Ada Lovelace'],
      ['orders', 'Ada Lovelace'],
      ['finance', 'Ada Lovelace'],
      ['owner', 'Ada Lovelace'],
    ] as const;
    for (const [role, leadName] of expectations) {
      asRole(role);
      const response = await call(automationsUrl(`/order_received/runs?before=${RUN}`));
      expect(response.status, role).toBe(200);
      const body = listFlowRunsResponseSchema.parse(await response.json());
      expect(body.runs[0]?.leadName, role).toBe(leadName);
      expect(flows.listRuns).toHaveBeenLastCalledWith(writeScope, 'order_received', {
        before: RUN,
        includeLeadNames: leadName !== null,
      });
    }
    expect((await call(automationsUrl('/order_received/runs?before=nope'))).status).toBe(400);
    flows.listRuns.mockResolvedValueOnce(undefined);
    const unknown = await call(automationsUrl(`/${FLOW}/runs`));
    expect(unknown.status).toBe(404);
    expect((await errorOf(unknown)).code).toBe('automation_not_found');
  });

  it('a detail whose active definition no longer parses is still served', async () => {
    flows.detail.mockResolvedValueOnce({
      ...detailOf(
        storedFlow(FLOW, {
          activeVersion: {
            id: '70000000-0000-4000-8000-000000000e61',
            version: 1,
            definition: { rotten: true },
            activatedAt: RUN_VERSION_AT,
            activatedBy: ACTOR,
          },
        }),
      ),
      needsAttention: { path: 'definition', code: 'definition_invalid', ref: 'definition' },
      active: { version: 1, definition: null },
    });
    const response = await call(automationsUrl(`/${FLOW}`));
    expect(response.status).toBe(200);
    const body = flowDetailResponseSchema.parse(await response.json());
    expect(body.active).toEqual({ version: 1, definition: null });
    expect(body.automation).toMatchObject({
      trigger: null,
      needsAttention: { code: 'definition_invalid' },
    });
  });

  it('a store failure is a 500 internal_error without detail', async () => {
    flows.list.mockRejectedValueOnce(new Error('boom: ada@example.test'));
    const response = await call(automationsUrl());
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('ada@example.test');
    expect(apiErrorResponseSchema.parse(JSON.parse(text)).error.code).toBe('internal_error');
  });
});
