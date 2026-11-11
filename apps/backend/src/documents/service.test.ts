import { describe, expect, it, vi } from 'vitest';

import { InMemoryR2DocumentStore } from '@gt-sales/adapters';

import { InMemoryDocumentRecordStore } from './memory-store.js';
import { DocumentService, type BackupLeaseGate, type DocumentContextResolver } from './service.js';

const resolver: DocumentContextResolver = {
  resolveChecklist: async () => ({ found: true, allowed: ['passport'] }),
  resolveOrderLeadId: async () => undefined,
};

/**
 * IMPLEMENTATION_PLAN §13: the expired-upload sweep must not hand back
 * physical-delete keys while the independent backup runner's lease is active,
 * so it cannot race the backup's referenced-object manifest/copy step.
 */
describe('DocumentService.runCleanup backup-lease gate', () => {
  // REL-18: the sweep used to expire the rows during a backup and drop their
  // keys, so those objects could never be deleted. Now nothing changes during
  // a backup and the same intent is expired, with its keys, once it ends.
  it('leaves expired intents untouched during a backup and expires them, with keys, afterwards', async () => {
    const store = new InMemoryDocumentRecordStore();
    const r2 = new InMemoryR2DocumentStore();
    let active = true;
    const backupLease: BackupLeaseGate = { isActive: async () => active };
    const service = new DocumentService(store, r2, resolver, { backupLease });

    const intent = await service.createIntent({
      workspaceId: 'w1',
      actorId: 'a1',
      requestId: 'r1',
      recordType: 'order',
      recordId: 'order-1',
      documentType: 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 10,
    });
    expect(intent.status).toBe('created');

    // Force the intent to be treated as expired regardless of TTL.
    const expiredService = new DocumentService(store, r2, resolver, {
      backupLease,
      now: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      cleanupGraceSeconds: 0,
    });

    const whileLeased = await expiredService.runCleanup({ workspaceId: 'w1', actorId: 'a1' });
    expect(whileLeased).toEqual({ expiredIntents: 0, cleanedObjects: [] });

    active = false;
    const afterBackup = await expiredService.runCleanup({ workspaceId: 'w1', actorId: 'a1' });
    expect(afterBackup.expiredIntents).toBe(1);
    expect(afterBackup.cleanedObjects.length).toBeGreaterThan(0);
  });

  it('sweepExpired deletes each abandoned object and counts a failed delete', async () => {
    const store = new InMemoryDocumentRecordStore();
    const r2 = new InMemoryR2DocumentStore();
    const service = new DocumentService(store, r2, resolver);
    for (const recordId of ['order-1', 'order-2']) {
      const intent = await service.createIntent({
        workspaceId: 'w1',
        actorId: 'a1',
        requestId: recordId,
        recordType: 'order',
        recordId,
        documentType: 'passport',
        declaredContentType: 'application/pdf',
        declaredSizeBytes: 10,
      });
      expect(intent.status).toBe('created');
    }
    const deleteObject = vi
      .spyOn(r2, 'deleteObject')
      .mockRejectedValueOnce(new Error('r2 unavailable'))
      .mockResolvedValue(undefined);
    const expiredService = new DocumentService(store, r2, resolver, {
      now: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      cleanupGraceSeconds: 0,
    });
    const swept = await expiredService.sweepExpired({ workspaceId: 'w1', actorId: 'a1' });
    expect(swept).toEqual({ expiredIntents: 2, deletedObjects: 1, failedDeletes: 1 });
    expect(deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', objectKey: expect.any(String) }),
    );
  });

  it('defaults to no-op (never withholds) when no backup lease is configured', async () => {
    const store = new InMemoryDocumentRecordStore();
    const r2 = new InMemoryR2DocumentStore();
    const service = new DocumentService(store, r2, resolver);
    const intent = await service.createIntent({
      workspaceId: 'w1',
      actorId: 'a1',
      requestId: 'r1',
      recordType: 'order',
      recordId: 'order-1',
      documentType: 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 10,
    });
    expect(intent.status).toBe('created');
    const expiredService = new DocumentService(store, r2, resolver, {
      now: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      cleanupGraceSeconds: 0,
    });
    const result = await expiredService.runCleanup({ workspaceId: 'w1', actorId: 'a1' });
    expect(result.cleanedObjects.length).toBeGreaterThan(0);
  });
});

describe('DocumentService.createIntent open-intent cap (audit L-4)', () => {
  const intentFor = (service: DocumentService, recordId: string) =>
    service.createIntent({
      workspaceId: 'w1',
      actorId: 'a1',
      requestId: 'r1',
      recordType: 'lead',
      recordId,
      documentType: 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 10,
    });

  it('refuses an intent once the record holds the most open ones, presigning nothing more', async () => {
    const store = new InMemoryDocumentRecordStore();
    const r2 = new InMemoryR2DocumentStore();
    const createUpload = vi.spyOn(r2, 'createUpload');
    const service = new DocumentService(store, r2, resolver, { maxOpenUploads: 3 });

    for (let index = 0; index < 3; index += 1) {
      expect((await intentFor(service, 'lead-1')).status).toBe('created');
    }
    expect(await intentFor(service, 'lead-1')).toEqual({ status: 'too_many_open' });
    expect(createUpload).toHaveBeenCalledTimes(3);

    // Another record has its own allowance.
    expect((await intentFor(service, 'lead-2')).status).toBe('created');
  });

  it('counts expired intents as free again', async () => {
    const store = new InMemoryDocumentRecordStore();
    const r2 = new InMemoryR2DocumentStore();
    const early = new DocumentService(store, r2, resolver, { maxOpenUploads: 1 });
    expect((await intentFor(early, 'lead-1')).status).toBe('created');
    expect((await intentFor(early, 'lead-1')).status).toBe('too_many_open');

    const later = new DocumentService(store, r2, resolver, {
      maxOpenUploads: 1,
      now: () => new Date(Date.now() + 60 * 60 * 1000),
    });
    expect((await intentFor(later, 'lead-1')).status).toBe('created');
  });

  it('defaults to 10 open intents', async () => {
    const store = new InMemoryDocumentRecordStore();
    const service = new DocumentService(store, new InMemoryR2DocumentStore(), resolver);
    for (let index = 0; index < 10; index += 1) {
      expect((await intentFor(service, 'lead-1')).status).toBe('created');
    }
    expect((await intentFor(service, 'lead-1')).status).toBe('too_many_open');
  });
});
