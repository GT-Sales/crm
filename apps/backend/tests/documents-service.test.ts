import { randomUUID } from 'node:crypto';

import { InMemoryR2DocumentStore, sha256Hex } from '@gt-sales/adapters';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryDocumentContextResolver,
  InMemoryDocumentRecordStore,
} from '../src/documents/memory-store.js';
import { DocumentService } from '../src/documents/service.js';

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const ACTOR = randomUUID();
const LEAD = randomUUID();
const REQUEST = randomUUID();

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const HTML = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x68, 0x69]);

/** Sets up a service over in-memory fakes with the passport checklist armed. */
function buildService(overrides: { maxBytes?: number } = {}) {
  const store = new InMemoryDocumentRecordStore();
  const r2 = new InMemoryR2DocumentStore();
  const resolver = new InMemoryDocumentContextResolver();
  resolver.setChecklist('lead', LEAD, ['passport']);
  const service = new DocumentService(store, r2, resolver, {
    maxBytes: overrides.maxBytes ?? 1024,
    downloadTtlSeconds: 120,
  });
  return { store, r2, resolver, service };
}

async function createLeadIntent(
  service: DocumentService,
  documentType = 'passport',
): Promise<string> {
  const outcome = await service.createIntent({
    workspaceId: WORKSPACE,
    actorId: ACTOR,
    requestId: REQUEST,
    recordType: 'lead',
    recordId: LEAD,
    documentType,
    declaredContentType: 'application/pdf',
    declaredSizeBytes: 100,
  });
  if (outcome.status !== 'created') throw new Error(`intent not created: ${outcome.status}`);
  return outcome.uploadId;
}

describe('DocumentService — upload/verify/attach', () => {
  let ctx: ReturnType<typeof buildService>;
  beforeEach(() => {
    ctx = buildService();
  });

  it('verifies and attaches a well-formed upload (happy path)', async () => {
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    const finalized = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    expect(finalized.status).toBe('available');
    if (finalized.status !== 'available') throw new Error('unreachable');
    expect(finalized.file.detectedMime).toBe('application/pdf');
    // The attached object is the CANDIDATE, never the staging object.
    expect(finalized.file.objectKey).toBe(ctx.store.snapshot(fileId)?.candidateKey);
    expect(finalized.file.objectKey).not.toBe(staging);
  });

  it('records a held intent for a change request, and finalizes it like any other', async () => {
    const outcome = await ctx.service.createIntent({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      recordType: 'lead',
      recordId: LEAD,
      documentType: 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 100,
      held: true,
    });
    if (outcome.status !== 'created') throw new Error('intent not created');
    expect(ctx.store.isHeld(outcome.uploadId)).toBe(true);
    const plain = await createLeadIntent(ctx.service);
    expect(ctx.store.isHeld(plain)).toBe(false);

    ctx.r2.putStagingObject(ctx.store.snapshot(outcome.uploadId)?.stagingKey ?? '', PDF);
    const finalized = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId: outcome.uploadId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    expect(finalized.status).toBe('available');
    expect(ctx.store.isHeld(outcome.uploadId)).toBe(true);
  });

  it('rejects a mislabelled type by signature (declared PDF, bytes are HTML)', async () => {
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, HTML);
    const finalized = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(HTML),
      ownedLeadId: LEAD,
    });
    expect(finalized).toMatchObject({ status: 'rejected', reason: 'unsupported_signature' });
    expect(ctx.store.snapshot(fileId)?.status).toBe('rejected');
    expect(ctx.store.snapshot(fileId)?.objectKey).toBeNull();
  });

  it('rejects an oversize upload at intent AND at finalize', async () => {
    const small = buildService({ maxBytes: 5 });
    small.resolver.setChecklist('lead', LEAD, ['passport']);
    // Declared oversize is refused before any signed URL is issued.
    const intent = await small.service.createIntent({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      recordType: 'lead',
      recordId: LEAD,
      documentType: 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 999,
    });
    expect(intent.status).toBe('too_large');

    // A client that under-declares then uploads oversize bytes is caught on the candidate.
    const underDeclared = await small.service.createIntent({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      recordType: 'lead',
      recordId: LEAD,
      documentType: 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 4,
    });
    if (underDeclared.status !== 'created') throw new Error('under-declared intent not created');
    const fileId = underDeclared.uploadId;
    const staging = small.store.snapshot(fileId)?.stagingKey ?? '';
    small.r2.putStagingObject(staging, PNG); // 10 bytes > maxBytes 5
    const finalized = await small.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PNG),
      ownedLeadId: LEAD,
    });
    expect(finalized).toMatchObject({ status: 'rejected', reason: 'too_large' });
  });

  it('rejects an upload whose bytes do not match the declared checksum', async () => {
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    const finalized = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PNG),
      ownedLeadId: LEAD,
    });
    expect(finalized).toMatchObject({ status: 'rejected', reason: 'checksum_mismatch' });
  });

  it('refuses an upload whose document type is not on the offer checklist', async () => {
    const outcome = await ctx.service.createIntent({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      recordType: 'lead',
      recordId: LEAD,
      documentType: 'drivers_licence',
      declaredContentType: 'image/png',
      declaredSizeBytes: 100,
    });
    expect(outcome.status).toBe('checklist_mismatch');
  });

  it('refuses an upload to a parent that is not in this workspace', async () => {
    const outcome = await ctx.service.createIntent({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      recordType: 'lead',
      recordId: randomUUID(), // no checklist configured → resolver reports not found
      documentType: 'passport',
      declaredContentType: 'application/pdf',
      declaredSizeBytes: 100,
    });
    expect(outcome.status).toBe('parent_not_found');
  });

  it('swapping the staged upload during finalize cannot make unchecked bytes available', async () => {
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    const finalized = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    if (finalized.status !== 'available') throw new Error('expected available');

    // Attacker swaps staging bytes AFTER the check.
    ctx.r2.overwriteStaging(staging, HTML);

    const link = await ctx.service.issueDownload({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      fileId,
      requestId: REQUEST,
    });
    expect(link.status).toBe('issued');
    const served = ctx.r2.getObject(finalized.file.objectKey ?? '');
    // What staff receive is the verified candidate, not the swapped staging bytes.
    expect(served).toEqual(PDF);
    expect(sha256Hex(served ?? new Uint8Array())).toBe(finalized.file.checksumSha256);
  });

  it('two simultaneous finalize calls cannot overwrite the approved object', async () => {
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    const run = () =>
      ctx.service.finalize({
        workspaceId: WORKSPACE,
        actorId: ACTOR,
        requestId: REQUEST,
        fileId,
        checksumSha256: sha256Hex(PDF),
        ownedLeadId: LEAD,
      });
    const [a, b] = await Promise.all([run(), run()]);
    const statuses = [a.status, b.status].sort();
    // Exactly one claims verification; the other observes it in progress.
    expect(statuses).toEqual(['available', 'in_progress']);
    expect(ctx.store.snapshot(fileId)?.status).toBe('available');
  });

  it('repeated finalize after completion returns a consistent outcome', async () => {
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    const first = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    const second = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    if (first.status !== 'available' || second.status !== 'available') {
      throw new Error('both finalize calls should be available');
    }
    expect(second.file.objectKey).toBe(first.file.objectKey);
    expect(second.file.checksumSha256).toBe(first.file.checksumSha256);
  });
});

