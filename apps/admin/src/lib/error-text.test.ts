import { describe, expect, it } from 'vitest';
import { apiErrorCodeSchema } from '@gt-sales/contracts';

import { BackendError } from './api';
import { describeError, describeInvalid, errorKind, isRetryable } from './error-text';

const REQUEST_ID = '3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f';

function backend(code: string, status = 400): BackendError {
  // Any string, so codes the contract does not list yet can be tried too.
  return Object.assign(new BackendError('internal_error', status, REQUEST_ID), { code });
}

describe('errorKind', () => {
  it('reads a failed fetch, a timeout and an abort as offline', () => {
    expect(errorKind(new TypeError('Failed to fetch'))).toBe('offline');
    expect(errorKind(new DOMException('The request timed out.', 'TimeoutError'))).toBe('offline');
    expect(errorKind(new DOMException('Aborted', 'AbortError'))).toBe('offline');
  });

  it('reads an edge 502, 503 or 504 and a status 0 as offline, whatever the code', () => {
    for (const status of [0, 502, 503, 504]) {
      expect(errorKind(backend('internal_error', status))).toBe('offline');
    }
  });

  it('reads internal_error, persistence_unavailable and other 5xx answers as server', () => {
    expect(errorKind(backend('internal_error', 500))).toBe('server');
    expect(errorKind(backend('persistence_unavailable', 500))).toBe('server');
    expect(errorKind(backend('webhook_rejected', 500))).toBe('server');
    expect(errorKind('internal_error')).toBe('server');
  });

  it('reads the sign-in codes as session and the access codes as permission', () => {
    expect(errorKind(backend('missing_session', 401))).toBe('session');
    expect(errorKind(backend('invalid_session', 401))).toBe('session');
    for (const code of [
      'permission_denied',
      'membership_missing',
      'membership_pending',
      'membership_revoked',
      'workspace_not_found',
    ]) {
      expect(errorKind(backend(code, 403))).toBe('permission');
    }
  });

  it('reads a mapped code as known and anything else as unknown', () => {
    expect(errorKind(backend('version_conflict', 409))).toBe('known');
    expect(errorKind('lead_trashed')).toBe('known');
    expect(errorKind(backend('a_code_from_the_future', 409))).toBe('unknown');
    expect(errorKind(new Error('boom'))).toBe('unknown');
    expect(errorKind(undefined)).toBe('unknown');
    // A prototype key is not a mapped code.
    expect(errorKind('constructor')).toBe('unknown');
  });

  it('only offers a retry when trying again may work', () => {
    expect(isRetryable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetryable(backend('internal_error', 500))).toBe(true);
    expect(isRetryable(backend('permission_denied', 403))).toBe(false);
    expect(isRetryable(backend('invalid_session', 401))).toBe(false);
  });
});

describe('describeError', () => {
  it('says the CRM could not be reached, and to check the connection', () => {
    expect(describeError(new TypeError('Failed to fetch'), 'load the leads')).toBe(
      "Couldn't reach the CRM to load the leads. Check your internet connection and try again.",
    );
    expect(describeError(backend('internal_error', 504), 'save the change')).toBe(
      "Couldn't reach the CRM to save the change. Check your internet connection and try again.",
    );
  });

  it('says the CRM had a problem, with the request reference for support', () => {
    expect(describeError(backend('internal_error', 500), 'load the leads')).toBe(
      "The CRM had a problem and couldn't load the leads. Try again in a minute; if it keeps happening, tell your admin. (Ref: 3f2a9c1e)",
    );
  });

  it('leaves the reference out when there is none', () => {
    expect(describeError('internal_error', 'load the leads')).toBe(
      "The CRM had a problem and couldn't load the leads. Try again in a minute; if it keeps happening, tell your admin.",
    );
    expect(describeError(new Error('boom'), 'show this page')).not.toContain('Ref:');
  });

  it('asks the person to sign in again when the sign-in has expired', () => {
    expect(describeError(backend('invalid_session', 401), 'save the change')).toBe(
      'Your sign-in has expired. Sign in again to continue.',
    );
  });

  it('names the action a role may not take, and who can grant it', () => {
    expect(describeError(backend('permission_denied', 403), 'archive the lead')).toBe(
      "You don't have permission to archive the lead. Ask the owner to give your role access.",
    );
    expect(describeError(backend('membership_revoked', 403), 'load the leads')).toBe(
      'Your access to this site was removed. Ask the owner if you need it back.',
    );
  });

  it('explains mapped codes in their own words', () => {
    expect(describeError(backend('version_conflict', 409), 'save the change')).toBe(
      'Someone else changed this while you were editing. Reload the page to see the latest, then try again.',
    );
    expect(describeError(backend('lead_trashed', 409), 'save the note')).toBe(
      'This lead is archived. Restore it first, then try again.',
    );
    expect(describeError(backend('rate_limited', 429), 'search the leads')).toBe(
      'Too many requests in a short time. Wait a minute, then try again.',
    );
    expect(describeError(backend('validation_error', 400), 'save the plan')).toBe(
      "Some of the details aren't valid, so the CRM couldn't save the plan. Check the fields and try again.",
    );
  });

  it('never shows an unknown code; it reads as the server sentence', () => {
    const text = describeError(backend('a_code_from_the_future', 409), 'save the change');
    expect(text).not.toContain('a_code_from_the_future');
    expect(text).toBe(
      "The CRM had a problem and couldn't save the change. Try again in a minute; if it keeps happening, tell your admin. (Ref: 3f2a9c1e)",
    );
  });

  it('has words for every code the backend can send, none of them a raw code', () => {
    for (const code of apiErrorCodeSchema.options) {
      const text = describeError(backend(code, 409), 'save the change');
      expect(text).not.toContain(code);
      expect(text).not.toMatch(/!/);
      expect(text).toMatch(/[.)]$/);
    }
  });
});

describe('describeInvalid', () => {
  const labels = { name: 'The name', priceMinor: 'The price', label: 'An option label' };

  it('names the field and its length limit', () => {
    expect(
      describeInvalid(
        { issues: [{ code: 'too_big', origin: 'string', maximum: 120, path: ['name'] }] },
        labels,
      ),
    ).toBe('The name can be at most 120 characters.');
    expect(
      describeInvalid(
        { issues: [{ code: 'too_small', origin: 'string', minimum: 1, path: ['name'] }] },
        labels,
      ),
    ).toBe("The name can't be empty. Fill it in.");
  });

  it('names a number limit and a nested field by its own label', () => {
    expect(
      describeInvalid(
        {
          issues: [{ code: 'too_big', origin: 'number', maximum: 1_000_000, path: ['priceMinor'] }],
        },
        labels,
      ),
    ).toBe('The price can be at most 1,000,000.');
    expect(
      describeInvalid(
        {
          issues: [
            { code: 'too_big', origin: 'string', maximum: 80, path: ['options', 2, 'label'] },
          ],
        },
        labels,
      ),
    ).toBe('An option label can be at most 80 characters.');
  });

  it('falls back to a general sentence for a field it has no label for', () => {
    expect(describeInvalid({ issues: [{ code: 'custom', path: ['other'] }] }, labels)).toBe(
      "One of the fields isn't valid. Check it and try again.",
    );
  });
});
