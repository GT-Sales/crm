import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LeadDocument } from '@gt-sales/contracts';

import { LeadDocuments } from './lead-documents';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const NOW = '2026-10-30T12:00:00.000Z';
const PASSPORT = '50000000-0000-4000-8000-000000000011';

const mocks = vi.hoisted(() => ({ reviewFile: vi.fn(), createFileDownloadLink: vi.fn() }));

vi.mock('../../lib/api', () => ({
  ...mocks,
  BackendError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

const passport: LeadDocument = {
  id: PASSPORT,
  documentType: 'passport',
  contentType: 'application/pdf',
  sizeBytes: 1_258_291,
  revision: 1,
  createdAt: NOW,
  review: null,
};
const visa: LeadDocument = {
  ...passport,
  id: '50000000-0000-4000-8000-000000000012',
  documentType: 'visa',
  review: { decision: 'approved', at: NOW },
};
const permit: LeadDocument = {
  ...passport,
  id: '50000000-0000-4000-8000-000000000013',
  documentType: 'study_permit',
  review: { decision: 'rejected', at: NOW },
};

function documents(canReview: boolean, onReviewed = vi.fn(async () => undefined)) {
  render(
    <LeadDocuments
      accessToken="staff-token"
      workspaceId={WORKSPACE}
      documents={[passport, visa, permit]}
      canDownload={false}
      canReview={canReview}
      onReviewed={onReviewed}
    />,
  );
  return {
    onReviewed,
    rows: within(screen.getByRole('list', { name: 'Documents' })).getAllByRole('listitem'),
  };
}

describe('LeadDocuments', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it('shows each document’s review, and no review controls without the permission', () => {
    const { rows } = documents(false);
    expect(
      rows.map((row) => within(row).getByText(/^(Not reviewed|Approved|Rejected)$/).textContent),
    ).toEqual(['Not reviewed', 'Approved', 'Rejected']);
    expect(screen.queryByRole('button', { name: /^(Approve|Reject) / })).toBeNull();
  });

  it('approves or rejects a document, then has the record reloaded', async () => {
    mocks.reviewFile.mockResolvedValue({ file: {}, requestId: NOW });
    const { onReviewed } = documents(true);
    fireEvent.click(screen.getByRole('button', { name: 'Approve Passport' }));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    expect(mocks.reviewFile).toHaveBeenCalledWith('staff-token', WORKSPACE, PASSPORT, {
      decision: 'approved',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reject Visa or approval letter' }));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(2));
    expect(mocks.reviewFile).toHaveBeenLastCalledWith('staff-token', WORKSPACE, visa.id, {
      decision: 'rejected',
    });
  });

  it('says why a review was not saved, and reloads nothing', async () => {
    const { BackendError } = await import('../../lib/api');
    mocks.reviewFile.mockRejectedValue(new BackendError('file_not_available', 409, NOW));
    const { onReviewed } = documents(true);
    fireEvent.click(screen.getByRole('button', { name: 'Reject Passport' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The review was not saved. Reason: file_not_available.',
    );
    expect(onReviewed).not.toHaveBeenCalled();
  });
});
