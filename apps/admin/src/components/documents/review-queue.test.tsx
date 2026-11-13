import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DocumentReviewQueueResponse } from '@gt-sales/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DocumentReviewQueue } from './review-queue';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const LEAD = '40000000-0000-4000-8000-000000000001';
const FILE = '50000000-0000-4000-8000-000000000001';

const mocks = vi.hoisted(() => ({
  listDocumentReviewQueue: vi.fn(),
  reviewFile: vi.fn(),
  createFileDownloadLink: vi.fn(),
}));
vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class BackendError extends Error {
    readonly code: string;
    constructor(code: string) {
      super(code);
      this.code = code;
    }
  },
}));
vi.mock('../staff-session-provider', () => ({
  useStaffSession: () => ({
    accessToken: 'staff-token',
    workspaces: [{ id: WORKSPACE, slug: 'getcanadasim', roles: ['owner'] }],
  }),
}));

function answer(overrides: Partial<DocumentReviewQueueResponse> = {}): DocumentReviewQueueResponse {
  return {
    items: [
      {
        document: {
          id: FILE,
          documentType: 'passport',
          contentType: 'application/pdf',
          sizeBytes: 2048,
          revision: 1,
          createdAt: '2026-11-04T12:00:00.000Z',
          review: null,
        },
        lead: {
          id: LEAD,
          leadType: 'sim_order',
          stage: 'pending',
          externalRef: 'MS-4',
          name: 'Nadia Khan',
        },
        required: true,
      },
    ],
    counts: { toReview: 1, rejected: 2 },
    page: { page: 1, pageSize: 50, total: 1 },
    access: { review: true, download: true },
    requestId: 'req_test',
    ...overrides,
  };
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listDocumentReviewQueue.mockResolvedValue(answer());
});

describe('DocumentReviewQueue', () => {
  it('lists what needs review with the lead, its plan requirement and both counts', async () => {
    render(<DocumentReviewQueue workspaceSlug="getcanadasim" />);
    const list = await screen.findByRole('list', { name: 'To review documents' });
    expect(within(list).getByRole('link', { name: 'Nadia Khan' }).getAttribute('href')).toBe(
      `/w/getcanadasim/leads/${LEAD}`,
    );
    expect(within(list).getByText('MS-4 · SIM order · Pending')).toBeTruthy();
    expect(within(list).getByText('Required by plan')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /To review\s*1/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('tab', { name: /Rejected\s*2/ })).toBeTruthy();
    expect(mocks.listDocumentReviewQueue).toHaveBeenCalledWith('staff-token', WORKSPACE, {
      status: 'to_review',
      page: 1,
    });
  });

  it('approves in place, names whose document it is, and reloads the queue', async () => {
    mocks.reviewFile.mockResolvedValue({});
    render(<DocumentReviewQueue workspaceSlug="getcanadasim" />);
    mocks.listDocumentReviewQueue.mockResolvedValue(
      answer({ items: [], counts: { toReview: 0, rejected: 2 } }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Approve Passport for Nadia Khan' }));
    await waitFor(() =>
      expect(mocks.reviewFile).toHaveBeenCalledWith('staff-token', WORKSPACE, FILE, {
        decision: 'approved',
      }),
    );
    expect(await screen.findByText(/Nothing to review/)).toBeTruthy();
    expect(mocks.listDocumentReviewQueue).toHaveBeenCalledTimes(2);
  });

  it('switches to rejected documents from the first page', async () => {
    render(<DocumentReviewQueue workspaceSlug="getcanadasim" />);
    fireEvent.click(await screen.findByRole('tab', { name: /Rejected/ }));
    await waitFor(() =>
      expect(mocks.listDocumentReviewQueue).toHaveBeenLastCalledWith('staff-token', WORKSPACE, {
        status: 'rejected',
        page: 1,
      }),
    );
  });

  it('hides review and open actions the role does not have, and says why', async () => {
    mocks.listDocumentReviewQueue.mockResolvedValue(
      answer({ access: { review: false, download: false } }),
    );
    render(<DocumentReviewQueue workspaceSlug="getcanadasim" />);
    await screen.findByRole('link', { name: 'Nadia Khan' });
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /View/ })).toBeNull();
    expect(screen.getByText(/Approving and rejecting needs the Orders role/)).toBeTruthy();
  });

  it('explains a role that may not see customer documents', async () => {
    const { BackendError } = await import('../../lib/api');
    mocks.listDocumentReviewQueue.mockRejectedValue(
      new BackendError('permission_denied', 403, 'r'),
    );
    render(<DocumentReviewQueue workspaceSlug="getcanadasim" />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Your role doesn't show customer documents. Ask the owner if you need to review them.",
    );
  });
});
