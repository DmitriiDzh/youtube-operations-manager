import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * File-based transport for CD5's sync cycle (AUTOMERGE_MIGRATION_PLAN.md §6, §8's "file-based,
 * over the existing operator-configured Syncthing folder" decision). Each device writes ONLY its
 * own file, named after its own `deviceId` (`src/lib/bootstrap-config/`) -- never a shared
 * filename two devices could both write to -- so Syncthing's own generic same-file conflict
 * handling never triggers for this data; a real CRDT-level conflict is instead detected and
 * surfaced by `change-drafts/services.ts`'s own `mergeIncoming`.
 *
 * `writeDeviceFile` reuses the identical atomic temp-file-then-rename pattern as
 * `change-drafts/adapters/automerge-store.ts`'s `saveDocumentBytes`, for the same reason: a
 * crash mid-write must never leave a truncated, unloadable file for a peer device to pick up.
 *
 * `listPeerFiles` must be defensive about what Syncthing itself places in this directory: a
 * `.sync-conflict-<timestamp>-<id>` copy (Syncthing's own generic same-filename-conflict
 * handling, which should never actually trigger here since every device owns a distinct
 * filename, but is defended against anyway) or an in-progress `.syncthing.*.tmp` temp file
 * mid-replication. Only a filename that is EXACTLY `<safe-device-id>.automerge` (no extra
 * dots/suffixes) is treated as a real peer file -- this incidentally also excludes both of the
 * artifact shapes above, since Syncthing always inserts its own marker text between the base
 * name and the `.automerge` extension.
 */
export type ChangeDraftsSyncTransportAdapter = {
  /** Throws if the operator's raw configured Syncthing root doesn't exist -- called once per
   * cycle by `services.ts`, only when a Syncthing root is actually configured (never against the
   * always-safe local fallback directory, and never against the deeper, already-appended `root`
   * the other two methods receive). See this adapter's own doc comment for why. */
  checkRootAvailable(configuredRoot: string): Promise<void>;
  writeDeviceFile(root: string, channelId: string, deviceId: string, bytes: Uint8Array): Promise<void>;
  listPeerFiles(
    root: string,
    channelId: string,
    ownDeviceId: string
  ): Promise<Array<{ deviceId: string; bytes: Uint8Array }>>;
};

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function channelDir(root: string, channelId: string): string {
  return path.join(root, sanitize(channelId));
}

const DEVICE_FILE_RE = /^([a-zA-Z0-9_-]+)\.automerge$/;

export function createFilesystemTransportAdapter(): ChangeDraftsSyncTransportAdapter {
  return {
    async checkRootAvailable(configuredRoot) {
      // Verify the operator's CONFIGURED Syncthing root already exists, before this module ever
      // appends its own "change-drafts" subfolder onto it and calls a recursive `mkdir` on the
      // result. This matters specifically on macOS: the configured root is commonly a path under
      // `/Volumes/<name>` (an external, Syncthing-shared drive) that is currently unmounted -- a
      // plain recursive `mkdir` targeting a path under it would silently create a REAL empty
      // directory at that mount point on the boot volume, which can later prevent the actual
      // external drive from ever mounting there again (or force it to mount under a different
      // name). Checked once per sync cycle (`services.ts`), against the raw configured value,
      // never against the already-appended `root` this adapter's other methods receive -- a
      // missing "change-drafts" subfolder under an otherwise-real, mounted root is the normal,
      // expected first-use case and must still be created freely.
      try {
        const rootStat = await stat(configuredRoot);
        if (!rootStat.isDirectory()) {
          throw new Error(`Configured sync folder exists but is not a directory: ${configuredRoot}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`Configured sync folder is not available (does not exist): ${configuredRoot}`);
        }
        throw error;
      }
    },

    async writeDeviceFile(root, channelId, deviceId, bytes) {
      const dir = channelDir(root, channelId);
      await mkdir(dir, { recursive: true });
      const finalPath = path.join(dir, `${sanitize(deviceId)}.automerge`);
      const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
      await writeFile(tmpPath, bytes);
      await rename(tmpPath, finalPath);
    },

    async listPeerFiles(root, channelId, ownDeviceId) {
      const dir = channelDir(root, channelId);
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }

      const ownFileName = `${sanitize(ownDeviceId)}.automerge`;
      const peers: Array<{ deviceId: string; bytes: Uint8Array }> = [];
      for (const entry of entries) {
        if (entry === ownFileName) continue;
        const match = DEVICE_FILE_RE.exec(entry);
        if (!match) continue; // not a real device file (Syncthing temp/.sync-conflict artifact, or unrelated)

        try {
          const buffer = await readFile(path.join(dir, entry));
          peers.push({ deviceId: match[1], bytes: new Uint8Array(buffer) });
        } catch (error) {
          // A file mid-replication can disappear or fail to read between `readdir` and
          // `readFile` -- skip it this cycle rather than fail the whole channel; it will be
          // picked up on the next cycle once fully written.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return peers;
    },
  };
}
