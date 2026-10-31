import { FakeEmailAdapter } from '@gt-sales/adapters';
import type { ClaimedJob, EmailDeliveryRecorder, EmailEligibilityChecker } from '@gt-sales/jobs';
import { describe, expect, it } from 'vitest';

import {
  createStaffNotificationHandler,
  staffNotificationEnvironmentFromEnv,
  type StaffNotificationEnvironment,
  type StaffNotificationMembers,
} from '../src/automations/staff-notification.js';

const SITE = '18000000-0000-4000-8000-000000008501';
const MEMBER = '28000000-0000-4000-8000-000000008501';
const RUNNER = '28000000-0000-4000-8000-000000008599';
const LEAD = '38000000-0000-4000-8000-000000008501';

const environment: StaffNotificationEnvironment = {
  ready: true,
  adminOrigin: 'https://crm.example',
  sender: { fromName: 'GT Sales CRM', fromAddress: 'crm@gt.example' },
  contactHash: (address) => `hash:${address.length}`,
};

const payload = (note: string) => ({
  actorId: MEMBER,
  flowKey: 'flow_abcdefghij012345',
  flowName: 'Follow up new orders',
  siteName: 'GetCanadaSim',
  leadId: LEAD,
  leadPath: `/w/getcanadasim/leads/${LEAD}`,
  note,
});

const job = (body: unknown): ClaimedJob => ({
  id: '58000000-0000-4000-8000-000000008501',
  workspaceId: SITE,
  jobType: 'staff_notification_email',
  messageId: '68000000-0000-4000-8000-000000008501',
  payloadVersion: 1,
  payload: body,
  attempts: 1,
  leaseOwnerId: 'test',
  actorId: RUNNER,
});

const eligible: EmailEligibilityChecker = {
  checkTransactional: async () => ({ eligible: true }),
  checkMarketing: async () => ({ eligible: true }),
};

const members = (
  member: Awaited<ReturnType<StaffNotificationMembers['readMember']>>,
): StaffNotificationMembers => ({ readMember: async () => member });

describe('the staff notification mail', () => {
  it('names the flow and links the lead, with the note on its own line, from the deployment sender', async () => {
    const email = new FakeEmailAdapter();
    const prepared: Array<Parameters<EmailDeliveryRecorder['prepare']>[0]> = [];
    const handler = createStaffNotificationHandler({
      email,
      eligibility: eligible,
      delivery: {
        prepare: async (input) => {
          prepared.push(input);
        },
        recordResult: async () => {},
      },
      environment,
      members: members({ active: true, notificationEmail: 'sam@staff.example' }),
    });
    const result = await handler(job(payload('Call them before noon.')));
    expect(result).toMatchObject({ status: 'completed' });
    expect(email.deliveries).toHaveLength(1);
    const [sent] = email.deliveries;
    expect(sent).toMatchObject({
      workspaceId: SITE,
      template: 'staff_notification',
      toAddress: 'sam@staff.example',
      sender: { fromName: 'GT Sales CRM', fromAddress: 'crm@gt.example' },
    });
    expect(sent?.rendered?.subject).toBe('GetCanadaSim: Follow up new orders');
    const lines = sent?.rendered?.text.split('\n') ?? [];
    expect(lines[0]).toBe(
      `The automation "Follow up new orders" asks you to look at a lead: https://crm.example/w/getcanadasim/leads/${LEAD}`,
    );
    expect(lines).toContain('Call them before noon.');
    expect(sent?.rendered?.html).toContain('<p>Call them before noon.</p>');
    expect(prepared).toEqual([
      expect.objectContaining({
        template: 'staff_notification',
        messageClass: 'transactional',
        contactHash: 'hash:17',
      }),
    ]);
  });

  it('escapes the note in the HTML and leaves a missing note out', async () => {
    const email = new FakeEmailAdapter();
    const handler = createStaffNotificationHandler({
      email,
      eligibility: eligible,
      environment,
      members: members({ active: true, notificationEmail: 'sam@staff.example' }),
    });
    await handler(job(payload('<b>now</b>')));
    expect(email.deliveries[0]?.rendered?.html).toContain('&lt;b&gt;now&lt;/b&gt;');
    const plain = new FakeEmailAdapter();
    await createStaffNotificationHandler({
      email: plain,
      eligibility: eligible,
      environment,
      members: members({ active: true, notificationEmail: 'sam@staff.example' }),
    })(job(payload('')));
    expect(plain.deliveries[0]?.rendered?.text.split('\n')).toHaveLength(1);
  });

  it('skips a revoked member and a member without an address', async () => {
    for (const [member, reason] of [
      [undefined, 'member_unavailable'],
      [{ active: false, notificationEmail: 'sam@staff.example' }, 'member_unavailable'],
      [{ active: true, notificationEmail: null }, 'member_has_no_address'],
    ] as const) {
      const email = new FakeEmailAdapter();
      const handler = createStaffNotificationHandler({
        email,
        eligibility: eligible,
        environment,
        members: members(member),
      });
      expect(await handler(job(payload('')))).toEqual({
        status: 'completed',
        providerId: `skipped:${reason}`,
      });
      expect(email.deliveries).toEqual([]);
    }
  });

  it('carries no customer detail: the mail is the payload’s keys and names only', async () => {
    const email = new FakeEmailAdapter();
    await createStaffNotificationHandler({
      email,
      eligibility: eligible,
      environment,
      members: members({ active: true, notificationEmail: 'sam@staff.example' }),
    })(job(payload('')));
    const text = email.deliveries[0]?.rendered?.text ?? '';
    expect(text).not.toContain('@');
    expect(text).toBe(
      `The automation "Follow up new orders" asks you to look at a lead: https://crm.example/w/getcanadasim/leads/${LEAD}`,
    );
  });

  it('refuses a payload that does not parse', async () => {
    const handler = createStaffNotificationHandler({
      email: new FakeEmailAdapter(),
      eligibility: eligible,
      environment,
      members: members({ active: true, notificationEmail: 'sam@staff.example' }),
    });
    await expect(handler(job({ ...payload(''), leadPath: '/w/../leads/x' }))).rejects.toThrow(
      'invalid_job_payload',
    );
  });

  it('is ready only with a sender the deployment can send from', () => {
    const secret = { EMAIL_CONTACT_HASH_SECRET: 'ci-email-contact-hash-secret-0123456789' };
    expect(
      staffNotificationEnvironmentFromEnv({
        ...secret,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 're_test',
        RESEND_FROM_NAME: 'GT Sales CRM',
        RESEND_FROM_EMAIL: 'crm@gt.example',
        ADMIN_ORIGIN: 'https://crm.example/',
      }),
    ).toMatchObject({
      ready: true,
      adminOrigin: 'https://crm.example',
      sender: { fromName: 'GT Sales CRM', fromAddress: 'crm@gt.example' },
    });
    expect(
      staffNotificationEnvironmentFromEnv({
        ...secret,
        EMAIL_PROVIDER: 'resend',
        RESEND_API_KEY: 'k',
      }).ready,
    ).toBe(false);
    expect(
      staffNotificationEnvironmentFromEnv({ ...secret, EMAIL_PROVIDER: 'fake', NODE_ENV: 'test' })
        .ready,
    ).toBe(true);
    expect(
      staffNotificationEnvironmentFromEnv({
        ...secret,
        EMAIL_PROVIDER: 'fake',
        NODE_ENV: 'production',
      }).ready,
    ).toBe(false);
    expect(staffNotificationEnvironmentFromEnv({}).ready).toBe(false);
  });
});
