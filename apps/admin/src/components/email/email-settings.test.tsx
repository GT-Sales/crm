import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_EMAIL_TEMPLATES,
  type CustomerEmailTemplate,
  type EmailSettingsResponse,
  type EmailTemplate,
  type UpdateEmailSettingsRequest,
} from '@gt-sales/contracts';

import { EmailSettings, EmailSettingsScreen } from './email-settings';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const STAMP = '2026-10-01T00:00:00.000Z';
const STAFF = '30000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => {
  class FakeBackendError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly details?: Record<string, unknown>,
    ) {
      super(code);
    }
  }
  return {
    FakeBackendError,
    getEmailSettings: vi.fn(),
    updateEmailSettings: vi.fn(),
    listEmailTemplates: vi.fn(),
    updateEmailTemplate: vi.fn(),
    previewEmailTemplate: vi.fn(),
    sendTestEmail: vi.fn(),
  };
});

vi.mock('../../lib/api', () => ({
  getEmailSettings: mocks.getEmailSettings,
  updateEmailSettings: mocks.updateEmailSettings,
  listEmailTemplates: mocks.listEmailTemplates,
  updateEmailTemplate: mocks.updateEmailTemplate,
  previewEmailTemplate: mocks.previewEmailTemplate,
  sendTestEmail: mocks.sendTestEmail,
  BackendError: mocks.FakeBackendError,
}));

vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'canadawide', roles: ['owner'] }],
  }),
}));

const saved: EmailSettingsResponse = {
  settings: {
    fromName: 'CanadaWide',
    fromAddress: 'orders@canadawide.example',
    replyTo: null,
    logoUrl: null,
    brandColor: '#123abc',
    footerText: 'CanadaWide, Toronto',
    siteUrl: 'https://canadawide.example',
    updatedAt: STAMP,
    updatedBy: STAFF,
  },
  fallback: null,
  requestId: 'req_test',
};

const unsaved: EmailSettingsResponse = {
  settings: null,
  fallback: {
    fromName: 'CanadaWide',
    fromAddress: 'hello@canadawide.example',
    siteUrl: 'https://canadawide.example',
  },
  requestId: 'req_test',
};

function template(key: CustomerEmailTemplate, version = 0): EmailTemplate {
  return {
    key,
    subject: `Subject of ${key}`,
    body: `Body of ${key}`,
    version,
    updatedAt: version === 0 ? null : STAMP,
    updatedBy: version === 0 ? null : STAFF,
  };
}

const templates = CUSTOMER_EMAIL_TEMPLATES.map((key) =>
  template(key, key === 'dispatched' ? 4 : 0),
);

const field = (name: string) => screen.getByRole('textbox', { name });

