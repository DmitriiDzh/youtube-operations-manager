import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Generic per-channel filesystem transport -- each device writes ONLY its own file, named after
 * its own `deviceId`, into a per-channel subdirectory. Functionally identical to
 * `change-drafts-sync/adapters/filesystem-transport.ts`'s `ChangeDraftsSyncTransportAdapter`
 * (that module predates this generic extraction and is left as-is, `AGENTS.md` §D), duplicated
 * here rather than imported so every document family goes through its OWN barrel-level import
 * (`sync-gateway-inventory.test.ts`) instead of reaching into a sibling child module's adapter.
 */
export type PerChannelTransportAdapter = {
  checkRootAvailable(configuredRoot: string): Promise<void>;
  writeDeviceFile(root: string, channelId: string, deviceId: string, bytes: Uint8Array): Promise<void>;
  listPeerFiles(root: string, channelId: string, ownDeviceId: string): Promise<Array<{ deviceId: string; bytes: Uint8Array }>>;
};

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function channelDir(root: string, channelId: string): string {
  return path.join(root, sanitize(channelId));
}

const DEVICE_FILE_RE = /^([a-zA-Z0-9_-]+)\.automerge$/;

export function createPerChannelFilesystemTransport(): PerChannelTransportAdapter {
  return {
    async checkRootAvailable(configuredRoot) {
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
        if (!match) continue;

        try {
          const buffer = await readFile(path.join(dir, entry));
          peers.push({ deviceId: match[1], bytes: new Uint8Array(buffer) });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return peers;
    },
  };
}
