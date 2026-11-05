import { describe, expect, it } from 'vitest';
import { CUSTOMER_EMAIL_TEMPLATES, codePropertyCatalog, type FlowSite } from '@gt-sales/contracts';

import { flowAttention, type StoredFlow } from '../src/automations/flow-store.js';

const MEMBER = '28000000-0000-4000-8000-00000000a001';
const FORMER = '28000000-0000-4000-8000-00000000a002';

const site: FlowSite = {
  templates: new Map(
    CUSTOMER_EMAIL_TEMPLATES.map((key) => [key, { archived: false, propertyKeys: [] }]),
  ),
  memberIds: new Set([MEMBER]),
  plans: new Map(),
  catalog: codePropertyCatalog,
};

function flowActivatedBy(activatedBy: string | null): StoredFlow {
  return {
    id: '60000000-0000-4000-8000-00000000a001',
    key: 'flow_abcdefghij012345',
    origin: 'custom',
    name: 'Verified follow-up',
    description: null,
    enabled: true,
    archived: false,
    revision: 1,
    activeVersion: {
      id: '70000000-0000-4000-8000-00000000a001',
      version: 1,
      definition: {
        schemaVersion: 1,
        trigger: { kind: 'stage_entered', leadType: 'internet', stage: 'contacted', when: null },
        steps: [{ id: 's_mail', kind: 'send_email', template: 'activated' }],
      },
      activatedAt: new Date('2026-11-01T12:00:00Z'),
      activatedBy,
    },
    draft: null,
    lastRunAt: null,
    runCount: 0,
    createdAt: new Date('2026-11-01T12:00:00Z'),
  };
}

describe('flowAttention', () => {
  it('flags a version whose activator is no longer an active member', () => {
    expect(flowAttention(flowActivatedBy(FORMER), site)).toEqual({
      path: 'activatedBy',
      code: 'activator_unavailable',
      ref: '',
    });
  });

  it('says nothing for an active activator or a built-in seeded without one', () => {
    expect(flowAttention(flowActivatedBy(MEMBER), site)).toBeNull();
    expect(flowAttention(flowActivatedBy(null), site)).toBeNull();
  });
});
