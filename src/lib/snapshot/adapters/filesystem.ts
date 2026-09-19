import { mkdir, readFile, readdir, rename, rm, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SnapshotError, type SnapshotManifest } from "../contracts";
import { parseSnapshotManifest } from "../schemas";

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

  // A file written moments earlier by a just-closed SQLite connection can briefly still hold
  // an OS-level lock on Windows even after close() returns (native binding handle release is
  // not perfectly synchronous) -- retry the rename rather than fail the whole export on an
  // unrelated, transient EBUSY.
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rename(stagingDir, finalDir);
      return finalDir;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
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
