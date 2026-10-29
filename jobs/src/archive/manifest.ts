import { sha256Hex } from '@gt-sales/adapters';
import { z } from 'zod';

/**
 * The manifest of one backup run: which deployment it came from, run id,
 * source ids, tool versions, every artifact's name, size and hash, the row
 * count of every dumped table and what was deliberately left out. It is
 * encrypted and uploaded last, like the payloads it describes, because it
 * names every artifact. A restore trusts nothing it cannot match against it:
 * the hashes prove each artifact is the one captured, the row counts prove
 * the restored database holds what the dump held. `deployment` says whose
 * database it is, because one workflow set backs up every deployment, each to
 * its own bucket (docs/RUNBOOKS/backup.md).
 */

export const manifestArtifactSchema = z
  .object({
    name: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  })
  .strict();
export type ManifestArtifact = z.infer<typeof manifestArtifactSchema>;

/** `schema.table`, as the dump names it. */
const qualifiedTableName = z.string().regex(/^[^.\s]+\.[^.\s]+$/);

export const backupManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    deployment: z.string().min(1),
    runId: z.string().min(1),
    capturedAt: z.iso.datetime(),
    sourceIds: z.record(z.string(), z.string()),
    toolVersions: z.record(z.string(), z.string()),
    artifacts: z.array(manifestArtifactSchema).min(1),
    rowCounts: z.record(qualifiedTableName, z.number().int().nonnegative()),
    counts: z.record(z.string(), z.number().int().nonnegative()),
    exclusions: z.array(z.string()),
  })
  .strict();
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export function manifestArtifact(name: string, bytes: Uint8Array): ManifestArtifact {
  return { name, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
}

export function buildManifest(input: {
  deployment: string;
  runId: string;
  capturedAt: Date;
  sourceIds: Record<string, string>;
  toolVersions: Record<string, string>;
  artifacts: ManifestArtifact[];
  rowCounts: Record<string, number>;
  counts: Record<string, number>;
  exclusions: string[];
}): BackupManifest {
  return backupManifestSchema.parse({
    schemaVersion: 1,
    deployment: input.deployment,
    runId: input.runId,
    capturedAt: input.capturedAt.toISOString(),
    sourceIds: input.sourceIds,
    toolVersions: input.toolVersions,
    artifacts: input.artifacts,
    rowCounts: input.rowCounts,
    counts: input.counts,
    exclusions: input.exclusions,
  });
}

export type ManifestVerification =
  { ok: true } | { ok: false; missing: string[]; mismatched: string[] };

/**
 * A snapshot is usable only when every referenced artifact is present and its
 * size and checksum match. Never partial-accept a manifest: a restore from a
 * snapshot with one artifact missing would look complete and silently lose
 * data.
 */
export function verifyManifestArtifacts(
  manifest: BackupManifest,
  decrypted: ReadonlyMap<string, Uint8Array>,
): ManifestVerification {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const artifact of manifest.artifacts) {
    const bytes = decrypted.get(artifact.name);
    if (!bytes) {
      missing.push(artifact.name);
      continue;
    }
    if (bytes.byteLength !== artifact.bytes || sha256Hex(bytes) !== artifact.sha256) {
      mismatched.push(artifact.name);
    }
  }
  if (missing.length > 0 || mismatched.length > 0) return { ok: false, missing, mismatched };
  return { ok: true };
}