describe('DocumentService — download and permission scoping', () => {
  it('the recorded checksum matches the exact object served to staff', async () => {
    const ctx = buildService();
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    const stored = ctx.store.snapshot(fileId);
    const served = ctx.r2.getObject(stored?.objectKey ?? '');
    expect(sha256Hex(served ?? new Uint8Array())).toBe(stored?.checksumSha256);
  });

  it('issues a 2-minute download link for an available file', async () => {
    const ctx = buildService();
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    const before = Date.now();
    await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    const link = await ctx.service.issueDownload({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      fileId,
      requestId: REQUEST,
    });
    if (link.status !== 'issued') throw new Error('expected issued');
    // Every issued link is audited without customer data (invariant 11).
    expect(ctx.store.audits).toEqual([
      { action: 'file.download_issued', fileId, audience: 'staff', disposition: 'attachment' },
    ]);
    const ttlMs = link.expiresAt.getTime() - before;
    // ~120s (link expiry is ultimately enforced by R2 on the presigned URL).
    expect(ttlMs).toBeGreaterThan(110_000);
    expect(ttlMs).toBeLessThanOrEqual(121_000);
  });

  it('refuses a download link for a tombstoned (deleted) file', async () => {
    const ctx = buildService();
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    await ctx.service.remove({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
    });
    const link = await ctx.service.issueDownload({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      fileId,
      requestId: REQUEST,
    });
    expect(link.status).toBe('not_available');
  });

  it('does not resolve a file id belonging to another workspace (foreign attachment)', async () => {
    const ctx = buildService();
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    // A caller in a different workspace cannot resolve this file.
    const link = await ctx.service.issueDownload({
      workspaceId: OTHER_WORKSPACE,
      actorId: ACTOR,
      fileId,
      requestId: REQUEST,
    });
    expect(link.status).toBe('not_found');
  });

  it('audits a customer download as the website audience', async () => {
    const ctx = buildService();
    const fileId = await createLeadIntent(ctx.service);
    ctx.r2.putStagingObject(ctx.store.snapshot(fileId)?.stagingKey ?? '', PDF);
    await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: LEAD,
    });
    const link = await ctx.service.issueDownload({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      fileId,
      requestId: REQUEST,
      ownedLeadId: LEAD,
    });
    expect(link.status).toBe('issued');
    expect(ctx.store.audits).toEqual([
      { action: 'file.download_issued', fileId, audience: 'website', disposition: 'attachment' },
    ]);
  });

  it('does not let one draft finalize or download another draft’s file', async () => {
    const ctx = buildService();
    const fileId = await createLeadIntent(ctx.service);
    const staging = ctx.store.snapshot(fileId)?.stagingKey ?? '';
    ctx.r2.putStagingObject(staging, PDF);
    // A different lead's grant (ownedLeadId) must not touch this file.
    const finalized = await ctx.service.finalize({
      workspaceId: WORKSPACE,
      actorId: ACTOR,
      requestId: REQUEST,
      fileId,
      checksumSha256: sha256Hex(PDF),
      ownedLeadId: randomUUID(),
    });
    expect(finalized.status).toBe('not_found');
    // The file was never claimed/transitioned.
    expect(ctx.store.snapshot(fileId)?.status).toBe('uploading');
  });
});
