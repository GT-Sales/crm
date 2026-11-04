import { aiStreamPartSchema } from '@gt-sales/contracts';
import { describe, expect, it } from 'vitest';
import { createActionProposalTools, signAiAction, verifyAiAction } from '../src/ai/actions.js';
import { TurnBudget } from '../src/ai/limits.js';
import { DatabaseAiReadService } from '../src/ai/read-service.js';
import { vi } from 'vitest';

const scope = {
  workspaceId: '10000000-0000-4000-8000-000000000001',
  actorId: '20000000-0000-4000-8000-000000000001',
};
const leadId = '30000000-0000-4000-8000-000000000001';
const now = new Date('2026-11-04T12:00:00Z');
const key = 'synthetic-signing-key';
const action = {
  ...scope,
  id: '40000000-0000-4000-8000-000000000001',
  expiresAt: new Date(now.getTime() + 600000).toISOString(),
  draft: { kind: 'note' as const, leadId, body: 'Call completed.' },
};

describe('signed AI confirmation cards', () => {
  it('binds the exact draft to its actor and Site and expires after ten minutes', () => {
    const token = signAiAction(action, key);
    expect(verifyAiAction(token, key, scope, now)).toEqual(action);
    expect(verifyAiAction(token, key, { ...scope, actorId: leadId }, now)).toBeUndefined();
    expect(verifyAiAction(token, key, { ...scope, workspaceId: leadId }, now)).toBeUndefined();
    expect(verifyAiAction(token, 'rotated-key', scope, now)).toBeUndefined();
    expect(verifyAiAction(token, key, scope, new Date(action.expiresAt))).toBeUndefined();
    const forged =
      Buffer.from(
        JSON.stringify({ ...action, draft: { ...action.draft, body: 'Changed' } }),
      ).toString('base64url') +
      '.' +
      token.split('.')[1];
    expect(verifyAiAction(forged, key, scope, now)).toBeUndefined();
    expect(verifyAiAction('invalid', key, scope, now)).toBeUndefined();
  });

  it('supports a full-length Unicode note in a signed card', () => {
    const long = { ...action, draft: { ...action.draft, body: '界'.repeat(4000) } };
    const token = signAiAction(long, key);
    expect(token.length).toBeGreaterThan(12000);
    expect(verifyAiAction(token, key, scope, now)?.draft).toEqual(long.draft);
  });

  it('prepares a bounded card without writes and keeps its token out of model results', async () => {
    const reads = new DatabaseAiReadService();
    vi.spyOn(reads, 'leadHint').mockResolvedValue({
      leadId,
      reference: 'MS-101',
      name: 'Example',
      stage: 'pending',
      leadType: 'sim_order',
    });
    const tools = createActionProposalTools({
      scope,
      site: { name: 'Test Site', slug: 'test' },
      key,
      reads,
      now: () => now,
      budget: new TurnBudget(),
      loadAccess: async () => ({
        membershipId: leadId,
        status: 'active',
        roles: ['owner'],
        permissions: [],
      }),
    });
    const result = await tools.execute('prepareNote', { leadId, body: 'Call completed.' });
    const proposal = tools.proposals[0];
    expect(proposal?.draft).toEqual(action.draft);
    expect(JSON.parse(result).status).toBe('confirmation_required');
    expect(result).not.toContain(proposal?.token);
    expect(proposal && verifyAiAction(proposal.token, key, scope, now)?.draft).toEqual(
      action.draft,
    );
    await tools.execute('prepareNote', { leadId, body: 'Call completed.' });
    expect(tools.proposals).toHaveLength(1);
    await tools.execute('prepareTask', {
      leadId,
      title: 'Call tomorrow',
      dueDate: '2026-11-05',
      assignee: 'me',
    });
    await tools.execute('prepareNote', { leadId, body: 'Another note' });
    expect(
      JSON.parse(await tools.execute('prepareNote', { leadId, body: 'Over limit' })).status,
    ).toBe('not_available');
    expect(tools.proposals).toHaveLength(3);
  });

  it('caps parallel proposals at three without breaking the stream contract', async () => {
    const reads = new DatabaseAiReadService();
    vi.spyOn(reads, 'leadHint').mockResolvedValue({
      leadId,
      reference: 'MS-101',
      name: 'Example',
      stage: 'pending',
      leadType: 'sim_order',
    });
    const tools = createActionProposalTools({
      scope,
      site: { name: 'Test', slug: 'test' },
      key,
      reads,
      now: () => now,
      budget: new TurnBudget(),
      loadAccess: async () => ({
        membershipId: leadId,
        status: 'active',
        roles: ['owner'],
        permissions: [],
      }),
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        tools.execute('prepareNote', { leadId, body: `Note ${index}` }),
      ),
    );
    expect(tools.proposals).toHaveLength(3);
    expect(
      results.filter((result) => JSON.parse(result).status === 'confirmation_required'),
    ).toHaveLength(3);
    expect(
      aiStreamPartSchema.safeParse({ type: 'actions', actions: tools.proposals }).success,
    ).toBe(true);
  });

  it('refuses read-only callers and unavailable leads, and rejects invalid dates', async () => {
    const reads = new DatabaseAiReadService();
    const lookup = vi.spyOn(reads, 'leadHint').mockResolvedValue(undefined);
    let roles: ('finance' | 'owner')[] = ['finance'];
    const tools = createActionProposalTools({
      scope,
      site: { name: 'Test', slug: 'test' },
      key,
      reads,
      now: () => now,
      budget: new TurnBudget(),
      loadAccess: async () => ({ membershipId: leadId, status: 'active', roles, permissions: [] }),
    });
    expect(JSON.parse(await tools.execute('prepareNote', { leadId, body: 'Note' })).status).toBe(
      'not_available',
    );
    expect(lookup).not.toHaveBeenCalled();
    roles = ['owner'];
    await tools.execute('prepareNote', { leadId, body: 'Note' });
    expect(tools.proposals).toHaveLength(0);
    expect(() =>
      tools.execute('prepareTask', {
        leadId,
        title: 'Bad date',
        dueDate: '2026-02-30',
        assignee: 'me',
      }),
    ).toThrow();
  });
});
