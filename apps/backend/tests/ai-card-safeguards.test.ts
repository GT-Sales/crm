import { tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AI_CARD_KINDS,
  aiActionCardSchema,
  type AiActionCard,
  type FlowStep,
} from '@gt-sales/contracts';

import {
  AI_CARD_ACTIONS,
  cardKindsFor,
  cardLeadLabel,
  dailyCapRefusal,
  emailMentionText,
  leadsInToolResult,
  legacyProposalOf,
  mentionedLeads,
  mentionedOtherLeads,
  SeenLeads,
  sideEffectsDigest,
} from '../src/ai/card-safeguards.js';
import { flowRunSentence } from '../src/ai/card-store.js';
import type { StaffAccessSnapshot } from '../src/staff/authorization.js';
import { assertAssistantToolPolicy } from '../src/ai/tool-policy.js';

const LEAD = '90000000-0000-4000-8000-000000000301';
const OTHER = '90000000-0000-4000-8000-000000000302';
const scope = {
  workspaceId: '10000000-0000-4000-8000-000000000301',
  actorId: '20000000-0000-4000-8000-000000000301',
};

const access = (
  roles: StaffAccessSnapshot['roles'],
  permissions: StaffAccessSnapshot['permissions'] = [],
  status: StaffAccessSnapshot['status'] = 'active',
): StaffAccessSnapshot => ({ membershipId: 'm', status, roles, permissions });

describe('the card action table (C1)', () => {
  it('names an action for every kind, the same ones the staff routes check', () => {
    expect(Object.keys(AI_CARD_ACTIONS).sort()).toEqual([...AI_CARD_KINDS].sort());
    for (const kind of AI_CARD_KINDS) {
      expect(AI_CARD_ACTIONS[kind]).toContain('workspace.read');
      expect(AI_CARD_ACTIONS[kind]).toContain(
        kind === 'automation_off' ? 'integration.manage' : 'lead.manage',
      );
    }
  });

  it('gives each member the kinds their roles and individual permissions allow, now', () => {
    const site = { automations: true };
    expect(cardKindsFor(access(['owner']), site)).toEqual([...AI_CARD_KINDS]);
    expect(cardKindsFor(access(['leads']), site)).not.toContain('automation_off');
    expect(cardKindsFor(access(['finance', 'orders']), site)).toEqual([]);
    // An individual allow grants the switch; an individual deny beats the owner role.
    expect(
      cardKindsFor(access(['viewer'], [{ name: 'integration_management', effect: 'allow' }]), site),
    ).toEqual(['automation_off']);
    expect(
      cardKindsFor(access(['owner'], [{ name: 'integration_management', effect: 'deny' }]), site),
    ).not.toContain('automation_off');
    expect(cardKindsFor(access(['owner'], [], 'revoked'), site)).toEqual([]);
    expect(cardKindsFor(undefined, site)).toEqual([]);
    // Off the automation allowlist, no switch for anyone.
    expect(cardKindsFor(access(['owner']), { automations: false })).not.toContain('automation_off');
  });

  it('lets the policy accept every card tool and nothing else', () => {
    const fn = tool({ inputSchema: z.object({}), execute: async () => '' });
    expect(() =>
      assertAssistantToolPolicy({
        prepareLeadEdit: fn,
        getLeadEditOptions: fn,
        getAssigneeOptions: fn,
        prepareTemplateEmail: fn,
        prepareArchive: fn,
        prepareAutomationOff: fn,
      }),
    ).not.toThrow();
    expect(() => assertAssistantToolPolicy({ prepareAutomationOn: fn })).toThrow();
  });
});

describe('a card’s lead label (B5)', () => {
  it('reads “name (type, created day)”, led by the server-set reference', () => {
    expect(
      cardLeadLabel({
        leadType: 'sim_order',
        reference: 'MS-1022',
        name: 'Robin Example',
        createdAt: new Date('2026-11-02T15:00:00Z'),
      }),
    ).toBe('MS-1022 · Robin Example (SIM order, created 2026-11-02)');
    // A customer-typed name never stands alone, and is cut so the server's part shows.
    const spoofed = cardLeadLabel({
      leadType: 'internet',
      reference: null,
      name: `MS-1022 · SIM order ${'x'.repeat(200)}`,
      createdAt: new Date('2026-11-02T15:00:00Z'),
    });
    expect(spoofed).toMatch(/\(Internet, created 2026-11-02\)$/);
    expect(cardLeadLabel({ leadType: 'internet', reference: null, name: null })).toBe(
      'Unnamed lead (Internet)',
    );
  });
});

