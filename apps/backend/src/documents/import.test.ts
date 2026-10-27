import { describe, expect, it, vi } from 'vitest';

import { InMemoryR2DocumentStore, sha256Hex } from '@gt-sales/adapters';
import { LEGACY_IMPORT_ACTOR_ID } from '@gt-sales/contracts';
import type { ClaimedJob } from '@gt-sales/jobs';

import { createLegacyDocumentImportHandler, isLeadSourceKey } from './import-job.js';
import { importedObjectKey } from './keys.js';
import { InMemoryDocumentRecordStore } from './memory-store.js';
import { DocumentService, type DocumentContextResolver } from './service.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000a51';
const LEAD = '40000000-0000-4000-8000-000000000a51';
const FILE = '50000000-0000-4000-8000-000000000a51';
const ACTOR = '20000000-0000-4000-8000-000000000a51';
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const HTML = new Uint8Array([0x3c, 0x21, 0x44, 0x4f, 0x43, 0x54, 0x59, 0x50, 0x45]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const SOURCE = `orders/${LEAD}/passport.pdf`;

function setup(leadFound = true) {
  const store = new InMemoryDocumentRecordStore();
  const r2 = new InMemoryR2DocumentStore();
  const resolver: DocumentContextResolver = {
    resolveChecklist: async () => (leadFound ? { found: true, allowed: [] } : { found: false }),
    resolveOrderLeadId: async () => undefined,
  };
  const service = new DocumentService(store, r2, resolver, { bucket: 'documents' });
  return { store, r2, service };
}

const importInput = {
  workspaceId: WORKSPACE,
  actorId: ACTOR,
  requestId: '60000000-0000-4000-8000-000000000a51',
  fileId: FILE,
  leadId: LEAD,
  documentType: 'passport',
  sourceKey: SOURCE,
  uploadedAt: new Date('2026-09-01T10:00:00Z'),
};

describe('DocumentService.importWebsiteDocument', () => {
  it('copies the website object onto the lead, verified, as from the old admin', async () => {
    const { store, r2, service } = setup();
    r2.putObject(SOURCE, PDF);
    const outcome = await service.importWebsiteDocument(importInput);
    expect(outcome).toMatchObject({ status: 'imported' });
    const file = store.snapshot(FILE);
    expect(file).toMatchObject({
      recordType: 'lead',
      recordId: LEAD,
      documentType: 'passport',
      status: 'available',
      objectKey: importedObjectKey(WORKSPACE, FILE),
      detectedMime: 'application/pdf',
      sizeBytes: PDF.byteLength,
      checksumSha256: sha256Hex(PDF),
      uploadedBy: LEGACY_IMPORT_ACTOR_ID,
      createdAt: importInput.uploadedAt,
    });
    expect(r2.getObject(importedObjectKey(WORKSPACE, FILE))).toEqual(PDF);
    // The website's own object stays exactly where it was.
    expect(r2.getObject(SOURCE)).toEqual(PDF);

    // Run again (a retried job): the same file, no second copy.
    const copy = vi.spyOn(r2, 'importObject');
    expect(await service.importWebsiteDocument(importInput)).toMatchObject({
      status: 'already_imported',
      file: { id: FILE },
    });
    expect(copy).not.toHaveBeenCalled();
  });

  it('copies nothing onto a lead that is gone or restricted', async () => {
    const { r2, service } = setup(false);
    r2.putObject(SOURCE, PDF);
    const copy = vi.spyOn(r2, 'importObject');
    expect(await service.importWebsiteDocument(importInput)).toEqual({
      status: 'lead_not_found',
    });
    expect(copy).not.toHaveBeenCalled();
  });

  it('reports a source that is no longer there', async () => {
    const { service } = setup();
    expect(await service.importWebsiteDocument(importInput)).toEqual({
      status: 'source_missing',
    });
  });

  it.each([
    ['not a document', HTML],
    ['WebP, which files never hold', WEBP],
  ])('rejects %s and removes its copy', async (_label, bytes) => {
    const { store, r2, service } = setup();
    r2.putObject(SOURCE, bytes);
    expect(await service.importWebsiteDocument(importInput)).toEqual({
      status: 'rejected',
      reason: 'unsupported_signature',
    });
    expect(r2.has(importedObjectKey(WORKSPACE, FILE))).toBe(false);
    expect(store.snapshot(FILE)).toBeUndefined();
  });
});

describe('DocumentService.issueDownload disposition', () => {
  it('views inline for staff, while a website always downloads', async () => {
    const { store, r2, service } = setup();
    r2.putObject(SOURCE, PDF);
    await service.importWebsiteDocument(importInput);
    const scope = { workspaceId: WORKSPACE, actorId: ACTOR, fileId: FILE, requestId: 'r' };

    const staff = await service.issueDownload({ ...scope, disposition: 'inline' });
    expect(staff).toMatchObject({ status: 'issued', url: expect.stringContaining('inline') });
    const website = await service.issueDownload({
      ...scope,
      ownedLeadId: LEAD,
      disposition: 'inline',
    });
    expect(website).toMatchObject({ status: 'issued', url: expect.stringContaining('attachment') });
    expect(store.audits.map(({ audience, disposition }) => [audience, disposition])).toEqual([
      ['staff', 'inline'],
      ['website', 'attachment'],
    ]);
  });
});

function job(payload: unknown, overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: '70000000-0000-4000-8000-000000000a51',
    workspaceId: WORKSPACE,
    jobType: 'legacy_document_import',
    messageId: FILE,
    payloadVersion: 1,
    payload,
    attempts: 1,
    leaseOwnerId: '80000000-0000-4000-8000-000000000a51',
    actorId: ACTOR,
    ...overrides,
  };
}

