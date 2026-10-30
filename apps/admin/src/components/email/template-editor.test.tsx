import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  EmailTemplate,
  PreviewEmailTemplateRequest,
  PreviewEmailTemplateResponse,
  UpdateEmailTemplateRequest,
} from '@gt-sales/contracts';

import { TemplateEditor } from './template-editor';

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
  return { FakeBackendError };
});

vi.mock('../../lib/api', () => ({ BackendError: mocks.FakeBackendError }));

const dispatched: EmailTemplate = {
  key: 'dispatched',
  subject: 'Your SIM is on its way',
  body: 'Hi {first name},\n\nYour SIM left with {courier}.',
  version: 2,
  updatedAt: '2026-10-01T00:00:00.000Z',
  updatedBy: '30000000-0000-4000-8000-000000000001',
};

const cancelled: EmailTemplate = {
  key: 'cancelled',
  subject: 'Your order was cancelled',
  body: 'Hi {first name},\n\nYour order was cancelled.',
  version: 0,
  updatedAt: null,
  updatedBy: null,
};

function rendered(subject: string): PreviewEmailTemplateResponse {
  return {
    subject,
    html: `<html><body><p>${subject}</p></body></html>`,
    text: `${subject}\n\nPlain words`,
    requestId: 'req_test',
  };
}

function setup(
  template: EmailTemplate = dispatched,
  overrides: {
    preview?: (input: PreviewEmailTemplateRequest) => Promise<PreviewEmailTemplateResponse>;
    onSave?: (input: UpdateEmailTemplateRequest) => Promise<string | undefined>;
    onSendTest?: () => Promise<string | undefined>;
  } = {},
) {
  const preview = vi.fn(
    overrides.preview ??
      ((input: PreviewEmailTemplateRequest) => Promise.resolve(rendered(input.subject))),
  );
  const onSave = vi.fn(overrides.onSave ?? (() => Promise.resolve(undefined)));
  const onSendTest = vi.fn(overrides.onSendTest ?? (() => Promise.resolve('Sent.')));
  render(
    <TemplateEditor
      template={template}
      preview={preview}
      onSave={onSave}
      onSendTest={onSendTest}
    />,
  );
  return { preview, onSave, onSendTest };
}

async function waitPreview(ms = 400) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TemplateEditor fields', () => {
  it('edits the subject and a monospace body, listing only the fill-ins this email may use', () => {
    setup(cancelled);
    expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveProperty(
      'value',
      'Your order was cancelled',
    );
    const body = screen.getByRole('textbox', { name: 'Body' });
    expect(body.className).toContain('font-mono');
    const fillIns = screen.getByRole('region', { name: 'Fill-ins' });
    expect(within(fillIns).getByText('{first name}')).toBeTruthy();
    expect(within(fillIns).getByText('The customer’s first name')).toBeTruthy();
    expect(within(fillIns).getByText('{tracking link}')).toBeTruthy();
    expect(within(fillIns).queryByText('{courier}')).toBeNull();
    expect(within(fillIns).queryByText('{code}')).toBeNull();
    expect(screen.getByRole('region', { name: 'Formatting' })).toBeTruthy();
  });

  it('offers the courier and tracking number to the Dispatched email', () => {
    setup(dispatched);
    const fillIns = screen.getByRole('region', { name: 'Fill-ins' });
    expect(within(fillIns).getByText('{courier}')).toBeTruthy();
    expect(within(fillIns).getByText('{tracking number}')).toBeTruthy();
  });
});

describe('TemplateEditor preview', () => {
  it('previews once per burst of typing, 400 ms after it stops, with the latest words', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { preview } = setup();
    await waitPreview();
    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenLastCalledWith({
      subject: dispatched.subject,
      body: dispatched.body,
    });

    const subject = screen.getByRole('textbox', { name: 'Subject' });
    for (const value of ['Y', 'Yo', 'You', 'Your SIM shipped']) {
      fireEvent.change(subject, { target: { value } });
      await waitPreview(100);
    }
    expect(preview).toHaveBeenCalledTimes(1);
    await waitPreview(300);
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenLastCalledWith({
      subject: 'Your SIM shipped',
      body: dispatched.body,
    });
  });

  it('shows the rendered mail in a sandboxed frame under its subject, and the text in its tab', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup();
    await waitPreview();
    const frame = await screen.findByTitle('Email preview');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<p>Your SIM is on its way</p>');
    expect(
      screen.getByText('Your SIM is on its way', { selector: '[data-preview-subject]' }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Text' }));
    expect(screen.getByRole('tab', { name: 'Text' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Plain words/)).toBeTruthy();
    expect(screen.queryByTitle('Email preview')).toBeNull();
  });

  it('names the fill-in a preview refused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup(dispatched, {
      preview: () =>
        Promise.reject(
          new mocks.FakeBackendError('invalid_fill_in', 400, {
            fillIn: 'tracking nmber',
            where: 'body',
          }),
        ),
    });
    await waitPreview();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Unknown fill-in {tracking nmber}',
    );
  });

  it('says what is wrong with the markup a preview refused', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setup(dispatched, {
      preview: () =>
        Promise.reject(
          new mocks.FakeBackendError('invalid_email_markup', 400, { reason: 'two_buttons' }),
        ),
    });
    await waitPreview();
    expect((await screen.findByRole('alert')).textContent).toContain('one button');
  });
});

describe('TemplateEditor save and test', () => {
  it('saves the subject and body with the version it loaded', async () => {
    const { onSave } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Body' }), {
      target: { value: 'Hi {first name}, it shipped.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        expectedVersion: 2,
        subject: 'Your SIM is on its way',
        body: 'Hi {first name}, it shipped.',
      }),
    );
    expect((await screen.findByRole('status')).textContent).toContain('Saved.');
  });

  it('shows why a save was refused', async () => {
    setup(dispatched, {
      onSave: () => Promise.resolve('This email changed elsewhere. Reload and try again.'),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'This email changed elsewhere. Reload and try again.',
    );
  });

  it('asks for a subject before saving', async () => {
    const { onSave } = setup();
    fireEvent.change(screen.getByRole('textbox', { name: 'Subject' }), { target: { value: ' ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByText('Enter a subject.')).textContent).toBe('Enter a subject.');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('sends a test and shows what happened', async () => {
    const { onSendTest } = setup(dispatched, {
      onSendTest: () => Promise.resolve('Sent to your address: check your inbox.'),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send me a test' }));
    expect(await screen.findByText('Sent to your address: check your inbox.')).toBeTruthy();
    expect(onSendTest).toHaveBeenCalledTimes(1);
  });
});