describe('mentions of other customers (B1)', () => {
  it('collects the leads a tool result names, a task’s lead included', () => {
    const result = JSON.stringify({
      status: 'ok',
      data: {
        leads: [{ leadId: LEAD, name: 'Pat Target', reference: null }],
        tasks: [{ taskId: 't', leadId: OTHER, leadName: 'Zara Quill', leadReference: 'MS-7' }],
      },
    });
    expect(leadsInToolResult(result)).toEqual([
      { leadId: LEAD, name: 'Pat Target', reference: null },
      { leadId: OTHER, name: 'Zara Quill', reference: 'MS-7' },
    ]);
    expect(leadsInToolResult('not json')).toEqual([]);
    const seen = new SeenLeads();
    seen.record(result);
    seen.record(result);
    expect(seen.list()).toHaveLength(2);
  });

  it('names another lead the text mentions as whole words, never the card’s own', () => {
    const others = [
      { leadId: OTHER, name: 'Zara Quill', reference: 'MS-7777' },
      { leadId: LEAD, name: 'Pat Target', reference: null },
      { leadId: '90000000-0000-4000-8000-000000000303', name: 'Al', reference: null },
    ];
    expect(
      mentionedOtherLeads('Hi Pat. Orders: ZARA quill and ms-7777; Al too.', others, {
        leadId: LEAD,
        name: 'Pat Target',
      }),
    ).toEqual(['MS-7777', 'Zara Quill']);
    // Part of a longer word is not a mention.
    expect(mentionedOtherLeads('MS-77770', others, { leadId: LEAD, name: 'Pat Target' })).toEqual(
      [],
    );
    // The same person's other request has the card lead's own name.
    expect(
      mentionedOtherLeads('Zara Quill', others, {
        leadId: '90000000-0000-4000-8000-000000000309',
        name: 'Zara Quill',
      }),
    ).toEqual([]);
  });

  it('normalises both sides as the reads clean record text: hidden and format characters are spaces', () => {
    const others = [{ leadId: OTHER, name: 'Zara\u200bQuill', reference: 'MS-7777' }];
    // A body that hides the name behind a zero-width or bidi character is still flagged.
    expect(
      mentionedOtherLeads('Hi Pat, see Zara\u2060Quill.', others, { leadId: LEAD, name: 'Pat' }),
    ).toEqual(['Zara Quill']);
    // A format character inside a reference does not split it either.
    expect(
      mentionedOtherLeads('Order MS-\u202e7777 is late.', others, { leadId: LEAD, name: 'Pat' }),
    ).toEqual(['MS-7777']);
    expect(
      mentionedOtherLeads('Hi Pat, Zara Quill too.', others, { leadId: LEAD, name: 'Pat' }),
    ).toEqual(['Zara Quill']);
  });

  describe('spelling variants of a name or reference (R3)', () => {
    const others = [{ leadId: OTHER, name: 'Robin Example', reference: 'MS-9001' }];
    const own = { leadId: LEAD, name: 'Sam Customer' };
    const flagged = (body: string) => mentionedOtherLeads(body, others, own);

    it('finds a reference written with a space, run together, or with other dashes', () => {
      for (const body of [
        'Order MS 9001 is late.',
        'Order MS9001 is late.',
        'Order MS‑9001 is late.', // non-breaking hyphen
        'Order MS–9001 is late.', // en dash
        'Order MS— 9001 is late.', // em dash and a space
        'Order MS 9001 is late.', // non-breaking space
        'Order ＭＳ－９００１ is late.', // full-width
        'Order ms.9001 is late.',
      ])
        expect(flagged(body), body).toEqual(['MS-9001']);
    });

    it('finds the name reordered, hyphenated, accented or in look-alike letters', () => {
      for (const body of [
        'Same as Robin-Example.',
        'Same as Example, Robin.',
        'Same as EXAMPLE Robin.',
        'Same as Rоbin Exаmple.', // Cyrillic о and а
        'Same as Röbin Exámple.',
        'Same as Robin Example.',
        "Same as Robin Example's order.",
      ])
        expect(flagged(body), body).toEqual(['Robin Example']);
    });

    it('does not flag one common word, a part of a word, or the two names far apart', () => {
      for (const body of [
        'Robin will call you back.',
        'The example is attached.',
        'Robinson Examples are not the same.',
        'Robin called. Here is a long note about nothing at all, as an example.',
        'Order MS-90010 is late.',
        'Items 9001 shipped.',
      ])
        expect(flagged(body), body).toEqual([]);
    });

    it('needs both a given name and a surname of three characters or more to match them apart', () => {
      const short = [{ leadId: OTHER, name: 'Al Wu', reference: null }];
      expect(mentionedOtherLeads('Wu, Al called.', short, own)).toEqual([]);
      // The whole name, in order, still matches.
      expect(mentionedOtherLeads('Al Wu called.', short, own)).toEqual(['Al Wu']);
    });
  });

  describe('hidden characters where the subject meets the body (T5)', () => {
    const others = [{ leadId: OTHER, name: 'Priya Sharma', reference: null }];
    for (const [label, hidden] of [
      ['zero-width space', '​'],
      ['zero-width joiner', '‍'],
      ['soft hyphen', '­'],
    ] as const) {
      it(`flags a name at the very start of the body with a ${label} inside it`, () => {
        expect(
          mentionedOtherLeads(
            emailMentionText('Your order', `Pri${hidden}ya Sharma ordered too`),
            others,
            {
              leadId: LEAD,
              name: 'Pat',
            },
          ),
        ).toEqual(['Priya Sharma']);
        // A line break inside the body is a separator too.
        expect(
          mentionedOtherLeads(`Hello\nPri${hidden}ya Sharma ordered too`, others, {
            leadId: LEAD,
            name: 'Pat',
          }),
        ).toEqual(['Priya Sharma']);
      });
    }
  });

  it('says which leads it found, so a revision is checked against them first', () => {
    const others = [
      { leadId: OTHER, name: 'Zara Quill', reference: null },
      { leadId: LEAD, name: 'Pat Target', reference: null },
    ];
    expect(mentionedLeads('About Pat Target.', others, { leadId: undefined, name: null })).toEqual({
      names: ['Pat Target'],
      leadIds: [LEAD],
    });
  });

  it('keeps every name a lead was seen under, its real one and the one a read cut short', () => {
    const seen = new SeenLeads();
    seen.record(
      JSON.stringify({ data: { leads: [{ leadId: OTHER, name: 'Zara Q…', reference: null }] } }),
    );
    seen.addLabels(new Map([[OTHER, { name: 'Zara Quillfeather-Smythe', reference: 'MS-9' }]]));
    seen.addId(LEAD);
    const list = seen.list();
    expect(list.map((lead) => lead.leadId)).toEqual([OTHER, OTHER, LEAD]);
    expect(
      mentionedOtherLeads('About Zara Quillfeather-Smythe and MS-9.', list, {
        leadId: LEAD,
        name: 'Pat',
      }),
    ).toEqual(['MS-9', 'Zara Quillfeather-Smythe']);
    expect(seen.ids()).toEqual([OTHER, LEAD]);
  });
});