describe('legacy_document_import job', () => {
  const payload = {
    leadId: LEAD,
    documentType: 'passport',
    sourceKey: SOURCE,
    uploadedAt: '2026-09-01T10:00:00.000Z',
  };

  it('imports under the job message id, and completes again on a rerun', async () => {
    const { r2, service } = setup();
    r2.putObject(SOURCE, PDF);
    const handler = createLegacyDocumentImportHandler(service);
    expect(await handler(job(payload))).toEqual({
      status: 'completed',
      providerId: `file:${FILE}`,
    });
    expect(await handler(job(payload))).toEqual({
      status: 'completed',
      providerId: `file:${FILE}`,
    });
  });

  it('completes as skipped when the lead or the source is gone', async () => {
    const gone = setup(false);
    expect(await createLegacyDocumentImportHandler(gone.service)(job(payload))).toEqual({
      status: 'completed',
      providerId: 'skipped:lead_not_found',
    });
    const missing = setup();
    expect(await createLegacyDocumentImportHandler(missing.service)(job(payload))).toEqual({
      status: 'completed',
      providerId: 'skipped:source_missing',
    });
  });

  it('fails, to be seen, on bytes that are not a document', async () => {
    const { r2, service } = setup();
    r2.putObject(SOURCE, HTML);
    await expect(createLegacyDocumentImportHandler(service)(job(payload))).rejects.toMatchObject({
      code: 'document_unsupported_signature',
      retryable: false,
    });
  });

  it.each([
    ['another lead’s folder', { sourceKey: `orders/${FILE}/passport.pdf` }],
    ['a workspace object', { sourceKey: `workspaces/${WORKSPACE}/candidate/x` }],
    ['a path that climbs out', { sourceKey: `orders/${LEAD}/../x.pdf` }],
    ['an unknown document type', { documentType: 'selfie' }],
    ['an extra field', { note: 'hello' }],
  ])('refuses %s without reading storage', async (_label, change) => {
    const { r2, service } = setup();
    const copy = vi.spyOn(r2, 'importObject');
    await expect(
      createLegacyDocumentImportHandler(service)(job({ ...payload, ...change })),
    ).rejects.toMatchObject({ code: 'invalid_job_payload', retryable: false });
    expect(copy).not.toHaveBeenCalled();
  });

  it('waits for object storage without spending an attempt', async () => {
    const now = new Date('2026-10-27T12:00:00Z');
    expect(await createLegacyDocumentImportHandler(undefined, () => now)(job(payload))).toEqual({
      status: 'retry',
      errorCode: 'feature_not_ready',
      availableAt: new Date('2026-10-27T13:00:00Z'),
      preserveAttempt: true,
    });
  });

  it('binds a source key to its own lead only', () => {
    expect(isLeadSourceKey(LEAD, `orders/${LEAD}/passport-1.jpg`)).toBe(true);
    expect(isLeadSourceKey(LEAD, `partners/${LEAD}/license.pdf`)).toBe(true);
    expect(isLeadSourceKey(LEAD.toUpperCase(), `orders/${LEAD}/sim-photo.jpg`)).toBe(true);
    expect(isLeadSourceKey(LEAD, `orders/${LEAD}/..`)).toBe(false);
    expect(isLeadSourceKey(LEAD, `orders/${LEAD}/a/b.pdf`)).toBe(false);
    expect(isLeadSourceKey(LEAD, `invoices/${LEAD}/a.pdf`)).toBe(false);
  });
});
