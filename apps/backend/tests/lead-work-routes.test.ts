import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiErrorResponseSchema,
  createLeadNoteResponseSchema,
  getWorkspaceLeadResponseSchema,
  leadStatsResponseSchema,
  leadBoardResponseSchema,
  leadsSummaryResponseSchema,
  leadTaskResponseSchema,
  leadTrashResponseSchema,
  listWorkspaceLeadsResponseSchema,
  markLeadOpenedResponseSchema,
  listWorkspaceTasksResponseSchema,
  queueCustomerEmailResponseSchema,
  updateStaffProfileResponseSchema,
  updateWorkspaceLeadResponseSchema,
  type LeadActivity,
  type LeadDetail,
  type LeadDocument,
  type LeadIdentity,
  type LeadTask,
  type RelatedLead,
  type StaffWorkspace,
} from '@gt-sales/contracts';

import { createApp } from '../src/app.js';
import type { StaffSessionVerifier, VerifiedStaffSession } from '../src/auth/session.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import type { LeadStore, ListLeadsInput } from '../src/leads/store.js';
import type { LeadWorkStore, UpdateLeadWorkInput } from '../src/leads/work-store.js';
import type { StaffStore } from '../src/staff/store.js';
import type { WebsiteCredentialStore } from '../src/website/store.js';

const ACTOR = '20000000-0000-4000-8000-000000000e01';
const WORKSPACE = '10000000-0000-4000-8000-000000000e01';
const MEMBERSHIP = '30000000-0000-4000-8000-000000000e01';
const LEAD = '90000000-0000-4000-8000-000000000e01';
const TASK = '91000000-0000-4000-8000-000000000e01';
const NOW = '2026-10-26T12:00:00.000Z';

const workspace: StaffWorkspace = {
  id: WORKSPACE,
  slug: 'canadawide',
  name: 'CanadaWide',
  membershipId: MEMBERSHIP,
  roles: ['owner'],
};

const lead: LeadDetail = {
  id: LEAD,
  workspaceId: WORKSPACE,
  leadType: 'internet',
  status: 'submitted',
  stage: 'new',
  contact: { fullName: 'Avery Example', email: 'avery@example.test', phone: '403 555 0101' },
  contactId: null,
  assignedActorId: null,
  externalRef: null,
  source: 'direct',
  attribution: {},
  consentVersion: 'cw-internet-contact-2026-10',
  openTaskCount: 1,
  nextTaskDueAt: NOW,
  // A countdown is a form detail too, so it goes with the form for a viewer.
  countdownDate: '2026-11-09',
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  form: { schemaVersion: 1, payload: { planId: 'ab-1gbps', dateOfBirth: '1990-04-12' } },
};

const note: LeadActivity = {
  id: '92000000-0000-4000-8000-000000000e01',
  actorId: ACTOR,
  createdAt: NOW,
  kind: 'note',
  body: 'Called, no answer.',
};

const task: LeadTask = {
  id: TASK,
  leadId: LEAD,
  title: 'Call back',
  dueAt: NOW,
  assignedActorId: ACTOR,
  status: 'open',
  completedAt: null,
  createdBy: ACTOR,
  createdAt: NOW,
  updatedAt: NOW,
};