describe('what a flow does, in words (C3, T3)', () => {
  const templates = new Map([
    ['dispatched', 'Dispatched'],
    ['activated', 'Activated'],
  ]);
  const flowSteps = (steps: FlowStep[]): FlowStep[] => steps;
  const branch: FlowStep = {
    id: 's_if',
    kind: 'if_else',
    // The condition's answer is not the card's to know; its shape does not matter here.
    condition: { match: 'all', items: [] },
    then: [
      {
        id: 's_task',
        kind: 'create_task',
        title: 'Call',
        dueInDays: 1,
        assignee: { kind: 'none' },
      },
    ],
    else: [{ id: 's_mail', kind: 'send_email', template: 'activated' }],
  };

  it('keeps definite words for steps that always run', () => {
    expect(
      flowRunSentence({
        name: 'Dispatched',
        conditional: false,
        steps: flowSteps([{ id: 's1', kind: 'send_email', template: 'dispatched' }]),
        templates,
        leadType: 'sim_order',
      }),
    ).toBe('“Dispatched” runs: sends the “Dispatched” email to the customer.');
  });

  it('says a branch’s steps may happen, depending on its conditions, never that both will', () => {
    const sentence = flowRunSentence({
      name: 'Verified follow-up',
      conditional: false,
      steps: flowSteps([branch]),
      templates,
      leadType: 'sim_order',
    });
    expect(sentence).toBe(
      '“Verified follow-up” runs and may, depending on its conditions: create a task, send the “Activated” email to the customer.',
    );
    const mixed = flowRunSentence({
      name: 'Mixed',
      conditional: true,
      steps: flowSteps([{ id: 's1', kind: 'send_email', template: 'dispatched' }, branch]),
      templates,
      leadType: 'sim_order',
    });
    expect(mixed).toBe(
      '“Mixed” (when its conditions match) runs: sends the “Dispatched” email to the customer; and may, depending on its conditions: create a task, send the “Activated” email to the customer.',
    );
  });
});

