import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomicIfChanged } from "@/lib/atomic-json-file";
import { fileStampKey, isSettledAt, stampOf } from "@/lib/file-fingerprint";
import type { PerDeviceReportStore } from "./index";

/** `<dir>/local.json` (this device's report) and `<dir>/peers/<deviceId>.json` (each peer's latest), written atomically. */
export function createFsPerDeviceReportStore(dir: string): PerDeviceReportStore {
  const peersDir = path.join(dir, "peers");
  // BL-162 (review): the review screen asks for the other devices' claims every 3 s; a peer report (up to 4 MB) is read from
  // disk again only when its file changed (its stamp: size, times, inode -- `file-fingerprint`, BL-277).
  const peerCache = new Map<string, { key: string; text: string }>();
  const safe = (deviceId: string) => deviceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const readOrNull = async (file: string) => {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  return {
    readLocal: () => readOrNull(path.join(dir, "local.json")),
    async writeLocal(json) {
      await mkdir(dir, { recursive: true });
      // BL-270: the same report is not written again (no fsync, the mtime stays).
      await writeFileAtomicIfChanged(path.join(dir, "local.json"), new TextEncoder().encode(json));
    },
    async readPeers() {
      let names: string[];
      try {
        names = await readdir(peersDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
      const out: Record<string, string> = {};
      for (const name of names.filter((n) => n.endsWith(".json"))) {
        const file = path.join(peersDir, name);
        const info = await stat(file).catch(() => null);
        if (!info) continue;
        const hit = peerCache.get(name);
        // BL-277: the shared `file-fingerprint` rule -- the stamp carries inode and ctime (a report replaced by another writer's
        // atomic rename always misses), and a file changed in the last 2 s (whole-second mtimes on HFS+) is not kept.
        const stamp = stampOf(info);
        const key = fileStampKey(stamp);
        let text: string | null;
        if (hit && hit.key === key) {
          text = hit.text;
        } else {
          const settled = isSettledAt(stamp, Date.now());
          text = await readOrNull(file);
          if (text && settled) peerCache.set(name, { key, text });
          else peerCache.delete(name);
        }
        if (text) out[name.slice(0, -".json".length)] = text;
      }
      return out;
    },
    async writePeer(deviceId, json) {
      await mkdir(peersDir, { recursive: true });
      // BL-270: a peer's report that did not change since the last cycle (same text) is not written again -- its mtime stays, so
      // the read cache above keeps it. Dropped from the cache only when it was really rewritten.
      if (await writeFileAtomicIfChanged(path.join(peersDir, `${safe(deviceId)}.json`), new TextEncoder().encode(json))) {
        peerCache.delete(`${safe(deviceId)}.json`);
      }
    },
  };
}
