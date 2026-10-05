import { z } from "zod";
import { SnapshotError } from "./contracts";

const snapshotFileEntrySchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const snapshotManifestSchema = z
  .object({
    formatVersion: z.literal(1),
    snapshotId: z.string().min(1),
    parentSnapshotId: z.string().min(1).nullable(),
    sourceDeviceId: z.string().min(1),
    generation: z.number().int().nonnegative(),
    schemaVersion: z.number().int().positive(),
    createdAt: z.string().datetime(),
    files: z.array(snapshotFileEntrySchema).min(1),
    complete: z.boolean(),
  })
  .strict();

export function parseSnapshotManifest(raw: unknown) {
  const parsed = snapshotManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SnapshotError(
      "snapshot_manifest_invalid",
      `Snapshot manifest failed validation: ${parsed.error.message}`
    );
  }
  return parsed.data;
}