describe('side effects and the older shape', () => {
  it('digests side effects in order', () => {
    expect(sideEffectsDigest(['a', 'b'])).not.toBe(sideEffectsDigest(['b', 'a']));
    expect(sideEffectsDigest(['a'])).toMatch(/^[0-9a-f]{64}$/);
  });

  const card = (extra: Partial<AiActionCard>): AiActionCard =>
    aiActionCardSchema.parse({
      id: '40000000-0000-4000-8000-000000000301',
      token: 't',
      expiresAt: '2026-11-19T12:10:00.000Z',
      siteName: 'Site',
      draft: { kind: 'note', leadId: LEAD, body: 'Hi' },
      ...extra,
    });

  it('gives an older admin the older proposal, without the extras', () => {
    expect(legacyProposalOf(card({ sideEffects: ['x'] }))).toEqual({
      id: '40000000-0000-4000-8000-000000000301',
      token: 't',
      expiresAt: '2026-11-19T12:10:00.000Z',
      siteName: 'Site',
      draft: { kind: 'note', leadId: LEAD, body: 'Hi' },
    });
  });

  it('gives an older admin no card it cannot show or confirm', () => {
    expect(legacyProposalOf(card({ acknowledgementRequired: true }))).toBeUndefined();
    expect(
      legacyProposalOf(card({ draft: { kind: 'lead_archive', leadId: LEAD, archived: true } })),
    ).toBeUndefined();
    expect(
      legacyProposalOf(
        card({
          draft: { kind: 'task', title: 'T', dueDate: null, assignee: OTHER },
        }),
      ),
    ).toBeUndefined();
    expect(
      legacyProposalOf(card({ draft: { kind: 'task_update', taskId: OTHER, title: 'New' } })),
    ).toBeUndefined();
  });
});

describe('daily caps (C7)', () => {
  it('counts every change, and mail against its own lower cap too', async () => {
    const keys: string[] = [];
    const allow = async (input: { bucketKey: string }) => {
      keys.push(input.bucketKey);
      return { allowed: true, retryAfterSeconds: 0 };
    };
    expect(await dailyCapRefusal(allow, scope, 'note')).toBeUndefined();
    expect(await dailyCapRefusal(allow, scope, 'template_email')).toBeUndefined();
    // Mail asks its own cap first: a mail its cap refuses is not counted as a change (T10).
    expect(keys).toEqual([
      `ai_card_day:${scope.actorId}:${scope.workspaceId}`,
      `ai_mail_day:${scope.actorId}:${scope.workspaceId}`,
      `ai_card_day:${scope.actorId}:${scope.workspaceId}`,
    ]);
    keys.length = 0;
    const refuseMail = async (input: { bucketKey: string }) => {
      keys.push(input.bucketKey);
      return { allowed: !input.bucketKey.startsWith('ai_mail_day'), retryAfterSeconds: 60 };
    };
    expect(await dailyCapRefusal(refuseMail, scope, 'email')).toEqual({
      reason: 'daily_mail',
      retryAfterSeconds: 60,
    });
    expect(keys).toEqual([`ai_mail_day:${scope.actorId}:${scope.workspaceId}`]);
    expect(await dailyCapRefusal(refuseMail, scope, 'lead_edit')).toBeUndefined();
    await expect(
      dailyCapRefusal(
        async () => {
          throw new Error('down');
        },
        scope,
        'note',
      ),
    ).rejects.toThrow('down');
  });
});