const relatedLead: RelatedLead = {
  id: '90000000-0000-4000-8000-000000000e02',
  leadType: 'mobility',
  status: 'submitted',
  stage: 'contacted',
  deletedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const identity: LeadIdentity = {
  id: '90000000-0000-4000-8000-000000000e03',
  idType: 'sin',
  sinMasked: '*** *** 046',
  dateOfBirth: '1990-01-31',
  fileId: null,
  createdAt: NOW,
};

const leadDocument: LeadDocument = {
  id: '90000000-0000-4000-8000-000000000e04',
  documentType: 'passport',
  contentType: 'application/pdf',
  sizeBytes: 1200,
  revision: 1,
  createdAt: NOW,
};

const { form: _form, ...listItem } = lead;

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
  setDisplayName = vi.fn(async () => 2);
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

class MemoryLeadStore implements LeadStore {
  readonly listCalls: ListLeadsInput[] = [];
  readLead: LeadStore['readLead'] = async () => ({ status: 'grant_invalid' });
  createLead: LeadStore['createLead'] = () => {
    throw new Error('unused');
  };
  updateLead: LeadStore['updateLead'] = () => {
    throw new Error('unused');
  };
  async listLeads(input: ListLeadsInput) {
    this.listCalls.push(input);
    return { leads: [listItem], page: { page: 1, pageSize: 25, total: 1 } };
  }
}

function memoryWorkStore() {
  return {
    summary: vi.fn<LeadWorkStore['summary']>(async () => ({
      types: [{ leadType: 'internet', total: 1 }],
      trash: 0,
    })),
    stats: vi.fn<LeadWorkStore['stats']>(async () => ({
      total: 3,
      stages: [{ stage: 'new', total: 3 }],
      daily: [{ day: '2026-10-26', total: 3 }],
      partners: [{ code: 'PT-7', name: 'Maple Study Abroad', total: 2 }],
    })),
    board: vi.fn<LeadWorkStore['board']>(async () => [
      { stage: 'new', total: 1, leads: [listItem] },
    ]),
    getLead: vi.fn<LeadWorkStore['getLead']>(async (input) =>
      input.leadId === LEAD
        ? {
            lead,
            activities: input.includeWork ? [note] : [],
            tasks: input.includeWork ? [task] : [],
            // Always returned here, so the route's own redaction is what the
            // viewer test sees.
            related: [relatedLead],
            identities: [identity],
            documents: [leadDocument],
          }
        : undefined,
    ),
    updateLead: vi.fn<LeadWorkStore['updateLead']>(async (input: UpdateLeadWorkInput) => ({
      status: 'updated',
      lead: { ...lead, stage: input.stage ?? lead.stage },
      activities: [],
    })),
    setTrashed: vi.fn<LeadWorkStore['setTrashed']>(async (input) => ({
      status: 'changed',
      lead: { ...lead, deletedAt: input.trashed ? NOW : null },
      activity: {
        id: '92000000-0000-4000-8000-000000000e02',
        actorId: ACTOR,
        createdAt: NOW,
        kind: 'system',
        event: input.trashed ? 'trashed' : 'restored',
      },
    })),
    markOpened: vi.fn<LeadWorkStore['markOpened']>(async () => ({
      status: 'opened',
      activity: {
        id: '92000000-0000-4000-8000-000000000e04',
        actorId: ACTOR,
        createdAt: NOW,
        kind: 'system',
        event: 'opened',
      },
    })),
    addNote: vi.fn<LeadWorkStore['addNote']>(async () => ({ status: 'created', activity: note })),
    queueCustomerEmail: vi.fn<LeadWorkStore['queueCustomerEmail']>(async () => ({
      status: 'queued',
      activity: {
        id: '92000000-0000-4000-8000-000000000e05',
        actorId: ACTOR,
        createdAt: NOW,
        kind: 'system',
        event: 'customer_emailed',
        template: 'sim_number_ready',
      },
    })),
    createTask: vi.fn<LeadWorkStore['createTask']>(async () => ({ status: 'saved', task })),
    updateTask: vi.fn<LeadWorkStore['updateTask']>(async () => ({ status: 'saved', task })),
    listTasks: vi.fn<LeadWorkStore['listTasks']>(async () => ({
      tasks: [
        { ...task, lead: { id: LEAD, leadType: 'internet', stage: 'new', contact: lead.contact } },
      ],
      total: 1,
    })),
  } satisfies LeadWorkStore;
}

const noopCredentialStore: WebsiteCredentialStore = {
  createCredential: async () => {
    throw new Error('unused');
  },
  listCredentials: async () => [],
  revokeCredential: async () => ({ status: 'not_found' }),
};

let server: Server;
let baseUrl: string;
let store: MemoryStaffStore;
let leadStore: MemoryLeadStore;
let work: ReturnType<typeof memoryWorkStore>;
// Whether this site can send mail to its customers right now.
let mailReady: boolean;

beforeEach(async () => {
  store = new MemoryStaffStore();
  leadStore = new MemoryLeadStore();
  work = memoryWorkStore();
  mailReady = true;
  server = createApp({
    staff: {
      sessionVerifier: new TokenVerifier(),
      store,
      credentialStore: noopCredentialStore,
      leadStore,
      leadWorkStore: work,
      customerEmail: {
        available: (workspaceId) => mailReady && workspaceId === WORKSPACE,
        sender: () => ({
          fromAddress: 'order@site.example',
          fromName: 'The Site',
          siteUrl: 'https://site.example',
        }),
        contactHash: (email) => `hash:${email}`,
      },
    },
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP server');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const leadsUrl = () => `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/leads`;

function call(url: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: 'Bearer token',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error;
}

describe('staff lead work routes', () => {
  it('passes the list filters through and reports what the caller may do', async () => {
    const response = await call(
      `${leadsUrl()}?type=internet&stage=qualified&assignee=me&q=avery&view=trash&page=2`,
    );
    expect(response.status).toBe(200);
    const body = listWorkspaceLeadsResponseSchema.parse(await response.json());
    expect(body.access).toEqual({ contacts: true, manage: true, revealSensitive: true });
    expect(leadStore.listCalls[0]).toMatchObject({
      leadType: 'internet',
      stage: 'qualified',
      assignee: 'me',
      search: 'avery',
      view: 'trash',
      page: 2,
    });
  });

  it('refuses a search to a role that cannot see contacts', async () => {
    store.access = { ...store.access, roles: ['viewer'] };
    const response = await call(`${leadsUrl()}?q=avery`);
    expect(response.status).toBe(403);
    expect((await errorCode(response)).code).toBe('permission_denied');
    expect(leadStore.listCalls).toHaveLength(0);

    const board = await call(`${leadsUrl()}/board?type=internet&q=avery`);
    expect(board.status).toBe(403);
  });

  it('routes /summary and /board before the lead id', async () => {
    const summary = await call(`${leadsUrl()}/summary`);
    expect(summary.status).toBe(200);
    expect(leadsSummaryResponseSchema.parse(await summary.json()).types).toEqual([
      { leadType: 'internet', total: 1 },
    ]);

    const board = await call(`${leadsUrl()}/board?type=internet&perStage=10`);
    expect(board.status).toBe(200);
    expect(leadBoardResponseSchema.parse(await board.json()).columns[0]?.stage).toBe('new');
    expect(work.board).toHaveBeenCalledWith(
      expect.objectContaining({ leadType: 'internet', workspaceId: WORKSPACE }),
      10,
    );

    expect((await call(`${leadsUrl()}/board`)).status).toBe(400);
  });

  it('gives the dashboard its counts, to any reader, for a known window only', async () => {
    store.access = { ...store.access, roles: ['viewer'] };
    const response = await call(`${leadsUrl()}/stats?leadType=sim_order&days=30`);
    expect(response.status).toBe(200);
    expect(leadStatsResponseSchema.parse(await response.json())).toMatchObject({
      leadType: 'sim_order',
      days: 30,
      total: 3,
      partners: [{ code: 'PT-7', name: 'Maple Study Abroad', total: 2 }],
    });
    expect(work.stats).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, leadType: 'sim_order', days: 30 }),
    );
    const allTime = await call(`${leadsUrl()}/stats?leadType=sim_order`);
    expect(leadStatsResponseSchema.parse(await allTime.json()).days).toBeNull();
    for (const query of ['leadType=sim_order&days=14', 'days=30', 'leadType=Sim Order']) {
      expect((await call(`${leadsUrl()}/stats?${query}`)).status).toBe(400);
    }
    expect(work.stats).toHaveBeenCalledTimes(2);
  });

  it('counts follow-ups due in the summary only for a calendar day', async () => {
    expect((await call(`${leadsUrl()}/summary?dueBy=2026-11-05`)).status).toBe(200);
    expect(work.summary).toHaveBeenLastCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, dueBy: '2026-11-05' }),
    );
    expect((await call(`${leadsUrl()}/summary?dueBy=soon`)).status).toBe(400);
    expect(work.summary).toHaveBeenCalledTimes(1);
  });

  it('shows a viewer the lead without contact, form, timeline, tasks or related requests', async () => {
    store.access = { ...store.access, roles: ['viewer'] };
    const response = await call(`${leadsUrl()}/${LEAD}`);
    expect(response.status).toBe(200);
    const body = getWorkspaceLeadResponseSchema.parse(await response.json());
    expect(body.lead.contact).toEqual({});
    expect(body.lead.form).toBeNull();
    expect(body.lead.countdownDate).toBeNull();
    expect(body.activities).toEqual([]);
    expect(body.tasks).toEqual([]);
    expect(body.related).toEqual([]);
    expect(body.identities).toEqual([]);
    expect(body.documents).toEqual([]);
    expect(body.access).toEqual({
      contacts: false,
      manage: false,
      revealSensitive: false,
      emailCustomer: false,
      downloadDocuments: false,
    });
    expect(work.getLead).toHaveBeenCalledWith(expect.objectContaining({ includeWork: false }));
  });

  it('offers to email the customer only to those who work leads, while the site can send', async () => {
    const access = async () =>
      getWorkspaceLeadResponseSchema.parse(await (await call(`${leadsUrl()}/${LEAD}`)).json())
        .access.emailCustomer;
    expect(await access()).toBe(true);
    mailReady = false;
    expect(await access()).toBe(false);
  });

  it('queues a mail to the customer, and says plainly why it cannot', async () => {
    const send = (body: unknown = { template: 'sim_number_ready' }) =>
      call(`${leadsUrl()}/${LEAD}/customer-emails`, { method: 'POST', body });

    const queued = await send();
    expect(queued.status).toBe(202);
    expect(queueCustomerEmailResponseSchema.parse(await queued.json()).activity).toMatchObject({
      kind: 'system',
      event: 'customer_emailed',
      template: 'sim_number_ready',
    });
    const [input] = work.queueCustomerEmail.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      workspaceId: WORKSPACE,
      leadId: LEAD,
      template: 'sim_number_ready',
      siteUrl: 'https://site.example',
    });
    expect(input?.contactHash('a@example.test')).toBe('hash:a@example.test');

    expect((await send({ template: 'something_else' })).status).toBe(400);

    work.queueCustomerEmail.mockResolvedValueOnce({ status: 'missing', missing: 'simNumber' });
    const missing = await send();
    expect(missing.status).toBe(409);
    expect(await errorCode(missing)).toMatchObject({
      code: 'conflict',
      details: { missing: 'simNumber' },
    });

    work.queueCustomerEmail.mockResolvedValueOnce({ status: 'trashed' });
    expect((await errorCode(await send())).code).toBe('lead_trashed');
    work.queueCustomerEmail.mockResolvedValueOnce({ status: 'not_found' });
    expect((await send()).status).toBe(404);

    // The site cannot send: refused before anything is queued.
    const calls = work.queueCustomerEmail.mock.calls.length;
    mailReady = false;
    const notReady = await send();
    expect(notReady.status).toBe(409);
    expect((await errorCode(notReady)).code).toBe('feature_not_ready');
    store.access = { ...store.access, roles: ['viewer'] };
    expect((await send()).status).toBe(403);
    expect(work.queueCustomerEmail.mock.calls.length).toBe(calls);
  });

  it('shows a lead worker everything, and 404s an unknown lead', async () => {
    store.access = { ...store.access, roles: ['leads'] };
    const response = await call(`${leadsUrl()}/${LEAD}`);
    const body = getWorkspaceLeadResponseSchema.parse(await response.json());
    expect(body.lead).toEqual(lead);
    expect(body.activities).toEqual([note]);
    expect(body.tasks).toEqual([task]);
    expect(body.related).toEqual([relatedLead]);
    expect(body.identities).toEqual([identity]);
    expect(body.documents).toEqual([leadDocument]);
    expect(body.access.revealSensitive).toBe(false);
    // Opening an original is its own permission, not part of working leads.
    expect(body.access.downloadDocuments).toBe(false);

    const missing = await call(`${leadsUrl()}/90000000-0000-4000-8000-0000000000ff`);
    expect(missing.status).toBe(404);
    expect((await errorCode(missing)).code).toBe('lead_not_found');
  });

  it('lets only lead managers change a lead', async () => {
    for (const roles of [['viewer'], ['finance'], ['orders']] as const) {
      store.access = { ...store.access, roles: [...roles] };
      const response = await call(`${leadsUrl()}/${LEAD}`, {
        method: 'PATCH',
        body: { stage: 'contacted' },
      });
      expect(response.status).toBe(403);
    }
    for (const path of ['notes', 'tasks', 'trash', 'restore']) {
      const response = await call(`${leadsUrl()}/${LEAD}/${path}`, {
        method: 'POST',
        body: path === 'notes' ? { body: 'x' } : path === 'tasks' ? { title: 'x' } : undefined,
      });
      expect(response.status).toBe(403);
    }
    expect(work.updateLead).not.toHaveBeenCalled();
    expect(work.addNote).not.toHaveBeenCalled();
    expect(work.setTrashed).not.toHaveBeenCalled();

    store.access = { ...store.access, roles: ['leads'] };
    const allowed = await call(`${leadsUrl()}/${LEAD}`, {
      method: 'PATCH',
      body: { stage: 'contacted', assignedActorId: null },
    });
    expect(allowed.status).toBe(200);
    expect(updateWorkspaceLeadResponseSchema.parse(await allowed.json()).lead.stage).toBe(
      'contacted',
    );
    expect(work.updateLead).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'contacted', assignedActorId: null, actorId: ACTOR }),
    );
  });

  it('maps each refused update to its error', async () => {
    const cases = [
      [{ status: 'not_found' }, 404, 'lead_not_found'],
      [{ status: 'trashed' }, 409, 'lead_trashed'],
      [{ status: 'invalid_stage' }, 400, 'validation_error'],
      [{ status: 'assignee_not_found' }, 422, 'assignee_not_found'],
    ] as const;
    for (const [outcome, status, code] of cases) {
      work.updateLead.mockResolvedValueOnce(outcome);
      const response = await call(`${leadsUrl()}/${LEAD}`, {
        method: 'PATCH',
        body: { stage: 'contacted' },
      });
      expect(response.status).toBe(status);
      const error = await errorCode(response);
      expect(error.code).toBe(code);
      if (code === 'validation_error') expect(error.details).toEqual({ field: 'stage' });
    }
  });

  it('passes form corrections through and names a refused field, never its value', async () => {
    const response = await call(`${leadsUrl()}/${LEAD}`, {
      method: 'PATCH',
      body: { form: { arrivalDate: '2026-11-09', gotVisa: null } },
    });
    expect(response.status).toBe(200);
    expect(work.updateLead).toHaveBeenCalledWith(
      expect.objectContaining({ form: { arrivalDate: '2026-11-09', gotVisa: null } }),
    );

    work.updateLead.mockResolvedValueOnce({ status: 'invalid_field', field: 'arrivalDate' });
    const refused = await call(`${leadsUrl()}/${LEAD}`, {
      method: 'PATCH',
      body: { form: { arrivalDate: '2026-02-30' } },
    });
    expect(refused.status).toBe(400);
    const error = await errorCode(refused);
    expect(error).toMatchObject({ code: 'validation_error', details: { field: 'arrivalDate' } });
    expect(JSON.stringify(error)).not.toContain('2026-02-30');
  });

  it('refuses an update that changes nothing or names an unknown field', async () => {
    for (const body of [
      {},
      { contact: {} },
      { form: {} },
      { form: { 'not a key': 'x' } },
      { status: 'submitted' },
      { stage: 'Not A Slug' },
    ]) {
      const response = await call(`${leadsUrl()}/${LEAD}`, { method: 'PATCH', body });
      expect(response.status).toBe(400);
      expect((await errorCode(response)).code).toBe('invalid_request');
    }
    expect(work.updateLead).not.toHaveBeenCalled();
  });

  it('records an open for someone who works leads, and refuses a reader', async () => {
    const opened = await call(`${leadsUrl()}/${LEAD}/opened`, { method: 'POST' });
    expect(opened.status).toBe(200);
    expect(markLeadOpenedResponseSchema.parse(await opened.json()).activity).toMatchObject({
      kind: 'system',
      event: 'opened',
    });
    expect(work.markOpened).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE, leadId: LEAD, actorId: ACTOR }),
    );

    work.markOpened.mockResolvedValueOnce({ status: 'not_found' });
    expect((await call(`${leadsUrl()}/${LEAD}/opened`, { method: 'POST' })).status).toBe(404);

    store.access = { ...store.access, roles: ['viewer'] };
    expect((await call(`${leadsUrl()}/${LEAD}/opened`, { method: 'POST' })).status).toBe(403);
    expect(work.markOpened).toHaveBeenCalledTimes(2);
  });

  it('adds a note, creates and updates a task, and trashes and restores', async () => {
    const created = await call(`${leadsUrl()}/${LEAD}/notes`, {
      method: 'POST',
      body: { body: '  Called, no answer.  ' },
    });
    expect(created.status).toBe(201);
    expect(createLeadNoteResponseSchema.parse(await created.json()).activity).toEqual(note);
    // Surrounding whitespace never reaches the timeline.
    expect(work.addNote).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Called, no answer.' }),
    );

    const newTask = await call(`${leadsUrl()}/${LEAD}/tasks`, {
      method: 'POST',
      body: { title: 'Call back', dueAt: NOW, assignedActorId: ACTOR },
    });
    expect(newTask.status).toBe(201);
    expect(leadTaskResponseSchema.parse(await newTask.json()).task).toEqual(task);

    const updated = await call(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/tasks/${TASK}`, {
      method: 'PATCH',
      body: { status: 'done' },
    });
    expect(updated.status).toBe(200);
    expect(work.updateTask).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, status: 'done' }),
    );

    work.updateTask.mockResolvedValueOnce({ status: 'not_found' });
    const missing = await call(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/tasks/${TASK}`, {
      method: 'PATCH',
      body: { status: 'done' },
    });
    expect(missing.status).toBe(404);
    expect((await errorCode(missing)).code).toBe('task_not_found');

    const trashed = await call(`${leadsUrl()}/${LEAD}/trash`, { method: 'POST' });
    expect(leadTrashResponseSchema.parse(await trashed.json()).activity).toMatchObject({
      kind: 'system',
      event: 'trashed',
    });
    const restored = await call(`${leadsUrl()}/${LEAD}/restore`, { method: 'POST' });
    expect(leadTrashResponseSchema.parse(await restored.json()).lead.deletedAt).toBeNull();
    expect(work.setTrashed.mock.calls.map(([input]) => input.trashed)).toEqual([true, false]);
  });

  it("lists the caller's open tasks by default, and only for roles that see contacts", async () => {
    const response = await call(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/tasks`);
    expect(response.status).toBe(200);
    expect(listWorkspaceTasksResponseSchema.parse(await response.json()).tasks).toHaveLength(1);
    expect(work.listTasks).toHaveBeenCalledWith(
      expect.objectContaining({ assignee: 'me', status: 'open' }),
      1,
      50,
    );

    const due = await call(
      `${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/tasks?assignee=all&dueBy=2026-11-05&pageSize=6`,
    );
    expect(due.status).toBe(200);
    expect(work.listTasks).toHaveBeenLastCalledWith(
      expect.objectContaining({ assignee: 'all', status: 'open', dueBy: '2026-11-05' }),
      1,
      6,
    );
    expect(
      (await call(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/tasks?dueBy=11/05/2026`)).status,
    ).toBe(400);

    store.access = { ...store.access, roles: ['viewer'] };
    const denied = await call(`${baseUrl}/api/v1/staff/workspaces/${WORKSPACE}/tasks`);
    expect(denied.status).toBe(403);
  });

  it("sets the caller's own display name, trimmed", async () => {
    const response = await call(`${baseUrl}/api/v1/staff/profile`, {
      method: 'PATCH',
      body: { displayName: '  Takib  ' },
    });
    expect(response.status).toBe(200);
    expect(updateStaffProfileResponseSchema.parse(await response.json())).toMatchObject({
      displayName: 'Takib',
      memberships: 2,
    });
    expect(store.setDisplayName).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: ACTOR, displayName: 'Takib' }),
    );

    for (const displayName of ['', '   ', 'x'.repeat(81)]) {
      const bad = await call(`${baseUrl}/api/v1/staff/profile`, {
        method: 'PATCH',
        body: { displayName },
      });
      expect(bad.status).toBe(400);
    }
  });
});
