import { mkdir, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SnapshotError, type SnapshotManifest } from "../contracts";
import { parseSnapshotManifest } from "../schemas";
import { renameWithRetry } from "@/lib/rename-retry";

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fresh, never-yet-published staging directory -- publishSnapshot() below is the only way
 * its contents become visible under a final snapshot id (AC-SNAP-01/03).
 */
export async function createStagingDir(snapshotsDir: string): Promise<{ dir: string; stagingId: string }> {
  const stagingId = randomUUID();
  const dir = path.join(snapshotsDir, `.staging-${stagingId}`);
  await mkdir(dir, { recursive: true });
  return { dir, stagingId };
}

export async function writeManifest(stagingDir: string, manifest: SnapshotManifest): Promise<void> {
  await writeFile(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

/**
 * Atomically publishes a staging directory as `<snapshotsDir>/<snapshotId>/` -- a reader can
 * never observe a directory under its final snapshot id that isn't already fully written
 * (rename is atomic on both NTFS and APFS/HFS+ for a same-volume move, which staging-dir ->
 * sibling-dir always is here). Never overwrites an existing published snapshot (AC-SNAP-08).
 */
export async function publishSnapshot(
  snapshotsDir: string,
  stagingDir: string,
  snapshotId: string
): Promise<string> {
  const finalDir = path.join(snapshotsDir, snapshotId);
  if (await pathExists(finalDir)) {
    throw new SnapshotError(
      "snapshot_already_exists",
      `A snapshot with id ${snapshotId} is already published -- refusing to overwrite it.`
    );
  }

  await renameWithRetry(stagingDir, finalDir);
  return finalDir;
}

export async function discardStagingDir(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}

export async function readManifestFromDir(snapshotDir: string): Promise<SnapshotManifest> {
  const manifestPath = path.join(snapshotDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new SnapshotError(
      "snapshot_file_missing",
      `No manifest.json found in ${snapshotDir} -- not a valid snapshot directory.`
    );
  }
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  return parseSnapshotManifest(raw);
}

/** Lists every *published* snapshot id (staging directories, prefixed `.staging-`, are never
 * included -- they are not yet valid/complete snapshots). */
export async function listPublishedSnapshotIds(snapshotsDir: string): Promise<string[]> {
  if (!(await pathExists(snapshotsDir))) return [];
  const entries = await readdir(snapshotsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/**
 * Automatic device sync (docs/roadmap/plans/DEVICE_AUTO_SYNC_PLAN.md §3.1): a snapshot's ancestry
 * travels as an extra data file, `lineage.json`, listed in the manifest's `files` (so it is
 * checksummed like `data.db`). The manifest schema itself is unchanged -- an older build's
 * `.strict()` schema would reject a new manifest field, but only verifies an extra file's hash.
 */
export const LINEAGE_FILE_NAME = "lineage.json";
export const MAX_ANCESTORS = 500;

/**
 * `supersedes` (review round 2): snapshots whose content this one deliberately REPLACES by a human
 * decision -- "keep mine" lists the other computers' conflicting tips, a "take theirs" marker lists
 * its author's own abandoned branch. It never widens what counts as a fast-forward; it only tells a
 * receiving computer whose head is listed that its own divergent data is being replaced, so that
 * import keeps a backup automatic retention never deletes.
 */
export type SnapshotLineageFile = { ancestors: string[]; supersedes: string[] };

export async function writeLineageFile(stagingDir: string, lineage: SnapshotLineageFile): Promise<void> {
  await writeFile(
    path.join(stagingDir, LINEAGE_FILE_NAME),
    JSON.stringify({
      formatVersion: 1,
      ancestors: lineage.ancestors.slice(0, MAX_ANCESTORS),
      supersedes: lineage.supersedes.slice(0, MAX_ANCESTORS),
    }),
    "utf8"
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

/** The snapshot's lineage file, or `null` when the manifest lists none (a snapshot from a build
 * before automatic sync). A listed-but-unreadable file throws, like any other missing/corrupt
 * snapshot file. */
export async function readLineageFile(snapshotDir: string, manifest: SnapshotManifest): Promise<SnapshotLineageFile | null> {
  if (!manifest.files.some((file) => file.path === LINEAGE_FILE_NAME)) return null;
  const filePath = path.join(snapshotDir, LINEAGE_FILE_NAME);
  if (!(await pathExists(filePath))) {
    throw new SnapshotError("snapshot_file_missing", `Snapshot ${manifest.snapshotId} is missing ${LINEAGE_FILE_NAME}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new SnapshotError("snapshot_manifest_invalid", `Snapshot ${manifest.snapshotId}'s ${LINEAGE_FILE_NAME} is not valid JSON.`);
  }
  const record = (parsed ?? {}) as { ancestors?: unknown; supersedes?: unknown };
  if (!isStringArray(record.ancestors) || (record.supersedes !== undefined && !isStringArray(record.supersedes))) {
    throw new SnapshotError("snapshot_manifest_invalid", `Snapshot ${manifest.snapshotId}'s ${LINEAGE_FILE_NAME} is malformed.`);
  }
  return { ancestors: record.ancestors, supersedes: record.supersedes ?? [] };
}

const SNAPSHOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Like `listPublishedSnapshotIds`, but only UUID-named directories: the Syncthing root also holds
 * the sync-gateway families' folders (`change-drafts/`, ...), which are not snapshots (§3.2). */
export async function listSnapshotIdsStrict(snapshotsDir: string): Promise<string[]> {
  return (await listPublishedSnapshotIds(snapshotsDir)).filter((name) => SNAPSHOT_ID_RE.test(name));
}
