import { describe, expect, it } from 'vitest';

import {
  backupManifestSchema,
  buildManifest,
  manifestArtifact,
  verifyManifestArtifacts,
} from '../src/archive/manifest.js';

const data = new TextEncoder().encode('data.sql contents');

function manifestInput(): Parameters<typeof buildManifest>[0] {
  return {
    deployment: 'gt-sales',
    runId: 'run-1',
    capturedAt: new Date('2026-10-29T06:17:00.000Z'),
    sourceIds: { supabaseProjectRef: 'abc123' },
    toolVersions: { pg_dump: '17.6' },
    artifacts: [manifestArtifact('data.sql', data)],
    rowCounts: { 'app.leads': 3, 'public.orders': 0 },
    counts: { referencedObjects: 2 },
    exclusions: ['supabase_project_settings'],
  };
}

describe('manifest', () => {
  const manifest = buildManifest(manifestInput());

  it('records the deployment, row counts and an ISO capture time', () => {
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      deployment: 'gt-sales',
      capturedAt: '2026-10-29T06:17:00.000Z',
      rowCounts: { 'app.leads': 3, 'public.orders': 0 },
      artifacts: [{ name: 'data.sql', bytes: data.byteLength }],
    });
    expect(manifest.artifacts[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is a snapshot only when every artifact is present and its checksum matches', () => {
    expect(verifyManifestArtifacts(manifest, new Map([['data.sql', data]]))).toEqual({ ok: true });
  });

  it('fails closed on a missing artifact', () => {
    expect(verifyManifestArtifacts(manifest, new Map())).toEqual({
      ok: false,
      missing: ['data.sql'],
      mismatched: [],
    });
  });

  it('fails closed on a checksum mismatch (tampered payload)', () => {
    const tampered = new TextEncoder().encode('different bytes, same name');
    expect(verifyManifestArtifacts(manifest, new Map([['data.sql', tampered]]))).toEqual({
      ok: false,
      missing: [],
      mismatched: ['data.sql'],
    });
  });

  it('rejects a manifest with no artifacts', () => {
    expect(() => buildManifest({ ...manifestInput(), artifacts: [] })).toThrow();
  });

  it('a manifest without deployment fails parsing', () => {
    const { deployment: _deployment, ...withoutDeployment } = manifest;
    expect(backupManifestSchema.safeParse(withoutDeployment).success).toBe(false);
    expect(() => buildManifest({ ...manifestInput(), deployment: '' })).toThrow();
  });

  it('rowCounts with a negative value fails', () => {
    expect(() => buildManifest({ ...manifestInput(), rowCounts: { 'app.leads': -1 } })).toThrow();
  });

  it('rowCounts keys must name schema.table', () => {
    expect(() => buildManifest({ ...manifestInput(), rowCounts: { leads: 3 } })).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(backupManifestSchema.safeParse({ ...manifest, extra: true }).success).toBe(false);
  });
});