describe('EmailSettings form', () => {
  it('saves the whole form, the brand colour in lower case and empty fields as null', async () => {
    const onSave = vi.fn((_input: UpdateEmailSettingsRequest) => Promise.resolve(undefined));
    render(<EmailSettings initial={saved} onSave={onSave} />);
    fireEvent.change(field('Brand colour'), { target: { value: '#AABBCC' } });
    expect(screen.getByLabelText('Brand colour picker')).toHaveProperty('value', '#aabbcc');
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        fromName: 'CanadaWide',
        fromAddress: 'orders@canadawide.example',
        replyTo: null,
        logoUrl: null,
        brandColor: '#aabbcc',
        footerText: 'CanadaWide, Toronto',
        siteUrl: 'https://canadawide.example',
      }),
    );
    expect((await screen.findByRole('status')).textContent).toContain('Saved.');
  });

  it('keeps the picker and the text field in step', () => {
    render(<EmailSettings initial={saved} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Brand colour picker'), {
      target: { value: '#00ff00' },
    });
    expect(field('Brand colour')).toHaveProperty('value', '#00ff00');
  });

  it('explains a sender address and refuses a malformed colour', async () => {
    const onSave = vi.fn();
    render(<EmailSettings initial={saved} onSave={onSave} />);
    expect(
      screen.getByText('Must be on a domain verified in Resend; send yourself a test to check.'),
    ).toBeTruthy();
    fireEvent.change(field('Brand colour'), { target: { value: 'red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByText(/Enter a colour as #rrggbb/)).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('starts from the server’s sender when nothing is saved, and says so', () => {
    render(<EmailSettings initial={unsaved} onSave={vi.fn()} />);
    expect(
      screen.getByText(
        "Not saved yet: mail goes out as CanadaWide <hello@canadawide.example> from the server's configuration.",
      ),
    ).toBeTruthy();
    expect(field('Sender name')).toHaveProperty('value', 'CanadaWide');
    expect(field('Sender address')).toHaveProperty('value', 'hello@canadawide.example');
    expect(field('Site address')).toHaveProperty('value', 'https://canadawide.example');
    expect(field('Brand colour')).toHaveProperty('value', '#d72638');
  });

  it('shows no note once the settings are saved', () => {
    render(<EmailSettings initial={saved} onSave={vi.fn()} />);
    expect(screen.queryByText(/Not saved yet/)).toBeNull();
  });
});

describe('EmailSettingsScreen', () => {
  beforeEach(() => {
    for (const mock of [
      mocks.getEmailSettings,
      mocks.updateEmailSettings,
      mocks.listEmailTemplates,
      mocks.updateEmailTemplate,
      mocks.previewEmailTemplate,
      mocks.sendTestEmail,
    ]) {
      mock.mockReset();
    }
    mocks.getEmailSettings.mockResolvedValue(saved);
    mocks.listEmailTemplates.mockResolvedValue({ templates, requestId: 'req_test' });
    mocks.previewEmailTemplate.mockResolvedValue({
      subject: 'Subject of dispatched',
      html: '<p>Body</p>',
      text: 'Body',
      requestId: 'req_test',
    });
  });

  it('loads the settings and the templates of the site', async () => {
    render(<EmailSettingsScreen workspaceSlug="canadawide" />);
    expect(await screen.findByRole('list', { name: 'Emails' })).toBeTruthy();
    expect(mocks.getEmailSettings).toHaveBeenCalledWith('staff-token', WORKSPACE);
    expect(mocks.listEmailTemplates).toHaveBeenCalledWith('staff-token', WORKSPACE);
    expect(field('Sender name')).toHaveProperty('value', 'CanadaWide');
  });

  it('opens the editor of the template the address names', async () => {
    render(<EmailSettingsScreen workspaceSlug="canadawide" initialTemplate="dispatched" />);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Dispatched' })).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'Subject' })).toHaveProperty(
      'value',
      'Subject of dispatched',
    );
  });

  it('saves the settings and reads them back', async () => {
    mocks.updateEmailSettings.mockResolvedValue(saved);
    render(<EmailSettingsScreen workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(mocks.updateEmailSettings).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        expect.objectContaining({ fromName: 'CanadaWide', brandColor: '#123abc' }),
      ),
    );
    await waitFor(() => expect(mocks.getEmailSettings).toHaveBeenCalledTimes(2));
  });

  it('saves a template with its version and reports a conflict in words', async () => {
    mocks.updateEmailTemplate.mockRejectedValue(
      new mocks.FakeBackendError('version_conflict', 409),
    );
    render(<EmailSettingsScreen workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Dispatched' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(mocks.updateEmailTemplate).toHaveBeenCalledWith(
        'staff-token',
        WORKSPACE,
        'dispatched',
        {
          expectedVersion: 4,
          subject: 'Subject of dispatched',
          body: 'Body of dispatched',
        },
      ),
    );
    expect(
      await within(dialog).findByText('This email changed elsewhere. Reload and try again.'),
    ).toBeTruthy();
  });

  it('sends a test of the template', async () => {
    mocks.sendTestEmail.mockResolvedValue({ queued: true, requestId: 'req_test' });
    render(<EmailSettingsScreen workspaceSlug="canadawide" initialTemplate="dispatched" />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send me a test' }));
    expect(await within(dialog).findByText('Sent to your address: check your inbox.')).toBeTruthy();
    expect(mocks.sendTestEmail).toHaveBeenCalledWith('staff-token', WORKSPACE, 'dispatched');
  });

  it('says when a test was already sent this minute', async () => {
    mocks.sendTestEmail.mockResolvedValue({ queued: false, requestId: 'req_test' });
    render(<EmailSettingsScreen workspaceSlug="canadawide" initialTemplate="dispatched" />);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send me a test' }));
    expect(await within(dialog).findByText('A test was already sent this minute.')).toBeTruthy();
  });

  it('says the Integrations permission is needed when the site refuses', async () => {
    mocks.getEmailSettings.mockRejectedValue(new mocks.FakeBackendError('permission_denied', 403));
    render(<EmailSettingsScreen workspaceSlug="canadawide" />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This needs the Integrations permission (the owner has it).',
    );
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });

  it('turns the page read-only when a save is refused for lack of permission', async () => {
    mocks.updateEmailSettings.mockRejectedValue(
      new mocks.FakeBackendError('permission_denied', 403),
    );
    render(<EmailSettingsScreen workspaceSlug="canadawide" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save settings' }));
    expect(
      (await screen.findAllByText('This needs the Integrations permission (the owner has it).'))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save settings' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  });
});
